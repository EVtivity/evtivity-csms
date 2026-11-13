// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// terminal-payments.ts against an in-memory database: every transition is a
// guarded UPDATE, so these tests check which from-states move and which stay
// (P5), the keys sent to the provider (P7) and the capture caps (P11 layer 1).

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { PAYMENT_TERMINAL_DEFAULT_HOLD_CENTS } from '@evtivity/lib';
import {
  TerminalProviderError,
  type PaymentTerminalProvider,
  type TerminalEvent,
  type TerminalTxnResult,
} from '@evtivity/payment-terminals';
import { createMemoryDb, memoryTable } from './helpers/memory-db.js';

const h = vi.hoisted(() => ({
  holdTerms: vi.fn(),
  getCompanyCurrency: vi.fn(),
  recordTerminalCapture: vi.fn(),
  markRefunded: vi.fn(),
  addPendingRefunds: vi.fn(),
  settleRefund: vi.fn(),
}));

const mem = createMemoryDb();
const tables = {
  paymentTerminalTransactions: memoryTable('ptt'),
  paymentTerminals: memoryTable('pt'),
  guestSessions: memoryTable('gs'),
  chargingSessions: memoryTable('cs'),
  webhookEvents: memoryTable('we'),
};

vi.mock('@evtivity/database', () => ({
  db: mem.client,
  getCompanyCurrency: h.getCompanyCurrency,
  ...tables,
}));
vi.mock('drizzle-orm', async () => (await import('./helpers/memory-db.js')).drizzleOperators);
vi.mock('../session-payments.js', () => ({ holdTerms: h.holdTerms }));
vi.mock('../payment-records.js', () => ({
  recordTerminalCapture: h.recordTerminalCapture,
  markRefunded: h.markRefunded,
  addPendingRefunds: h.addPendingRefunds,
  settleRefund: h.settleRefund,
}));
vi.mock('../webhooks.js', () => ({
  withWebhookEventLock: (_p: string, _e: string, fn: () => Promise<unknown>) => fn(),
}));

const {
  startTerminalPayment,
  applyTerminalTxnResult,
  claimTerminalStart,
  linkTerminalGuestSession,
  terminalHoldOfGuestSession,
  linkTerminalSession,
  voidTerminalTransaction,
  terminalTransactionOfSession,
  settleTerminalSession,
  refundTerminalRecordLocked,
  ingestTerminalWebhook,
  terminalWebhookProvider,
  reconcileTerminalTransactions,
  isVoidable,
  openTerminalHolds,
  terminalRegistry,
  TERMINAL_CLAIM_STALE_MS,
  TERMINAL_ENDED_SETTLE_DELAY_MS,
} = await import('../terminal-payments.js');
const { WebhookNotConfiguredError } = await import('../errors.js');

type Row = Record<string, unknown>;

let txnSeq = 0;
mem.defaults['ptt'] = () => ({
  id: `ptx_${String(++txnSeq)}`,
  providerTxnRef: null,
  authorizedCents: null,
  capturedCents: null,
  refundedCents: null,
  guestSessionId: null,
  sessionId: null,
  pendingOperationRef: null,
  pendingOperationAt: null,
  paymentRecordId: null,
  failureReason: null,
  evseNumber: null,
  receiptUrl: null,
  updatedAt: new Date(),
});
mem.uniques['we'] = [['provider', 'eventId']];

function result(overrides: Partial<TerminalTxnResult> = {}): TerminalTxnResult {
  return {
    providerTxnRef: 'ref_1',
    state: 'authorized',
    authorizedCents: 2000,
    capturedCents: null,
    currency: 'USD',
    cardLast4: '4242',
    cardBin: '424242',
    cardBrand: 'visa',
    declineCode: null,
    receiptUrl: null,
    evseId: null,
    ...overrides,
  };
}

function fakeProvider(overrides: Partial<PaymentTerminalProvider> = {}) {
  return {
    id: 'simulated',
    capabilities: { stateLookup: false },
    startPayment: vi.fn(async () => result({ state: 'presenting', authorizedCents: null })),
    getTransaction: vi.fn(async () => null),
    capture: vi.fn(async (_ref: string, amount: number) =>
      result({ state: 'captured', capturedCents: amount }),
    ),
    void: vi.fn(async () => result({ state: 'voided' })),
    refund: vi.fn(async () => ({ refundRef: 'rf_1', state: 'succeeded' as const })),
    verifyWebhook: vi.fn((): TerminalEvent[] => []),
    ...overrides,
  } as unknown as PaymentTerminalProvider & {
    startPayment: Mock<PaymentTerminalProvider['startPayment']>;
    getTransaction: Mock<PaymentTerminalProvider['getTransaction']>;
    capture: Mock<PaymentTerminalProvider['capture']>;
    void: Mock<PaymentTerminalProvider['void']>;
    refund: Mock<PaymentTerminalProvider['refund']>;
    verifyWebhook: Mock<PaymentTerminalProvider['verifyWebhook']>;
  };
}

let provider = fakeProvider();
let configured = true;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx = {
  registry: {} as never,
  logger,
  terminals: {
    getProvider: vi.fn(async () => (configured ? provider : null)),
  } as never,
};

function terminal(overrides: Row = {}): Row {
  return {
    id: 'trm_1',
    status: 'active',
    integrationMode: 'cloud',
    stationId: 'sta_1',
    providerDeviceId: 'dev_1',
    provider: 'simulated',
    siteId: 'sit_1',
    ...overrides,
  };
}

