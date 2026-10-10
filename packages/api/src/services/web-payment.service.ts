// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { and, eq, gte, isNull } from 'drizzle-orm';
import {
  AppError,
  TOTP_VERSION_V1,
  decryptString,
  encryptString,
  verifyTotpV1,
} from '@evtivity/lib';
import {
  db,
  chargingStations,
  evses,
  stationAuditLog,
  stationConfigurations,
  stationWebPaymentConfigs,
  writeAudit,
} from '@evtivity/database';
import { sendOcppCommandAndWait } from '@evtivity/services/ocpp-command';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import { config } from '../lib/config.js';

// The only writer of station_web_payment_configs. Dynamic QR codes (OCPP 2.1
// C25): the CSMS sets WebPaymentsCtrlr on the station (URL template, TOTP
// parameters, shared secret) and keeps the secret, encrypted, so it can check
// the time-based one-time password in a scanned QR code URL (C25.FR.07-09).

/** Path of the portal page a dynamic QR code opens (C25.FR.50 placeholders). */
export const QR_PATH_TEMPLATE = '/qr/{chargingstationid}/{evse}/{totp}/{version}';

const COMPONENT = 'WebPaymentsCtrlr';

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

/** A stored device model report this recent answers a support check without asking the station. */
export const STORED_SUPPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type WebPaymentSupportStatus = 'supported' | 'not_supported' | 'unknown';

export type WebPaymentSupportReason =
  | 'reported'
  | 'not_available'
  | 'unknown_component'
  | 'unknown_variable'
  | 'ocpp_version'
  | 'offline'
  | 'timeout'
  | 'command_failed'
  | 'unexpected_response'
  | 'not_checked';

export interface WebPaymentSupportView {
  status: WebPaymentSupportStatus;
  reason: WebPaymentSupportReason;
  /** Where the answer came from: a live GetVariables, the stored device model, or neither. */
  source: 'station' | 'device_model' | 'none';
  /** WebPaymentsCtrlr.Enabled as the station reported it, null when not reported. */
  stationEnabled: boolean | null;
  /** When the station answered (live) or last reported the component (stored), ISO 8601. */
  checkedAt: string | null;
}

export interface WebPaymentContext {
  actor: AuditActorInfo;
  log: Logger;
}

export interface WebPaymentSettings {
  /** WebPaymentsCtrlr.ValidityTime, 6 to 3600 seconds. */
  validitySeconds: number;
  /** WebPaymentsCtrlr.Length, at least 6. */
  totpLength: number;
}

export interface WebPaymentConfigView {
  enabled: boolean;
  validitySeconds: number | null;
  totpLength: number | null;
  totpVersion: string | null;
  urlTemplate: string | null;
}

export type QrValidationReason =
  | 'malformed_url'
  | 'missing_parameter'
  | 'unknown_station'
  | 'unsupported_version'
  | 'invalid_totp'
  | 'unknown_evse';

export type QrValidationResult =
  | { valid: true; stationId: string; evseId: number }
  | { valid: false; reason: QrValidationReason };

function encryptionKey(): string {
  return config.SETTINGS_ENCRYPTION_KEY;
}

export function qrUrlTemplate(): string {
  return `${config.PORTAL_URL.replace(/\/+$/, '')}${QR_PATH_TEMPLATE}`;
}

async function loadStation(stationDbId: string) {
  const [station] = await db
    .select({
      id: chargingStations.id,
      stationId: chargingStations.stationId,
      ocppProtocol: chargingStations.ocppProtocol,
      isOnline: chargingStations.isOnline,
    })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationDbId));
  if (station == null) throw new AppError('Station not found', 404, 'STATION_NOT_FOUND');
  return station;
}

function assertReachable(station: { isOnline: boolean; ocppProtocol: string | null }): void {
  if (!station.isOnline) throw new AppError('Station is offline', 409, 'STATION_OFFLINE');
  if (station.ocppProtocol !== 'ocpp2.1') {
    throw new AppError(
      'Dynamic QR codes need a station that uses OCPP 2.1',
      400,
      'OCPP_VERSION_MISMATCH',
    );
  }
}

const NOT_SUPPORTED_MESSAGE = 'The station does not support dynamic QR codes (WebPaymentsCtrlr)';

function notSupported(): AppError {
  return new AppError(NOT_SUPPORTED_MESSAGE, 409, 'WEB_PAYMENTS_NOT_SUPPORTED');
}

