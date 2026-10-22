// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { iccidChanged, iccidsMatch, isValidIccid, normalizeIccid } from '../iccid.js';

describe('normalizeIccid', () => {
  it('accepts 19 and 20 digits', () => {
    expect(normalizeIccid('8901260000000000001')).toBe('8901260000000000001');
    expect(normalizeIccid('89012600000000000012')).toBe('89012600000000000012');
  });

  it('trims and removes a trailing F padding, in either case', () => {
    expect(normalizeIccid('  8901260000000000001F ')).toBe('8901260000000000001');
    expect(normalizeIccid('8901260000000000001f')).toBe('8901260000000000001');
    expect(normalizeIccid('89012600000000000012F')).toBe('89012600000000000012');
  });

  it('refuses anything else', () => {
    for (const value of [
      '',
      '   ',
      '890126000000000001',
      '890126000000000000123',
      '8901260000000000001FF',
      'F8901260000000000001',
      '89012600000000A0001',
      '8901 2600 0000 0000 001',
    ]) {
      expect(normalizeIccid(value)).toBeNull();
    }
  });

  it('refuses null and undefined', () => {
    expect(normalizeIccid(null)).toBeNull();
    expect(normalizeIccid(undefined)).toBeNull();
  });
});

describe('isValidIccid', () => {
  it('follows normalizeIccid', () => {
    expect(isValidIccid('8901260000000000001F')).toBe(true);
    expect(isValidIccid('12345')).toBe(false);
  });
});

describe('iccidsMatch', () => {
  it('compares normalized values', () => {
    expect(iccidsMatch('8901260000000000001F', '8901260000000000001')).toBe(true);
    expect(iccidsMatch('8901260000000000001', '8901260000000000002')).toBe(false);
  });

  it('never matches an invalid value, not even itself', () => {
    expect(iccidsMatch('abc', 'abc')).toBe(false);
    expect(iccidsMatch(null, null)).toBe(false);
  });
});

describe('iccidChanged', () => {
  it('ignores a trailing F, case and spaces', () => {
    expect(iccidChanged('8901260000000000001', '8901260000000000001F')).toBe(false);
    expect(iccidChanged(' 8901260000000000001f', '8901260000000000001')).toBe(false);
  });

  it('sees another SIM, a removed one and a first one', () => {
    expect(iccidChanged('8901260000000000001', '8901260000000000019')).toBe(true);
    expect(iccidChanged('8901260000000000001', null)).toBe(true);
    expect(iccidChanged(null, '8901260000000000001')).toBe(true);
    expect(iccidChanged(null, '')).toBe(false);
  });

  it('compares values that are not ICCIDs as text', () => {
    expect(iccidChanged('ABC', 'abc ')).toBe(false);
    expect(iccidChanged('ABC', '8901260000000000001')).toBe(true);
  });
});
