// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();
vi.mock('../config.js', () => ({ db: { select: mockSelect } }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({ type: 'eq' })) }));
vi.mock('../schema/settings.js', () => ({ settings: { key: 'key', value: 'value' } }));

function chainResolving(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  return chain;
}

describe('parsePrepaidLowCreditThresholdCents', () => {
  it('accepts whole cents from 0 to the maximum', async () => {
    const { parsePrepaidLowCreditThresholdCents, MAX_PREPAID_LOW_CREDIT_THRESHOLD_CENTS } =
      await import('../lib/prepaid-settings.js');
    expect(parsePrepaidLowCreditThresholdCents(0)).toBe(0);
    expect(parsePrepaidLowCreditThresholdCents(500)).toBe(500);
    expect(parsePrepaidLowCreditThresholdCents(MAX_PREPAID_LOW_CREDIT_THRESHOLD_CENTS)).toBe(
      MAX_PREPAID_LOW_CREDIT_THRESHOLD_CENTS,
    );
  });

  it('refuses negative, fractional, too large and non-number values', async () => {
    const { parsePrepaidLowCreditThresholdCents, MAX_PREPAID_LOW_CREDIT_THRESHOLD_CENTS } =
      await import('../lib/prepaid-settings.js');
    expect(parsePrepaidLowCreditThresholdCents(-1)).toBeNull();
    expect(parsePrepaidLowCreditThresholdCents(1.5)).toBeNull();
    expect(
      parsePrepaidLowCreditThresholdCents(MAX_PREPAID_LOW_CREDIT_THRESHOLD_CENTS + 1),
    ).toBeNull();
    expect(parsePrepaidLowCreditThresholdCents('500')).toBeNull();
    expect(parsePrepaidLowCreditThresholdCents(null)).toBeNull();
  });
});

describe('getPrepaidLowCreditThresholdCents', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns the stored threshold and caches it for 60 seconds', async () => {
    mockSelect.mockReturnValue(chainResolving([{ value: 1000 }]));
    const { getPrepaidLowCreditThresholdCents } = await import('../lib/prepaid-settings.js');

    await expect(getPrepaidLowCreditThresholdCents()).resolves.toBe(1000);
    await getPrepaidLowCreditThresholdCents();
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('returns the default when the key is missing or invalid', async () => {
    mockSelect.mockReturnValue(chainResolving([]));
    const { getPrepaidLowCreditThresholdCents, clearPrepaidSettingsCache } =
      await import('../lib/prepaid-settings.js');
    await expect(getPrepaidLowCreditThresholdCents()).resolves.toBe(500);

    clearPrepaidSettingsCache();
    mockSelect.mockReturnValue(chainResolving([{ value: -5 }]));
    await expect(getPrepaidLowCreditThresholdCents()).resolves.toBe(500);
  });

  it('returns the cached value on a read error', async () => {
    mockSelect.mockReturnValue(chainResolving([{ value: 0 }]));
    const { getPrepaidLowCreditThresholdCents } = await import('../lib/prepaid-settings.js');
    await expect(getPrepaidLowCreditThresholdCents()).resolves.toBe(0);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    mockSelect.mockReturnValue(chainResolving(new Error('db down')));
    await expect(getPrepaidLowCreditThresholdCents()).resolves.toBe(0);
    vi.restoreAllMocks();
  });
});
