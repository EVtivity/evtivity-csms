// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PNC16_VENDOR_ID } from './iso15118-pnc16.js';
import type { Permission } from './permissions.js';

/**
 * Station commands that need `stations:write` alone: the everyday station
 * operations (reset, availability, unlock, cache,
 * local list, display messages, message triggers that sign nothing) and the
 * reads. Every other command needs a feature permission on top, deny by
 * default (`ocppCommandRoutePermissions`).
 */
export const STATIONS_WRITE_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'Reset',
  'ChangeAvailability',
  'UnlockConnector',
  'ClearCache',
  'TriggerMessage',
  'ExtendedTriggerMessage',
  'SendLocalList',
  'GetLocalListVersion',
  'SetDisplayMessage',
  'ClearDisplayMessage',
  'GetDisplayMessages',
  'GetVariables',
  'GetConfiguration',
  'GetBaseReport',
  'GetReport',
  'GetMonitoringReport',
  'GetTransactionStatus',
  'GetPeriodicEventStream',
  'GetTariffs',
  'VatNumberValidation',
]);

/**
 * The permission a station security profile change needs on top of
 * `stations:write`: it sends SetNetworkProfile (2.x) or ChangeConfiguration
 * SecurityProfile (1.6), station configuration. Password changes and
 * credential rotation stay on `stations:write`, so operators can still
 * rotate station passwords. The API route check and the CSMS dialog use it.
 */
export const SECURITY_PROFILE_PERMISSION: Permission = 'settings.stationConfig:write';

/**
 * The feature permission a station command needs on top of `stations:write`:
 * the write permission of the page that owns the feature. The generic command
 * routes
 * (`POST /v1/ocpp/commands/{v21,v16}/<action>`) and the station routes that
 * send the same commands use this one map. A command in neither this map nor
 * `STATIONS_WRITE_ONLY_COMMANDS` needs `settings.stationConfig:write`.
 */
export const OCPP_COMMAND_EXTRA_PERMISSION: Readonly<Record<string, Permission | undefined>> = {
  // Firmware
  UpdateFirmware: 'settings.firmware:write',
  PublishFirmware: 'settings.firmware:write',
  UnpublishFirmware: 'settings.firmware:write',
  SignedUpdateFirmware: 'settings.firmware:write',
  // Station configuration, network profile, monitoring and vendor messages
  SetVariables: 'settings.stationConfig:write',
  ChangeConfiguration: 'settings.stationConfig:write',
  SetNetworkProfile: SECURITY_PROFILE_PERMISSION,
  SetVariableMonitoring: 'settings.stationConfig:write',
  ClearVariableMonitoring: 'settings.stationConfig:write',
  SetMonitoringBase: 'settings.stationConfig:write',
  SetMonitoringLevel: 'settings.stationConfig:write',
  OpenPeriodicEventStream: 'settings.stationConfig:write',
  AdjustPeriodicEventStream: 'settings.stationConfig:write',
  ClosePeriodicEventStream: 'settings.stationConfig:write',
  DataTransfer: 'settings.stationConfig:write',
  // Log uploads send the station's logs (security events, id tokens,
  // configuration) to a URL the caller picks, so they are station
  // configuration, not reads.
  GetLog: 'settings.stationConfig:write',
  GetDiagnostics: 'settings.stationConfig:write',
  // Certificates
  InstallCertificate: 'certificates:write',
  DeleteCertificate: 'certificates:write',
  CertificateSigned: 'certificates:write',
  GetInstalledCertificateIds: 'certificates:write',
  // Smart charging and grid signals
  SetChargingProfile: 'smartCharging:write',
  ClearChargingProfile: 'smartCharging:write',
  GetCompositeSchedule: 'smartCharging:write',
  GetChargingProfiles: 'smartCharging:write',
  UpdateDynamicSchedule: 'smartCharging:write',
  SetDERControl: 'smartCharging:write',
  ClearDERControl: 'smartCharging:write',
  GetDERControl: 'smartCharging:write',
  AFRRSignal: 'smartCharging:write',
  UsePriorityCharging: 'smartCharging:write',
  // Tariffs and costs
  SetDefaultTariff: 'pricing:write',
  ClearTariffs: 'pricing:write',
  ChangeTransactionTariff: 'pricing:write',
  CostUpdated: 'pricing:write',
  // Reservations
  ReserveNow: 'reservations:write',
  CancelReservation: 'reservations:write',
  // Sessions
  RequestStartTransaction: 'sessions:write',
  RequestStopTransaction: 'sessions:write',
  RemoteStartTransaction: 'sessions:write',
  RemoteStopTransaction: 'sessions:write',
  RequestBatterySwap: 'sessions:write',
  // Driver data held by the station
  CustomerInformation: 'drivers:write',
};

/** The permission a command needs on top of `stations:write`, or null for the allowlist. */
export function ocppCommandExtraPermission(action: string): Permission | null {
  if (STATIONS_WRITE_ONLY_COMMANDS.has(action)) return null;
  return OCPP_COMMAND_EXTRA_PERMISSION[action] ?? 'settings.stationConfig:write';
}

/**
 * Trigger messages that make a station send a certificate signing request
 * (1.6 ExtendedTriggerMessage, 2.1 TriggerMessage). They are certificate
 * actions, so they need `certificates:write`; any other trigger stays on
 * `stations:write`.
 */
const SIGN_CERTIFICATE_TRIGGERS = new Set([
  'SignChargePointCertificate',
  'SignChargingStationCertificate',
  'SignV2GCertificate',
  'SignV2G20Certificate',
  'SignCombinedCertificate',
]);

/** The permissions `authorize()` checks for a command route of this action. */
export function ocppCommandRoutePermissions(action: string): Permission[] {
  const extra = ocppCommandExtraPermission(action);
  return extra == null ? ['stations:write'] : ['stations:write', extra];
}

/**
 * The permission a command body needs beyond its route permissions, or null:
 * a trigger of a certificate signing request, and a DataTransfer of the OCPP
 * 1.6 Plug and Charge application note (vendorId `PNC16_VENDOR_ID`), which
 * carries certificate messages.
 */
export function ocppCommandPayloadPermission(
  action: string,
  payload: Record<string, unknown>,
): Permission | null {
  if (action === 'DataTransfer') {
    const vendorId = payload['vendorId'];
    return typeof vendorId === 'string' &&
      vendorId.trim().toLowerCase() === PNC16_VENDOR_ID.toLowerCase()
      ? 'certificates:write'
      : null;
  }
  if (action !== 'ExtendedTriggerMessage' && action !== 'TriggerMessage') return null;
  const requested = payload['requestedMessage'];
  return typeof requested === 'string' && SIGN_CERTIFICATE_TRIGGERS.has(requested)
    ? 'certificates:write'
    : null;
}