async function setWebPaymentVariables(
  stationOcppId: string,
  values: Array<[string, string]>,
  options: { refuseUnsupported: boolean } = { refuseUnsupported: false },
): Promise<void> {
  const result = await sendOcppCommandAndWait(stationOcppId, 'SetVariables', {
    setVariableData: values.map(([variable, attributeValue]) => ({
      component: { name: COMPONENT },
      variable: { name: variable },
      attributeValue,
    })),
  });
  if (result.error != null) {
    throw new AppError(
      `SetVariables ${COMPONENT} failed: ${result.error}`,
      502,
      'OCPP_COMMAND_FAILED',
    );
  }
  const results =
    (result.response?.['setVariableResult'] as
      | { attributeStatus?: string; variable?: { name?: string } }[]
      | undefined) ?? [];
  // A station without the component (B06) cannot show dynamic QR codes at all:
  // say so, instead of reporting a refused setting.
  if (
    options.refuseUnsupported &&
    results.some(
      (r) => r.attributeStatus === 'UnknownComponent' || r.attributeStatus === 'UnknownVariable',
    )
  ) {
    throw notSupported();
  }
  const refused = values.filter(([variable]) => {
    const status = results.find((r) => r.variable?.name === variable)?.attributeStatus;
    return status !== 'Accepted' && status !== 'RebootRequired';
  });
  if (refused.length > 0) {
    throw new AppError(
      `The station did not accept ${refused.map(([v]) => `${COMPONENT}.${v}`).join(', ')}`,
      502,
      'STATION_SECURITY_CHANGE_REJECTED',
    );
  }
}

async function audit(stationDbId: string, notes: string, ctx: WebPaymentContext): Promise<void> {
  await writeAudit(
    { table: stationAuditLog, idColumn: 'station_id' },
    {
      entityId: stationDbId,
      entityIdSnapshot: stationDbId,
      action: 'updated',
      ...ctx.actor,
      notes,
    },
    db,
    ctx.log,
  );
}

export async function getWebPaymentConfig(stationDbId: string): Promise<WebPaymentConfigView> {
  await loadStation(stationDbId);
  const [row] = await db
    .select()
    .from(stationWebPaymentConfigs)
    .where(eq(stationWebPaymentConfigs.stationId, stationDbId));
  if (row == null) {
    return {
      enabled: false,
      validitySeconds: null,
      totpLength: null,
      totpVersion: null,
      urlTemplate: null,
    };
  }
  return {
    enabled: true,
    validitySeconds: row.validitySeconds,
    totpLength: row.totpLength,
    totpVersion: row.totpVersion,
    urlTemplate: row.urlTemplate,
  };
}

/**
 * Configures dynamic QR codes on an online OCPP 2.1 station with a fresh shared
 * secret. The secret is stored only after the station accepts every variable,
 * so the CSMS never validates against a secret the station does not use.
 */
export async function enableWebPayments(
  stationDbId: string,
  settings: WebPaymentSettings,
  ctx: WebPaymentContext,
): Promise<WebPaymentConfigView> {
  const station = await loadStation(stationDbId);
  assertReachable(station);
  // The last device model report decides first; a station that never reported
  // the component is asked by the SetVariables below (enabling before a
  // support check is allowed).
  const stored = await storedSupport(station.id, Date.now());
  if (stored?.status === 'not_supported') throw notSupported();

  const sharedSecret = crypto.randomBytes(24).toString('base64url');
  const urlTemplate = qrUrlTemplate();
  await setWebPaymentVariables(
    station.stationId,
    [
      ['URLTemplate', urlTemplate],
      ['TOTPVersion', TOTP_VERSION_V1],
      ['ValidityTime', String(settings.validitySeconds)],
      ['Length', String(settings.totpLength)],
      ['SharedSecret', sharedSecret],
      ['Enabled', 'true'],
    ],
    { refuseUnsupported: true },
  );

  const values = {
    sharedSecretEnc: encryptString(sharedSecret, encryptionKey()),
    validitySeconds: settings.validitySeconds,
    totpLength: settings.totpLength,
    totpVersion: TOTP_VERSION_V1,
    urlTemplate,
    updatedAt: new Date(),
  };
  await db
    .insert(stationWebPaymentConfigs)
    .values({ stationId: station.id, ...values })
    .onConflictDoUpdate({ target: stationWebPaymentConfigs.stationId, set: values });
  await audit(
    station.id,
    `Dynamic QR code payments enabled (ValidityTime ${String(settings.validitySeconds)}s, Length ${String(settings.totpLength)})`,
    ctx,
  );
  return getWebPaymentConfig(station.id);
}

/**
 * Turns dynamic QR codes off. An online station gets WebPaymentsCtrlr.Enabled =
 * false first; the stored secret is removed either way, so a QR code the
 * station still shows is no longer accepted (fails closed).
 */
