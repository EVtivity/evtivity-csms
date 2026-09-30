// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { applyMultiplier, energyToWh } from '../server/meter-units.js';

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
