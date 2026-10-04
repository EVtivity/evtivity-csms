// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sessionChargeTax } from '@evtivity/lib';

const m = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const updates: Array<{ table: unknown; values: Record<string, unknown>; where?: unknown }> = [];
  const updateReturns: unknown[][] = [];
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const deletes: unknown[] = [];
  const deletedRows: unknown[] = [];
  const failures = { insert: null as Error | null, updates: [] as Array<Error | null> };

  function selectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'innerJoin', 'limit', 'orderBy']) {
      chain[method] = () => chain;
    }
    chain['then'] = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(selectQueue.shift() ?? []).then(resolve, reject);
    return chain;
  }

  const db = {
    select: vi.fn(() => selectChain()),
    update: vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: unknown) => {
          updates.push({ table, values, where });
          const err = failures.updates.shift() ?? null;
          const done = err != null ? Promise.reject(err) : Promise.resolve();
          return {
            then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              done.then(resolve, reject),
            returning: () => done.then(() => updateReturns.shift() ?? [{ id: 21 }]),
          };
        },
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return failures.insert != null ? Promise.reject(failures.insert) : Promise.resolve();
      },
    })),
    delete: vi.fn((table: unknown) => ({
      where: () => {
        deletes.push(table);
        return { returning: () => Promise.resolve(deletedRows.splice(0)) };
      },
    })),
  };

  return {
    selectQueue,
    updates,
    updateReturns,
    inserts,
    deletes,
    deletedRows,
    failures,
    db,
    getCompanyCurrency: vi.fn(),
    getPlatformFeePercent: vi.fn(),
    dispatchSystemNotification: vi.fn(),
    findSessionRecord: vi.fn(),
    markCaptured: vi.fn(),
    markCancelled: vi.fn(),
    markHoldFailed: vi.fn(),
    recordGuestHold: vi.fn(),
    holdTerms: vi.fn(),
    sessionFeeGrossCents: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({
  db: m.db,
  client: { __client: true },
  getCompanyCurrency: m.getCompanyCurrency,
  getPlatformFeePercent: m.getPlatformFeePercent,
  guestSessions: { __table: 'guest_sessions', provider: 'gs.provider' },
  chargingSessions: { __table: 'charging_sessions' },
  chargingStations: { __table: 'charging_stations' },
  sessionFeeGrossCents: m.sessionFeeGrossCents,
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  lte: (a: unknown, b: unknown) => ({ lte: [a, b] }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: strings.join('?'),
    values,
  }),
}));

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchSystemNotification: m.dispatchSystemNotification,
}));

vi.mock('../payment-records.js', () => ({
  findSessionRecord: m.findSessionRecord,
  markCaptured: m.markCaptured,
  markCancelled: m.markCancelled,
  markHoldFailed: m.markHoldFailed,
  recordGuestHold: m.recordGuestHold,
}));

vi.mock('../session-payments.js', () => ({ holdTerms: m.holdTerms }));

import {
  attachGuestAuthorisation,
  authorizeGuestHold,
  claimGuestStart,
  continueGuestHold,
  expireGuestSessions,
  failExhaustedGuestCapture,
  guestHoldTerms,
  handleGuestSessionEvent,
  rollbackGuestStart,
} from '../guest-payments.js';
import type { GuestEventDeps, GuestHoldInput } from '../guest-payments.js';
import { PaymentDeclinedError, PaymentProviderNotConfiguredError } from '../errors.js';
import type { PaymentProviderRegistry } from '../registry.js';

const provider = {
  id: 'stripe',
  authorizeHold: vi.fn(),
  continueHold: vi.fn(),
  capture: vi.fn(),
  cancelHold: vi.fn(),
};
const registry = {
  getPaymentProvider: vi.fn(),
  getActivePaymentProvider: vi.fn(),
  settings: vi.fn(),
};
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const deps: GuestEventDeps = {
  registry: registry as unknown as PaymentProviderRegistry,
  logger,
  templatesDirs: ['/templates'],
};

const TERMS = {
  preAuthAmountCents: 5000,
  sitePaymentConfigId: 3,
  payoutAccountId: 'acct_site',
  payoutBlocked: false,
};

function guestTable(): unknown {
  return { __table: 'guest_sessions', provider: 'gs.provider' };
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 11,
    status: 'pre_authorized',
    provider: 'stripe',
    providerPaymentId: 'pi_1',
    preAuthAmountCents: 5000,
    currency: 'EUR',
    ...overrides,
  };
}

function finalizeGuest(): Record<string, unknown> {
  return { id: 21, guestEmail: 'guest@example.com', stationOcppId: 'CS-1' };
}

function chargedSession(finalCostCents: number | null): Record<string, unknown> {
  return { finalCostCents, tariffTaxRate: null, costBreakdown: null, siteId: 'site_1' };
}

function receiptSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    energyDeliveredWh: '12000',
    finalCostCents: 800,
    tariffTaxRate: null,
    currency: 'EUR',
    startedAt: '2026-01-01T10:00:00Z',
    endedAt: '2026-01-01T10:30:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  m.selectQueue.length = 0;
  m.updates.length = 0;
  m.updateReturns.length = 0;
  m.inserts.length = 0;
  m.deletes.length = 0;
  m.deletedRows.length = 0;
  m.failures.insert = null;
  m.failures.updates = [];
  m.getCompanyCurrency.mockResolvedValue('EUR');
  m.getPlatformFeePercent.mockResolvedValue(10);
  m.dispatchSystemNotification.mockResolvedValue(undefined);
  m.findSessionRecord.mockResolvedValue(null);
  m.markCaptured.mockResolvedValue(true);
  m.markCancelled.mockResolvedValue(true);
  m.markHoldFailed.mockResolvedValue(true);
  m.recordGuestHold.mockResolvedValue(11);
  m.holdTerms.mockResolvedValue(TERMS);
  provider.authorizeHold.mockResolvedValue({
    status: 'authorized',
    paymentId: 'pi_new',
    authorizedCents: 5000,
  });
  provider.capture.mockResolvedValue({ capturedCents: 0, applicationFeeCents: 0 });
  provider.cancelHold.mockResolvedValue({ status: 'succeeded' });
  registry.getPaymentProvider.mockResolvedValue(provider);
  registry.getActivePaymentProvider.mockResolvedValue(provider);
});