function txn(overrides: Row = {}): Row {
  const row: Row = {
    ...mem.defaults['ptt']!(),
    paymentTerminalId: 'trm_1',
    provider: 'simulated',
    siteId: 'sit_1',
    stationId: 'sta_1',
    state: 'requested',
    currency: 'USD',
    requestedCents: 2000,
    requestedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
  (mem.tables['ptt'] ??= []).push(row);
  return row;
}

const rows = (): Row[] => mem.tables['ptt'] ?? [];

beforeEach(() => {
  mem.reset();
  txnSeq = 0;
  provider = fakeProvider();
  configured = true;
  vi.clearAllMocks();
  h.holdTerms.mockResolvedValue({ preAuthAmountCents: 2500 });
  h.getCompanyCurrency.mockResolvedValue('usd');
  h.recordTerminalCapture.mockResolvedValue({ id: 77 });
});

describe('terminalRegistry', () => {
  it('fails loud in a process without terminals', () => {
    expect(() => terminalRegistry({ registry: {} as never, logger })).toThrow(
      /no payment terminal/,
    );
  });
});

describe('startTerminalPayment', () => {
  const input = { terminalId: 'trm_1', evseChoices: [1, 2], evseNumber: null };

  it('answers the terminal states before any provider call', async () => {
    expect(await startTerminalPayment(input, ctx)).toEqual({ kind: 'not_found' });
    mem.tables['pt'] = [terminal({ status: 'inactive' })];
    expect((await startTerminalPayment(input, ctx)).kind).toBe('inactive');
    mem.tables['pt'] = [terminal({ integrationMode: 'hardware' })];
    expect((await startTerminalPayment(input, ctx)).kind).toBe('hardware');
    mem.tables['pt'] = [terminal({ stationId: null })];
    expect((await startTerminalPayment(input, ctx)).kind).toBe('not_paired');
    mem.tables['pt'] = [terminal({ providerDeviceId: null })];
    expect((await startTerminalPayment(input, ctx)).kind).toBe('not_paired');
    expect(provider.startPayment).not.toHaveBeenCalled();
  });

  it('answers busy while the terminal has an open payment', async () => {
    mem.tables['pt'] = [terminal()];
    txn({ state: 'presenting' });
    expect((await startTerminalPayment(input, ctx)).kind).toBe('busy');
    expect(rows()).toHaveLength(1);
  });

  it('stores the row first, then starts the hold of the site amount keyed by the row id', async () => {
    mem.tables['pt'] = [terminal()];
    const out = await startTerminalPayment({ ...input, receiptEmail: 'a@b.example' }, ctx);
    expect(out.kind).toBe('started');
    const stored = rows()[0]!;
    expect(stored).toMatchObject({
      state: 'presenting',
      requestedCents: 2500,
      currency: 'USD',
      providerTxnRef: 'ref_1',
      receiptEmail: 'a@b.example',
      siteId: 'sit_1',
      stationId: 'sta_1',
    });
    expect(provider.startPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        providerDeviceId: 'dev_1',
        amountCents: 2500,
        currency: 'USD',
        idempotencyKey: `terminal_auth_${String(stored.id)}`,
        reference: stored.id,
        evseChoices: [1, 2],
      }),
    );
  });

  it('uses the default hold when the site has none, and refuses an amount out of range', async () => {
    mem.tables['pt'] = [terminal()];
    h.holdTerms.mockResolvedValue({ preAuthAmountCents: 0 });
    await startTerminalPayment(input, ctx);
    expect(rows()[0]!.requestedCents).toBe(PAYMENT_TERMINAL_DEFAULT_HOLD_CENTS);
    mem.reset();
    mem.tables['pt'] = [terminal()];
    expect((await startTerminalPayment({ ...input, amountCents: 0 }, ctx)).kind).toBe(
      'invalid_amount',
    );
    expect((await startTerminalPayment({ ...input, amountCents: 1_000_001 }, ctx)).kind).toBe(
      'invalid_amount',
    );
    expect(rows()).toHaveLength(0);
  });

  it('fails the row when the provider is not configured', async () => {
    mem.tables['pt'] = [terminal()];
    configured = false;
    expect(await startTerminalPayment(input, ctx)).toEqual({
      kind: 'not_configured',
      provider: 'simulated',
    });
    expect(rows()[0]).toMatchObject({ state: 'failed', failureReason: 'provider_not_configured' });
  });

  it('fails the row on a refusal but leaves an unknown outcome for the reconciliation', async () => {
    mem.tables['pt'] = [terminal()];
    provider.startPayment.mockRejectedValueOnce(new TerminalProviderError('device_offline', 'x'));
    const refused = await startTerminalPayment(input, ctx);
    expect(refused.kind).toBe('provider_error');
    expect(rows()[0]).toMatchObject({ state: 'failed', failureReason: 'start_device_offline' });

    provider.startPayment.mockRejectedValueOnce(new Error('socket hang up'));
    const unknown = await startTerminalPayment(input, ctx);
    expect(unknown.kind).toBe('provider_error');
    if (unknown.kind === 'provider_error') expect(unknown.error.kind).toBe('unavailable');
    expect(rows()[1]!.state).toBe('requested');

    provider.startPayment.mockRejectedValueOnce(new TerminalProviderError('device_busy', 'x'));
    mem.tables['ptt'] = [];
    await startTerminalPayment(input, ctx);
    expect(rows()[0]!.state).toBe('requested');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

describe('applyTerminalTxnResult', () => {
  it('ignores an unknown row, another reference and another currency', async () => {
    expect(await applyTerminalTxnResult('ptx_x', result(), ctx)).toEqual({
      transition: 'none',
      transaction: null,
    });
    const r = txn({ providerTxnRef: 'ref_other' });
    expect((await applyTerminalTxnResult(r.id as string, result(), ctx)).transition).toBe('none');
    r.providerTxnRef = null;
    expect(
      (await applyTerminalTxnResult(r.id as string, result({ currency: 'EUR' }), ctx)).transition,
    ).toBe('none');
    expect(r.state).toBe('requested');
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('authorizes within the hold and stores the card fields and the picked EVSE', async () => {
    const r = txn({ state: 'presenting' });
    const out = await applyTerminalTxnResult(
      r.id as string,
      result({ authorizedCents: 1500, evseId: 2, receiptUrl: 'https://r.example/1' }),
      ctx,
    );
    expect(out.transition).toBe('authorized');
    expect(r).toMatchObject({
      state: 'authorized',
      authorizedCents: 1500,
      cardLast4: '4242',
      cardBin: '424242',
      evseNumber: 2,
      receiptUrl: 'https://r.example/1',
      providerTxnRef: 'ref_1',
    });
  });

  it('keeps a paired EVSE and takes the requested amount when none is reported', async () => {
    const r = txn({ evseNumber: 1 });
    await applyTerminalTxnResult(r.id as string, result({ authorizedCents: null, evseId: 3 }), ctx);
    expect(r).toMatchObject({ state: 'authorized', authorizedCents: 2000, evseNumber: 1 });
  });

  it('voids an authorization above the hold', async () => {
    const r = txn({ state: 'presenting' });
    const out = await applyTerminalTxnResult(
      r.id as string,
      result({ authorizedCents: 2001 }),
      ctx,
    );
    expect(out.transition).toBe('late_void');
    expect(provider.void).toHaveBeenCalledWith('ref_1', 'terminal_void_ref_1');
    expect(r).toMatchObject({ state: 'voided', failureReason: 'authorized_amount_out_of_range' });
  });

  it('never revives an ended payment: a late authorization is voided at the provider', async () => {
    for (const state of ['voided', 'expired', 'failed', 'declined']) {
      const r = txn({ state });
      const out = await applyTerminalTxnResult(r.id as string, result(), ctx);
      expect(out.transition).toBe('late_void');
      expect(r.state).toBe(state);
    }
    expect(provider.void).toHaveBeenCalledTimes(4);
  });

  it('keeps a late void fail-open when the provider throws', async () => {
    const r = txn({ state: 'voided' });
    provider.void.mockRejectedValueOnce(new Error('down'));
    expect((await applyTerminalTxnResult(r.id as string, result(), ctx)).transition).toBe(
      'late_void',
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it('changes nothing for an authorization of a captured row', async () => {
    const r = txn({ state: 'captured', providerTxnRef: 'ref_1' });
    expect((await applyTerminalTxnResult(r.id as string, result(), ctx)).transition).toBe('none');
    expect(provider.void).not.toHaveBeenCalled();
    expect(r.state).toBe('captured');
  });

  it('applies the other states only from their from-states', async () => {
    const a = txn();
    expect(
      (await applyTerminalTxnResult(a.id as string, result({ state: 'presenting' }), ctx))
        .transition,
    ).toBe('presenting');
    expect(
      (await applyTerminalTxnResult(a.id as string, result({ state: 'presenting' }), ctx))
        .transition,
    ).toBe('none');
    expect(
      (
        await applyTerminalTxnResult(
          a.id as string,
          result({ state: 'declined', declineCode: '05' }),
          ctx,
        )
      ).transition,
    ).toBe('declined');
    expect(a).toMatchObject({ state: 'declined', declineCode: '05' });
    expect(
      (await applyTerminalTxnResult(a.id as string, result({ state: 'declined' }), ctx)).transition,
    ).toBe('none');

    const b = txn({ state: 'authorized' });
    expect(
      (await applyTerminalTxnResult(b.id as string, result({ state: 'expired' }), ctx)).transition,
    ).toBe('expired');
    expect(
      (await applyTerminalTxnResult(b.id as string, result({ state: 'expired' }), ctx)).transition,
    ).toBe('none');

    const c = txn();
    expect(
      (await applyTerminalTxnResult(c.id as string, result({ state: 'failed' }), ctx)).transition,
    ).toBe('failed');
    expect(c.failureReason).toBe('provider_failed');
    expect(
      (await applyTerminalTxnResult(c.id as string, result({ state: 'failed' }), ctx)).transition,
    ).toBe('none');

    const d = txn({ state: 'void_requested' });
    expect(
      (await applyTerminalTxnResult(d.id as string, result({ state: 'voided' }), ctx)).transition,
    ).toBe('voided');
    expect(d.voidedAt).toBeInstanceOf(Date);
    expect(
      (await applyTerminalTxnResult(d.id as string, result({ state: 'voided' }), ctx)).transition,
    ).toBe('none');

    expect(
      (await applyTerminalTxnResult(d.id as string, result({ state: 'refunded' }), ctx)).transition,
    ).toBe('none');
  });

  it('records an async capture only for a capture in flight, capped at the hold', async () => {
    const a = txn({ state: 'authorized', providerTxnRef: 'ref_1', authorizedCents: 1000 });
    expect(
      (
        await applyTerminalTxnResult(
          a.id as string,
          result({ state: 'captured', capturedCents: 900 }),
          ctx,
        )
      ).transition,
    ).toBe('none');
    a.state = 'capture_requested';
    const out = await applyTerminalTxnResult(
      a.id as string,
      result({ state: 'captured', capturedCents: 5000, receiptUrl: 'https://r.example' }),
      ctx,
    );
    expect(out.transition).toBe('captured');
    expect(a).toMatchObject({
      state: 'captured',
      capturedCents: 1000,
      paymentRecordId: 77,
      receiptUrl: 'https://r.example',
    });
    expect(h.recordTerminalCapture).toHaveBeenCalledWith(
      expect.objectContaining({ capturedCents: 1000, authorizedCents: 1000, status: 'captured' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('answers none for a capture of a row without an authorization', async () => {
    const a = txn({ state: 'capture_requested', providerTxnRef: 'ref_1' });
    const out = await applyTerminalTxnResult(
      a.id as string,
      result({ state: 'captured', capturedCents: 10 }),
      ctx,
    );
    expect(out.transition).toBe('none');
    expect(h.recordTerminalCapture).not.toHaveBeenCalled();
  });
});

describe('charging link', () => {
  it('claims the start once, and again only after the claim went stale', async () => {
    const r = txn({ state: 'authorized' });
    const now = new Date();
    expect(await claimTerminalStart(r.id as string, now)).not.toBeNull();
    expect(await claimTerminalStart(r.id as string, now)).toBeNull();
    const later = new Date(now.getTime() + TERMINAL_CLAIM_STALE_MS + 1);
    expect(await claimTerminalStart(r.id as string, later)).not.toBeNull();
    const pending = txn({ state: 'presenting' });
    expect(await claimTerminalStart(pending.id as string, now)).toBeNull();
  });

  it('links the guest session once and ends the claim', async () => {
    const r = txn({ state: 'authorized', pendingOperationRef: 'start' });
    expect(await linkTerminalGuestSession(r.id as string, 9, 2)).toBe(true);
    expect(r).toMatchObject({ guestSessionId: 9, evseNumber: 2, pendingOperationRef: null });
    expect(await linkTerminalGuestSession(r.id as string, 10, 1)).toBe(false);
    expect(r.guestSessionId).toBe(9);
    expect(await claimTerminalStart(r.id as string)).toBeNull();
  });

  it('reports the hold of a guest session', async () => {
    expect(await terminalHoldOfGuestSession(5)).toBeNull();
    const r = txn({ state: 'authorized', guestSessionId: 5, authorizedCents: 1200 });
    expect(await terminalHoldOfGuestSession(5)).toEqual({ held: true, authorizedCents: 1200 });
    r.state = 'voided';
    expect(await terminalHoldOfGuestSession(5)).toEqual({ held: false, authorizedCents: 1200 });
  });

  it('stamps the session on the transaction once', async () => {
    const r = txn({ guestSessionId: 5 });
    await linkTerminalSession(5, 'ses_1');
    await linkTerminalSession(5, 'ses_2');
    expect(r.sessionId).toBe('ses_1');
  });
});

describe('voidTerminalTransaction', () => {
  it('expires a start without a reference and calls nothing', async () => {
    const r = txn();
    const out = await voidTerminalTransaction(r.id as string, 'operator', ctx);
    expect(out.transition).toBe('expired');
    expect(r).toMatchObject({ state: 'expired', failureReason: 'operator' });
    expect(provider.void).not.toHaveBeenCalled();
  });

  it('writes void_requested before the call and voids with the void key', async () => {
    const r = txn({ state: 'authorized', providerTxnRef: 'ref_9' });
    let stateAtCall: unknown;
    provider.void.mockImplementationOnce(() => {
      stateAtCall = r.state;
      return Promise.resolve(result({ providerTxnRef: 'ref_9', state: 'voided' }));
    });
    const out = await voidTerminalTransaction(r.id as string, 'x'.repeat(600), ctx);
    expect(out.transition).toBe('voided');
    expect(provider.void).toHaveBeenCalledWith('ref_9', 'terminal_void_ref_9');
    expect(stateAtCall).toBe('void_requested');
    expect(r.state).toBe('voided');
    expect((r.failureReason as string).length).toBe(500);
  });

  it('treats an expired answer as voided and any other answer as none', async () => {
    const r = txn({ state: 'authorized', providerTxnRef: 'ref_9' });
    provider.void.mockResolvedValueOnce(result({ state: 'expired' }));
    expect((await voidTerminalTransaction(r.id as string, 'x', ctx)).transition).toBe('voided');
    const s = txn({ state: 'authorized', providerTxnRef: 'ref_8' });
    provider.void.mockResolvedValueOnce(result({ state: 'authorized' }));
    expect((await voidTerminalTransaction(s.id as string, 'x', ctx)).transition).toBe('none');
    expect(s.state).toBe('void_requested');
  });

  it('does nothing for a captured row', async () => {
    const r = txn({ state: 'captured', providerTxnRef: 'ref_9' });
    expect((await voidTerminalTransaction(r.id as string, 'x', ctx)).transition).toBe('none');
    expect(r.state).toBe('captured');
    expect(provider.void).not.toHaveBeenCalled();
  });

  it('keeps void_requested without a provider or on an unknown outcome, fails a not_found', async () => {
    const r = txn({ state: 'authorized', providerTxnRef: 'ref_9' });
    configured = false;
    expect((await voidTerminalTransaction(r.id as string, 'x', ctx)).transition).toBe('none');
    expect(r.state).toBe('void_requested');
    configured = true;
    provider.void.mockRejectedValueOnce(new TerminalProviderError('unavailable', 'x'));
    await voidTerminalTransaction(r.id as string, 'x', ctx);
    expect(r.state).toBe('void_requested');
    provider.void.mockRejectedValueOnce(new Error('boom'));
    await voidTerminalTransaction(r.id as string, 'x', ctx);
    expect(r.state).toBe('void_requested');
    provider.void.mockRejectedValueOnce(new TerminalProviderError('not_found', 'x'));
    await voidTerminalTransaction(r.id as string, 'x', ctx);
    expect(r).toMatchObject({ state: 'failed', failureReason: 'void_not_found' });
  });
});

describe('settleTerminalSession', () => {
  function session(overrides: Row = {}): Row {
    const s = {
      id: 'ses_1',
      status: 'completed',
      finalCostCents: 800,
      currency: 'usd',
      ...overrides,
    };
    (mem.tables['cs'] ??= []).push(s);
    return s;
  }

  it('answers none without a transaction or in a state it does not settle', async () => {
    expect(await settleTerminalSession('ses_1', ctx)).toEqual({ kind: 'none' });
    txn({ state: 'voided', sessionId: 'ses_1' });
    expect(await settleTerminalSession('ses_1', ctx)).toEqual({ kind: 'none' });
  });

  it('answers a capture already done', async () => {
    txn({ state: 'captured', sessionId: 'ses_1', capturedCents: 700, paymentRecordId: 3 });
    expect(await settleTerminalSession('ses_1', ctx)).toMatchObject({
      kind: 'captured',
      capturedCents: 700,
      paymentRecordId: 3,
    });
  });

  it('answers none without a session row and not_ended while it runs', async () => {
    txn({
      state: 'authorized',
      sessionId: 'ses_1',
      providerTxnRef: 'ref_1',
      authorizedCents: 1000,
    });
    expect(await settleTerminalSession('ses_1', ctx)).toEqual({ kind: 'none' });
    session({ status: 'active' });
    expect(await settleTerminalSession('ses_1', ctx)).toEqual({ kind: 'not_ended' });
  });

  it('releases the hold uncollected on another currency or a free session', async () => {
    const r = txn({
      state: 'authorized',
      sessionId: 'ses_1',
      providerTxnRef: 'ref_1',
      authorizedCents: 1000,
    });
    const s = session({ currency: 'eur' });
    expect((await settleTerminalSession('ses_1', ctx)).kind).toBe('voided');
    expect(r).toMatchObject({ state: 'voided', failureReason: 'currency_mismatch' });
    expect(provider.capture).not.toHaveBeenCalled();

    r.state = 'authorized';
    s.currency = 'usd';
    s.finalCostCents = -5;
    expect((await settleTerminalSession('ses_1', ctx)).kind).toBe('voided');
    expect(r.failureReason).toBe('no_cost');
  });

  it('captures the final cost capped at the hold, keyed by the reference', async () => {
    const r = txn({
      state: 'authorized',
      sessionId: 'ses_1',
      providerTxnRef: 'ref_1',
      authorizedCents: 1000,
    });
    session({ finalCostCents: 1500 });
    const out = await settleTerminalSession('ses_1', ctx);
    expect(provider.capture).toHaveBeenCalledWith('ref_1', 1000, 'terminal_capture_ref_1');
    expect(out).toMatchObject({ kind: 'captured', capturedCents: 1000, paymentRecordId: 77 });
    expect(r).toMatchObject({ state: 'captured', capturedCents: 1000 });
  });

  it('never records more than it asked even when the provider reports more', async () => {
    const r = txn({
      state: 'authorized',
      sessionId: 'ses_1',
      providerTxnRef: 'ref_1',
      authorizedCents: 1000,
    });
    session();
    provider.capture.mockResolvedValueOnce(result({ state: 'captured', capturedCents: 999 }));
    expect(await settleTerminalSession('ses_1', ctx)).toMatchObject({ capturedCents: 800 });
    expect(r.capturedCents).toBe(800);
  });

  it('finds the transaction through the guest session and links it', async () => {
    const r = txn({
      state: 'authorized',
      guestSessionId: 4,
      providerTxnRef: 'ref_1',
      authorizedCents: 1000,
    });
    mem.tables['gs'] = [{ id: 4, chargingSessionId: 'ses_1' }];
    session();
    expect((await terminalTransactionOfSession('ses_1'))?.sessionId).toBe('ses_1');
    expect(r.sessionId).toBe('ses_1');
    expect(await terminalTransactionOfSession('ses_x')).toBeNull();
  });

  it('stays pending on an open answer, an unknown outcome or no provider', async () => {
    const r = txn({
      state: 'authorized',
      sessionId: 'ses_1',
      providerTxnRef: 'ref_1',
      authorizedCents: 1000,
    });
    session();
    provider.capture.mockResolvedValueOnce(result({ state: 'authorized' }));
    expect((await settleTerminalSession('ses_1', ctx)).kind).toBe('pending');
    expect(r.state).toBe('capture_requested');
    provider.capture.mockRejectedValueOnce(new TerminalProviderError('rate_limited', 'x'));
    expect((await settleTerminalSession('ses_1', ctx)).kind).toBe('pending');
    provider.capture.mockRejectedValueOnce(new Error('socket'));
    expect((await settleTerminalSession('ses_1', ctx)).kind).toBe('pending');
    configured = false;
    expect((await settleTerminalSession('ses_1', ctx)).kind).toBe('pending');
    expect(r.state).toBe('capture_requested');
  });

  it('answers none when the claimed row has no reference', async () => {
    txn({ state: 'authorized', sessionId: 'ses_1', authorizedCents: 1000 });
    session();
    expect(await settleTerminalSession('ses_1', ctx)).toEqual({ kind: 'none' });
    expect(provider.capture).not.toHaveBeenCalled();
  });

  it('records a failed payment when the capture is refused', async () => {
    const r = txn({
      state: 'authorized',
      sessionId: 'ses_1',
      providerTxnRef: 'ref_1',
      authorizedCents: 1000,
    });
    session();
    h.recordTerminalCapture.mockResolvedValueOnce({ id: 55 });
    provider.capture.mockRejectedValueOnce(new TerminalProviderError('declined', 'x'));
    const out = await settleTerminalSession('ses_1', ctx);
    expect(out).toMatchObject({ kind: 'failed', reason: 'capture_declined' });
    expect(r).toMatchObject({ state: 'failed', paymentRecordId: 55 });
    expect(h.recordTerminalCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        capturedCents: 0,
        failureReason: 'capture_declined',
      }),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('refundTerminalRecordLocked', () => {
  const record = {
    id: 12,
    provider: 'simulated',
    providerPaymentId: 'ref_1',
    capturedAmountCents: 1000,
    refundedAmountCents: 0,
  } as never;
  const tx = mem.client as never;

  it('answers missing_payment_id and not_configured before any call', async () => {
    expect(
      await refundTerminalRecordLocked(
        tx,
        { ...(record as object), providerPaymentId: null } as never,
        { requestedCents: 100, alreadyRefundedCents: 0 },
        {} as never,
        ctx,
      ),
    ).toEqual({ status: 'missing_payment_id' });
    configured = false;
    expect(
      await refundTerminalRecordLocked(
        tx,
        record,
        { requestedCents: 100, alreadyRefundedCents: 0 },
        {} as never,
        ctx,
      ),
    ).toEqual({ status: 'not_configured', providerId: 'simulated' });
  });

  it('refunds in full with the refund key and marks the row refunded', async () => {
    const r = txn({ state: 'captured', paymentRecordId: 12, capturedCents: 1000 });
    h.markRefunded.mockResolvedValueOnce({ id: 12 });
    const out = await refundTerminalRecordLocked(
      tx,
      record,
      { requestedCents: 1000, alreadyRefundedCents: 0 },
      { actorUserId: 'usr_1', actionReason: (full: boolean) => (full ? 'full' : 'part') } as never,
      ctx,
    );
    expect(provider.refund).toHaveBeenCalledWith('ref_1', 1000, 'terminal_refund_ref_1_0_1000');
    expect(out).toMatchObject({ status: 'refunded', full: true, refundedNowCents: 1000 });
    expect(h.markRefunded).toHaveBeenCalledWith(
      12,
      expect.objectContaining({ refundedTotalCents: 1000, full: true, actionReason: 'full' }),
      ctx,
      tx,
    );
    expect(r).toMatchObject({ state: 'refunded', refundedCents: 1000 });
  });

  it('marks a partial refund and throws when the record cannot be marked', async () => {
    const r = txn({ state: 'captured', paymentRecordId: 12, capturedCents: 1000 });
    h.markRefunded.mockResolvedValueOnce({ id: 12 });
    const out = await refundTerminalRecordLocked(
      tx,
      record,
      { requestedCents: 300, alreadyRefundedCents: 0 },
      {} as never,
      ctx,
    );
    expect(out).toMatchObject({ full: false });
    expect(r).toMatchObject({ state: 'partially_refunded', refundedCents: 300 });
    h.markRefunded.mockResolvedValueOnce(null);
    await expect(
      refundTerminalRecordLocked(
        tx,
        record,
        { requestedCents: 300, alreadyRefundedCents: 300 },
        {} as never,
        ctx,
      ),
    ).rejects.toThrow(/could not be marked refunded/);
  });

  it('lists a pending refund on the record and the row', async () => {
    const r = txn({ state: 'captured', paymentRecordId: 12, capturedCents: 1000 });
    provider.refund.mockResolvedValue({ refundRef: 'rf_2', state: 'pending' });
    h.addPendingRefunds.mockResolvedValueOnce({ id: 12 });
    const out = await refundTerminalRecordLocked(
      tx,
      record,
      { requestedCents: 400, alreadyRefundedCents: 0 },
      {} as never,
      ctx,
    );
    expect(out).toMatchObject({ refundStatus: 'pending', pendingCents: 400, refundedNowCents: 0 });
    expect(r).toMatchObject({ state: 'refund_pending', pendingOperationRef: 'rf_2' });
    h.addPendingRefunds.mockResolvedValueOnce(null);
    await expect(
      refundTerminalRecordLocked(
        tx,
        record,
        { requestedCents: 400, alreadyRefundedCents: 0 },
        {} as never,
        ctx,
      ),
    ).rejects.toThrow(/could not list the refund/);
  });

  it('refunds a record without a terminal row', async () => {
    h.markRefunded.mockResolvedValueOnce({ id: 12 });
    const out = await refundTerminalRecordLocked(
      tx,
      record,
      { requestedCents: 1000, alreadyRefundedCents: 0 },
      {} as never,
      ctx,
    );
    expect(out.status).toBe('refunded');
  });
});

describe('ingestTerminalWebhook', () => {
  function event(overrides: Partial<TerminalEvent> = {}): TerminalEvent {
    return {
      eventId: 'ev_1',
      providerTxnRef: 'ref_1',
      providerDeviceId: null,
      reference: null,
      kind: 'txn_state',
      txn: result(),
      ...overrides,
    };
  }

  it('names the dedupe key per provider and fails without a provider', async () => {
    expect(terminalWebhookProvider('idtech')).toBe('terminal:idtech');
    configured = false;
    await expect(ingestTerminalWebhook('simulated', Buffer.from('{}'), {}, ctx)).rejects.toThrow(
      WebhookNotConfiguredError,
    );
  });

  it('applies an event once and counts the redelivery as a duplicate', async () => {
    const r = txn({ state: 'presenting', providerTxnRef: 'ref_1' });
    provider.verifyWebhook.mockReturnValue([event()]);
    const first = await ingestTerminalWebhook('simulated', Buffer.from('{}'), {}, ctx);
    expect(first.applied[0]?.applied?.transition).toBe('authorized');
    expect(r.state).toBe('authorized');
    expect(mem.tables['we']?.[0]?.processedAt).toBeInstanceOf(Date);
    const again = await ingestTerminalWebhook('simulated', Buffer.from('{}'), {}, ctx);
    expect(again).toEqual({ applied: [], duplicates: 1 });
  });

  it('applies an event whose earlier claim never finished', async () => {
    const r = txn({ state: 'presenting', providerTxnRef: 'ref_1' });
    mem.tables['we'] = [{ provider: 'terminal:simulated', eventId: 'ev_1', processedAt: null }];
    provider.verifyWebhook.mockReturnValue([event()]);
    const out = await ingestTerminalWebhook('simulated', Buffer.from('{}'), {}, ctx);
    expect(out.duplicates).toBe(0);
    expect(r.state).toBe('authorized');
  });

  it('matches a first event by the CSMS reference of a row without one', async () => {
    const r = txn({ state: 'presenting' });
    provider.verifyWebhook.mockReturnValue([event({ reference: r.id as string })]);
    await ingestTerminalWebhook('simulated', Buffer.from('{}'), {}, ctx);
    expect(r).toMatchObject({ state: 'authorized', providerTxnRef: 'ref_1' });
  });

  it('voids an authorization for an unknown transaction and ignores other unknown events', async () => {
    provider.verifyWebhook.mockReturnValue([
      event(),
      event({ eventId: 'ev_2', txn: result({ state: 'declined' }) }),
      {
        eventId: 'ev_3',
        providerTxnRef: 'ref_1',
        providerDeviceId: null,
        reference: null,
        kind: 'txn_state',
      },
    ]);
    const out = await ingestTerminalWebhook('simulated', Buffer.from('{}'), {}, ctx);
    expect(out.applied).toHaveLength(3);
    expect(provider.void).toHaveBeenCalledTimes(1);
    expect(provider.void).toHaveBeenCalledWith('ref_1', 'terminal_void_ref_1');
  });

  it('takes the money state from the provider when it can look it up', async () => {
    const r = txn({ state: 'presenting', providerTxnRef: 'ref_1' });
    provider = fakeProvider({ capabilities: { stateLookup: true } as never });
    provider.verifyWebhook.mockReturnValue([event()]);
    provider.getTransaction.mockResolvedValueOnce(null);
    const ignored = await ingestTerminalWebhook('simulated', Buffer.from('{}'), {}, ctx);
    expect(ignored.applied[0]?.applied).toBeUndefined();
    expect(r.state).toBe('presenting');
    provider.verifyWebhook.mockReturnValue([event({ eventId: 'ev_2' })]);
    provider.getTransaction.mockResolvedValueOnce(result({ state: 'declined' }));
    await ingestTerminalWebhook('simulated', Buffer.from('{}'), {}, ctx);
    expect(r.state).toBe('declined');
  });

  it('passes device events to the caller', async () => {
    const lastSeenAt = new Date();
    provider.verifyWebhook.mockReturnValue([
      event({
        kind: 'device_status',
        providerDeviceId: 'dev_1',
        device: { online: true, lastSeenAt, iccid: null },
      }),
      event({ eventId: 'ev_2', kind: 'device_status', providerDeviceId: null }),
    ]);
    const out = await ingestTerminalWebhook('simulated', Buffer.from('{}'), {}, ctx);
    expect(out.applied[0]?.device).toEqual({
      providerDeviceId: 'dev_1',
      online: true,
      lastSeenAt,
      iccid: null,
    });
    expect(out.applied[1]?.device).toBeUndefined();
  });

  it('settles a refund event and moves the row by the record', async () => {
    const r = txn({
      state: 'refund_pending',
      providerTxnRef: 'ref_1',
      paymentRecordId: 12,
      capturedCents: 1000,
    });
    h.settleRefund.mockResolvedValueOnce({
      status: 'applied',
      record: { status: 'partially_refunded', refundedAmountCents: 400 },
    });
    provider.verifyWebhook.mockReturnValue([
      event({
        kind: 'refund',
        refund: { refundRef: 'rf_1', amountCents: 400, state: 'succeeded' },
      }),
    ]);
    await ingestTerminalWebhook('simulated', Buffer.from('{}'), {}, ctx);
    expect(h.settleRefund).toHaveBeenCalledWith(
      12,
      { refundId: 'rf_1', paymentId: 'ref_1', amountCents: 400, outcome: 'succeeded' },
      expect.anything(),
    );
    expect(r).toMatchObject({ state: 'partially_refunded', refundedCents: 400 });

    h.settleRefund.mockResolvedValueOnce({
      status: 'applied',
      record: { status: 'refunded', refundedAmountCents: 1000 },
    });
    provider.verifyWebhook.mockReturnValue([
      event({
        eventId: 'ev_2',
        kind: 'refund',
        refund: { refundRef: 'rf_2', amountCents: 600, state: 'succeeded' },
      }),
    ]);
    await ingestTerminalWebhook('simulated', Buffer.from('{}'), {}, ctx);
    expect(r).toMatchObject({ state: 'refunded', refundedCents: 1000 });

    r.state = 'refund_pending';
    h.settleRefund.mockResolvedValueOnce({
      status: 'applied',
      record: { status: 'captured', refundedAmountCents: 0 },
    });
    provider.verifyWebhook.mockReturnValue([
      event({
        eventId: 'ev_3',
        kind: 'refund',
        refund: { refundRef: 'rf_3', amountCents: 600, state: 'failed' },
      }),
    ]);
    await ingestTerminalWebhook('simulated', Buffer.from('{}'), {}, ctx);
    expect(r.state).toBe('captured');
  });

  it('ignores refund events without a record or a refund', async () => {
    txn({ state: 'captured', providerTxnRef: 'ref_1' });
    provider.verifyWebhook.mockReturnValue([
      event({ kind: 'refund', refund: { refundRef: 'rf', amountCents: 1, state: 'succeeded' } }),
      event({ eventId: 'ev_2', kind: 'refund' }),
    ]);
    await ingestTerminalWebhook('simulated', Buffer.from('{}'), {}, ctx);
    expect(h.settleRefund).not.toHaveBeenCalled();
  });

  it('forgets the claim when applying fails, so a redelivery applies it', async () => {
    txn({ state: 'presenting', providerTxnRef: 'ref_1' });
    provider.verifyWebhook.mockReturnValue([event()]);
    mem.failNextUpdate['ptt'] = [new Error('db down')];
    await expect(ingestTerminalWebhook('simulated', Buffer.from('{}'), {}, ctx)).rejects.toThrow(
      'db down',
    );
    expect(mem.tables['we']).toHaveLength(0);
  });
});

describe('reconcileTerminalTransactions', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const stale = new Date(now.getTime() - TERMINAL_CLAIM_STALE_MS - 1000);

  beforeEach(() => {
    mem.tables['pt'] = [terminal()];
  });

  it('skips fresh rows and unexpired starts', async () => {
    txn({ updatedAt: now });
    txn({ updatedAt: stale, expiresAt: new Date(now.getTime() + 1000) });
    const out = await reconcileTerminalTransactions(ctx, now);
    expect(out).toMatchObject({ lookedUp: 0, voided: 0 });
  });

  it('replays an unanswered start with its key, then voids what the provider holds', async () => {
    const r = txn({ updatedAt: stale, expiresAt: stale });
    provider.startPayment.mockResolvedValueOnce(
      result({ providerTxnRef: 'ref_r', state: 'presenting' }),
    );
    const out = await reconcileTerminalTransactions(ctx, now);
    expect(provider.startPayment).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `terminal_auth_${String(r.id)}` }),
    );
    expect(provider.void).toHaveBeenCalledWith('ref_r', 'terminal_void_ref_r');
    expect(out).toMatchObject({ lookedUp: 1, voided: 1 });
    expect(r.state).toBe('voided');
  });

  it('expires an unanswered start whose replay fails', async () => {
    const r = txn({ updatedAt: stale, expiresAt: stale });
    provider.startPayment.mockRejectedValueOnce(new Error('down'));
    const out = await reconcileTerminalTransactions(ctx, now);
    expect(out.voided).toBe(1);
    expect(r).toMatchObject({ state: 'expired', failureReason: 'start_expired' });
  });

  it('voids an authorized hold whose charging never started', async () => {
    const lonely = txn({
      state: 'authorized',
      providerTxnRef: 'ref_a',
      updatedAt: stale,
      authorizedAt: stale,
    });
    const guestGone = txn({
      state: 'authorized',
      providerTxnRef: 'ref_b',
      guestSessionId: 3,
      updatedAt: stale,
      authorizedAt: stale,
    });
    const guestWaiting = txn({
      state: 'authorized',
      providerTxnRef: 'ref_c',
      guestSessionId: 4,
      updatedAt: stale,
      authorizedAt: stale,
    });
    mem.tables['gs'] = [
      { id: 3, status: 'expired' },
      { id: 4, status: 'payment_authorized' },
    ];
    const out = await reconcileTerminalTransactions(ctx, now);
    expect(out.voided).toBe(2);
    expect(lonely.state).toBe('voided');
    expect(guestGone.state).toBe('voided');
    expect(guestWaiting.state).toBe('authorized');
  });

  it('settles an ended session only after the settle delay', async () => {
    const recent = new Date(now.getTime() - 60_000);
    const r = txn({
      state: 'authorized',
      providerTxnRef: 'ref_1',
      authorizedCents: 1000,
      sessionId: 'ses_1',
      updatedAt: stale,
    });
    mem.tables['cs'] = [
      { id: 'ses_1', status: 'completed', endedAt: recent, finalCostCents: 300, currency: 'USD' },
    ];
    expect((await reconcileTerminalTransactions(ctx, now)).settled).toBe(0);
    mem.tables['cs'][0]!.endedAt = new Date(now.getTime() - TERMINAL_ENDED_SETTLE_DELAY_MS - 1);
    const out = await reconcileTerminalTransactions(ctx, now);
    expect(out).toMatchObject({ settled: 1, settledSessionIds: ['ses_1'] });
    expect(r).toMatchObject({ state: 'captured', capturedCents: 300 });
  });

  it('retries a stale capture and a stale void with their keys', async () => {
    const cap = txn({
      state: 'capture_requested',
      providerTxnRef: 'ref_1',
      authorizedCents: 1000,
      sessionId: 'ses_1',
      updatedAt: stale,
    });
    const vd = txn({ state: 'void_requested', providerTxnRef: 'ref_2', updatedAt: stale });
    mem.tables['cs'] = [
      { id: 'ses_1', status: 'completed', endedAt: stale, finalCostCents: 450, currency: 'USD' },
    ];
    const out = await reconcileTerminalTransactions(ctx, now);
    expect(provider.capture).toHaveBeenCalledWith('ref_1', 450, 'terminal_capture_ref_1');
    expect(provider.void).toHaveBeenCalledWith('ref_2', 'terminal_void_ref_2');
    expect(out).toMatchObject({ settled: 1, voided: 1, errors: 0 });
    expect(cap.state).toBe('captured');
    expect(vd.state).toBe('voided');
  });

  it('counts a failed row and goes on', async () => {
    txn({ state: 'void_requested', providerTxnRef: 'ref_2', updatedAt: stale });
    const second = txn({ state: 'void_requested', providerTxnRef: 'ref_3', updatedAt: stale });
    mem.failNextUpdate['ptt'] = [new Error('db down')];
    const out = await reconcileTerminalTransactions(ctx, now);
    expect(out.errors).toBe(1);
    expect(second.state).toBe('voided');
  });
});

describe('isVoidable and openTerminalHolds', () => {
  it('names the states an operator can void', () => {
    expect(['authorized', 'requested', 'presenting'].every((state) => isVoidable({ state }))).toBe(
      true,
    );
    expect(isVoidable({ state: 'captured' })).toBe(false);
  });

  it('counts the holds with a reference only', async () => {
    txn({ state: 'authorized', providerTxnRef: 'ref_1' });
    txn({ state: 'capture_requested', providerTxnRef: 'ref_2' });
    txn({ state: 'authorized' });
    txn({ state: 'voided', providerTxnRef: 'ref_3' });
    txn({ state: 'authorized', providerTxnRef: 'ref_4', paymentTerminalId: 'trm_2' });
    expect(await openTerminalHolds('trm_1')).toBe(2);
  });
});
