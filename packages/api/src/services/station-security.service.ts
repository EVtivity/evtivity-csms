// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { hash } from 'argon2';
import { eq } from 'drizzle-orm';
import {
  AppError,
  ValidationError,
  generateStationPassword,
  validateStationPassword,
} from '@evtivity/lib';
import type { StationOcppProtocol } from '@evtivity/lib';
import {
  db,
  chargingStations,
  connectionLogs,
  stationAuditLog,
  writeAudit,
} from '@evtivity/database';
import { sendOcppCommandAndWait } from '@evtivity/services/ocpp-command';
import type { CommandResult } from '@evtivity/services/ocpp-command';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import { config } from '../lib/config.js';
import { syncCssStationSecurity } from '../lib/css-pairing.js';

// The only writer of a station's Basic Auth password and security profile.
// Credentials switch only after the station accepts them (OCPP 2.1 A01.FR.03),
// and an upgrade stays pending until the station connects with the new profile
// (A05), so a failed change never locks a station out.

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface SecurityChangeContext {
  actor: AuditActorInfo;
  log: Logger;
}

interface StationRow {
  id: string;
  stationId: string;
  ocppProtocol: string | null;
  securityProfile: number;
  pendingSecurityProfile: number | null;
  isOnline: boolean;
  hasPassword: boolean;
}

const PASSWORD_ERRORS: Record<string, string> = {
  tooShort: 'Password is too short',
  tooLong: 'Password is too long',
  invalidCharacters: 'Password contains characters OCPP does not allow',
};

async function loadStation(stationDbId: string): Promise<StationRow> {
  const [row] = await db
    .select({
      id: chargingStations.id,
      stationId: chargingStations.stationId,
      ocppProtocol: chargingStations.ocppProtocol,
      securityProfile: chargingStations.securityProfile,
      pendingSecurityProfile: chargingStations.pendingSecurityProfile,
      isOnline: chargingStations.isOnline,
      basicAuthPasswordHash: chargingStations.basicAuthPasswordHash,
    })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationDbId));
  if (row == null) throw new AppError('Station not found', 404, 'STATION_NOT_FOUND');
  const { basicAuthPasswordHash, ...rest } = row;
  return { ...rest, hasPassword: basicAuthPasswordHash != null };
}

function protocolOf(station: StationRow): StationOcppProtocol {
  return station.ocppProtocol === 'ocpp1.6' ? 'ocpp1.6' : 'ocpp2.1';
}

function assertValidPassword(password: string, station: StationRow): void {
  assertValidPasswordFor(password, protocolOf(station));
}

function assertValidPasswordFor(password: string, protocol: StationOcppProtocol): void {
  const error = validateStationPassword(password, protocol);
  if (error != null) {
    const max = protocol === 'ocpp1.6' ? 20 : 40;
    throw new ValidationError(
      `${PASSWORD_ERRORS[error] ?? 'Invalid password'} (16-${String(max)} characters, letters, digits and * - _ = : + | @ .)`,
    );
  }
}

function commandError(action: string, result: CommandResult): AppError {
  return new AppError(
    `${action} failed: ${result.error ?? 'no response'}`,
    502,
    'OCPP_COMMAND_FAILED',
  );
}

function rejected(action: string, status: string | undefined): AppError {
  return new AppError(
    `The station did not accept ${action} (${status ?? 'no status'})`,
    502,
    'STATION_SECURITY_CHANGE_REJECTED',
  );
}

// A SetVariables reply: 2.1 carries a per-variable attributeStatus, the 1.6
// ChangeConfiguration it is translated to carries a status.
function setVariableStatus(response: Record<string, unknown> | undefined): string | undefined {
  const results = response?.['setVariableResult'] as { attributeStatus?: string }[] | undefined;
  return results?.[0]?.attributeStatus ?? (response?.['status'] as string | undefined);
}

async function setVariable(
  station: StationRow,
  component: string,
  variable: string,
  value: string,
  accept: string[] = ['Accepted'],
): Promise<void> {
  const result = await sendOcppCommandAndWait(station.stationId, 'SetVariables', {
    setVariableData: [
      { component: { name: component }, variable: { name: variable }, attributeValue: value },
    ],
  });
  if (result.error != null) throw commandError(`${component}.${variable}`, result);
  const status = setVariableStatus(result.response);
  if (status == null || !accept.includes(status))
    throw rejected(`${component}.${variable}`, status);
}