describe('handleGuestSessionEvent: TransactionStarted', () => {
  it('links the guest session and records its hold in the session currency', async () => {
    m.selectQueue.push(
      [
        {
          id: 21,
          stationOcppId: 'CS-1',
          provider: 'stripe',
          providerPaymentId: 'pi_1',
          preAuthAmountCents: 5000,
        },
      ],
      [{ siteId: 'site_1' }],
      [{ currency: 'GBP' }],
    );

    await handleGuestSessionEvent(
      { type: 'TransactionStarted', sessionId: 'ses_1', idToken: { idToken: 'tok_1' } },
      deps,
    );

    expect(m.updates).toHaveLength(1);
    expect(m.updates[0]?.table).toEqual(guestTable());
    expect(m.updates[0]?.values).toMatchObject({ chargingSessionId: 'ses_1', status: 'charging' });
    expect(m.holdTerms).toHaveBeenCalledWith(deps, 'site_1');
    expect(m.recordGuestHold).toHaveBeenCalledWith({
      sessionId: 'ses_1',
      sitePaymentConfigId: 3,
      provider: 'stripe',
      paymentId: 'pi_1',
      currency: 'GBP',
      preAuthAmountCents: 5000,
    });
    expect(m.getCompanyCurrency).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { guestSessionId: 21, chargingSessionId: 'ses_1' },
      'Linked guest session to charging session',
    );
  });

  it('falls back to no site and the company currency when station and session are missing', async () => {
    m.selectQueue.push(
      [
        {
          id: 21,
          stationOcppId: 'CS-1',
          provider: 'stripe',
          providerPaymentId: 'pi_1',
          preAuthAmountCents: null,
        },
      ],
      [],
      [],
    );

    await handleGuestSessionEvent(
      { type: 'TransactionStarted', sessionId: 'ses_1', idToken: { idToken: 'tok_1' } },
      deps,
    );

    expect(m.holdTerms).toHaveBeenCalledWith(deps, null);
    expect(m.recordGuestHold).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'EUR', preAuthAmountCents: null }),
    );
  });

  it('links a guest session without a hold and records no payment', async () => {
    m.selectQueue.push([{ id: 21, stationOcppId: 'CS-1', providerPaymentId: null }]);

    await handleGuestSessionEvent(
      { type: 'TransactionStarted', sessionId: 'ses_1', idToken: { idToken: 'tok_1' } },
      deps,
    );

    expect(m.updates).toHaveLength(1);
    expect(m.recordGuestHold).not.toHaveBeenCalled();
  });

  it('logs and records no payment for a hold without a provider', async () => {
    m.selectQueue.push([
      { id: 21, stationOcppId: 'CS-1', provider: null, providerPaymentId: 'pi_1' },
    ]);

    await handleGuestSessionEvent(
      { type: 'TransactionStarted', sessionId: 'ses_1', idToken: { idToken: 'tok_1' } },
      deps,
    );

    expect(m.updates).toHaveLength(1);
    expect(m.recordGuestHold).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      { guestSessionId: 21, paymentId: 'pi_1' },
      'Guest hold has no provider; its payment record was not written',
    );
  });

  it('is a no-op when no authorized guest session matches the token', async () => {
    m.selectQueue.push([]);

    await handleGuestSessionEvent(
      { type: 'TransactionStarted', sessionId: 'ses_1', idToken: { idToken: 'tok_x' } },
      deps,
    );

    expect(m.updates).toHaveLength(0);
    expect(m.recordGuestHold).not.toHaveBeenCalled();
  });

  it('does not link when the event has no sessionId', async () => {
    m.selectQueue.push([
      { id: 21, stationOcppId: 'CS-1', provider: 'stripe', providerPaymentId: 'pi_1' },
    ]);

    await handleGuestSessionEvent(
      { type: 'TransactionStarted', idToken: { idToken: 'tok_1' } },
      deps,
    );

    expect(m.updates).toHaveLength(0);
  });

  it('ignores a TransactionStarted without an idToken', async () => {
    await handleGuestSessionEvent({ type: 'TransactionStarted', sessionId: 'ses_1' }, deps);

    expect(m.db.select).not.toHaveBeenCalled();
  });
});

