// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

const SEVERITY_MAP: Record<string, SecuritySeverity> = {
  // Critical - immediate threat
  TamperDetectionActivated: 'critical',
  SettingSystemTime: 'critical',
  InvalidFirmwareSignature: 'critical',
  AttemptedReplayAttack: 'critical',

  // High - authentication / certificate failures
  FailedToAuthenticateAtCentralSystem: 'high',
  InvalidCentralSystemCertificate: 'high',
  InvalidChargePointCertificate: 'high',

  // Medium - operational warnings
  InvalidMessages: 'medium',
  MemoryExhaustion: 'medium',

  // Low - routine lifecycle
  StartupOfTheDevice: 'low',
  ResetOrReboot: 'low',

  // Info - benign events (FirmwareUpdated, MaintenanceLoginAccepted, etc.)
  MaintenanceLoginAccepted: 'info',
  FirmwareUpdated: 'info',
};

export function getSecuritySeverity(eventType: string): SecuritySeverity {
  return SEVERITY_MAP[eventType] ?? 'info';
}
