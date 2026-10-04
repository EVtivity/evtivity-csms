// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyReply } from 'fastify';

const { mockAssertSelectable, redisInstances, redisListeners } = vi.hoisted(() => ({
  mockAssertSelectable: vi.fn(),
  redisInstances: [] as Array<{ url: string; options: unknown }>,
  redisListeners: [] as string[],
}));

vi.mock('@evtivity/payments', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertProviderSelectable: mockAssertSelectable,
}));

vi.mock('ioredis', () => ({
  Redis: class {
    constructor(url: string, options: unknown) {
      redisInstances.push({ url, options });
    }
    get(key: string) {
      return Promise.resolve(`value of ${key}`);
    }
    set(...args: unknown[]) {
      return Promise.resolve(args.length === 4 ? 'OK' : null);
    }
    on(event: string): this {
      redisListeners.push(event);
      return this;
    }
  },
}));

import { PaymentProviderUpgradePendingError } from '@evtivity/payments';
import {
  assertPaymentProviderWritable,
  providerSwitchStore,
  replyIfProviderUpgradePending,
  setProviderSwitchStore,
} from '../lib/provider-switch.js';

const store = { get: vi.fn(), set: vi.fn() };

beforeEach(() => {
  mockAssertSelectable.mockReset();
  mockAssertSelectable.mockResolvedValue(undefined);
  setProviderSwitchStore(store);
});

afterEach(() => {
  setProviderSwitchStore(null);
});

describe('assertPaymentProviderWritable', () => {
  it('runs the guard for payments.provider with the watch store', async () => {
    await assertPaymentProviderWritable('payments.provider', 'adyen');
    expect(mockAssertSelectable).toHaveBeenCalledWith('adyen', store);
  });

  it('skips other keys and non-string values', async () => {
    await assertPaymentProviderWritable('stripe.publishableKey', 'adyen');
    await assertPaymentProviderWritable('payments.provider', null);
    expect(mockAssertSelectable).not.toHaveBeenCalled();
  });

  it('passes the guard refusal on', async () => {
    const err = new PaymentProviderUpgradePendingError('adyen', {
      legacyConnections: 1,
      hosts: [],
      lastLegacySeenAt: null,
      watchCheckedAt: null,
    });
    mockAssertSelectable.mockRejectedValueOnce(err);
    await expect(assertPaymentProviderWritable('payments.provider', 'adyen')).rejects.toBe(err);
  });
});

describe('providerSwitchStore', () => {
  it('connects to Redis only on the first guard read, once per process', async () => {
    setProviderSwitchStore(null);
    const redisStore = providerSwitchStore();
    expect(redisInstances).toHaveLength(0);
    await expect(redisStore.get('k')).resolves.toBe('value of k');
    await expect(redisStore.set('k', 'v', 'EX', 60)).resolves.toBe('OK');
    expect(redisInstances).toHaveLength(1);
    expect(redisInstances[0]?.options).toEqual({ maxRetriesPerRequest: 2 });
    // Connection errors go to the structured log, not "[ioredis] Unhandled error event".
    expect(redisListeners).toEqual(['error']);
  });

  it('returns the store a test sets', () => {
    expect(providerSwitchStore()).toBe(store);
  });
});

describe('replyIfProviderUpgradePending', () => {
  function fakeReply() {
    const send = vi.fn(() => Promise.resolve());
    const status = vi.fn(() => ({ send }));
    return { reply: { status } as unknown as FastifyReply, status, send };
  }

  it('answers 409 with the code and details for a guard refusal', async () => {
    const details = {
      legacyConnections: 2,
      hosts: ['10.0.0.7'],
      lastLegacySeenAt: '2026-10-04T11:59:00.000Z',
      watchCheckedAt: '2026-10-04T11:59:30.000Z',
    };
    const { reply, status, send } = fakeReply();
    await expect(
      replyIfProviderUpgradePending(
        reply,
        new PaymentProviderUpgradePendingError('adyen', details),
      ),
    ).resolves.toBe(true);
    expect(status).toHaveBeenCalledWith(409);
    expect(send).toHaveBeenCalledWith({
      error:
        'A process older than v0.1.38 is still connected. Finish the upgrade, then select Adyen.',
      code: 'PAYMENT_PROVIDER_UPGRADE_PENDING',
      details,
    });
  });

  it('leaves any other error to the caller', async () => {
    const { reply, status } = fakeReply();
    await expect(replyIfProviderUpgradePending(reply, new Error('db down'))).resolves.toBe(false);
    expect(status).not.toHaveBeenCalled();
  });
});
