// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();
vi.mock('../config.js', () => ({ db: { select: mockSelect } }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({ type: 'eq' })) }));
vi.mock('../schema/settings.js', () => ({ settings: { key: 'key', value: 'value' } }));
const mockWarn = vi.fn();
vi.mock('@evtivity/lib', () => ({ createLogger: () => ({ warn: mockWarn }) }));

function chainResolving(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  return chain;
}

describe('isSplitBillingEnabled', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function read(rows: unknown): Promise<boolean> {
    mockSelect.mockReturnValue(chainResolving(rows));
    const { isSplitBillingEnabled } = await import('../lib/pricing-settings.js');
    return isSplitBillingEnabled();
  }

  it('is on when the settings row is missing (the shipped default)', async () => {
    expect(await read([])).toBe(true);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('is off when the stored value is false', async () => {
    expect(await read([{ value: false }])).toBe(false);
  });

  it('is on when the stored value is true, cached for 60 seconds', async () => {
    mockSelect.mockReturnValue(chainResolving([{ value: true }]));
    const { isSplitBillingEnabled } = await import('../lib/pricing-settings.js');
    expect(await isSplitBillingEnabled()).toBe(true);
    expect(await isSplitBillingEnabled()).toBe(true);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('is on for an invalid stored value, with a warning', async () => {
    for (const value of ['false', 0, null, { enabled: false }]) {
      vi.resetModules();
      mockWarn.mockClear();
      expect(await read([{ value }])).toBe(true);
      expect(mockWarn).toHaveBeenCalledTimes(1);
    }
  });

  it('is on when the read fails without a cached value', async () => {
    expect(await read(new Error('db down'))).toBe(true);
  });

  it('keeps a cached false when a later read fails', async () => {
    vi.useFakeTimers();
    try {
      mockSelect.mockReturnValue(chainResolving([{ value: false }]));
      const { isSplitBillingEnabled } = await import('../lib/pricing-settings.js');
      expect(await isSplitBillingEnabled()).toBe(false);
      vi.advanceTimersByTime(61_000);
      mockSelect.mockReturnValue(chainResolving(new Error('db down')));
      expect(await isSplitBillingEnabled()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the cached value when a later read fails', async () => {
    vi.useFakeTimers();
    try {
      mockSelect.mockReturnValue(chainResolving([{ value: true }]));
      const { isSplitBillingEnabled } = await import('../lib/pricing-settings.js');
      expect(await isSplitBillingEnabled()).toBe(true);
      vi.advanceTimersByTime(61_000);
      mockSelect.mockReturnValue(chainResolving(new Error('db down')));
      expect(await isSplitBillingEnabled()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
