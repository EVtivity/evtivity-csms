// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { applyMultiplier, energyToWh, overallValue } from '../server/meter-units.js';

describe('applyMultiplier', () => {
  it('scales by a power of ten', () => {
    expect(applyMultiplier(12, 0)).toBe(12);
    expect(applyMultiplier(12, 3)).toBe(12000);
    expect(applyMultiplier(1234, -3)).toBe(1.234);
  });
});

describe('energyToWh', () => {
  it('treats a missing unit and Wh as Wh', () => {
    expect(energyToWh(2908247, null)).toBe(2908247);
    expect(energyToWh(2908247, 'Wh')).toBe(2908247);
  });

  it('converts kWh to Wh without float noise', () => {
    expect(energyToWh(2908.247, 'kWh')).toBe(2908247);
    expect(energyToWh(0.1, 'kWh')).toBe(100);
  });

  it('rejects non-energy units and non-numeric values', () => {
    expect(energyToWh(11, 'kW')).toBeNull();
    expect(energyToWh(Number('abc'), 'Wh')).toBeNull();
  });
});

describe('overallValue', () => {
  it('uses the sample without a phase when there is one', () => {
    expect(
      overallValue([
        { value: 100, phase: 'L1' },
        { value: 300, phase: null },
        { value: 100, phase: 'L2' },
      ]),
    ).toBe(300);
  });

  it('sums the lines when only per-phase samples exist', () => {
    expect(
      overallValue([
        { value: 100.1, phase: 'L1' },
        { value: 100.2, phase: 'L2-N' },
        { value: 100.3, phase: 'L3' },
      ]),
    ).toBe(300.6);
  });

  it('uses a single line as the total for a single-phase station', () => {
    expect(overallValue([{ value: 42, phase: 'L1' }])).toBe(42);
  });

  it('ignores line-to-line and neutral samples', () => {
    expect(
      overallValue([
        { value: 400, phase: 'L1-L2' },
        { value: 1, phase: 'N' },
      ]),
    ).toBeNull();
  });

  it('returns null when a line appears twice', () => {
    expect(
      overallValue([
        { value: 1, phase: 'L1' },
        { value: 1, phase: 'L1-N' },
      ]),
    ).toBeNull();
  });

  it('returns null for no samples', () => {
    expect(overallValue([])).toBeNull();
  });
});