async function logConnectionEvent(
  station: StationRow,
  event: string,
  metadata: Record<string, unknown>,
  ctx: SecurityChangeContext,
): Promise<void> {
  try {
    await db.insert(connectionLogs).values({ stationId: station.id, event, metadata });
  } catch (err) {
    ctx.log.warn({ err, stationId: station.id }, 'Failed to write connection_logs row');
  }
}

async function audit(
  station: StationRow,
  notes: string,
  ctx: SecurityChangeContext,
): Promise<void> {
  await writeAudit(
    { table: stationAuditLog, idColumn: 'station_id' },
    {
      entityId: station.id,
      entityIdSnapshot: station.id,
      action: 'updated',
      ...ctx.actor,
      notes,
    },
    db,
    ctx.log,
  );
}

async function storePasswordHash(station: StationRow, password: string): Promise<void> {
  await db
    .update(chargingStations)
    .set({ basicAuthPasswordHash: await hash(password), updatedAt: new Date() })
    .where(eq(chargingStations.id, station.id));
}

async function sendPassword(station: StationRow, password: string): Promise<void> {
  // 2.1 SetVariables(SecurityCtrlr.BasicAuthPassword); the OCPP server sends
  // ChangeConfiguration(AuthorizationKey, hex) to a 1.6 station.
  await setVariable(station, 'SecurityCtrlr', 'BasicAuthPassword', password);
}

export interface PasswordChangeResult {
  // 'station': the station accepted it. 'stored': saved for a station that is
  // offline or does not use a password yet; configure it on the station.
  appliedTo: 'station' | 'stored';
}

export async function changeStationPassword(
  stationDbId: string,
  password: string,
  ctx: SecurityChangeContext,
): Promise<PasswordChangeResult> {
  const station = await loadStation(stationDbId);
  assertValidPassword(password, station);
  const usesPassword = station.securityProfile === 1 || station.securityProfile === 2;
  const appliedTo = station.isOnline && usesPassword ? 'station' : 'stored';
  if (appliedTo === 'station') await sendPassword(station, password);
  await storePasswordHash(station, password);
  if (!station.isOnline) {
    await syncCssStationSecurity(station.stationId, {
      securityProfile: station.securityProfile,
      password,
    });
  }
  await logConnectionEvent(station, 'password_changed', { changedBy: 'operator', appliedTo }, ctx);
  await audit(station, `Station credentials set (${appliedTo})`, ctx);
  return { appliedTo };
}

export async function rotateStationPassword(
  stationDbId: string,
  ctx: SecurityChangeContext,
): Promise<void> {
  const station = await loadStation(stationDbId);
  if (station.securityProfile !== 1 && station.securityProfile !== 2) {
    throw new AppError(
      'Credential rotation only applies to security profiles 1 and 2',
      400,
      'ROTATION_NOT_APPLICABLE',
    );
  }
  if (!station.isOnline) throw new AppError('Station is offline', 409, 'STATION_OFFLINE');
  const password = generateStationPassword();
  await sendPassword(station, password);
  await storePasswordHash(station, password);
  await logConnectionEvent(station, 'credentials_rotated', { rotatedBy: 'operator' }, ctx);
  await audit(station, 'Station credentials rotated', ctx);
}

export interface InitialStationPassword {
  // Plaintext for the paired simulator row (css_stations.password), null when
  // the station uses no password.
  password: string | null;
  // Value for charging_stations.basic_auth_password_hash on insert.
  passwordHash: string | null;
}

/**
 * Credentials for a station row that does not exist yet. A given password is
 * validated for the protocol; profiles 1 and 2 (Basic Auth) without one get a
 * generated password, so a simulator created with it can connect at once.
 * Profiles 0 and 3 use no password unless one is given.
 */
export async function initialStationPassword(opts: {
  ocppProtocol: StationOcppProtocol;
  securityProfile: number;
  password?: string | undefined;
}): Promise<InitialStationPassword> {
  const usesPassword = opts.securityProfile === 1 || opts.securityProfile === 2;
  const password = opts.password ?? (usesPassword ? generateStationPassword() : null);
  if (password == null) return { password: null, passwordHash: null };
  assertValidPasswordFor(password, opts.ocppProtocol);
  return { password, passwordHash: await hash(password) };
}

