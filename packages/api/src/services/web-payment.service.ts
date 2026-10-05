// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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

async function setWebPaymentVariables(
  stationOcppId: string,
  values: Array<[string, string]>,
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

  const sharedSecret = crypto.randomBytes(24).toString('base64url');
  const urlTemplate = qrUrlTemplate();
  await setWebPaymentVariables(station.stationId, [
    ['URLTemplate', urlTemplate],
    ['TOTPVersion', TOTP_VERSION_V1],
    ['ValidityTime', String(settings.validitySeconds)],
    ['Length', String(settings.totpLength)],
    ['SharedSecret', sharedSecret],
    ['Enabled', 'true'],
  ]);

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

/**
 * Decodes a scanned QR code URL against the URL template and checks its
 * time-based one-time password (C25.FR.07-09). Only a valid URL lets the EV
 * driver continue to the payment page (C25.FR.08, C25.FR.20).
 */
export async function validateQrCodeUrl(
  url: string,
  nowMs: number = Date.now(),
): Promise<QrValidationResult> {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return { valid: false, reason: 'malformed_url' };
  }

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
  } catch {
    return { valid: false, reason: 'malformed_url' };
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
