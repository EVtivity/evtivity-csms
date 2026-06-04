// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

const { mockGetStripeConfig, mockCancelPaymentIntent, selectRows, updateCalls, updateBehavior } =
  vi.hoisted(() => ({
    mockGetStripeConfig: vi.fn(),
    mockCancelPaymentIntent: vi.fn(),
    selectRows: { value: [] as unknown[] },
    updateCalls: [] as { set: unknown; whereArg: unknown }[],
    updateBehavior: { rejectIds: new Set<string>() },
  }));

// db.select().from().where() -> resolves selectRows.
// db.update().set(payload).where(eqArg) -> records the call and resolves/rejects.
let lastSetPayload: unknown;

function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() => Promise.resolve(selectRows.value));
  return chain;
}

function makeUpdateChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain['update'] = vi.fn(() => chain);
  chain['set'] = vi.fn((payload: unknown) => {
    lastSetPayload = payload;
    return chain;
  });
  chain['where'] = vi.fn((whereArg: unknown) => {
    updateCalls.push({ set: lastSetPayload, whereArg });
    const id = (whereArg as { __id?: string }).__id;
    if (id != null && updateBehavior.rejectIds.has(id)) {
      return Promise.reject(new Error('db write failed'));
    }
    return Promise.resolve();
  });
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => makeUpdateChain()),
  },
  guestSessions: {
    id: 'guest_sessions.id',
    status: 'guest_sessions.status',
    expiresAt: 'guest_sessions.expiresAt',
  },
}));

// eq() returns a tagged object so the update mock can correlate the row id.
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ __id: val })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  lte: vi.fn(),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: strings.join('?'), vals }),
    {},
  ),
}));

vi.mock('@evtivity/api/src/services/stripe.service.js', () => ({
  getStripeConfig: mockGetStripeConfig,
  cancelPaymentIntent: mockCancelPaymentIntent,
}));

function makeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

beforeEach(() => {
  mockGetStripeConfig.mockReset().mockResolvedValue({ secretKey: 'sk_test' });
  mockCancelPaymentIntent.mockReset().mockResolvedValue(undefined);
  selectRows.value = [];
  updateCalls.length = 0;
  updateBehavior.rejectIds = new Set();
  lastSetPayload = undefined;
});

describe('guestSessionCleanupHandler', () => {
  it('does nothing and logs no summary when no sessions are expired', async () => {
    selectRows.value = [];
    const { guestSessionCleanupHandler } = await import('../../handlers/guest-session-cleanup.js');
    const log = makeLog();
    await guestSessionCleanupHandler(log);

    expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('cancels the Stripe pre-auth and marks the row expired for a session with a PI', async () => {
    selectRows.value = [{ id: 'gs_1', stripePaymentIntentId: 'pi_1' }];
    const { guestSessionCleanupHandler } = await import('../../handlers/guest-session-cleanup.js');
    const log = makeLog();
    await guestSessionCleanupHandler(log);

    expect(mockGetStripeConfig).toHaveBeenCalledWith(null);
    expect(mockCancelPaymentIntent).toHaveBeenCalledWith({ secretKey: 'sk_test' }, 'pi_1');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.set).toMatchObject({ status: 'expired' });
    expect((updateCalls[0]!.set as { updatedAt: Date }).updatedAt).toBeInstanceOf(Date);
    expect(log.info).toHaveBeenCalledWith({ count: 1 }, 'Expired guest sessions cleaned up');
  });

  it('skips the Stripe cancel for a session without a payment intent but still expires the row', async () => {
    selectRows.value = [{ id: 'gs_2', stripePaymentIntentId: null }];
    const { guestSessionCleanupHandler } = await import('../../handlers/guest-session-cleanup.js');
    await guestSessionCleanupHandler(makeLog());

    expect(mockGetStripeConfig).not.toHaveBeenCalled();
    expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
  });

  it('does not cancel when the Stripe config is null but still expires the row', async () => {
    mockGetStripeConfig.mockResolvedValue(null);
    selectRows.value = [{ id: 'gs_3', stripePaymentIntentId: 'pi_3' }];
    const { guestSessionCleanupHandler } = await import('../../handlers/guest-session-cleanup.js');
    await guestSessionCleanupHandler(makeLog());

    expect(mockGetStripeConfig).toHaveBeenCalledWith(null);
    expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
  });

  it('warns but still expires the row when the Stripe cancel throws (fail-open)', async () => {
    mockCancelPaymentIntent.mockRejectedValue(new Error('PI already cancelled'));
    selectRows.value = [{ id: 'gs_4', stripePaymentIntentId: 'pi_4' }];
    const { guestSessionCleanupHandler } = await import('../../handlers/guest-session-cleanup.js');
    const log = makeLog();
    await expect(guestSessionCleanupHandler(log)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toMatchObject({ guestSessionId: 'gs_4' });
    // DB write still ran despite the cancel failure.
    expect(updateCalls).toHaveLength(1);
  });

  it('logs an error and continues when the DB expire-write throws', async () => {
    updateBehavior.rejectIds = new Set(['gs_5']);
    selectRows.value = [{ id: 'gs_5', stripePaymentIntentId: null }];
    const { guestSessionCleanupHandler } = await import('../../handlers/guest-session-cleanup.js');
    const log = makeLog();
    await expect(guestSessionCleanupHandler(log)).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.error).mock.calls[0]![0]).toMatchObject({ guestSessionId: 'gs_5' });
    // Summary still logged (expired.length > 0).
    expect(log.info).toHaveBeenCalledWith({ count: 1 }, 'Expired guest sessions cleaned up');
  });

  it('processes every expired session and reports the total count', async () => {
    selectRows.value = [
      { id: 'gs_a', stripePaymentIntentId: 'pi_a' },
      { id: 'gs_b', stripePaymentIntentId: null },
      { id: 'gs_c', stripePaymentIntentId: 'pi_c' },
    ];
    const { guestSessionCleanupHandler } = await import('../../handlers/guest-session-cleanup.js');
    const log = makeLog();
    await guestSessionCleanupHandler(log);

    expect(mockCancelPaymentIntent).toHaveBeenCalledTimes(2);
    expect(updateCalls).toHaveLength(3);
    expect(log.info).toHaveBeenCalledWith({ count: 3 }, 'Expired guest sessions cleaned up');
  });
});