export interface ProfileChangeResult {
  // 'updated': saved directly (offline station). 'pending': sent to the
  // station, applied when it connects with the new profile. 'unchanged'.
  status: 'updated' | 'pending' | 'unchanged';
}

async function setPendingProfile(station: StationRow, profile: number | null): Promise<void> {
  await db
    .update(chargingStations)
    .set({ pendingSecurityProfile: profile, updatedAt: new Date() })
    .where(eq(chargingStations.id, station.id));
}

export async function changeSecurityProfile(
  stationDbId: string,
  profile: number,
  password: string | undefined,
  ctx: SecurityChangeContext,
): Promise<ProfileChangeResult> {
  const station = await loadStation(stationDbId);
  const needsPassword = profile === 1 || profile === 2;
  if (password != null) assertValidPassword(password, station);

  if (profile === station.securityProfile) {
    if (password != null) await changeStationPassword(stationDbId, password, ctx);
    if (station.pendingSecurityProfile == null) return { status: 'unchanged' };
    // Saving the current profile cancels a pending upgrade.
    await setPendingProfile(station, null);
    await audit(
      station,
      `Security profile upgrade to ${String(station.pendingSecurityProfile)} cancelled`,
      ctx,
    );
    return { status: 'updated' };
  }

  if (needsPassword && password == null && !station.hasPassword) {
    throw new AppError(
      'Password required when moving to security profile 1 or 2',
      400,
      'PASSWORD_REQUIRED',
    );
  }

  if (!station.isOnline) {
    // Provisioning: the station is configured on site to match.
    await db
      .update(chargingStations)
      .set({
        securityProfile: profile,
        pendingSecurityProfile: null,
        ...(password != null
          ? { basicAuthPasswordHash: await hash(password) }
          : needsPassword
            ? {}
            : { basicAuthPasswordHash: null }),
        updatedAt: new Date(),
      })
      .where(eq(chargingStations.id, station.id));
    await syncCssStationSecurity(station.stationId, { securityProfile: profile, password });
    await audit(station, `Security profile set to ${String(profile)} (station offline)`, ctx);
    return { status: 'updated' };
  }

  // OCPP never lowers a connected station's profile (2.1 A05 remark, A05.FR.08-10).
  if (profile < station.securityProfile) {
    throw new AppError(
      'A connected station cannot be moved to a lower security profile over OCPP',
      400,
      'SECURITY_PROFILE_DOWNGRADE',
    );
  }

  // A station that already uses a password keeps authenticating with it until
  // the upgrade completes, so a new password is applied first, on its own.
  const currentUsesPassword = station.securityProfile === 1 || station.securityProfile === 2;
  if (password != null && currentUsesPassword && needsPassword) {
    await changeStationPassword(stationDbId, password, ctx);
  }
  const passwordForUpgrade = needsPassword && !currentUsesPassword ? password : undefined;

  if (protocolOf(station) === 'ocpp1.6') {
    await upgrade16(station, profile, passwordForUpgrade);
  } else {
    await upgrade21(station, profile, passwordForUpgrade);
  }
  if (passwordForUpgrade != null) await storePasswordHash(station, passwordForUpgrade);
  await setPendingProfile(station, profile);
  await logConnectionEvent(
    station,
    'security_profile_change_sent',
    { fromProfile: station.securityProfile, toProfile: profile },
    ctx,
  );
  await audit(station, `Security profile upgrade to ${String(profile)} sent to the station`, ctx);
  return { status: 'pending' };
}

// OCPP 1.6 Security Whitepaper: set AuthorizationKey when needed, then
// ChangeConfiguration(SecurityProfile), then a Hard reset (OCTT 1.6 security tests).
async function upgrade16(
  station: StationRow,
  profile: number,
  password: string | undefined,
): Promise<void> {
  if (password != null) await sendPassword(station, password);
  await setVariable(station, 'SecurityCtrlr', 'SecurityProfile', String(profile));
  await reset(station, 'Immediate');
}

async function reset(station: StationRow, type: 'Immediate' | 'OnIdle'): Promise<void> {
  const result = await sendOcppCommandAndWait(station.stationId, 'Reset', { type });
  if (result.error != null) throw commandError('Reset', result);
  const status = result.response?.['status'] as string | undefined;
  if (status !== 'Accepted' && status !== 'Scheduled') throw rejected('Reset', status);
}

