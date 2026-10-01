// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  STATION_PASSWORD_CHARSET,
  stationPasswordRules,
  validateStationPassword,
  generateStationPassword,
  toAuthorizationKeyHex,
} from '../station-password.js';

describe('stationPasswordRules', () => {
  it('uses 16-20 characters for OCPP 1.6 (AuthorizationKey is 16-20 bytes)', () => {
    expect(stationPasswordRules('ocpp1.6')).toEqual({ min: 16, max: 20 });
  });

  it('uses 16-40 characters for OCPP 2.1 (A00.FR.205)', () => {
    expect(stationPasswordRules('ocpp2.1')).toEqual({ min: 16, max: 40 });
  });
});

describe('validateStationPassword', () => {
  it('accepts a passwordString within the length range', () => {
    expect(validateStationPassword('abcDEF123*-_=:+|@.', 'ocpp2.1')).toBeNull();
    expect(validateStationPassword('abcdefghijklmnop', 'ocpp1.6')).toBeNull();
  });

  it('rejects a password that is too short or too long for the protocol', () => {
    expect(validateStationPassword('short', 'ocpp2.1')).toBe('tooShort');
    expect(validateStationPassword('a'.repeat(21), 'ocpp1.6')).toBe('tooLong');
    expect(validateStationPassword('a'.repeat(41), 'ocpp2.1')).toBe('tooLong');
    expect(validateStationPassword('a'.repeat(40), 'ocpp2.1')).toBeNull();
  });

  it('rejects characters outside the OCPP passwordString set', () => {
    expect(validateStationPassword('abcdefghijklmnop!', 'ocpp2.1')).toBe('invalidCharacters');
    expect(validateStationPassword('abcdefghijklmnop ', 'ocpp2.1')).toBe('invalidCharacters');
    expect(validateStationPassword('abcdefghijklmnöp', 'ocpp2.1')).toBe('invalidCharacters');
  });
});

describe('generateStationPassword', () => {
  it('returns 20 characters from the passwordString set, valid for both protocols', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateStationPassword();
      expect(pw).toHaveLength(20);
      expect(pw.split('').every((c) => STATION_PASSWORD_CHARSET.includes(c))).toBe(true);
      expect(validateStationPassword(pw, 'ocpp1.6')).toBeNull();
      expect(validateStationPassword(pw, 'ocpp2.1')).toBeNull();
    }
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateStationPassword()));
    expect(seen.size).toBe(100);
  });
});

describe('toAuthorizationKeyHex', () => {
  it('hex-encodes the password bytes (OCTT TC_073 example)', () => {
    expect(toAuthorizationKeyHex('OCA_OCTT_admin_test')).toBe(
      '4F43415F4F4354545F61646D696E5F74657374',
    );
  });
});
