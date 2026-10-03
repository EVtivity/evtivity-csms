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
  and: vi.fn(),
}));

vi.mock('../schema/settings.js', () => ({
  settings: { key: 'key', value: 'value' },
}));

vi.mock('../schema/payments.js', () => ({
  sitePaymentConfigs: {},
}));

const KEY = 'test-encryption-key-32chars-long!';

function makeChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() => Promise.resolve(result));
  return chain;
}

describe('getStripeWebhookSecret', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('decrypts the stored signing secret', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: encryptString('whsec_live_1', KEY) }]));
    const { getStripeWebhookSecret } = await import('../lib/payment-settings.js');
    expect(await getStripeWebhookSecret(KEY)).toBe('whsec_live_1');
  });

  it('returns null when the setting is empty or missing', async () => {
    mockSelect.mockReturnValueOnce(makeChain([{ value: '' }]));
    const mod = await import('../lib/payment-settings.js');
    expect(await mod.getStripeWebhookSecret(KEY)).toBeNull();
    mod.clearStripeWebhookSecretCache();
    mockSelect.mockReturnValueOnce(makeChain([]));
    expect(await mod.getStripeWebhookSecret(KEY)).toBeNull();
  });

  it('throws when the stored value cannot be decrypted with the key', async () => {
    mockSelect.mockReturnValue(makeChain([{ value: encryptString('whsec_x', KEY) }]));
    const { getStripeWebhookSecret } = await import('../lib/payment-settings.js');
    await expect(getStripeWebhookSecret('another-key-of-32-characters-long!')).rejects.toThrow();
  });

  it('caches for 60 seconds and reloads after the TTL or a clear', async () => {
    vi.useFakeTimers();
    mockSelect.mockReturnValue(makeChain([{ value: encryptString('whsec_a', KEY) }]));
    const mod = await import('../lib/payment-settings.js');
    await mod.getStripeWebhookSecret(KEY);
    await mod.getStripeWebhookSecret(KEY);
    expect(mockSelect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_001);
    mockSelect.mockReturnValue(makeChain([{ value: encryptString('whsec_b', KEY) }]));
    expect(await mod.getStripeWebhookSecret(KEY)).toBe('whsec_b');
    expect(mockSelect).toHaveBeenCalledTimes(2);

    mod.clearStripeWebhookSecretCache();
    mockSelect.mockReturnValue(makeChain([{ value: encryptString('whsec_c', KEY) }]));
    expect(await mod.getStripeWebhookSecret(KEY)).toBe('whsec_c');
    expect(mockSelect).toHaveBeenCalledTimes(3);
  });
});