export async function disableWebPayments(
  stationDbId: string,
  ctx: WebPaymentContext,
): Promise<WebPaymentConfigView> {
  const station = await loadStation(stationDbId);
  if (station.isOnline && station.ocppProtocol === 'ocpp2.1') {
    await setWebPaymentVariables(station.stationId, [['Enabled', 'false']]);
  }
  const removed = await db
    .delete(stationWebPaymentConfigs)
    .where(eq(stationWebPaymentConfigs.stationId, station.id))
    .returning({ stationId: stationWebPaymentConfigs.stationId });
  if (removed.length > 0) {
    await audit(station.id, 'Dynamic QR code payments disabled', ctx);
  }
  return getWebPaymentConfig(station.id);
}

// WebPaymentsCtrlr (OCPP 2.1 part 2, 2.4.2) has no Available variable of its
// own: its mandatory readable variables are URLTemplate, TOTPVersion,
// ValidityTime and Length, and C25.FR.01 reads its Enabled. A station without
// the component answers UnknownComponent (B06.FR.06), one without a variable
// UnknownVariable (B06.FR.07). Available is asked too, as on other
// controllers: a station that reports it false lacks the feature.
const SUPPORT_VARIABLES = ['TOTPVersion', 'Enabled', 'Available'] as const;

interface ReportedVariable {
  variable: string;
  value: string | null;
  updatedAt: Date;
}

function parseBoolean(value: string | null | undefined): boolean | null {
  if (value == null) return null;
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function supportFromStored(rows: ReportedVariable[]): WebPaymentSupportView | null {
  const [first, ...rest] = rows;
  if (first == null) return null;
  const latest = rest.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a), first);
  const stationEnabled = parseBoolean(rows.find((r) => r.variable === 'Enabled')?.value);
  const available = parseBoolean(rows.find((r) => r.variable === 'Available')?.value);
  return {
    status: available === false ? 'not_supported' : 'supported',
    reason: available === false ? 'not_available' : 'reported',
    source: 'device_model',
    stationEnabled,
    checkedAt: latest.updatedAt.toISOString(),
  };
}

async function storedSupport(
  stationDbId: string,
  nowMs: number,
): Promise<WebPaymentSupportView | null> {
  const rows = await db
    .select({
      variable: stationConfigurations.variable,
      value: stationConfigurations.value,
      updatedAt: stationConfigurations.updatedAt,
    })
    .from(stationConfigurations)
    .where(
      and(
        eq(stationConfigurations.stationId, stationDbId),
        eq(stationConfigurations.component, COMPONENT),
        isNull(stationConfigurations.instance),
        isNull(stationConfigurations.evseId),
        eq(stationConfigurations.attributeType, 'Actual'),
        gte(stationConfigurations.updatedAt, new Date(nowMs - STORED_SUPPORT_MAX_AGE_MS)),
      ),
    );
  return supportFromStored(rows);
}

function unchecked(
  status: WebPaymentSupportStatus,
  reason: WebPaymentSupportReason,
): WebPaymentSupportView {
  return { status, reason, source: 'none', stationEnabled: null, checkedAt: null };
}

async function liveSupport(
  stationOcppId: string,
  log: Logger,
  nowMs: number,
): Promise<WebPaymentSupportView> {
  const result = await sendOcppCommandAndWait(stationOcppId, 'GetVariables', {
    getVariableData: SUPPORT_VARIABLES.map((variable) => ({
      component: { name: COMPONENT },
      variable: { name: variable },
    })),
  });
  const checkedAt = new Date(nowMs).toISOString();
  const live = (
    status: WebPaymentSupportStatus,
    reason: WebPaymentSupportReason,
    stationEnabled: boolean | null = null,
  ): WebPaymentSupportView => ({ status, reason, source: 'station', stationEnabled, checkedAt });

  if (result.error != null) {
    // A support check is advisory: report unknown, log, and let the operator retry.
    log.warn(
      { stationId: stationOcppId, error: result.error },
      'WebPaymentsCtrlr support check failed',
    );
    return live('unknown', result.error.startsWith('No response') ? 'timeout' : 'command_failed');
  }
  const results =
    (result.response?.['getVariableResult'] as
      | {
          attributeStatus?: string;
          attributeValue?: string;
          component?: { name?: string };
          variable?: { name?: string };
        }[]
      | undefined) ?? [];
  const byVariable = (name: string) =>
    results.find((r) => r.component?.name === COMPONENT && r.variable?.name === name);

  if (results.some((r) => r.attributeStatus === 'UnknownComponent')) {
    return live('not_supported', 'unknown_component');
  }
  const enabled = byVariable('Enabled');
  const stationEnabled =
    enabled?.attributeStatus === 'Accepted' ? parseBoolean(enabled.attributeValue) : null;
  const available = byVariable('Available');
  if (
    available?.attributeStatus === 'Accepted' &&
    parseBoolean(available.attributeValue) === false
  ) {
    return live('not_supported', 'not_available', stationEnabled);
  }
  const totpVersion = byVariable('TOTPVersion');
  if (totpVersion?.attributeStatus === 'Accepted') {
    return live('supported', 'reported', stationEnabled);
  }
  if (totpVersion?.attributeStatus === 'UnknownVariable') {
    // The component exists but lacks a variable C25 requires.
    return live('not_supported', 'unknown_variable', stationEnabled);
  }
  return live('unknown', 'unexpected_response', stationEnabled);
}

