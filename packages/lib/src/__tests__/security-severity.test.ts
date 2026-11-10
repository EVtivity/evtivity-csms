// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CUSTOM_SECURITY_EVENT_TYPES,
  SECURITY_EVENT_TYPES_16,
  SECURITY_EVENT_TYPES_2X,
  SECURITY_SEVERITIES,
  getSecuritySeverity,
  isSecuritySeverity,
  securityEventTypesFor,
  securitySeverityRank,
} from '../security-severity.js';

const EXPECTED: Record<string, string> = {
  // 2.0.1 and 2.1
  FirmwareUpdated: 'info',
  FailedToAuthenticateAtCsms: 'high',
  CsmsFailedToAuthenticate: 'high',
  SettingSystemTime: 'critical',
  StartupOfTheDevice: 'low',
  ResetOrReboot: 'low',
  SecurityLogWasCleared: 'high',
  ReconfigurationOfSecurityParameters: 'medium',
  MemoryExhaustion: 'medium',
  InvalidMessages: 'medium',
  AttemptedReplayAttacks: 'critical',
  TamperDetectionActivated: 'critical',
  InvalidFirmwareSignature: 'critical',
  InvalidFirmwareSigningCertificate: 'high',
  InvalidCsmsCertificate: 'high',
  InvalidChargingStationCertificate: 'high',
  DiscardedRenewedClientCertificate: 'medium',
  InvalidTLSVersion: 'high',
  InvalidTLSCipherSuite: 'high',
  MaintenanceLoginAccepted: 'info',
  MaintenanceLoginFailed: 'high',
  // 1.6 names
  FailedToAuthenticateAtCentralSystem: 'high',
  CentralSystemFailedToAuthenticate: 'high',
  InvalidCentralSystemCertificate: 'high',
  InvalidChargePointCertificate: 'high',
  // the singular form kept for stored rows
  AttemptedReplayAttack: 'critical',
  // custom
  TiltDetected: 'critical',
  CableCutDetected: 'critical',
};

describe('security severity', () => {
  it('orders the severities worst first', () => {
    expect(SECURITY_SEVERITIES).toEqual(['critical', 'high', 'medium', 'low', 'info']);
    expect(securitySeverityRank('critical')).toBe(0);
    expect(securitySeverityRank('info')).toBe(4);
    expect(securitySeverityRank('high')).toBeLessThan(securitySeverityRank('medium'));
  });

  it('guards severity values', () => {
    expect(isSecuritySeverity('high')).toBe(true);
    expect(isSecuritySeverity('severe')).toBe(false);
    expect(isSecuritySeverity(3)).toBe(false);
  });

  it.each(Object.entries(EXPECTED))('rates %s as %s', (type, severity) => {
    expect(getSecuritySeverity(type)).toBe(severity);
  });

  it('rates every listed type explicitly', () => {
    const listed = [
      ...SECURITY_EVENT_TYPES_2X,
      ...SECURITY_EVENT_TYPES_16,
      ...CUSTOM_SECURITY_EVENT_TYPES,
    ];
    for (const type of listed) expect(EXPECTED[type], type).toBeDefined();
  });

  it('rates an unknown type as info', () => {
    expect(getSecuritySeverity('SomethingElse')).toBe('info');
    expect(getSecuritySeverity('')).toBe('info');
    // Own keys only, never an Object.prototype member.
    expect(getSecuritySeverity('constructor')).toBe('info');
    expect(getSecuritySeverity('toString')).toBe('info');
  });

  it('lists the 2.0.1 and 2.1 events of the specification appendices', () => {
    for (const path of [
      'docs/ocpp/OCPP-2.1/Appendices_CSV_v2.1/security_events.csv',
      'docs/ocpp/OCPP-2.0.1/Appendices_CSV_v1.5/security_events.csv',
    ]) {
      const file = resolve(__dirname, '../../../..', path);
      // The specification files are private-only.
      if (!existsSync(file)) continue;
      const names = readFileSync(file, 'utf8')
        .split('\n')
        .slice(1)
        .map((line) => line.split(';')[0]?.trim() ?? '')
        .filter((name) => name !== '');
      expect([...SECURITY_EVENT_TYPES_2X].sort()).toEqual([...names].sort());
    }
    expect(SECURITY_EVENT_TYPES_2X).toHaveLength(21);
  });

  it('lists the 1.6 events of the security white paper edition 4, section 8, in its order', () => {
    expect(SECURITY_EVENT_TYPES_16).toEqual([
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
    ]);
  });

  it('rates a firmware signing certificate failure high, a bad firmware signature critical', () => {
    expect(getSecuritySeverity('InvalidFirmwareSigningCertificate')).toBe('high');
    expect(getSecuritySeverity('InvalidFirmwareSignature')).toBe('critical');
  });

  it('offers the protocol list plus the custom types', () => {
    expect(securityEventTypesFor('ocpp1.6')).toContain('InvalidChargePointCertificate');
    expect(securityEventTypesFor('ocpp1.6')).not.toContain('InvalidCsmsCertificate');
    expect(securityEventTypesFor('ocpp2.0.1')).toContain('InvalidCsmsCertificate');
    expect(securityEventTypesFor('ocpp2.1')).toContain('TiltDetected');
    expect(securityEventTypesFor('ocpp1.6')).toContain('TiltDetected');
  });
});
