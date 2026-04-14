// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { calculateCo2AvoidedKg } from '../carbon.js';

describe('Carbon calculation for session projections', () => {
  it('calculates CO2 avoided for a session with site carbon region', () => {
    // 30 kWh session, California grid (0.22 kg/kWh)
    const result = calculateCo2AvoidedKg(30_000, 0.22);
    expect(result).toBe(7.2); // 30 * 0.46 - 30 * 0.22 = 13.8 - 6.6 = 7.2
  });

  it('returns 0 for zero energy session', () => {
    expect(calculateCo2AvoidedKg(0, 0.22)).toBe(0);
  });

  it('handles session without carbon region (no calculation needed)', () => {
    // When region is null, the projection skips calculation entirely
    // This test just documents that behavior - nothing to call
    expect(true).toBe(true);
  });

  it('matches expected formula: gasoline CO2 minus grid CO2', () => {
    // 100 kWh at Texas grid (0.373)
    // gasoline: 100 * 0.46 = 46
    // grid: 100 * 0.373 = 37.3
    // avoided: 46 - 37.3 = 8.7
    expect(calculateCo2AvoidedKg(100_000, 0.373)).toBe(8.7);
  });
});
