// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  formatVehicleId,
  normalizeEvccid,
  normalizeMacAddress,
  normalizeVin,
  stripVehicleIdPrefix,
  vehicleIdColumn,
  vehicleIdFromAdditionalInfo,
  vehicleIdFromIdTag,
  vehicleIdFromIdToken,
  vehicleIdFromTypedToken,
  canonicalTokenValue,
  isVehicleShapedTokenValue,
  stationTokenLookup,
  tokenVehicleIdCandidates,
} from '../vehicle-id.js';

describe('normalizeMacAddress', () => {
  it.each([
    ['92d50a693f80', '92D50A693F80'],
    ['92:D5:0A:69:3F:80', '92D50A693F80'],
    ['92-d5-0a-69-3f-80', '92D50A693F80'],
    ['92d5.0a69.3f80', '92D50A693F80'],
    [' 92D50A693F80 ', '92D50A693F80'],
  ])('normalizes %s', (raw, expected) => {
    expect(normalizeMacAddress(raw)).toBe(expected);
  });

  it.each(['92D50A693F', '92D50A693F80AB', '92:D5-0A:69:3F:80', 'GGD50A693F80', ''])(
    'refuses %s',
    (raw) => {
      expect(normalizeMacAddress(raw)).toBeNull();
    },
  );
});

describe('normalizeVin', () => {
  it('uppercases a VIN', () => {
    expect(normalizeVin(' 5yj3e1ea7kf317000 ')).toBe('5YJ3E1EA7KF317000');
  });

  it.each(['5YJ3E1EA7KF31700', '5YJ3E1EA7KF3170001', '5YJ3E1EA7KF31700O', 'IYJ3E1EA7KF317000'])(
    'refuses %s',
    (raw) => {
      expect(normalizeVin(raw)).toBeNull();
    },
  );
});

describe('normalizeEvccid', () => {
  it('keeps the MAC address form', () => {
    expect(normalizeEvccid('92:d5:0a:69:3f:80')).toBe('92D50A693F80');
  });

  it('uppercases an ISO 15118-20 identifier', () => {
    expect(normalizeEvccid('evcc-1234')).toBe('EVCC-1234');
  });

  it('refuses empty, whitespace and over-long values', () => {
    expect(normalizeEvccid('  ')).toBeNull();
    expect(normalizeEvccid('a b')).toBeNull();
    expect(normalizeEvccid('A'.repeat(256))).toBeNull();
  });
});

describe('vehicleIdFromIdToken', () => {
  it('reads the vehicle types', () => {
    expect(vehicleIdFromIdToken('MacAddress', '92:d5:0a:69:3f:80')).toEqual({
      value: '92D50A693F80',
      type: 'MacAddress',
      source: 'id_token',
    });
    expect(vehicleIdFromIdToken('VIN', '5yj3e1ea7kf317000')?.value).toBe('5YJ3E1EA7KF317000');
    expect(vehicleIdFromIdToken('EVCCID', '92d50a693f80')?.type).toBe('EVCCID');
  });

  it('ignores other types and values that do not fit the type', () => {
    expect(vehicleIdFromIdToken('ISO14443', '92D50A693F80')).toBeNull();
    expect(vehicleIdFromIdToken('MacAddress', 'not-a-mac')).toBeNull();
    expect(vehicleIdFromIdToken(null, '92D50A693F80')).toBeNull();
  });
});

describe('vehicleIdFromAdditionalInfo', () => {
  it('reads the EVCCID entry (Q01.FR.02)', () => {
    expect(
      vehicleIdFromAdditionalInfo([
        { additionalIdToken: 'VDE-AR-E-2532-100', type: 'ISO14443SubType' },
        { additionalIdToken: '92d50a693f80', type: 'EVCCID' },
      ]),
    ).toEqual({ value: '92D50A693F80', type: 'EVCCID', source: 'additional_info' });
  });

  it('matches custom VIN and MacAddress types case insensitively', () => {
    expect(
      vehicleIdFromAdditionalInfo([{ additionalIdToken: '5YJ3E1EA7KF317000', type: 'vin' }])?.type,
    ).toBe('VIN');
  });

  it('returns null without a vehicle entry', () => {
    expect(vehicleIdFromAdditionalInfo(undefined)).toBeNull();
    expect(vehicleIdFromAdditionalInfo([{ additionalIdToken: 'x', type: 'Other' }])).toBeNull();
  });
});

