// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encryptString } from '@evtivity/lib';

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

const StripeCtor = vi.fn(function (this: Record<string, unknown>, key: string, opts: unknown) {
  this['key'] = key;
  this['opts'] = opts;
});
vi.mock('stripe', () => ({ default: StripeCtor }));

const KEY = 'test-encryption-key-32chars-long!';

function makeChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() => Promise.resolve(result));
  return chain;
}

describe('getStripeClient', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a client from the decrypted secret key with 3 network retries', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: encryptString('sk_live_abc', KEY) }]));
    const { getStripeClient } = await import('../lib/stripe-client.js');

    const client = (await getStripeClient(KEY)) as unknown as { key: string; opts: unknown };

    expect(StripeCtor).toHaveBeenCalledTimes(1);
    expect(client.key).toBe('sk_live_abc');
    expect(client.opts).toEqual({ maxNetworkRetries: 3 });
  });

  it('returns null when no secret key is set', async () => {
    mockSelect.mockReturnValueOnce(makeChain([{ value: '' }]));
    const mod = await import('../lib/stripe-client.js');
    expect(await mod.getStripeClient(KEY)).toBeNull();
    mod.clearStripeClientCache();
    mockSelect.mockReturnValueOnce(makeChain([]));
    expect(await mod.getStripeClient(KEY)).toBeNull();
    expect(StripeCtor).not.toHaveBeenCalled();
  });

  it('throws when the key cannot be decrypted, so no payment proceeds without it', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: encryptString('sk_x', KEY) }]));
    const { getStripeClient } = await import('../lib/stripe-client.js');
    await expect(getStripeClient('another-key-of-32-characters-long!')).rejects.toThrow();
  });

  it('reuses one client for 60 seconds, then reloads the setting', async () => {
    vi.useFakeTimers();
    mockSelect.mockReturnValue(makeChain([{ value: encryptString('sk_a', KEY) }]));
    const mod = await import('../lib/stripe-client.js');
    const first = await mod.getStripeClient(KEY);
    const second = await mod.getStripeClient(KEY);
    expect(second).toBe(first);
    expect(mockSelect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_001);
    mockSelect.mockReturnValue(makeChain([{ value: encryptString('sk_b', KEY) }]));
    const third = (await mod.getStripeClient(KEY)) as unknown as { key: string };
    expect(third.key).toBe('sk_b');
    expect(mockSelect).toHaveBeenCalledTimes(2);

    mod.clearStripeClientCache();
    await mod.getStripeClient(KEY);
    expect(mockSelect).toHaveBeenCalledTimes(3);
  });
});
