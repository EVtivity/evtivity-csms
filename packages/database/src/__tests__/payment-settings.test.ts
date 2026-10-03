// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSelect = vi.fn();
vi.mock('../config.js', () => ({
  db: {
    select: mockSelect,
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => ({ type: 'eq', val })),
  and: vi.fn(),
}));

vi.mock('../schema/settings.js', () => ({
  settings: { key: 'key', value: 'value' },
}));

vi.mock('../schema/payments.js', () => ({
  sitePaymentConfigs: {},
}));

function makeChain(result: unknown[] | Error) {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  return chain;
}

/** First select is the platform setting, the second the site config. */
function respond(platform: unknown[] | Error, site: unknown[] | Error = []): void {
  mockSelect.mockReturnValueOnce(makeChain(platform)).mockReturnValueOnce(makeChain(site));
}

describe('getPlatformFeePercent', () => {
  beforeEach(() => {
    vi.resetModules();
    mockSelect.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prefers the enabled site override over the platform setting', async () => {
    respond([{ value: 5 }], [{ percent: '20' }]);
    const { getPlatformFeePercent } = await import('../lib/payment-settings.js');
    expect(await getPlatformFeePercent('site-1')).toBe(20);
  });

  it('falls back to the platform setting, then 0, and clamps to 100', async () => {
    const mod = await import('../lib/payment-settings.js');
    respond([{ value: 7.5 }]);
    expect(await mod.getPlatformFeePercent('site-a')).toBe(7.5);
    respond([]);
    expect(await mod.getPlatformFeePercent('site-b')).toBe(0);
    respond([{ value: 150 }]);
    expect(await mod.getPlatformFeePercent('site-c')).toBe(100);
    respond([{ value: 'not a number' }]);
    expect(await mod.getPlatformFeePercent('site-d')).toBe(0);
  });

  it('reads no site config without a site', async () => {
    mockSelect.mockReturnValueOnce(makeChain([{ value: 3 }]));
    const { getPlatformFeePercent } = await import('../lib/payment-settings.js');
    expect(await getPlatformFeePercent(null)).toBe(3);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('caches per site for 60 seconds and clears on demand', async () => {
    vi.useFakeTimers();
    const mod = await import('../lib/payment-settings.js');
    respond([{ value: 4 }]);
    expect(await mod.getPlatformFeePercent('site-x')).toBe(4);
    expect(await mod.getPlatformFeePercent('site-x')).toBe(4);
    expect(mockSelect).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(60_001);
    respond([{ value: 6 }]);
    expect(await mod.getPlatformFeePercent('site-x')).toBe(6);

    mod.clearPlatformFeeCache();
    respond([{ value: 8 }]);
    expect(await mod.getPlatformFeePercent('site-x')).toBe(8);
  });

  it('serves the last value on a read failure and throws without one', async () => {
    vi.useFakeTimers();
    const mod = await import('../lib/payment-settings.js');
    respond(new Error('db down'));
    await expect(mod.getPlatformFeePercent('site-y')).rejects.toThrow('db down');

    respond([{ value: 9 }]);
    expect(await mod.getPlatformFeePercent('site-y')).toBe(9);
    vi.advanceTimersByTime(60_001);
    respond(new Error('db down'));
    expect(await mod.getPlatformFeePercent('site-y')).toBe(9);
  });
});
