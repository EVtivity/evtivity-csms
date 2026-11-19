// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  OCPP_ID_TOKEN_TYPES,
  PORTAL_ID_TOKEN_TYPES,
  isOcppIdTokenType,
  driverTokenStatus,
  FLEET_USER_CARD_TYPES,
  isFleetUserCardType,
} from '../id-token-types.js';

describe('fleet user card types', () => {
  it('offers a fleet user an ordinary RFID card first and another RFID card, both portal types', () => {
    expect(FLEET_USER_CARD_TYPES).toEqual(['ISO14443', 'ISO15693']);
    for (const type of FLEET_USER_CARD_TYPES) expect(PORTAL_ID_TOKEN_TYPES).toContain(type);
  });

  it('refuses every other type', () => {
    for (const type of OCPP_ID_TOKEN_TYPES) {
      expect(isFleetUserCardType(type)).toBe(type === 'ISO14443' || type === 'ISO15693');
    }
  });
});

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

  it('leaves the CSMS-issued, system, payment terminal and vehicle id types out of the portal list', () => {
    expect([...PORTAL_ID_TOKEN_TYPES].sort()).toEqual(
      ['ISO14443', 'ISO15693', 'KeyCode', 'Local', 'eMAID'].sort(),
    );
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
