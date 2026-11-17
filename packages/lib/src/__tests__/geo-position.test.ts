// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { haversineKm, parsePosition } from '../geo-position.js';

describe('parsePosition', () => {
  it('reads two empty or null values as no position', () => {
    expect(parsePosition('', ' ')).toEqual({ ok: true, value: null });
    expect(parsePosition(null, undefined)).toEqual({ ok: true, value: null });
  });

  it('keeps a valid pair trimmed as typed', () => {
    expect(parsePosition(' 47.99591 ', '7.85222')).toEqual({
      ok: true,
      value: { latitude: '47.99591', longitude: '7.85222' },
    });
    expect(parsePosition('-90', '180')).toMatchObject({ ok: true });
  });

  it('refuses one coordinate without the other', () => {
    expect(parsePosition('47.9', '')).toEqual({
      ok: false,
      field: 'longitude',
      problem: 'missing',
    });
    expect(parsePosition(null, '7.8')).toEqual({
      ok: false,
      field: 'latitude',
      problem: 'missing',
    });
  });

  it('refuses text that is no plain decimal number, too long, or out of range', () => {
    for (const bad of ['1e2', '0x10', '47,9', 'NaN', 'Infinity', '47.', '.5', '1'.repeat(21)]) {
      expect(parsePosition(bad, '7.8'), bad).toMatchObject({
        ok: false,
        field: 'latitude',
        problem: 'invalid',
      });
    }
    expect(parsePosition('90.0001', '0')).toMatchObject({
      field: 'latitude',
      problem: 'out_of_range',
    });
    expect(parsePosition('0', '-180.5')).toMatchObject({
      field: 'longitude',
      problem: 'out_of_range',
    });
  });
});

describe('haversineKm', () => {
  it('is 0 for one point and about 111 km for one degree of latitude', () => {
    expect(haversineKm(48, 7.8, 48, 7.8)).toBe(0);
    expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(111.19, 1);
  });
});
