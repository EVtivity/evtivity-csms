// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { asuToDbm, gradeSignal, readSignalStrength } from '../signal-grade.js';

describe('gradeSignal', () => {
  it('grades a positive dBm unknown, since a received signal is always below 0 dBm', () => {
    expect(gradeSignal({ dbm: 1 })).toBe('unknown');
    expect(gradeSignal({ dbm: 31 })).toBe('unknown');
    expect(gradeSignal({ dbm: 0.5 })).toBe('unknown');
  });

  it('grades at the default thresholds, boundaries included', () => {
    expect(gradeSignal({ dbm: -50 })).toBe('good');
    expect(gradeSignal({ dbm: -65 })).toBe('good');
    expect(gradeSignal({ dbm: -66 })).toBe('fair');
    expect(gradeSignal({ dbm: -85 })).toBe('fair');
    expect(gradeSignal({ dbm: -86 })).toBe('poor');
    expect(gradeSignal({ dbm: -120 })).toBe('poor');
  });

  it('uses the thresholds it is given', () => {
    const thresholds = { goodDbm: -70, fairDbm: -100 };
    expect(gradeSignal({ dbm: -70 }, thresholds)).toBe('good');
    expect(gradeSignal({ dbm: -71 }, thresholds)).toBe('fair');
    expect(gradeSignal({ dbm: -100 }, thresholds)).toBe('fair');
    expect(gradeSignal({ dbm: -101 }, thresholds)).toBe('poor');
  });

  it('converts an ASU value to dBm first', () => {
    // ASU 24 is -65 dBm, ASU 14 is -85 dBm, ASU 13 is -87 dBm.
    expect(gradeSignal({ asu: 24 })).toBe('good');
    expect(gradeSignal({ asu: 23 })).toBe('fair');
    expect(gradeSignal({ asu: 14 })).toBe('fair');
    expect(gradeSignal({ asu: 13 })).toBe('poor');
  });

  it('is unknown for ASU 99, an out of range ASU and a missing value', () => {
    expect(gradeSignal({ asu: 99 })).toBe('unknown');
    expect(gradeSignal({ asu: 40 })).toBe('unknown');
    expect(gradeSignal({ asu: null })).toBe('unknown');
    expect(gradeSignal({ dbm: null })).toBe('unknown');
    expect(gradeSignal({ dbm: Number.NaN })).toBe('unknown');
  });
});

describe('asuToDbm', () => {
  it('maps the GSM range', () => {
    expect(asuToDbm(0)).toBe(-113);
    expect(asuToDbm(31)).toBe(-51);
    expect(asuToDbm(99)).toBeNull();
    expect(asuToDbm(-1)).toBeNull();
  });
});

describe('readSignalStrength', () => {
  it('takes the reported unit', () => {
    expect(readSignalStrength('-71', 'dBm')).toEqual({
      value: -71,
      unit: 'dBm',
      inferred: false,
      dbm: -71,
    });
    expect(readSignalStrength('-71', 'dbmW')?.unit).toBe('dBm');
    expect(readSignalStrength('20', 'ASU')).toEqual({
      value: 20,
      unit: 'ASU',
      inferred: false,
      dbm: -73,
    });
  });

  it('infers the unit from the range when none is reported', () => {
    expect(readSignalStrength('-90', null)).toMatchObject({
      unit: 'dBm',
      inferred: true,
      dbm: -90,
    });
    expect(readSignalStrength('18', undefined)).toMatchObject({
      unit: 'ASU',
      inferred: true,
      dbm: -77,
    });
    expect(readSignalStrength(99, 'unknown-unit')).toMatchObject({
      unit: 'ASU',
      inferred: true,
      dbm: null,
    });
  });

  it('refuses a value that is not a number or fits no unit', () => {
    expect(readSignalStrength('', null)).toBeNull();
    expect(readSignalStrength('strong', null)).toBeNull();
    expect(readSignalStrength('45', null)).toBeNull();
    expect(readSignalStrength(null, 'dBm')).toBeNull();
  });
});
