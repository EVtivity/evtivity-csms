// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { aiCostInCompanyCurrencyMicros, aiUsageCostMicros } from '../pricing-engine.js';

const PRICES = { inputPerMTok: 3_000_000, cachedInputPerMTok: 300_000, outputPerMTok: 15_000_000 };

describe('aiUsageCostMicros', () => {
  it('bills cached reads at the cached price and the rest at the input price', () => {
    // 900 uncached * 3 + 100 cached * 0.3 + 50 output * 15 = 2700 + 30 + 750
    const usage = {
      inputTokens: 1_000,
      cachedReadTokens: 100,
      cacheWriteTokens: 0,
      outputTokens: 50,
    };
    expect(aiUsageCostMicros(usage, PRICES)).toBe(3_480);
  });

  it('bills cached reads at the input price without a cached price', () => {
    const usage = {
      inputTokens: 1_000,
      cachedReadTokens: 100,
      cacheWriteTokens: 0,
      outputTokens: 0,
    };
    expect(aiUsageCostMicros(usage, { ...PRICES, cachedInputPerMTok: null })).toBe(3_000);
  });

  it('rounds half up to whole micro-USD and stays exact on large counts', () => {
    const one = { inputTokens: 1, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    expect(aiUsageCostMicros(one, { ...PRICES, inputPerMTok: 500_000 })).toBe(1);
    expect(aiUsageCostMicros(one, { ...PRICES, inputPerMTok: 499_999 })).toBe(0);
    const big = {
      inputTokens: 10_000_000_000,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    };
    expect(aiUsageCostMicros(big, PRICES)).toBe(30_000_000_000);
  });

  it('never counts more cached tokens than input tokens, nor negative counts', () => {
    const odd = { inputTokens: 10, cachedReadTokens: 50, cacheWriteTokens: 0, outputTokens: -5 };
    expect(aiUsageCostMicros(odd, PRICES)).toBe(3);
  });
});

describe('aiCostInCompanyCurrencyMicros', () => {
  it('states the cost only in USD, the providers price currency', () => {
    expect(aiCostInCompanyCurrencyMicros(1_234, 'USD')).toBe(1_234);
    expect(aiCostInCompanyCurrencyMicros(1_234, 'usd')).toBe(1_234);
    expect(aiCostInCompanyCurrencyMicros(1_234, 'EUR')).toBeNull();
    expect(aiCostInCompanyCurrencyMicros(null, 'USD')).toBeNull();
  });
});
