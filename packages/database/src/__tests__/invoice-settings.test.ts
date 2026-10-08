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

describe('parseInvoicePaymentTermsDays', () => {
  it('accepts whole days from 0 to 365', async () => {
    const { parseInvoicePaymentTermsDays } = await import('../lib/invoice-settings.js');
    expect(parseInvoicePaymentTermsDays(0)).toBe(0);
    expect(parseInvoicePaymentTermsDays(14)).toBe(14);
    expect(parseInvoicePaymentTermsDays(365)).toBe(365);
  });

  it('refuses negative, fractional, too long and non-number values', async () => {
    const { parseInvoicePaymentTermsDays } = await import('../lib/invoice-settings.js');
    expect(parseInvoicePaymentTermsDays(-1)).toBeNull();
    expect(parseInvoicePaymentTermsDays(1.5)).toBeNull();
    expect(parseInvoicePaymentTermsDays(366)).toBeNull();
    expect(parseInvoicePaymentTermsDays('30')).toBeNull();
    expect(parseInvoicePaymentTermsDays(null)).toBeNull();
  });
});

describe('getInvoicePaymentTermsDays', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns the stored term and caches it for 60 seconds', async () => {
    mockSelect.mockReturnValue(chainResolving([{ value: 14 }]));
    const { getInvoicePaymentTermsDays } = await import('../lib/invoice-settings.js');

    await expect(getInvoicePaymentTermsDays()).resolves.toBe(14);
    await getInvoicePaymentTermsDays();
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('returns 30 days when the key is missing or invalid', async () => {
    mockSelect.mockReturnValue(chainResolving([]));
    const { getInvoicePaymentTermsDays, clearInvoiceSettingsCache } =
      await import('../lib/invoice-settings.js');
    await expect(getInvoicePaymentTermsDays()).resolves.toBe(30);

    clearInvoiceSettingsCache();
    mockSelect.mockReturnValue(chainResolving([{ value: 400 }]));
    await expect(getInvoicePaymentTermsDays()).resolves.toBe(30);
  });

  it('returns the cached value on a read error', async () => {
    mockSelect.mockReturnValue(chainResolving([{ value: 0 }]));
    const { getInvoicePaymentTermsDays } = await import('../lib/invoice-settings.js');
    await expect(getInvoicePaymentTermsDays()).resolves.toBe(0);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    mockSelect.mockReturnValue(chainResolving(new Error('db down')));
    await expect(getInvoicePaymentTermsDays()).resolves.toBe(0);
    vi.restoreAllMocks();
  });
});

describe('parseFleetInvoiceRunDay', () => {
  it('accepts whole days from 1 to 28', async () => {
    const { parseFleetInvoiceRunDay } = await import('../lib/invoice-settings.js');
    expect(parseFleetInvoiceRunDay(1)).toBe(1);
    expect(parseFleetInvoiceRunDay(15)).toBe(15);
    expect(parseFleetInvoiceRunDay(28)).toBe(28);
  });

  it('refuses 0, 29 and later, fractional and non-number values', async () => {
    const { parseFleetInvoiceRunDay } = await import('../lib/invoice-settings.js');
    expect(parseFleetInvoiceRunDay(0)).toBeNull();
    expect(parseFleetInvoiceRunDay(29)).toBeNull();
    expect(parseFleetInvoiceRunDay(31)).toBeNull();
    expect(parseFleetInvoiceRunDay(2.5)).toBeNull();
    expect(parseFleetInvoiceRunDay('1')).toBeNull();
    expect(parseFleetInvoiceRunDay(null)).toBeNull();
  });
});

describe('getFleetInvoiceRunDay', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns the stored day and caches it for 60 seconds', async () => {
    mockSelect.mockReturnValue(chainResolving([{ value: 5 }]));
    const { getFleetInvoiceRunDay } = await import('../lib/invoice-settings.js');

    await expect(getFleetInvoiceRunDay()).resolves.toBe(5);
    await getFleetInvoiceRunDay();
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('returns day 1 when the key is missing or invalid, and the cache clears', async () => {
    mockSelect.mockReturnValue(chainResolving([]));
    const { getFleetInvoiceRunDay, clearInvoiceSettingsCache } =
      await import('../lib/invoice-settings.js');
    await expect(getFleetInvoiceRunDay()).resolves.toBe(1);

    clearInvoiceSettingsCache();
    mockSelect.mockReturnValue(chainResolving([{ value: 30 }]));
    await expect(getFleetInvoiceRunDay()).resolves.toBe(1);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it('returns the cached value on a read error', async () => {
    mockSelect.mockReturnValue(chainResolving([{ value: 3 }]));
    const { getFleetInvoiceRunDay } = await import('../lib/invoice-settings.js');
    await expect(getFleetInvoiceRunDay()).resolves.toBe(3);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    mockSelect.mockReturnValue(chainResolving(new Error('db down')));
    await expect(getFleetInvoiceRunDay()).resolves.toBe(3);
    vi.restoreAllMocks();
  });
});
