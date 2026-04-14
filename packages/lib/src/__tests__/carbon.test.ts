// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { calculateCo2AvoidedKg, GASOLINE_CO2_KG_PER_KWH } from '../carbon.js';

describe('calculateCo2AvoidedKg', () => {
  it('returns 0 for zero energy', () => {
    expect(calculateCo2AvoidedKg(0, 0.22)).toBe(0);
  });

  it('calculates correctly for 50 kWh at 0.22 intensity', () => {
    // 50 * 0.46 - 50 * 0.22 = 23 - 11 = 12.0
    const result = calculateCo2AvoidedKg(50_000, 0.22);
    expect(result).toBe(12);
  });

  it('returns low avoided CO2 for high intensity grid (0.45)', () => {
    // 30 kWh: 30 * 0.46 - 30 * 0.45 = 13.8 - 13.5 = 0.3
    const result = calculateCo2AvoidedKg(30_000, 0.45);
    expect(result).toBe(0.3);
  });

  it('returns high avoided CO2 for low intensity grid like Norway (0.01)', () => {
    // 50 kWh: 50 * 0.46 - 50 * 0.01 = 23 - 0.5 = 22.5
    const result = calculateCo2AvoidedKg(50_000, 0.01);
    expect(result).toBe(22.5);
  });

  it('returns negative value when grid is dirtier than gasoline equivalent', () => {
    // 10 kWh: 10 * 0.46 - 10 * 0.80 = 4.6 - 8.0 = -3.4
    const result = calculateCo2AvoidedKg(10_000, 0.8);
    expect(result).toBe(-3.4);
  });

  it('exports the gasoline constant', () => {
    expect(GASOLINE_CO2_KG_PER_KWH).toBe(0.46);
  });
});
