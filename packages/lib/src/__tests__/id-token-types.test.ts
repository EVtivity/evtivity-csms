// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  OCPP_ID_TOKEN_TYPES,
  DRIVER_ID_TOKEN_TYPES,
  isOcppIdTokenType,
  driverTokenStatus,
} from '../id-token-types.js';

describe('OCPP IdToken types', () => {
  it('lists the 11 OCPP 2.1 IdTokenEnumStringType values', () => {
    expect([...OCPP_ID_TOKEN_TYPES].sort()).toEqual(
      [
        'Central',
        'DirectPayment',
        'EVCCID',
        'ISO14443',
        'ISO15693',
        'KeyCode',
        'Local',
        'MacAddress',
        'NoAuthorization',
        'VIN',
        'eMAID',
      ].sort(),
    );
  });

  it('leaves the CSMS-issued, system and payment terminal types out of the driver list', () => {
    expect(DRIVER_ID_TOKEN_TYPES).not.toContain('Central');
    expect(DRIVER_ID_TOKEN_TYPES).not.toContain('NoAuthorization');
    expect(DRIVER_ID_TOKEN_TYPES).not.toContain('DirectPayment');
    expect(DRIVER_ID_TOKEN_TYPES).toContain('ISO14443');
    expect(DRIVER_ID_TOKEN_TYPES).toContain('VIN');
  });

  it('checks a value against the list', () => {
    expect(isOcppIdTokenType('EVCCID')).toBe(true);
    expect(isOcppIdTokenType('iso14443')).toBe(false);
    expect(isOcppIdTokenType('MasterPass')).toBe(false);
  });
});

describe('driverTokenStatus', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const past = '2026-10-01T00:00:00Z';
  const future = '2027-01-01T00:00:00Z';

  it('is active for an active token without expiry or with a future one', () => {
    expect(driverTokenStatus({ isActive: true }, now)).toBe('active');
    expect(driverTokenStatus({ isActive: true, expiresAt: future }, now)).toBe('active');
  });

  it('is expired for an active token past its expiry', () => {
    expect(driverTokenStatus({ isActive: true, expiresAt: past }, now)).toBe('expired');
  });

  it('puts inactive and revoked before expiry, as the authorize check does', () => {
    expect(driverTokenStatus({ isActive: false, expiresAt: past }, now)).toBe('inactive');
    expect(driverTokenStatus({ isActive: false, revokedAt: past, expiresAt: past }, now)).toBe(
      'revoked',
    );
  });
});
