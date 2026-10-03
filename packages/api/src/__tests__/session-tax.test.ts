// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { chargedCostBreakdown } from '@evtivity/lib';
import { storedCostBreakdown, storedSessionCostTax } from '../lib/session-tax.js';

describe('storedCostBreakdown', () => {
  const breakdown = chargedCostBreakdown(1190, 0.19, 'net');

  it('returns the stored breakdown of the cost shown', () => {
    expect(
      storedCostBreakdown({
        costCents: 1190,
        costBreakdown: JSON.parse(JSON.stringify(breakdown)),
      }),
    ).toEqual(breakdown);
  });

  it('ignores a missing breakdown, one for another amount, and an invalid one', () => {
    expect(storedCostBreakdown({ costCents: null, costBreakdown: breakdown })).toBeNull();
    expect(storedCostBreakdown({ costCents: 1190, costBreakdown: null })).toBeNull();
    expect(storedCostBreakdown({ costCents: 1200, costBreakdown: breakdown })).toBeNull();
    expect(
      storedCostBreakdown({ costCents: 1190, costBreakdown: { ...breakdown, taxCents: 1 } }),
    ).toBeNull();
  });
});

describe('storedSessionCostTax', () => {
  it('splits the cost shown with its stored breakdown', () => {
    expect(
      storedSessionCostTax({
        costCents: 1190,
        costBreakdown: chargedCostBreakdown(1190, 0.19, 'net'),
      }),
    ).toEqual({ netCents: 1000, taxCents: 190, taxRate: '0.19' });
    expect(
      storedSessionCostTax({ costCents: 500, costBreakdown: chargedCostBreakdown(500, 0, 'net') }),
    ).toBeNull();
  });
});
