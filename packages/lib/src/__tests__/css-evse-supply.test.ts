// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { cssEvseSupply, isNorthAmericanCountry } from '../css-evse-supply.js';

describe('cssEvseSupply', () => {
  it('puts North American AC on one 208 V circuit and DC on 480Y/277 V', () => {
    expect(cssEvseSupply('ac_type1', 'US')).toEqual({ phases: 1, voltage: 208 });
    expect(cssEvseSupply('ac_type2', 'CA')).toEqual({ phases: 1, voltage: 208 });
    expect(cssEvseSupply('dc_ccs1', 'US')).toEqual({ phases: 3, voltage: 277 });
    expect(cssEvseSupply('dc_chademo', 'United States')).toEqual({ phases: 3, voltage: 277 });
  });

  it('puts European Type 2 and DC on three-phase 230/400 V and Type 1 on one phase', () => {
    expect(cssEvseSupply('ac_type2', 'DE')).toEqual({ phases: 3, voltage: 230 });
    expect(cssEvseSupply('dc_ccs2', 'NL')).toEqual({ phases: 3, voltage: 230 });
    expect(cssEvseSupply('ac_type1', 'NL')).toEqual({ phases: 1, voltage: 230 });
  });

  it('treats an unknown country as IEC 230/400 V', () => {
    expect(cssEvseSupply('ac_type2', null)).toEqual({ phases: 3, voltage: 230 });
    expect(isNorthAmericanCountry('  us ')).toBe(true);
    expect(isNorthAmericanCountry('GB')).toBe(false);
    expect(isNorthAmericanCountry(undefined)).toBe(false);
  });
});