describe('handleGuestSessionEvent: TransactionEnded', () => {
  async function end(): Promise<void> {
    await handleGuestSessionEvent({ type: 'TransactionEnded', sessionId: 'ses_1' }, deps);
  }

  it('captures a cost below the hold and sends the receipt', async () => {
    m.findSessionRecord.mockResolvedValue(record());
    m.selectQueue.push([finalizeGuest()], [chargedSession(800)], [receiptSession()]);

    await end();

    expect(registry.getPaymentProvider).toHaveBeenCalledWith('stripe');
    expect(provider.capture).toHaveBeenCalledWith({
      paymentId: 'pi_1',
      amountCents: 800,
      currency: 'EUR',
      merchantReference: 'sess_ses_1',
      payoutAccountId: null,
      feeTax: sessionChargeTax({ finalCostCents: 800, tariffTaxRate: null, costBreakdown: null }),
      platformFeePercent: 10,
      idempotencyKey: 'capture_pi_1',
    });
    expect(m.getPlatformFeePercent).toHaveBeenCalledWith('site_1');
    expect(m.markCaptured).toHaveBeenCalledWith(11, {
      capturedCents: 800,
      failureReason: null,
      pendingRef: null,
    });
    expect(m.updates.at(-1)?.values).toMatchObject({ status: 'completed' });
    expect(m.dispatchSystemNotification).toHaveBeenCalledWith(
      { __client: true },
      'session.Receipt',
      { email: 'guest@example.com' },
      expect.objectContaining({
        stationId: 'CS-1',
        energyDeliveredWh: 12000,
        finalCostCents: 800,
        currency: 'EUR',
        costIncludesTax: false,
        durationMinutes: 30,
        startedAt: '2026-01-01T10:00:00.000Z',
        endedAt: '2026-01-01T10:30:00.000Z',
      }),
      ['/templates'],
    );
  });

  it('captures at most the hold and records the uncollected rest as a guest shortfall', async () => {
    m.findSessionRecord.mockResolvedValue(record({ preAuthAmountCents: 5000 }));
    m.selectQueue.push([finalizeGuest()], [chargedSession(6000)], [receiptSession()]);

    await end();

    expect(provider.capture).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5000, idempotencyKey: 'capture_pi_1' }),
    );
    const [, captured] = m.markCaptured.mock.calls[0] as [number, { failureReason: string }];
    expect(captured).toMatchObject({ capturedCents: 5000 });
    expect(captured.failureReason).toMatch(
      /^Guest shortfall: hold 5000c captured, 1000c uncollected/,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ finalCost: 6000, holdCents: 5000, shortfallCents: 1000 }),
      'Guest session cost exceeds the hold; captured the hold, shortfall uncollected',
    );
  });

  it('captures the full cost when the record has no hold amount', async () => {
    m.findSessionRecord.mockResolvedValue(record({ preAuthAmountCents: null }));
    m.selectQueue.push([finalizeGuest()], [chargedSession(9000)], [receiptSession()]);

    await end();

    expect(provider.capture).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 9000 }));
    expect(m.markCaptured).toHaveBeenCalledWith(11, {
      capturedCents: 9000,
      failureReason: null,
      pendingRef: null,
    });
  });

  it('cancels the hold at a cost of 0', async () => {
    m.findSessionRecord.mockResolvedValue(record());
    m.selectQueue.push([finalizeGuest()], [chargedSession(null)], [receiptSession()]);

    await end();

    expect(provider.capture).not.toHaveBeenCalled();
    expect(provider.cancelHold).toHaveBeenCalledWith({
      paymentId: 'pi_1',
      merchantReference: 'sess_ses_1',
      idempotencyKey: 'cancel_pi_1',
    });
    expect(m.markCancelled).toHaveBeenCalledWith(11, null);
    expect(m.updates.at(-1)?.values).toMatchObject({ status: 'completed' });
  });

  it.each(['captured', 'cancelled', 'failed'])('skips a record already %s', async (status) => {
    m.findSessionRecord.mockResolvedValue(record({ status }));
    m.selectQueue.push([finalizeGuest()]);

    await end();

    expect(provider.capture).not.toHaveBeenCalled();
    expect(provider.cancelHold).not.toHaveBeenCalled();
    expect(m.updates).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRecordId: 11, status }),
      'Skipping guest payment finalization, already terminal',
    );
  });

  it('completes a free session without a record and sends the receipt', async () => {
    m.findSessionRecord.mockResolvedValue(null);
    m.selectQueue.push([finalizeGuest()], [receiptSession({ finalCostCents: 0 })]);

    await end();

    expect(registry.getPaymentProvider).not.toHaveBeenCalled();
    expect(m.updates).toHaveLength(1);
    expect(m.updates[0]?.values).toMatchObject({ status: 'completed' });
    expect(m.dispatchSystemNotification).toHaveBeenCalledTimes(1);
  });

  it('completes a session whose record has no payment id', async () => {
    m.findSessionRecord.mockResolvedValue(record({ providerPaymentId: null }));
    m.selectQueue.push([finalizeGuest()], [receiptSession()]);

    await end();

    expect(provider.capture).not.toHaveBeenCalled();
    expect(m.updates[0]?.values).toMatchObject({ status: 'completed' });
  });

  it('completes the guest session when the pinned provider is not configured', async () => {
    m.findSessionRecord.mockResolvedValue(record());
    m.selectQueue.push([finalizeGuest()], [chargedSession(800)]);
    registry.getPaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('stripe'));

    await end();

    expect(provider.capture).not.toHaveBeenCalled();
    expect(m.updates[0]?.values).toMatchObject({ status: 'completed' });
    expect(logger.error).toHaveBeenCalledWith(
      { guestSessionId: 21 },
      'No payment provider for guest payment capture',
    );
    expect(m.dispatchSystemNotification).not.toHaveBeenCalled();
  });

  it('rethrows any other provider lookup error', async () => {
    m.findSessionRecord.mockResolvedValue(record());
    m.selectQueue.push([finalizeGuest()], [chargedSession(800)]);
    registry.getPaymentProvider.mockRejectedValue(new Error('registry down'));

    await expect(end()).rejects.toThrow('registry down');
    expect(m.updates).toHaveLength(0);
  });

  it('finishes a simulated hold with the simulated provider', async () => {
    m.findSessionRecord.mockResolvedValue(
      record({ provider: 'simulated', providerPaymentId: 'pi_sim_1' }),
    );
    m.selectQueue.push([finalizeGuest()], [chargedSession(800)], [receiptSession()]);

    await end();

    expect(registry.getPaymentProvider).toHaveBeenCalledWith('simulated');
  });

  it('marks the record failed and rethrows when the capture fails', async () => {
    m.findSessionRecord.mockResolvedValue(record());
    m.selectQueue.push([finalizeGuest()], [chargedSession(800)]);
    provider.capture.mockRejectedValue(new Error('card declined'));

    await expect(end()).rejects.toThrow('card declined');

    expect(m.markHoldFailed).toHaveBeenCalledWith(11, 'card declined');
    expect(m.markCaptured).not.toHaveBeenCalled();
    expect(m.updates).toHaveLength(0);
    expect(m.dispatchSystemNotification).not.toHaveBeenCalled();
  });

  it('uses the Unknown payment error fallback for a non-Error throw', async () => {
    m.findSessionRecord.mockResolvedValue(record());
    m.selectQueue.push([finalizeGuest()], [chargedSession(800)]);
    provider.capture.mockRejectedValue('weird');

    await expect(end()).rejects.toBe('weird');
    expect(m.markHoldFailed).toHaveBeenCalledWith(11, 'Unknown payment error');
  });

  it('returns when the charging session row is missing', async () => {
    m.findSessionRecord.mockResolvedValue(record());
    m.selectQueue.push([finalizeGuest()], []);

    await end();

    expect(registry.getPaymentProvider).not.toHaveBeenCalled();
    expect(m.updates).toHaveLength(0);
  });

  it('is a no-op when no guest session is linked', async () => {
    m.selectQueue.push([]);

    await end();

    expect(m.findSessionRecord).not.toHaveBeenCalled();
  });

  it('sends no receipt to a guest without an email', async () => {
    m.findSessionRecord.mockResolvedValue(null);
    m.selectQueue.push([{ ...finalizeGuest(), guestEmail: '' }]);

    await end();

    expect(m.dispatchSystemNotification).not.toHaveBeenCalled();
  });

  it('skips the receipt when the charging session is missing at receipt time', async () => {
    m.findSessionRecord.mockResolvedValue(null);
    m.selectQueue.push([finalizeGuest()], []);

    await end();

    expect(m.dispatchSystemNotification).not.toHaveBeenCalled();
  });

  it('formats a taxed receipt and defaults missing values', async () => {
    m.findSessionRecord.mockResolvedValue(null);
    m.selectQueue.push(
      [finalizeGuest()],
      [
        receiptSession({
          energyDeliveredWh: null,
          finalCostCents: 1190,
          tariffTaxRate: '0.19',
          startedAt: null,
          endedAt: null,
        }),
      ],
    );

    await end();

    expect(m.dispatchSystemNotification).toHaveBeenCalledWith(
      expect.anything(),
      'session.Receipt',
      expect.anything(),
      expect.objectContaining({
        energyDeliveredWh: 0,
        finalCostCents: 1190,
        costIncludesTax: true,
        durationMinutes: 0,
      }),
      ['/templates'],
    );
  });

  it('logs and swallows a receipt notification failure', async () => {
    m.findSessionRecord.mockResolvedValue(null);
    m.selectQueue.push([finalizeGuest()], [receiptSession()]);
    m.dispatchSystemNotification.mockRejectedValue(new Error('smtp down'));

    await expect(end()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ guestSessionId: 21 }),
      'Failed to send guest receipt notification',
    );
  });

  it('ignores an unrelated event type', async () => {
    await handleGuestSessionEvent({ type: 'StatusNotification', sessionId: 'ses_1' }, deps);

    expect(m.db.select).not.toHaveBeenCalled();
  });
});