describe('vehicleIdFromIdTag (OCPP 1.6)', () => {
  it('strips the VID: prefix in any case', () => {
    expect(stripVehicleIdPrefix('vid:92D50A693F80')).toEqual({
      value: '92D50A693F80',
      prefixed: true,
    });
    expect(vehicleIdFromIdTag('VID:92D50A693F80')).toEqual({
      value: '92D50A693F80',
      type: 'MacAddress',
      source: 'id_tag',
    });
  });

  it('detects a MAC address and a VIN without a prefix', () => {
    expect(vehicleIdFromIdTag('92:D5:0A:69:3F:80')?.type).toBe('MacAddress');
    expect(vehicleIdFromIdTag('5YJ3E1EA7KF317000')?.type).toBe('VIN');
  });

  it('leaves card UIDs and other tags alone', () => {
    expect(vehicleIdFromIdTag('04A2B3C4')).toBeNull();
    expect(vehicleIdFromIdTag('04A2B3C4D5E6F7')).toBeNull();
    expect(vehicleIdFromIdTag('drv_abc123')).toBeNull();
    expect(vehicleIdFromIdTag('VID:nothing')).toBeNull();
  });
});

describe('vehicleIdFromTypedToken', () => {
  it('prefers the token itself, then additionalInfo', () => {
    expect(
      vehicleIdFromTypedToken({
        idToken: '04A2B3C4',
        type: 'ISO14443',
        additionalInfo: [{ additionalIdToken: '92D50A693F80', type: 'EVCCID' }],
      })?.source,
    ).toBe('additional_info');
    expect(vehicleIdFromTypedToken({ idToken: '92D50A693F80', type: 'MacAddress' })?.source).toBe(
      'id_token',
    );
  });
});

describe('helpers', () => {
  it('maps types to the vehicle column', () => {
    expect(vehicleIdColumn('VIN')).toBe('vin');
    expect(vehicleIdColumn('EVCCID')).toBe('evccid');
    expect(vehicleIdColumn('MacAddress')).toBe('evccid');
  });

  it('formats a MAC address with colons and leaves other ids as they are', () => {
    expect(formatVehicleId('92D50A693F80')).toBe('92:D5:0A:69:3F:80');
    expect(formatVehicleId('5YJ3E1EA7KF317000')).toBe('5YJ3E1EA7KF317000');
  });
});

describe('canonical token values', () => {
  it.each([
    ['92d50a693f80', '92D50A693F80'],
    ['92-D5-0A-69-3F-80', '92D50A693F80'],
    ['vid:92:d5:0a:69:3f:80', '92D50A693F80'],
    ['92d5.0a69.3f80', '92D50A693F80'],
    ['5yj3e1ea7kf317000', '5YJ3E1EA7KF317000'],
    ['VID:5YJ3E1EA7KF317000', '5YJ3E1EA7KF317000'],
    ['04a1b2c3d4e5f6', '04a1b2c3d4e5f6'],
    ['abcd1234', 'abcd1234'],
    ['DE-ABC-C12345678-X', 'DE-ABC-C12345678-X'],
  ])('%s compares as %s', (value, canonical) => {
    expect(canonicalTokenValue(value)).toBe(canonical);
  });

  it('looks a station value up as sent, and canonical for vehicle id cards only', () => {
    expect(stationTokenLookup('ABCD1234')).toEqual({ exact: 'ABCD1234', canonical: null });
    expect(stationTokenLookup('VID:92D50A693F80')).toEqual({
      exact: 'VID:92D50A693F80',
      canonical: '92D50A693F80',
    });
  });

  it.each([
    ['92D50A693F80', true],
    ['92-d5-0a-69-3f-80', true],
    ['92:D5:0A:69:3F:80', true],
    ['92d5.0a69.3f80', true],
    ['5YJ3E1EA7KF317000', true],
    ['VID:ABCD', true],
    ['vid:04a1b2c3', true],
    ['04A1B2C3', false],
    ['04A1B2C3D4E5F6', false],
    ['04A1B2C3D4E5F6A7', false],
    ['DE-ABC-C12345678-X', false],
    ['KEY-1234', false],
  ])('a driver card value %s is vehicle shaped: %s', (value, shaped) => {
    expect(isVehicleShapedTokenValue(value)).toBe(shaped);
  });

  it('compares a card with vehicle ids canonical and as an uppercase EVCCID', () => {
    expect(tokenVehicleIdCandidates('vid:92-d5-0a-69-3f-80')).toEqual([
      '92D50A693F80',
      '92-D5-0A-69-3F-80',
    ]);
    expect(tokenVehicleIdCandidates('evcc-15118-20-id')).toEqual([
      'evcc-15118-20-id',
      'EVCC-15118-20-ID',
    ]);
  });
});
