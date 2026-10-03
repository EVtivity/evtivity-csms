// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();
vi.mock('../config.js', () => ({
  db: {
    select: mockSelect,
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => ({ type: 'eq', val })),
}));

vi.mock('../schema/settings.js', () => ({
  settings: { key: 'key', value: 'value' },
}));

function makeChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() => Promise.resolve(result));
  return chain;
}

function makeFailingChain() {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() => Promise.reject(new Error('db down')));
  return chain;
}

describe('getCompanyCurrency', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns the configured currency, upper-cased', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: 'eur' }]));
    const { getCompanyCurrency } = await import('../lib/system-settings.js');
    expect(await getCompanyCurrency()).toBe('EUR');
  });

  it('falls back to USD when the setting is missing', async () => {
    mockSelect.mockReturnValue(makeChain([]));
    const { getCompanyCurrency } = await import('../lib/system-settings.js');
    expect(await getCompanyCurrency()).toBe('USD');
  });

  it('falls back to USD for a zero-decimal currency the platform cannot bill in', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: 'JPY' }]));
    const { getCompanyCurrency } = await import('../lib/system-settings.js');
    expect(await getCompanyCurrency()).toBe('USD');
  });

  it('falls back to USD when the setting is not a 3-letter code', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: 'Euro' }]));
    const { getCompanyCurrency } = await import('../lib/system-settings.js');
    expect(await getCompanyCurrency()).toBe('USD');
  });

  it('caches the value for subsequent calls', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: 'GBP' }]));
    const { getCompanyCurrency } = await import('../lib/system-settings.js');
    await getCompanyCurrency();
    await getCompanyCurrency();
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the cache is cleared', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: 'GBP' }]));
    const { getCompanyCurrency, clearSystemSettingsCache } =
      await import('../lib/system-settings.js');
    await getCompanyCurrency();
    clearSystemSettingsCache();
    mockSelect.mockReturnValue(makeChain([{ value: 'SEK' }]));
    expect(await getCompanyCurrency()).toBe('SEK');
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it('returns the last cached value when the query fails', async () => {
    vi.useFakeTimers();
    try {
      mockSelect.mockReturnValue(makeChain([{ value: 'CAD' }]));
      const { getCompanyCurrency } = await import('../lib/system-settings.js');
      expect(await getCompanyCurrency()).toBe('CAD');
      vi.advanceTimersByTime(61_000);
      mockSelect.mockReturnValue(makeFailingChain());
      expect(await getCompanyCurrency()).toBe('CAD');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns USD when the first query fails', async () => {
    mockSelect.mockReturnValue(makeFailingChain());
    const { getCompanyCurrency } = await import('../lib/system-settings.js');
    expect(await getCompanyCurrency()).toBe('USD');
  });
});

describe('getCompanyPriceDisplay', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns the configured price display', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: 'gross' }]));
    const { getCompanyPriceDisplay } = await import('../lib/system-settings.js');
    expect(await getCompanyPriceDisplay()).toBe('gross');
  });

  it('falls back to net when the setting is missing or invalid', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: 'brutto' }]));
    const { getCompanyPriceDisplay, clearSystemSettingsCache } =
      await import('../lib/system-settings.js');
    expect(await getCompanyPriceDisplay()).toBe('net');
    clearSystemSettingsCache();
    mockSelect.mockReturnValue(makeChain([]));
    expect(await getCompanyPriceDisplay()).toBe('net');
  });

  it('caches the value until the cache is cleared', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: 'gross' }]));
    const { getCompanyPriceDisplay, clearSystemSettingsCache } =
      await import('../lib/system-settings.js');
    await getCompanyPriceDisplay();
    await getCompanyPriceDisplay();
    expect(mockSelect).toHaveBeenCalledTimes(1);
    clearSystemSettingsCache();
    mockSelect.mockReturnValue(makeChain([{ value: 'net' }]));
    expect(await getCompanyPriceDisplay()).toBe('net');
  });

  it('returns net when the first query fails', async () => {
    mockSelect.mockReturnValue(makeFailingChain());
    const { getCompanyPriceDisplay } = await import('../lib/system-settings.js');
    expect(await getCompanyPriceDisplay()).toBe('net');
  });
});

describe('getCompanyTaxBasis', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns the configured tax basis', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: 'gross' }]));
    const { getCompanyTaxBasis } = await import('../lib/system-settings.js');
    expect(await getCompanyTaxBasis()).toBe('gross');
  });

  it('falls back to net when the setting is missing or invalid', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: 'brutto' }]));
    const { getCompanyTaxBasis, clearSystemSettingsCache } =
      await import('../lib/system-settings.js');
    expect(await getCompanyTaxBasis()).toBe('net');
    clearSystemSettingsCache();
    mockSelect.mockReturnValue(makeChain([]));
    expect(await getCompanyTaxBasis()).toBe('net');
  });

  it('caches the value until the cache is cleared', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: 'gross' }]));
    const { getCompanyTaxBasis, clearSystemSettingsCache } =
      await import('../lib/system-settings.js');
    await getCompanyTaxBasis();
    await getCompanyTaxBasis();
    expect(mockSelect).toHaveBeenCalledTimes(1);
    clearSystemSettingsCache();
    mockSelect.mockReturnValue(makeChain([{ value: 'net' }]));
    expect(await getCompanyTaxBasis()).toBe('net');
  });

  it('keeps the last value, or net, when the query fails', async () => {
    mockSelect.mockReturnValue(makeFailingChain());
    const { getCompanyTaxBasis } = await import('../lib/system-settings.js');
    expect(await getCompanyTaxBasis()).toBe('net');
  });
});

describe('getCompanyCountry', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns the configured country, upper-cased', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: ' de ' }]));
    const { getCompanyCountry } = await import('../lib/system-settings.js');
    expect(await getCompanyCountry()).toBe('DE');
  });

  it('returns null when the setting is missing or not a two-letter code', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: 'Germany' }]));
    const { getCompanyCountry, clearSystemSettingsCache } =
      await import('../lib/system-settings.js');
    expect(await getCompanyCountry()).toBeNull();
    clearSystemSettingsCache();
    mockSelect.mockReturnValue(makeChain([]));
    expect(await getCompanyCountry()).toBeNull();
  });

  it('caches the value until the cache is cleared', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: 'US' }]));
    const { getCompanyCountry, clearSystemSettingsCache } =
      await import('../lib/system-settings.js');
    await getCompanyCountry();
    await getCompanyCountry();
    expect(mockSelect).toHaveBeenCalledTimes(1);
    clearSystemSettingsCache();
    mockSelect.mockReturnValue(makeChain([{ value: 'FR' }]));
    expect(await getCompanyCountry()).toBe('FR');
  });

  it('keeps the last value, or null, when the query fails', async () => {
    vi.useFakeTimers();
    mockSelect.mockReturnValue(makeChain([{ value: 'NL' }]));
    const { getCompanyCountry, clearSystemSettingsCache } =
      await import('../lib/system-settings.js');
    expect(await getCompanyCountry()).toBe('NL');
    vi.advanceTimersByTime(60_001);
    mockSelect.mockReturnValue(makeFailingChain());
    expect(await getCompanyCountry()).toBe('NL');
    clearSystemSettingsCache();
    expect(await getCompanyCountry()).toBeNull();
    vi.useRealTimers();
  });
});