describe('guestHoldTerms', () => {
  it('holds the session fee plus the configured hold when the hold is below the fee', async () => {
    m.holdTerms.mockResolvedValue({ ...TERMS, preAuthAmountCents: 50 });
    m.selectQueue.push([{ id: 'sta_1' }]);
    m.sessionFeeGrossCents.mockResolvedValue(217);
    expect(await guestHoldTerms(deps, 'site_1', 'CS-1')).toEqual({
      ...TERMS,
      preAuthAmountCents: 267,
      sessionFeeCents: 217,
    });
    expect(m.sessionFeeGrossCents).toHaveBeenCalledWith(
      { stationUuid: 'sta_1', driverUuid: null },
      { __client: true },
    );
  });

  it('keeps a hold that covers the session fee', async () => {
    m.selectQueue.push([{ id: 'sta_1' }]);
    m.sessionFeeGrossCents.mockResolvedValue(217);
    expect(await guestHoldTerms(deps, 'site_1', 'CS-1')).toEqual({
      ...TERMS,
      sessionFeeCents: 217,
    });
  });

  it('keeps the hold for an unknown station', async () => {
    m.selectQueue.push([]);
    expect(await guestHoldTerms(deps, 'site_1', 'CS-X')).toEqual({ ...TERMS, sessionFeeCents: 0 });
    expect(m.sessionFeeGrossCents).not.toHaveBeenCalled();
  });
});