async function getVariables(
  station: StationRow,
  items: { component: string; instance?: string; variable: string }[],
): Promise<(string | undefined)[]> {
  const result = await sendOcppCommandAndWait(station.stationId, 'GetVariables', {
    getVariableData: items.map((i) => ({
      component: { name: i.component, ...(i.instance != null ? { instance: i.instance } : {}) },
      variable: { name: i.variable },
    })),
  });
  if (result.error != null) throw commandError('GetVariables', result);
  const results = (result.response?.['getVariableResult'] ?? []) as {
    attributeStatus?: string;
    attributeValue?: string;
    component?: { name?: string; instance?: string };
    variable?: { name?: string };
  }[];
  return items.map((item) => {
    const match = results.find(
      (r) =>
        r.component?.name === item.component &&
        r.variable?.name === item.variable &&
        (item.instance == null || r.component.instance === item.instance),
    );
    return match?.attributeStatus === 'Accepted' ? match.attributeValue : undefined;
  });
}

// OCPP 2.1 A05: SetNetworkProfile into a free slot, put it first in
// NetworkConfigurationPriority, then Reset(OnIdle). The station connects with
// the new profile and drops the lower ones (A05.FR.06).
async function upgrade21(
  station: StationRow,
  profile: number,
  password: string | undefined,
): Promise<void> {
  const [priority] = await getVariables(station, [
    { component: 'OCPPCommCtrlr', variable: 'NetworkConfigurationPriority' },
  ]);
  const slots = (priority ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const activeSlot = slots[0];
  if (activeSlot == null) {
    throw new AppError(
      'The station did not report NetworkConfigurationPriority',
      502,
      'STATION_SECURITY_CHANGE_REJECTED',
    );
  }
  const [currentUrl, ocppInterface, messageTimeout] = await getVariables(station, [
    { component: 'NetworkConfiguration', instance: activeSlot, variable: 'OcppCsmsUrl' },
    { component: 'NetworkConfiguration', instance: activeSlot, variable: 'OcppInterface' },
    { component: 'NetworkConfiguration', instance: activeSlot, variable: 'MessageTimeout' },
  ]);

  // Profiles 2 and 3 need TLS. Moving from plain WebSocket to TLS needs the
  // public wss:// address; otherwise the station keeps its current address.
  const needsTlsUrl = profile >= 2 && station.securityProfile < 2;
  const ocppCsmsUrl = needsTlsUrl ? config.OCPP_STATION_TLS_URL : currentUrl;
  if (ocppCsmsUrl == null || ocppCsmsUrl === '') {
    throw needsTlsUrl
      ? new AppError(
          'OCPP_STATION_TLS_URL is not configured, so the station cannot be moved to TLS',
          400,
          'STATION_TLS_URL_NOT_CONFIGURED',
        )
      : new AppError(
          'The station did not report its CSMS URL',
          502,
          'STATION_SECURITY_CHANGE_REJECTED',
        );
  }

  let newSlot = 1;
  while (slots.includes(String(newSlot))) newSlot++;
  const result = await sendOcppCommandAndWait(station.stationId, 'SetNetworkProfile', {
    configurationSlot: newSlot,
    connectionData: {
      // Ignored by 2.1 stations; kept for 2.0.1 stations and OCTT TC_A_19.
      ocppVersion: 'OCPP20',
      ocppInterface: ocppInterface ?? 'Wired0',
      ocppTransport: 'JSON',
      messageTimeout: Number(messageTimeout ?? 30) || 30,
      ocppCsmsUrl,
      securityProfile: profile,
      ...(password != null ? { basicAuthPassword: password } : {}),
    },
  });
  if (result.error != null) throw commandError('SetNetworkProfile', result);
  const status = result.response?.['status'] as string | undefined;
  if (status !== 'Accepted') throw rejected('SetNetworkProfile', status);

  // Rejected here when the station lacks a CSMS root certificate (profiles 2-3)
  // or a station certificate (profile 3), A05.FR.02-03.
  await setVariable(
    station,
    'OCPPCommCtrlr',
    'NetworkConfigurationPriority',
    [String(newSlot), ...slots].join(','),
    ['Accepted', 'RebootRequired'],
  );
  await reset(station, 'OnIdle');
}
