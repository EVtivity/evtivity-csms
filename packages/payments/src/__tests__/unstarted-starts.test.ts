// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => {
  const updateReturns: unknown[][] = [];
  const selectQueue: unknown[][] = [];
  const updates: Array<{ values: Record<string, unknown>; where: unknown }> = [];
  function selectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where']) chain[method] = () => chain;
    chain['then'] = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(selectQueue.shift() ?? []).then(resolve, reject);
    return chain;
  }
  return {
    updateReturns,
    selectQueue,
    updates,
    db: {
      select: vi.fn(() => selectChain()),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => ({
          where: (where: unknown) => {
            updates.push({ values, where });
            return { returning: () => Promise.resolve(updateReturns.shift() ?? []) };
          },
        }),
      })),
    },
    failUnstartedRemoteSession: vi.fn(),
    cancelOpenSessionHold: vi.fn(),
    pinnedProvider: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({
  db: m.db,
  failUnstartedRemoteSession: m.failUnstartedRemoteSession,
  guestSessions: {
    id: 'gs.id',
    status: 'gs.status',
    provider: 'gs.provider',
    providerPaymentId: 'gs.provider_payment_id',
    sessionToken: 'gs.session_token',
    startRequestedAt: 'gs.start_requested_at',
    chargingSessionId: 'gs.charging_session_id',
  },
}));
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (col: unknown, value: unknown) => ({ op: 'eq', col, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    text: strings.join('?'),
    values,
  }),
}));
vi.mock('../session-payments.js', () => ({ cancelOpenSessionHold: m.cancelOpenSessionHold }));
vi.mock('../pinning.js', () => ({ pinnedProvider: m.pinnedProvider }));
vi.mock('../guest-payments.js', () => ({ GUEST_REFERENCE_PREFIX: 'guest_' }));

import { closeUnstartedRemoteStart, failUnstartedGuestSession } from '../unstarted-starts.js';
import type { PaymentContext } from '../context.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx = { registry: { tag: 'registry' }, logger } as unknown as PaymentContext;
const session = {
  id: 'ses_1',
  stationUuid: 'sta_1',
  siteId: 'sit_1',
  driverId: 'drv_1',
  reservationId: null,
};
const cancelHold = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  m.updateReturns.length = 0;
  m.selectQueue.length = 0;
  m.updates.length = 0;
  cancelHold.mockResolvedValue({ state: 'succeeded' });
  m.pinnedProvider.mockResolvedValue({ id: 'stripe', cancelHold });
});

describe('closeUnstartedRemoteStart', () => {
  it('fails the session first, then cancels its open hold', async () => {
    m.failUnstartedRemoteSession.mockResolvedValue({ outcome: 'failed', session });
    m.cancelOpenSessionHold.mockResolvedValue({ status: 'cancelled', paymentRecordId: 9 });

    expect(await closeUnstartedRemoteStart('ses_1', ctx)).toEqual({
      outcome: 'failed',
      session,
      hold: { status: 'cancelled', paymentRecordId: 9 },
    });
    expect(m.failUnstartedRemoteSession).toHaveBeenCalledWith('ses_1');
    expect(m.cancelOpenSessionHold).toHaveBeenCalledWith(
      'ses_1',
      'No EV connected after the remote start',
      ctx,
    );
    expect(m.failUnstartedRemoteSession.mock.invocationCallOrder[0]).toBeLessThan(
      m.cancelOpenSessionHold.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('cancels again for a session a previous attempt already closed', async () => {
    m.failUnstartedRemoteSession.mockResolvedValue({ outcome: 'closed', session });
    m.cancelOpenSessionHold.mockResolvedValue({ status: 'none' });

    expect(await closeUnstartedRemoteStart('ses_1', ctx)).toEqual({
      outcome: 'closed',
      session,
      hold: { status: 'none' },
    });
  });

  it.each(['skipped', 'not_found'] as const)(
    'leaves a %s session and its hold alone',
    async (o) => {
      m.failUnstartedRemoteSession.mockResolvedValue({ outcome: o });

      expect(await closeUnstartedRemoteStart('ses_1', ctx)).toEqual({ outcome: o });
      expect(m.cancelOpenSessionHold).not.toHaveBeenCalled();
    },
  );
});

describe('failUnstartedGuestSession', () => {
  const guest = { provider: 'stripe', paymentId: 'pi_guest', sessionToken: 'tok123' };

  it('fails a payment_authorized guest session and cancels its hold', async () => {
    m.updateReturns.push([guest]);

    expect(await failUnstartedGuestSession(301, ctx)).toEqual({
      outcome: 'failed',
      holdCancelled: true,
    });
    expect(m.updates[0]?.values).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(m.updates[0]?.where)).toContain('payment_authorized');
    expect(m.pinnedProvider).toHaveBeenCalledWith(ctx.registry, 'stripe');
    expect(cancelHold).toHaveBeenCalledWith({
      paymentId: 'pi_guest',
      merchantReference: 'guest_tok123',
      idempotencyKey: 'cancel_pi_guest',
    });
  });

  it('fails a free guest session without a provider call', async () => {
    m.updateReturns.push([{ provider: null, paymentId: null, sessionToken: 'tokfree' }]);

    expect(await failUnstartedGuestSession(302, ctx)).toEqual({
      outcome: 'failed',
      holdCancelled: false,
    });
    expect(m.pinnedProvider).not.toHaveBeenCalled();
  });

  it('cancels again on a retry of a session it already failed', async () => {
    m.updateReturns.push([]);
    m.selectQueue.push([guest]);

    expect(await failUnstartedGuestSession(303, ctx)).toEqual({
      outcome: 'closed',
      holdCancelled: true,
    });
    expect(cancelHold).toHaveBeenCalledTimes(1);
  });

  it('leaves a guest session that charges, ended or expired alone', async () => {
    m.updateReturns.push([]);
    m.selectQueue.push([], [{ id: 304 }]);

    expect(await failUnstartedGuestSession(304, ctx)).toEqual({ outcome: 'skipped' });
    expect(m.pinnedProvider).not.toHaveBeenCalled();
  });

  it('reports an unknown guest session', async () => {
    m.updateReturns.push([]);
    m.selectQueue.push([], []);

    expect(await failUnstartedGuestSession(305, ctx)).toEqual({ outcome: 'not_found' });
  });

  it('throws a provider error so the job retries', async () => {
    m.updateReturns.push([guest]);
    cancelHold.mockRejectedValueOnce(new Error('provider down'));

    await expect(failUnstartedGuestSession(306, ctx)).rejects.toThrow('provider down');
  });
});