describe('authorizeGuestHold', () => {
  const input: GuestHoldInput = {
    sessionToken: 'tok_1',
    stationOcppId: 'CS-1',
    evseId: 1,
    siteId: 'site_1',
    methodPayload: 'pm_card',
    guestEmail: 'guest@example.com',
    maxCostCents: 9000,
    maxEnergyWh: 20000,
    maxTimeSeconds: 3600,
    expiresAt: new Date('2026-01-01T11:00:00Z'),
  };

  it('returns not_configured when payments are off', async () => {
    registry.getActivePaymentProvider.mockResolvedValue(null);

    expect(await authorizeGuestHold(input, deps)).toEqual({ outcome: 'not_configured' });
    expect(provider.authorizeHold).not.toHaveBeenCalled();
  });

  it('returns not_configured when the active provider is not available', async () => {
    registry.getActivePaymentProvider.mockRejectedValue(
      new PaymentProviderNotConfiguredError('adyen'),
    );

    expect(await authorizeGuestHold(input, deps)).toEqual({ outcome: 'not_configured' });
  });

  it('returns not_configured when the selected provider has no credentials', async () => {
    registry.getActivePaymentProvider.mockRejectedValue(
      new PaymentProviderNotConfiguredError('adyen'),
    );

    expect(await authorizeGuestHold(input, deps)).toEqual({ outcome: 'not_configured' });
  });

  it('rethrows an unexpected provider lookup error', async () => {
    registry.getActivePaymentProvider.mockRejectedValue(new Error('settings unreadable'));

    await expect(authorizeGuestHold(input, deps)).rejects.toThrow('settings unreadable');
  });

  it('declines before any provider call when the payout account is not ready', async () => {
    m.holdTerms.mockResolvedValue({ ...TERMS, payoutAccountId: null, payoutBlocked: true });

    expect(await authorizeGuestHold(input, deps)).toEqual({
      outcome: 'declined',
      reason: 'This site cannot accept card payments yet',
    });
    expect(provider.authorizeHold).not.toHaveBeenCalled();
    expect(m.inserts).toHaveLength(0);
  });

  it('places the hold, stores the guest session and caps the cost at the hold', async () => {
    const result = await authorizeGuestHold(input, deps);

    expect(result).toEqual({
      outcome: 'authorized',
      paymentId: 'pi_new',
      preAuthAmountCents: 5000,
    });
    expect(m.holdTerms).toHaveBeenCalledWith(deps, 'site_1');
    expect(provider.authorizeHold).toHaveBeenCalledWith({
      method: { kind: 'one_time', payload: 'pm_card' },
      initiator: 'shopper',
      merchantReference: 'guest_tok_1',
      amountCents: 5000,
      currency: 'EUR',
      payoutAccountId: 'acct_site',
      receiptEmail: 'guest@example.com',
      idempotencyKey: 'guest_preauth_tok_1',
    });
    expect(m.inserts).toHaveLength(1);
    expect(m.inserts[0]?.table).toEqual(guestTable());
    expect(m.inserts[0]?.values).toEqual({
      stationOcppId: 'CS-1',
      evseId: 1,
      provider: 'stripe',
      providerPaymentId: 'pi_new',
      stripePaymentIntentId: 'pi_new',
      guestEmail: 'guest@example.com',
      preAuthAmountCents: 5000,
      status: 'payment_authorized',
      startRequestedAt: expect.any(Date),
      sessionToken: 'tok_1',
      expiresAt: input.expiresAt,
      maxCostCents: 5000,
      maxEnergyWh: 20000,
      maxTimeSeconds: 3600,
    });
  });

  it('keeps a cost limit below the hold and defaults a missing one to the hold', async () => {
    await authorizeGuestHold({ ...input, maxCostCents: 1200 }, deps);
    await authorizeGuestHold({ ...input, maxCostCents: null }, deps);

    expect(m.inserts[0]?.values['maxCostCents']).toBe(1200);
    expect(m.inserts[1]?.values['maxCostCents']).toBe(5000);
  });

  it('returns declined with the provider message', async () => {
    provider.authorizeHold.mockRejectedValue(new PaymentDeclinedError('Your card was declined.'));

    expect(await authorizeGuestHold(input, deps)).toEqual({
      outcome: 'declined',
      reason: 'Your card was declined.',
    });
    expect(m.inserts).toHaveLength(0);
  });

  it('returns declined with a fallback reason for a non-Error throw', async () => {
    provider.authorizeHold.mockRejectedValue('weird');

    expect(await authorizeGuestHold(input, deps)).toEqual({
      outcome: 'declined',
      reason: 'Payment failed',
    });
  });

  it('returns not_configured when the provider reports missing credentials on the hold', async () => {
    provider.authorizeHold.mockRejectedValue(new PaymentProviderNotConfiguredError('stripe'));

    expect(await authorizeGuestHold(input, deps)).toEqual({ outcome: 'not_configured' });
  });

  it('cancels a hold that needs authentication and declines it', async () => {
    provider.authorizeHold.mockResolvedValue({
      status: 'action_required',
      paymentId: 'pi_3ds',
      action: { type: 'redirect' },
    });

    expect(await authorizeGuestHold(input, deps)).toEqual({
      outcome: 'declined',
      reason: 'Your card requires authentication.',
    });
    expect(provider.cancelHold).toHaveBeenCalledWith({
      paymentId: 'pi_3ds',
      merchantReference: 'guest_tok_1',
      idempotencyKey: 'cancel_pi_3ds',
    });
    expect(m.inserts).toHaveLength(0);
  });

  it('declines an action without a payment id and cancels nothing', async () => {
    provider.authorizeHold.mockResolvedValue({
      status: 'action_required',
      paymentId: null,
      action: { type: 'redirect' },
    });

    expect(await authorizeGuestHold(input, deps)).toMatchObject({ outcome: 'declined' });
    expect(provider.cancelHold).not.toHaveBeenCalled();
  });

  it('still declines when cancelling the pending hold fails', async () => {
    provider.authorizeHold.mockResolvedValue({
      status: 'action_required',
      paymentId: 'pi_3ds',
      action: { type: 'redirect' },
    });
    provider.cancelHold.mockRejectedValue(new Error('provider 500'));

    expect(await authorizeGuestHold(input, deps)).toMatchObject({ outcome: 'declined' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'pi_3ds' }),
      'Failed to cancel the guest hold',
    );
  });

  it('cancels the hold and rethrows when the guest session cannot be stored', async () => {
    m.failures.insert = new Error('unique violation');

    await expect(authorizeGuestHold(input, deps)).rejects.toThrow('unique violation');

    expect(provider.cancelHold).toHaveBeenCalledWith({
      paymentId: 'pi_new',
      merchantReference: 'guest_tok_1',
      idempotencyKey: 'cancel_pi_new',
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'pi_new', sessionToken: 'tok_1' }),
      'guest_sessions insert failed after the hold; cancelling it',
    );
  });
});

