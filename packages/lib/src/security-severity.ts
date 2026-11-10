// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Severity of OCPP station security events (SecurityEventNotification), stored in
 * `security_events.severity` on insert. Shared by the OCPP projection, the API
 * filters, the dashboard card and the simulator. Browser-safe (no imports).
 */

/** The five severities, worst first. */
export const SECURITY_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number];

/** Rank of a severity, 0 the worst (critical), 4 the mildest (info). */
export function securitySeverityRank(severity: SecuritySeverity): number {
  return SECURITY_SEVERITIES.indexOf(severity);
}

export function isSecuritySeverity(value: unknown): value is SecuritySeverity {
  return typeof value === 'string' && (SECURITY_SEVERITIES as readonly string[]).includes(value);
}

/**
 * OCPP 2.0.1 and 2.1 security events (the same 21 names in both: OCPP 2.0.1 part 2
 * appendices v1.5 and OCPP 2.1 part 2 appendices v2.1, security_events.csv).
 */
export const SECURITY_EVENT_TYPES_2X = [
  'FirmwareUpdated',
  'FailedToAuthenticateAtCsms',
  'CsmsFailedToAuthenticate',
  'SettingSystemTime',
  'StartupOfTheDevice',
  'ResetOrReboot',
  'SecurityLogWasCleared',
  'ReconfigurationOfSecurityParameters',
  'MemoryExhaustion',
  'InvalidMessages',
  'AttemptedReplayAttacks',
  'TamperDetectionActivated',
  'InvalidFirmwareSignature',
  'InvalidFirmwareSigningCertificate',
  'InvalidCsmsCertificate',
  'InvalidChargingStationCertificate',
  'DiscardedRenewedClientCertificate',
  'InvalidTLSVersion',
  'InvalidTLSCipherSuite',
  'MaintenanceLoginAccepted',
  'MaintenanceLoginFailed',
] as const;

/**
 * OCPP 1.6 security events (OCA white paper "Improved security for OCPP 1.6-J",
 * edition 4, 2026-02-05, section 8 "Security Events", in its order): the 2.x list
 * with the Central System and Charge Point names. Edition 2 had 18; edition 4 adds
 * MaintenanceLoginAccepted, MaintenanceLoginFailed and DiscardedRenewedClientCertificate.
 */
export const SECURITY_EVENT_TYPES_16 = [
  'FirmwareUpdated',
  'FailedToAuthenticateAtCentralSystem',
  'CentralSystemFailedToAuthenticate',
  'SettingSystemTime',
  'StartupOfTheDevice',
  'ResetOrReboot',
  'SecurityLogWasCleared',
  'ReconfigurationOfSecurityParameters',
  'MemoryExhaustion',
  'InvalidMessages',
  'AttemptedReplayAttacks',
  'TamperDetectionActivated',
  'InvalidFirmwareSignature',
  'InvalidFirmwareSigningCertificate',
  'InvalidCentralSystemCertificate',
  'InvalidChargePointCertificate',
  'InvalidTLSVersion',
  'InvalidTLSCipherSuite',
  'MaintenanceLoginAccepted',
  'MaintenanceLoginFailed',
  'DiscardedRenewedClientCertificate',
] as const;

/**
 * Vendor-style events outside the OCPP lists that chargers report as free-form
 * security event types (the `type` field is a string of up to 50 characters).
 * Both are physical tamper events, so critical like TamperDetectionActivated.
 */
export const CUSTOM_SECURITY_EVENT_TYPES = ['TiltDetected', 'CableCutDetected'] as const;

/**
 * The stored severity of every listed security event type. Migration
 * 0488_release_0_1_51.sql re-rates stored rows with the same pairs in SQL; a
 * database guard test fails when the two differ.
 */
export const SECURITY_SEVERITY_TABLE: Readonly<Record<string, SecuritySeverity>> = {
  // Critical: an immediate threat to the station or its firmware.
  TamperDetectionActivated: 'critical',
  // Vendor tamper sensors: the station was tilted or knocked over, a cable was cut.
  TiltDetected: 'critical',
  CableCutDetected: 'critical',
  SettingSystemTime: 'critical',
  InvalidFirmwareSignature: 'critical',
  // 2.0.1 and 2.1 and the 1.6 whitepaper spell it with an s; the singular form was the
  // original entry of this table and stays for rows stations already reported.
  AttemptedReplayAttacks: 'critical',
  AttemptedReplayAttack: 'critical',

  // High: authentication, certificate and transport security failures.
  FailedToAuthenticateAtCentralSystem: 'high',
  FailedToAuthenticateAtCsms: 'high',
  CentralSystemFailedToAuthenticate: 'high',
  CsmsFailedToAuthenticate: 'high',
  InvalidCentralSystemCertificate: 'high',
  InvalidCsmsCertificate: 'high',
  InvalidChargePointCertificate: 'high',
  InvalidChargingStationCertificate: 'high',
  // A firmware signing certificate that does not chain or has expired: the station refuses
  // the update before installing anything, like the other certificate failures (owner
  // decision 2026-11-10). It never trips security.autoDisableOnCritical; a bad signature
  // over the image stays critical.
  InvalidFirmwareSigningCertificate: 'high',
  // A TLS version or cipher suite below the security specification: a downgrade risk.
  InvalidTLSVersion: 'high',
  InvalidTLSCipherSuite: 'high',
  // A failed local maintenance login is a failed authentication.
  MaintenanceLoginFailed: 'high',
  // Clearing the security log can hide an earlier attack.
  SecurityLogWasCleared: 'high',

  // Medium: operational warnings that need a look but are not an attack by themselves.
  InvalidMessages: 'medium',
  MemoryExhaustion: 'medium',
  // Keys or the security profile changed: expected after a CSMS change, else a warning.
  ReconfigurationOfSecurityParameters: 'medium',
  // The station kept its old client certificate after a renewal failed to connect.
  DiscardedRenewedClientCertificate: 'medium',

  // Low: routine lifecycle.
  StartupOfTheDevice: 'low',
  ResetOrReboot: 'low',

  // Info: benign events.
  MaintenanceLoginAccepted: 'info',
  FirmwareUpdated: 'info',
};

/** The stored severity of a security event type; unknown types are info. */
export function getSecuritySeverity(eventType: string): SecuritySeverity {
  // Own keys only: a type such as "constructor" or "toString" is info, never an
  // Object.prototype member.
  return Object.hasOwn(SECURITY_SEVERITY_TABLE, eventType)
    ? (SECURITY_SEVERITY_TABLE[eventType] ?? 'info')
    : 'info';
}

/** The security event types a simulator station of a protocol offers (OCPP list, then custom). */
export function securityEventTypesFor(protocol: string | null | undefined): readonly string[] {
  const ocpp = protocol === 'ocpp1.6' ? SECURITY_EVENT_TYPES_16 : SECURITY_EVENT_TYPES_2X;
  return [...ocpp, ...CUSTOM_SECURITY_EVENT_TYPES];
}
