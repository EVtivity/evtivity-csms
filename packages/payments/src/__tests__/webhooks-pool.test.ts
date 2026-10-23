// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The webhook event lock holds one pool connection in its transaction while
// the apply works on others. With at least as many concurrent deliveries as
// pool connections, every connection held a lock and waited for a second
// one, and the process hung. A fake pool of 3 connections
// shared by the lock transactions and the db calls proves every delivery
// completes.

import { describe, it, expect, vi } from 'vitest';

const pool = vi.hoisted(() => {
  const size = 3;
  let free = size;
  let peak = 0;
  const waiting: Array<() => void> = [];
  async function acquire(): Promise<void> {
    if (free > 0) {
      free--;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    peak = Math.max(peak, size - free);
  }
  function release(): void {
    const next = waiting.shift();
    if (next != null) next();
    else free++;
  }
  /** One statement on a pool connection: waits for a free one, then frees it. */
  async function statement<T>(value: T): Promise<T> {
    await acquire();
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    return value;
  }
  return { size, acquire, release, statement, peak: () => peak };
});

vi.mock('@evtivity/database', () => {
  const chain = (value: unknown) => {
    const b: Record<string, unknown> = {};
    for (const m of ['values', 'onConflictDoNothing', 'set', 'from']) b[m] = () => b;
    b['returning'] = () => pool.statement(value);
    b['where'] = () =>
      Object.assign(pool.statement(value), { returning: () => pool.statement(value) });
    return b;
  };
  return {
    client: {
      options: { max: pool.size },
      begin: async (fn: (tx: unknown) => Promise<unknown>) => {
        await pool.acquire();
        try {
          const lockTx = () => Promise.resolve([{ locked: true }]);
          return await fn(lockTx);
        } finally {
          pool.release();
        }
      },
    },
    db: {
      insert: () => chain([{ eventId: 'x' }]),
      update: () => chain([]),
      delete: () => chain([]),
      select: () => chain([]),
    },
    webhookEvents: { provider: 'p', eventId: 'e', processedAt: 'pa' },
  };
});
vi.mock('drizzle-orm', () => ({ and: () => ({}), eq: () => ({}) }));
vi.mock('../payment-records.js', () => ({}));
vi.mock('../session-payments.js', () => ({}));
vi.mock('../guest-payments.js', () => ({ GUEST_REFERENCE_PREFIX: 'guest_' }));
vi.mock('../payout-accounts.js', () => ({}));

import {
  ingestPaymentWebhook,
  webhookLockSlotCount,
  WEBHOOK_APPLY_CONNECTIONS,
} from '../webhooks.js';
import type { PaymentContext } from '../context.js';
import type { PaymentProviderRegistry } from '../registry.js';

describe('webhook lock slots (PP2 Info 1)', () => {
  it('leaves every held lock its apply connections and one connection free', () => {
    // An apply can hold a transaction and write an audit row on the pool at once.
    expect(WEBHOOK_APPLY_CONNECTIONS).toBe(2);
    for (const poolMax of [1, 2, 3, 4, 7, 10, 20, 50]) {
      const slots = webhookLockSlotCount(poolMax);
      expect(slots).toBeGreaterThanOrEqual(1);
      if (poolMax >= 4) {
        expect(slots * (1 + WEBHOOK_APPLY_CONNECTIONS)).toBeLessThanOrEqual(poolMax - 1);
      }
    }
    expect(webhookLockSlotCount(10)).toBe(3);
  });
});

describe('webhook event lock and the connection pool', () => {
  it('completes more concurrent deliveries than pool connections', async () => {
    let n = 0;
    const provider = {
      id: 'stripe',
      // An event the apply ignores, so the apply itself needs no record.
      verifyWebhook: () => [
        { type: 'customer.created', eventId: `evt_${String(++n)}`, occurredAt: new Date() },
      ],
      webhookAck: () => ({ status: 200, contentType: 'application/json', body: '{}' }),
    };
    const ctx: PaymentContext = {
      registry: {
        getPaymentProvider: () => Promise.resolve(provider),
      } as unknown as PaymentProviderRegistry,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const deliveries = Array.from({ length: pool.size * 4 }, () =>
      ingestPaymentWebhook('stripe', 'raw', {}, ctx),
    );
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000));
    const outcome = await Promise.race([Promise.all(deliveries), timeout]);
    expect(outcome).not.toBe('timeout');
    expect(outcome).toHaveLength(pool.size * 4);
    expect(pool.peak()).toBeLessThanOrEqual(pool.size);
  });
});