describe('rollbackGuestStart', () => {
  it('deletes the guest session and cancels its hold with the provider of the row', async () => {
    m.deletedRows.push({ provider: 'stripe' });
    await rollbackGuestStart({ sessionToken: 'tok_1', paymentId: 'pi_1' }, deps);

    expect(m.deletes).toEqual([guestTable()]);
    expect(registry.getPaymentProvider).toHaveBeenCalledWith('stripe');
    expect(provider.cancelHold).toHaveBeenCalledWith({
      paymentId: 'pi_1',
      merchantReference: 'guest_tok_1',
      idempotencyKey: 'cancel_pi_1',
    });
  });

  it('only deletes the guest session when there is no hold', async () => {
    await rollbackGuestStart({ sessionToken: 'tok_1', paymentId: null }, deps);

    expect(m.deletes).toHaveLength(1);
    expect(registry.getPaymentProvider).not.toHaveBeenCalled();
  });

  it('warns when the deleted row has no provider', async () => {
    await rollbackGuestStart({ sessionToken: 'tok_1', paymentId: 'pi_1' }, deps);
    expect(registry.getPaymentProvider).not.toHaveBeenCalled();
    expect(provider.cancelHold).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'pi_1' }),
      'Failed to cancel guest PaymentIntent after start failure',
    );
  });

  it('warns when the hold provider is not available', async () => {
    m.deletedRows.push({ provider: 'stripe' });
    registry.getPaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('stripe'));

    await expect(
      rollbackGuestStart({ sessionToken: 'tok_1', paymentId: 'pi_1' }, deps),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'pi_1' }),
      'Failed to cancel guest PaymentIntent after start failure',
    );
  });
});

describe('failExhaustedGuestCapture', () => {
  it('fails the guest session and the hold record and cancels the hold', async () => {
    m.findSessionRecord.mockResolvedValue(record());

    await failExhaustedGuestCapture('ses_1', 'capture failed', deps);

    expect(m.updates[0]?.table).toEqual(guestTable());
    expect(m.updates[0]?.values).toMatchObject({ status: 'failed' });
    expect(m.markHoldFailed).toHaveBeenCalledWith(
      11,
      'Capture worker exhausted retries: capture failed',
    );
    expect(provider.cancelHold).toHaveBeenCalledWith({
      paymentId: 'pi_1',
      merchantReference: 'sess_ses_1',
      idempotencyKey: 'cancel_pi_1',
    });
  });

  it('stops after the guest session when no hold is open', async () => {
    m.findSessionRecord.mockResolvedValue(record({ status: 'captured' }));

    await failExhaustedGuestCapture('ses_1', 'boom', deps);

    expect(m.updates).toHaveLength(1);
    expect(m.markHoldFailed).not.toHaveBeenCalled();
    expect(provider.cancelHold).not.toHaveBeenCalled();
  });

  it('stops after the guest session when there is no record', async () => {
    m.findSessionRecord.mockResolvedValue(null);

    await failExhaustedGuestCapture('ses_1', 'boom', deps);

    expect(m.markHoldFailed).not.toHaveBeenCalled();
  });

  it('records the failure but cancels nothing without a payment id', async () => {
    m.findSessionRecord.mockResolvedValue(record({ providerPaymentId: null }));

    await failExhaustedGuestCapture('ses_1', 'boom', deps);

    expect(m.markHoldFailed).toHaveBeenCalledTimes(1);
    expect(registry.getPaymentProvider).not.toHaveBeenCalled();
  });

  it('warns when the cancel fails (the hold expires by itself)', async () => {
    m.findSessionRecord.mockResolvedValue(record());
    provider.cancelHold.mockRejectedValue(new Error('provider 500'));

    await expect(failExhaustedGuestCapture('ses_1', 'boom', deps)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_1', paymentRecordId: 11 }),
      'Failed to cancel the guest hold after exhausted retries; it expires by itself',
    );
  });
});