/**
 * Whether a station can show dynamic QR codes (WebPaymentsCtrlr, OCPP 2.1 C25).
 * Without `live` it answers from the stored device model (NotifyReport or an
 * earlier GetVariables, at most 24 hours old) and never contacts the station.
 * With `live` it asks an online OCPP 2.1 station with GetVariables; an offline
 * station falls back to the stored device model. A stored report can only show
 * support: only the station's UnknownComponent answer proves it is missing.
 */
export async function checkWebPaymentSupport(
  stationDbId: string,
  options: { live: boolean; log: Logger },
  nowMs: number = Date.now(),
): Promise<WebPaymentSupportView> {
  const station = await loadStation(stationDbId);
  if (station.ocppProtocol !== 'ocpp2.1') return unchecked('not_supported', 'ocpp_version');
  if (options.live && station.isOnline) {
    return liveSupport(station.stationId, options.log, nowMs);
  }
  const stored = await storedSupport(station.id, nowMs);
  if (stored != null) return stored;
  return station.isOnline ? unchecked('unknown', 'not_checked') : unchecked('unknown', 'offline');
}

/**
 * Decodes a scanned QR code URL against the URL template and checks its
 * time-based one-time password (C25.FR.07-09). Only a valid URL lets the EV
 * driver continue to the payment page (C25.FR.08, C25.FR.20).
 */
export async function validateQrCodeUrl(
  url: string,
  nowMs: number = Date.now(),
): Promise<QrValidationResult> {
  const parsedUrl = URL.parse(url);
  if (parsedUrl == null) return { valid: false, reason: 'malformed_url' };
  const pathname = parsedUrl.pathname;

  // The template ends in qr/{chargingstationid}/{evse}/{totp}/{version}; an
  // omitted parameter leaves an empty or missing path segment.
  const parts = pathname.replace(/\/+$/, '').split('/');
  const segments = parts.slice(-5);
  if (segments.length < 5 || segments[0] !== 'qr') {
    return { valid: false, reason: 'missing_parameter' };
  }
  let decoded: string[];
  try {
    decoded = segments.slice(1).map((s) => decodeURIComponent(s));
  } catch (err) {
    if (err instanceof URIError) return { valid: false, reason: 'malformed_url' };
    throw err;
  }
  const [chargingStationId = '', evse = '', totp = '', version = ''] = decoded;
  if (chargingStationId === '' || evse === '' || totp === '' || version === '') {
    return { valid: false, reason: 'missing_parameter' };
  }
  const evseId = /^[1-9]\d{0,4}$/.test(evse) ? Number(evse) : null;
  if (evseId == null) return { valid: false, reason: 'missing_parameter' };

  const [row] = await db
    .select({
      stationDbId: chargingStations.id,
      sharedSecretEnc: stationWebPaymentConfigs.sharedSecretEnc,
      validitySeconds: stationWebPaymentConfigs.validitySeconds,
      totpLength: stationWebPaymentConfigs.totpLength,
      totpVersion: stationWebPaymentConfigs.totpVersion,
    })
    .from(stationWebPaymentConfigs)
    .innerJoin(chargingStations, eq(chargingStations.id, stationWebPaymentConfigs.stationId))
    .where(eq(chargingStations.stationId, chargingStationId));
  if (row == null) return { valid: false, reason: 'unknown_station' };
  if (version !== row.totpVersion) return { valid: false, reason: 'unsupported_version' };

  const sharedSecret = decryptString(row.sharedSecretEnc, encryptionKey());
  const params = {
    sharedSecret,
    validitySeconds: row.validitySeconds,
    length: row.totpLength,
  };
  if (!verifyTotpV1(totp, params, nowMs)) return { valid: false, reason: 'invalid_totp' };

  const [evseRow] = await db
    .select({ id: evses.id })
    .from(evses)
    .where(and(eq(evses.stationId, row.stationDbId), eq(evses.evseId, evseId)));
  if (evseRow == null) return { valid: false, reason: 'unknown_evse' };

  return { valid: true, stationId: chargingStationId, evseId };
}