describe('expireGuestSessions', () => {
  it('cancels each hold and marks every expired session expired', async () => {
    m.selectQueue.push([
      { id: 1, provider: 'stripe', providerPaymentId: 'pi_a', sessionToken: 'tok_a' },
      { id: 2, providerPaymentId: null, sessionToken: 'tok_b' },
      { id: 3, provider: 'simulated', providerPaymentId: 'pi_sim_c', sessionToken: 'tok_c' },
    ]);

    expect(await expireGuestSessions(deps)).toBe(3);

    expect(provider.cancelHold).toHaveBeenCalledTimes(2);
    expect(provider.cancelHold).toHaveBeenCalledWith({
      paymentId: 'pi_a',
      merchantReference: 'guest_tok_a',
      idempotencyKey: 'cancel_pi_a',
    });
    expect(registry.getPaymentProvider).toHaveBeenCalledWith('simulated');
    expect(m.updates).toHaveLength(3);
    for (const update of m.updates) {
      expect(update.values).toMatchObject({ status: 'expired' });
    }
  });

  it('returns 0 when nothing expired', async () => {
    m.selectQueue.push([]);

    expect(await expireGuestSessions(deps)).toBe(0);
    expect(m.updates).toHaveLength(0);
  });

  it('still expires the row when the cancel fails', async () => {
    m.selectQueue.push([
      { id: 4, provider: 'stripe', providerPaymentId: 'pi_d', sessionToken: 'tok_d' },
    ]);
    provider.cancelHold.mockRejectedValue(new Error('already cancelled'));

    expect(await expireGuestSessions(deps)).toBe(1);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ guestSessionId: 4 }),
      'Failed to cancel the guest hold on expiry; it expires by itself',
    );
    expect(m.updates).toHaveLength(1);
  });

  it('logs and continues when marking a row expired fails', async () => {
    m.selectQueue.push([
      { id: 5, providerPaymentId: null, sessionToken: 'tok_e' },
      { id: 6, providerPaymentId: null, sessionToken: 'tok_f' },
    ]);
    m.failures.updates = [new Error('db write failed')];

    expect(await expireGuestSessions(deps)).toBe(2);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ guestSessionId: 5 }),
      'Failed to mark guest session expired',
    );
    expect(m.updates).toHaveLength(2);
  });
});

describe('guest 3DS round trip (P10a)', () => {
  const browser = { origin: 'https://portal.example', returnUrl: 'https://portal.example/r' };
  const input: GuestHoldInput = {
    sessionToken: 'tok_1',
    stationOcppId: 'CS-1',
    evseId: 1,
    siteId: 'site_1',
    methodPayload: { paymentMethod: { type: 'scheme' } },
    browser,
    guestEmail: 'guest@example.com',
    maxCostCents: null,
    maxEnergyWh: null,
    maxTimeSeconds: null,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  };
  const action = { provider: 'adyen', data: { type: 'redirect' } };
  const adyen = { ...provider, id: 'adyen' };

  function waiting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 21,
      status: 'pending_payment',
      provider: 'adyen',
      providerPaymentId: null,
      preAuthAmountCents: 5000,
      expiresAt: new Date('2099-01-01T00:00:00Z'),
      ...overrides,
    };
  }

  beforeEach(() => {
    registry.getActivePaymentProvider.mockResolvedValue(adyen);
    registry.getPaymentProvider.mockResolvedValue(adyen);
  });

  it('stores a pending_payment session without Stripe ids and returns the client action', async () => {
    // activeProvider refuses adyen until the guard part lands; the shape is
    // the same for any provider with client actions.
    registry.getActivePaymentProvider.mockResolvedValue(provider);
    provider.authorizeHold.mockResolvedValue({
      status: 'action_required',
      paymentId: null,
      action,
    });

    expect(await authorizeGuestHold(input, deps)).toEqual({ outcome: 'action_required', action });
    expect(provider.authorizeHold).toHaveBeenCalledWith(
      expect.objectContaining({
        method: { kind: 'one_time', payload: input.methodPayload, browser },
        initiator: 'shopper',
        merchantReference: 'guest_tok_1',
      }),
    );
    expect(provider.cancelHold).not.toHaveBeenCalled();
    expect(m.inserts[0]?.values).toMatchObject({
      provider: 'stripe',
      providerPaymentId: null,
      stripePaymentIntentId: null,
      status: 'pending_payment',
      startRequestedAt: null,
    });
  });

  it('continues with the details and authorizes the waiting session', async () => {
    m.selectQueue.push([waiting()]);
    adyen.continueHold.mockResolvedValue({
      status: 'authorized',
      paymentId: 'PSP1',
      authorizedCents: 5000,
    });

    expect(
      await continueGuestHold({ sessionToken: 'tok_1', details: { redirectResult: 'abc' } }, deps),
    ).toEqual({ outcome: 'authorized', paymentId: 'PSP1', preAuthAmountCents: 5000 });
    const call = adyen.continueHold.mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(call).toMatchObject({ paymentId: null, details: { redirectResult: 'abc' } });
    expect(call.idempotencyKey).toMatch(/^guest_details_tok_1_[0-9a-f]{24}$/);
    expect(call.idempotencyKey.length).toBeLessThanOrEqual(64);
    expect(m.updates.at(-1)?.values).toMatchObject({
      providerPaymentId: 'PSP1',
      stripePaymentIntentId: null,
      status: 'payment_authorized',
    });
  });

  it('answers a session the webhook already authorized without a provider call', async () => {
    m.selectQueue.push([waiting({ status: 'payment_authorized', providerPaymentId: 'PSP1' })]);
    expect(await continueGuestHold({ sessionToken: 'tok_1', details: {} }, deps)).toEqual({
      outcome: 'authorized',
      paymentId: 'PSP1',
      preAuthAmountCents: 5000,
    });
    expect(adyen.continueHold).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown token', []],
    ['an expired session', [waiting({ expiresAt: new Date('2000-01-01T00:00:00Z') })]],
    ['a failed session', [waiting({ status: 'failed' })]],
  ])('returns not_pending for %s', async (_label, rows) => {
    m.selectQueue.push(rows);
    expect(await continueGuestHold({ sessionToken: 'tok_1', details: {} }, deps)).toEqual({
      outcome: 'not_pending',
    });
    expect(adyen.continueHold).not.toHaveBeenCalled();
  });

  it('returns another client action and stores a payment id it learns', async () => {
    m.selectQueue.push([waiting()]);
    adyen.continueHold.mockResolvedValue({ status: 'action_required', paymentId: 'PSP1', action });
    expect(await continueGuestHold({ sessionToken: 'tok_1', details: {} }, deps)).toEqual({
      outcome: 'action_required',
      action,
    });
    expect(m.updates.at(-1)?.values).toMatchObject({ providerPaymentId: 'PSP1' });
  });

  it('fails the session on a refusal', async () => {
    m.selectQueue.push([waiting()]);
    adyen.continueHold.mockRejectedValue(new PaymentDeclinedError('Refused'));
    expect(await continueGuestHold({ sessionToken: 'tok_1', details: {} }, deps)).toEqual({
      outcome: 'declined',
      reason: 'Refused',
    });
    expect(m.updates.at(-1)?.values).toMatchObject({ status: 'failed' });
  });

  it('cancels a hold authorized after the session stopped waiting', async () => {
    m.selectQueue.push([waiting()]);
    m.updateReturns.push([]);
    adyen.continueHold.mockResolvedValue({
      status: 'authorized',
      paymentId: 'PSP1',
      authorizedCents: 5000,
    });
    expect(await continueGuestHold({ sessionToken: 'tok_1', details: {} }, deps)).toEqual({
      outcome: 'not_pending',
    });
    expect(adyen.cancelHold).toHaveBeenCalledWith({
      paymentId: 'PSP1',
      merchantReference: 'guest_tok_1',
      idempotencyKey: 'cancel_PSP1',
    });
  });

  it('returns not_configured when the pinned provider is gone', async () => {
    m.selectQueue.push([waiting()]);
    registry.getPaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('adyen'));
    expect(await continueGuestHold({ sessionToken: 'tok_1', details: {} }, deps)).toEqual({
      outcome: 'not_configured',
    });
  });

  describe('attachGuestAuthorisation (O4)', () => {
    const attach = { provider: 'adyen', sessionToken: 'tok_1', paymentId: 'PSP1' };

    it('attaches the authorisation to a waiting session', async () => {
      m.selectQueue.push([{ id: 21, provider: 'adyen', providerPaymentId: null }]);
      expect(await attachGuestAuthorisation(attach)).toBe('attached');
      expect(m.updates.at(-1)?.values).toMatchObject({
        providerPaymentId: 'PSP1',
        stripePaymentIntentId: null,
        status: 'payment_authorized',
      });
    });

    it('reports a session that already holds the payment', async () => {
      m.selectQueue.push([{ id: 21, provider: 'adyen', providerPaymentId: 'PSP1' }]);
      m.updateReturns.push([]);
      expect(await attachGuestAuthorisation(attach)).toBe('already_attached');
    });

    it('reports an orphan when the session no longer waits or holds another payment', async () => {
      m.selectQueue.push([{ id: 21, provider: 'adyen', providerPaymentId: 'OTHER' }]);
      m.updateReturns.push([]);
      expect(await attachGuestAuthorisation(attach)).toBe('orphan');
    });

    it('reports a missing session', async () => {
      m.selectQueue.push([]);
      expect(await attachGuestAuthorisation(attach)).toBe('missing');
      expect(m.updates).toHaveLength(0);
    });
  });

  it('records pending captures and cancels at guest finalization', async () => {
    m.findSessionRecord.mockResolvedValue(record());
    provider.capture.mockResolvedValue({ state: 'pending', operationRef: 'CAP1' });
    registry.getPaymentProvider.mockResolvedValue(provider);
    m.selectQueue.push([finalizeGuest()], [chargedSession(800)], [receiptSession()]);
    await handleGuestSessionEvent({ type: 'TransactionEnded', sessionId: 'ses_1' }, deps);
    expect(m.markCaptured).toHaveBeenCalledWith(11, {
      capturedCents: 800,
      failureReason: null,
      pendingRef: 'CAP1',
    });

    provider.cancelHold.mockResolvedValue({ state: 'pending', operationRef: 'CXL1' });
    m.selectQueue.push([finalizeGuest()], [chargedSession(0)], [receiptSession()]);
    await handleGuestSessionEvent({ type: 'TransactionEnded', sessionId: 'ses_1' }, deps);
    expect(m.markCancelled).toHaveBeenCalledWith(11, 'CXL1');
  });
});

describe('claimGuestStart (P10 Part B)', () => {
  it('claims the start of an authorized session once and returns where to start it', async () => {
    m.updateReturns.push([{ stationOcppId: 'CS-1', evseId: 2, paymentId: 'PSP1' }]);

    expect(await claimGuestStart('tok_1')).toEqual({
      claim: 'claimed',
      stationOcppId: 'CS-1',
      evseId: 2,
      paymentId: 'PSP1',
    });
    const update = m.updates.at(-1);
    expect(update?.values).toEqual({
      startRequestedAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(JSON.stringify(update?.where)).toContain('payment_authorized');
    expect(JSON.stringify(update?.where)).toContain('IS NULL');
  });

  it('reports a start another request already sent', async () => {
    m.updateReturns.push([]);
    m.selectQueue.push([{ startRequestedAt: new Date() }]);

    expect(await claimGuestStart('tok_1')).toEqual({ claim: 'already_requested' });
  });

  it('reports a session that cannot be started (unknown, waiting, expired)', async () => {
    m.updateReturns.push([], []);
    m.selectQueue.push([], [{ startRequestedAt: null }]);

    expect(await claimGuestStart('tok_1')).toEqual({ claim: 'not_startable' });
    expect(await claimGuestStart('tok_1')).toEqual({ claim: 'not_startable' });
  });
});
