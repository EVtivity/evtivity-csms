// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const inserts: Array<{ table: unknown; values: unknown; conflict: boolean }> = [];
  const insertResults: unknown[][] = [];
  const insert = vi.fn((table: unknown) => {
    const call = { table, values: undefined as unknown, conflict: false };
    inserts.push(call);
    const b = {
      values: (v: unknown) => {
        call.values = v;
        return b;
      },
      onConflictDoNothing: () => {
        call.conflict = true;
        return b;
      },
      returning: () => Promise.resolve(insertResults.shift() ?? [{ eventId: 'x' }]),
    };
    return b;
  });
  return {
    inserts,
    insertResults,
    insert,
    deleteWhere: vi.fn(() => Promise.resolve()),
    findByPaymentId: vi.fn(),
    findByChargePaymentId: vi.fn(),
    lockRecord: vi.fn(),
    transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn({ tag: 'tx' })),
    markOpenPaymentFailed: vi.fn(),
    markRefunded: vi.fn(),
    refreshPayoutAccountById: vi.fn(),
    findRecord: vi.fn(),
    confirmOperation: vi.fn(),
    failPendingCapture: vi.fn(),
    markAuthorisationEnded: vi.fn(),
    markCaptured: vi.fn(),
    markHoldFailed: vi.fn(),
    settleRefund: vi.fn(),
    attachGuestAuthorisation: vi.fn(),
    matchPendingAdjustment: vi.fn(),
    settleAdjustedHold: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({
  db: { insert: h.insert, delete: () => ({ where: h.deleteWhere }), transaction: h.transaction },
  webhookEvents: { provider: 'we.provider', eventId: 'we.event_id' },
}));
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (col: unknown, value: unknown) => ({ op: 'eq', col, value }),
}));
vi.mock('../payment-records.js', () => ({
  findByPaymentId: h.findByPaymentId,
  findByChargePaymentId: h.findByChargePaymentId,
  lockRecord: h.lockRecord,
  markOpenPaymentFailed: h.markOpenPaymentFailed,
  markRefunded: h.markRefunded,
  findRecord: h.findRecord,
  confirmOperation: h.confirmOperation,
  failPendingCapture: h.failPendingCapture,
  markAuthorisationEnded: h.markAuthorisationEnded,
  markCaptured: h.markCaptured,
  markHoldFailed: h.markHoldFailed,
  matchPendingAdjustment: h.matchPendingAdjustment,
  settleRefund: h.settleRefund,
}));
vi.mock('../session-payments.js', () => ({ settleAdjustedHold: h.settleAdjustedHold }));
vi.mock('../guest-payments.js', () => ({
  GUEST_REFERENCE_PREFIX: 'guest_',
  attachGuestAuthorisation: h.attachGuestAuthorisation,
}));

vi.mock('../payout-accounts.js', () => ({
  refreshPayoutAccountById: h.refreshPayoutAccountById,
}));

import { applyPaymentEvent, ingestPaymentWebhook } from '../webhooks.js';
import {
  PaymentProviderNotConfiguredError,
  WebhookNotConfiguredError,
  WebhookSignatureError,
} from '../errors.js';
import type { PaymentContext } from '../context.js';
import type { PaymentProviderRegistry } from '../registry.js';
import type { NormalizedPaymentEvent, WebhookAck } from '../types.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const getPaymentProvider = vi.fn();
const verifyWebhook = vi.fn();
const ack: WebhookAck = { status: 200, contentType: 'application/json', body: '{}' };
const ctx: PaymentContext = {
  registry: { getPaymentProvider } as unknown as PaymentProviderRegistry,
  logger,
};

const at = new Date('2026-10-01T00:00:00Z');

function refunded(
  overrides: Partial<Extract<NormalizedPaymentEvent, { type: 'payment.refunded' }>> = {},
): NormalizedPaymentEvent {
  return {
    type: 'payment.refunded',
    eventId: 'evt_r',
    paymentId: 'pi_1',
    occurredAt: at,
    refundId: null,
    amountCents: null,
    cumulativeRefundedCents: 1000,
    capturedCents: 3000,
    ...overrides,
  };
}

beforeEach(() => {
  h.inserts.length = 0;
  h.insertResults.length = 0;
  getPaymentProvider.mockResolvedValue({
    id: 'stripe',
    verifyWebhook,
    webhookAck: () => ack,
  });
  verifyWebhook.mockReturnValue([]);
  h.findByPaymentId.mockResolvedValue({
    id: 5,
    status: 'captured',
    capturedAmountCents: 3000,
    refundedAmountCents: 0,
  });
  // A record without top-ups is found by its own payment, as before.
  h.findByChargePaymentId.mockImplementation(
    (provider: string, id: string) => h.findByPaymentId(provider, id) as unknown,
  );
  h.markOpenPaymentFailed.mockResolvedValue(true);
  h.markRefunded.mockResolvedValue({ id: 5, status: 'partially_refunded' });
  h.findRecord.mockImplementation((id: number) => Promise.resolve({ id, status: 'changed' }));
});

describe('ingestPaymentWebhook', () => {
  it('throws WebhookNotConfiguredError when the provider is not configured', async () => {
    getPaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('adyen'));
    await expect(ingestPaymentWebhook('adyen', '{}', {}, ctx)).rejects.toBeInstanceOf(
      WebhookNotConfiguredError,
    );
  });

  it('propagates other provider lookup errors', async () => {
    getPaymentProvider.mockRejectedValue(new Error('db down'));
    await expect(ingestPaymentWebhook('stripe', '{}', {}, ctx)).rejects.toThrow('db down');
  });

  it('propagates signature errors and records nothing', async () => {
    verifyWebhook.mockImplementation(() => {
      throw new WebhookSignatureError('invalid', 'bad signature');
    });
    await expect(
      ingestPaymentWebhook('stripe', 'raw', { 'stripe-signature': 's' }, ctx),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('forgets the event id and rethrows when applying fails', async () => {
    verifyWebhook.mockReturnValue([
      refunded({ eventId: 'evt_9' }),
      refunded({ eventId: 'evt_10' }),
    ]);
    h.markRefunded.mockRejectedValue(new Error('db timeout'));
    await expect(ingestPaymentWebhook('stripe', 'raw', {}, ctx)).rejects.toThrow('db timeout');
    expect(h.deleteWhere).toHaveBeenCalledOnce();
    expect(h.deleteWhere).toHaveBeenCalledWith({
      op: 'and',
      args: [
        { op: 'eq', col: 'we.provider', value: 'stripe' },
        { op: 'eq', col: 'we.event_id', value: 'evt_9' },
      ],
    });
    expect(h.inserts).toHaveLength(1);
  });

  it('dedupes on event id, applies first-seen events and returns the ack', async () => {
    verifyWebhook.mockReturnValue([
      {
        type: 'payment.failed',
        eventId: 'evt_1',
        paymentId: 'pi_1',
        occurredAt: at,
        reason: 'declined',
        providerType: 'payment_intent.payment_failed',
      },
      { type: 'ignored', eventId: 'evt_2', providerType: 'customer.created', occurredAt: at },
      refunded({ eventId: 'evt_3' }),
    ]);
    h.insertResults.push([{ eventId: 'evt_1' }], [], [{ eventId: 'evt_3' }]);
    const headers = { 'stripe-signature': 'sig' };

    const result = await ingestPaymentWebhook('stripe', 'raw', headers, ctx);

    expect(verifyWebhook).toHaveBeenCalledWith('raw', headers);
    expect(result).toEqual({
      ack,
      applied: 2,
      duplicates: 1,
      notices: [{ kind: 'record_changed', record: { id: 5, status: 'changed' } }],
    });
    expect(h.inserts.map((c) => c.values)).toEqual([
      { provider: 'stripe', eventId: 'evt_1', eventType: 'payment_intent.payment_failed' },
      { provider: 'stripe', eventId: 'evt_2', eventType: 'customer.created' },
      { provider: 'stripe', eventId: 'evt_3', eventType: 'payment.refunded' },
    ]);
    expect(h.inserts.every((c) => c.conflict)).toBe(true);
    expect(h.markOpenPaymentFailed).toHaveBeenCalledOnce();
    expect(h.markRefunded).toHaveBeenCalledOnce();
    expect(h.deleteWhere).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { eventId: 'evt_2' },
      'Duplicate webhook event, skipping',
    );
  });
});

describe('applyPaymentEvent', () => {
  describe('payment.failed', () => {
    const failed = (reason: string | null, providerType?: string): NormalizedPaymentEvent => ({
      type: 'payment.failed',
      eventId: 'evt_f',
      paymentId: 'pi_1',
      occurredAt: at,
      reason,
      ...(providerType != null ? { providerType } : {}),
    });

    it('marks an open payment failed with a labelled reason', async () => {
      await applyPaymentEvent('stripe', failed('card_declined'), ctx);
      expect(h.findByPaymentId).toHaveBeenCalledWith('stripe', 'pi_1');
      expect(h.markOpenPaymentFailed).toHaveBeenCalledWith(5, 'Stripe webhook: card_declined');
      expect(logger.info).toHaveBeenCalledWith(
        { paymentId: 'pi_1', reason: 'card_declined' },
        'Payment marked as failed via webhook',
      );
    });

    it('cuts the provider reason to 480 characters', async () => {
      await applyPaymentEvent('adyen', failed('r'.repeat(600)), ctx);
      expect(h.markOpenPaymentFailed).toHaveBeenCalledWith(5, `Adyen webhook: ${'r'.repeat(480)}`);
    });

    it('falls back to the provider event type, then the normalized type', async () => {
      await applyPaymentEvent('stripe', failed(null, 'payment_intent.payment_failed'), ctx);
      expect(h.markOpenPaymentFailed).toHaveBeenLastCalledWith(
        5,
        'Stripe webhook: payment_intent.payment_failed',
      );
      await applyPaymentEvent('custom', failed(null), ctx);
      expect(h.markOpenPaymentFailed).toHaveBeenLastCalledWith(5, 'custom webhook: payment.failed');
    });

    it('leaves a terminal record alone and logs it', async () => {
      h.markOpenPaymentFailed.mockResolvedValue(false);
      await applyPaymentEvent('simulated', failed('x'), ctx);
      expect(h.markOpenPaymentFailed).toHaveBeenCalledWith(5, 'Simulated webhook: x');
      expect(logger.info).toHaveBeenCalledWith(
        { paymentId: 'pi_1', status: 'captured' },
        'Payment failure webhook ignored: record is in a terminal state',
      );
    });

    it('does nothing for an unknown payment', async () => {
      h.findByPaymentId.mockResolvedValue(null);
      await applyPaymentEvent('stripe', failed('x'), ctx);
      expect(h.markOpenPaymentFailed).not.toHaveBeenCalled();
    });
  });

  describe('payment.refunded', () => {
    it('applies a partial cumulative refund against the event capture', async () => {
      await applyPaymentEvent('stripe', refunded(), ctx);
      expect(h.markRefunded).toHaveBeenCalledWith(5, { refundedTotalCents: 1000, full: false });
      expect(logger.info).toHaveBeenCalledWith(
        { paymentId: 'pi_1', status: 'partially_refunded', refundedAmount: 1000 },
        'Payment refund status updated via webhook',
      );
    });

    it('is full when the cumulative total reaches the captured amount', async () => {
      await applyPaymentEvent(
        'stripe',
        refunded({ cumulativeRefundedCents: 2000, capturedCents: 2000 }),
        ctx,
      );
      expect(h.markRefunded).toHaveBeenCalledWith(5, { refundedTotalCents: 2000, full: true });
    });

    it('falls back to the record capture, then zero', async () => {
      await applyPaymentEvent(
        'stripe',
        refunded({ cumulativeRefundedCents: 3000, capturedCents: null }),
        ctx,
      );
      expect(h.markRefunded).toHaveBeenLastCalledWith(5, { refundedTotalCents: 3000, full: true });

      h.findByPaymentId.mockResolvedValue({
        id: 6,
        status: 'captured',
        capturedAmountCents: null,
        refundedAmountCents: 0,
      });
      await applyPaymentEvent(
        'stripe',
        refunded({ cumulativeRefundedCents: 100, capturedCents: null }),
        ctx,
      );
      expect(h.markRefunded).toHaveBeenLastCalledWith(6, { refundedTotalCents: 100, full: true });
    });

    it.each([[0], [-1]])('skips a refund event with a cumulative total of %i', async (total) => {
      await applyPaymentEvent('stripe', refunded({ cumulativeRefundedCents: total }), ctx);
      expect(h.markRefunded).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        { paymentId: 'pi_1' },
        'Refund webhook without a refunded amount',
      );
    });

    it('logs when the guarded update does not apply (never lowers the total)', async () => {
      h.markRefunded.mockResolvedValue(null);
      h.findByPaymentId.mockResolvedValue({
        id: 5,
        status: 'refunded',
        capturedAmountCents: 3000,
        refundedAmountCents: 3000,
      });
      await applyPaymentEvent('stripe', refunded(), ctx);
      expect(logger.info).toHaveBeenCalledWith(
        {
          paymentId: 'pi_1',
          status: 'refunded',
          refundedAmountCents: 3000,
          refundedAmount: 1000,
        },
        'Refund webhook ignored: record not refundable or already refunded further',
      );
    });

    it('settles an increment-only refund once through the ledger', async () => {
      const record = { id: 5, status: 'partially_refunded' };
      h.settleRefund.mockResolvedValue({
        status: 'applied',
        record,
        entry: { refundId: 'OP1', paymentId: 'pi_1', amountCents: 500, state: 'succeeded' },
      });
      const notice = await applyPaymentEvent(
        'adyen',
        refunded({
          cumulativeRefundedCents: null,
          refundId: 're_1',
          operationRef: 'OP1',
          amountCents: 500,
        }),
        ctx,
      );
      expect(h.settleRefund).toHaveBeenCalledWith(5, {
        refundId: 'OP1',
        paymentId: 'pi_1',
        amountCents: 500,
        outcome: 'succeeded',
      });
      expect(h.markRefunded).not.toHaveBeenCalled();
      expect(notice).toEqual({ kind: 'refund_succeeded', record, amountCents: 500 });
    });

    it('does nothing for an unknown payment', async () => {
      h.findByPaymentId.mockResolvedValue(null);
      await applyPaymentEvent('stripe', refunded(), ctx);
      expect(h.markRefunded).not.toHaveBeenCalled();
    });
  });

  describe('payment.refunded on a record with top-ups', () => {
    // Hold pi_1 captured 2000, top-up pi_top 600: captured 2600.
    function topUpRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: 9,
        status: 'captured',
        providerPaymentId: 'pi_1',
        capturedAmountCents: 2600,
        refundedAmountCents: 0,
        preAuthAmountCents: 2000,
        metadata: { topUps: [{ paymentId: 'pi_top', amountCents: 600, refundedCents: 0 }] },
        ...overrides,
      };
    }

    beforeEach(() => {
      h.findByChargePaymentId.mockResolvedValue(topUpRecord());
      h.lockRecord.mockResolvedValue(topUpRecord());
      h.markRefunded.mockResolvedValue({ id: 9, status: 'partially_refunded' });
    });

    it('finds the record by the top-up and adds its refund to the record total', async () => {
      await applyPaymentEvent(
        'stripe',
        refunded({ paymentId: 'pi_top', cumulativeRefundedCents: 600, capturedCents: 600 }),
        ctx,
      );
      expect(h.findByChargePaymentId).toHaveBeenCalledWith('stripe', 'pi_top');
      expect(h.lockRecord).toHaveBeenCalledWith({ tag: 'tx' }, 9);
      expect(h.markRefunded).toHaveBeenCalledWith(
        9,
        {
          refundedTotalCents: 600,
          full: false,
          topUps: [{ paymentId: 'pi_top', amountCents: 600, refundedCents: 600 }],
        },
        { tag: 'tx' },
      );
    });

    it('is not full when only the hold charge is refunded in full', async () => {
      await applyPaymentEvent(
        'stripe',
        refunded({ cumulativeRefundedCents: 2000, capturedCents: 2000 }),
        ctx,
      );
      expect(h.markRefunded).toHaveBeenCalledWith(
        9,
        {
          refundedTotalCents: 2000,
          full: false,
          topUps: [{ paymentId: 'pi_top', amountCents: 600, refundedCents: 0 }],
        },
        { tag: 'tx' },
      );
    });

    it('is full when the last charge reaches its capture', async () => {
      h.lockRecord.mockResolvedValue(
        topUpRecord({ status: 'partially_refunded', refundedAmountCents: 2000 }),
      );
      await applyPaymentEvent(
        'stripe',
        refunded({ paymentId: 'pi_top', cumulativeRefundedCents: 600, capturedCents: 600 }),
        ctx,
      );
      expect(h.markRefunded).toHaveBeenCalledWith(
        9,
        {
          refundedTotalCents: 2600,
          full: true,
          topUps: [{ paymentId: 'pi_top', amountCents: 600, refundedCents: 600 }],
        },
        { tag: 'tx' },
      );
    });

    it('never counts a refund the record already holds (our own refund, a replay)', async () => {
      // The operator refund recorded hold 2000 and top-up 300.
      h.lockRecord.mockResolvedValue(
        topUpRecord({
          status: 'partially_refunded',
          refundedAmountCents: 2300,
          metadata: { topUps: [{ paymentId: 'pi_top', amountCents: 600, refundedCents: 300 }] },
        }),
      );
      await applyPaymentEvent(
        'stripe',
        refunded({ paymentId: 'pi_top', cumulativeRefundedCents: 300, capturedCents: 600 }),
        ctx,
      );
      await applyPaymentEvent(
        'stripe',
        refunded({ cumulativeRefundedCents: 1500, capturedCents: 2000 }),
        ctx,
      );
      expect(h.markRefunded).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        { paymentId: 'pi_top', paymentRecordId: 9 },
        'Refund webhook ignored: charge already refunded this far',
      );
    });

    it('caps a charge at its capture', async () => {
      await applyPaymentEvent(
        'stripe',
        refunded({ paymentId: 'pi_top', cumulativeRefundedCents: 900, capturedCents: 600 }),
        ctx,
      );
      expect(h.markRefunded).toHaveBeenCalledWith(
        9,
        {
          refundedTotalCents: 600,
          full: false,
          topUps: [{ paymentId: 'pi_top', amountCents: 600, refundedCents: 600 }],
        },
        { tag: 'tx' },
      );
    });

    it('logs when the record is no longer refundable', async () => {
      h.markRefunded.mockResolvedValue(null);
      await applyPaymentEvent(
        'stripe',
        refunded({ paymentId: 'pi_top', cumulativeRefundedCents: 600, capturedCents: 600 }),
        ctx,
      );
      expect(logger.info).toHaveBeenCalledWith(
        { paymentId: 'pi_top', status: 'captured' },
        'Refund webhook ignored: record not refundable',
      );
    });

    it('does nothing when the record vanished or does not list the charge', async () => {
      h.lockRecord.mockResolvedValueOnce(null);
      await applyPaymentEvent('stripe', refunded({ paymentId: 'pi_top' }), ctx);
      h.findByChargePaymentId.mockResolvedValueOnce(topUpRecord());
      h.lockRecord.mockResolvedValueOnce(topUpRecord({ providerPaymentId: 'pi_other' }));
      await applyPaymentEvent('stripe', refunded({ paymentId: 'pi_1' }), ctx);
      expect(h.markRefunded).not.toHaveBeenCalled();
    });
  });

  it('warns on a dispute', async () => {
    await applyPaymentEvent(
      'stripe',
      {
        type: 'payment.disputed',
        eventId: 'evt_d',
        paymentId: 'pi_1',
        occurredAt: at,
        disputeId: 'dp_1',
        reason: 'fraudulent',
      },
      ctx,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { paymentId: 'pi_1', disputeId: 'dp_1', reason: 'fraudulent' },
      'Payment dispute created',
    );
  });

  it('logs an ignored event at debug', async () => {
    await applyPaymentEvent(
      'stripe',
      { type: 'ignored', eventId: 'evt_i', providerType: 'customer.updated', occurredAt: at },
      ctx,
    );
    expect(logger.debug).toHaveBeenCalledWith(
      { type: 'customer.updated' },
      'Unhandled webhook event type',
    );
    expect(h.findByPaymentId).not.toHaveBeenCalled();
  });

  const payoutEvent = {
    type: 'payout_account.updated' as const,
    eventId: 'evt_a',
    accountId: 'acct_1',
    occurredAt: at,
    providerType: 'account.updated',
  };

  it('refreshes the payout account from the provider, never from the payload', async () => {
    h.refreshPayoutAccountById.mockResolvedValueOnce(2);
    await applyPaymentEvent('stripe', payoutEvent, ctx);
    expect(h.refreshPayoutAccountById).toHaveBeenCalledWith('acct_1', ctx);
    expect(logger.info).toHaveBeenCalledWith(
      { accountId: 'acct_1', updated: 2 },
      'Payout account status refreshed',
    );
    expect(h.findByPaymentId).not.toHaveBeenCalled();
    expect(h.findByChargePaymentId).not.toHaveBeenCalled();
  });

  it('logs an account no site uses at info', async () => {
    h.refreshPayoutAccountById.mockResolvedValueOnce(0);
    await applyPaymentEvent('stripe', payoutEvent, ctx);
    expect(logger.info).toHaveBeenCalledWith(
      { accountId: 'acct_1' },
      'Payout account event for an account no site uses',
    );
  });

  it('throws when the account cannot be read, so the provider retries', async () => {
    h.refreshPayoutAccountById.mockRejectedValueOnce(new Error('Stripe down'));
    await expect(applyPaymentEvent('stripe', payoutEvent, ctx)).rejects.toThrow('Stripe down');
  });
});

describe('applyPaymentEvent: authorisation adjustment (P10 Part D)', () => {
  const hold = {
    id: 9,
    status: 'pre_authorized',
    providerPaymentId: 'PSP1',
    pendingOperation: 'adjust',
    pendingOperationRef: 'ADJ1',
  };
  const adjusted = (
    overrides: Partial<Extract<NormalizedPaymentEvent, { type: 'payment.adjusted' }>> = {},
  ): NormalizedPaymentEvent => ({
    type: 'payment.adjusted',
    eventId: 'AUTHORISATION_ADJUSTMENT:ADJ1:true',
    paymentId: 'PSP1',
    operationRef: 'ADJ1',
    occurredAt: at,
    authorizedCents: 7000,
    success: true,
    ...overrides,
  });

  beforeEach(() => {
    h.findByChargePaymentId.mockResolvedValue(hold);
    h.matchPendingAdjustment.mockResolvedValue(hold);
    h.findRecord.mockResolvedValue({ ...hold, status: 'captured' });
    h.settleAdjustedHold.mockResolvedValue({
      mode: 'card',
      status: 'captured',
      paymentRecordId: 9,
      driverId: 'd1',
      capturedCents: 7000,
      shortfallCents: 0,
      recorded: true,
    });
  });

  it('settles the hold at the adjusted amount and tells the driver', async () => {
    const notice = await applyPaymentEvent('adyen', adjusted(), ctx);
    expect(h.matchPendingAdjustment).toHaveBeenCalledWith(9, 'ADJ1');
    expect(h.settleAdjustedHold).toHaveBeenCalledWith(
      hold,
      { success: true, authorizedCents: 7000 },
      ctx,
    );
    expect(notice).toEqual({
      kind: 'session_paid',
      record: { ...hold, status: 'captured' },
      amountCents: 7000,
    });
    expect(logger.info).toHaveBeenCalledWith(
      { paymentRecordId: 9, authorizedCents: 7000, operationRef: 'ADJ1' },
      'Authorisation adjusted via webhook; capturing the final cost',
    );
  });

  it('falls back to the hold and a top-up when the adjustment was refused', async () => {
    await applyPaymentEvent('adyen', adjusted({ success: false, authorizedCents: 0 }), ctx);
    expect(h.settleAdjustedHold).toHaveBeenCalledWith(
      hold,
      { success: false, authorizedCents: 0 },
      ctx,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { paymentRecordId: 9, operationRef: 'ADJ1' },
      'Authorisation adjustment refused; capturing the hold and charging the rest as a top-up',
    );
  });

  it('reports a failed capture to the driver', async () => {
    h.settleAdjustedHold.mockResolvedValue({
      mode: 'card',
      status: 'failed',
      paymentRecordId: 9,
      driverId: 'd1',
      reason: 'Refused',
    });
    h.findRecord.mockResolvedValue({ ...hold, status: 'failed' });
    expect(await applyPaymentEvent('adyen', adjusted(), ctx)).toEqual({
      kind: 'capture_failed',
      record: { ...hold, status: 'failed' },
      reason: 'Refused',
    });
  });

  it('refreshes the operator UI for an unrecorded capture, a cancel or a pending adjustment', async () => {
    for (const outcome of [
      {
        mode: 'card',
        status: 'captured',
        paymentRecordId: 9,
        driverId: 'd1',
        capturedCents: 7000,
        shortfallCents: 0,
        recorded: false,
      },
      { mode: 'card', status: 'cancelled', paymentRecordId: 9, recorded: true },
      { mode: 'card', status: 'adjusting', paymentRecordId: 9, driverId: 'd1' },
    ]) {
      h.settleAdjustedHold.mockResolvedValueOnce(outcome);
      expect(await applyPaymentEvent('adyen', adjusted(), ctx)).toMatchObject({
        kind: 'record_changed',
      });
    }
  });

  it('returns nothing when the settlement had nothing to settle or the record is gone', async () => {
    h.settleAdjustedHold.mockResolvedValueOnce({ mode: 'none' });
    expect(await applyPaymentEvent('adyen', adjusted(), ctx)).toBeNull();
    h.findRecord.mockResolvedValueOnce(null);
    expect(await applyPaymentEvent('adyen', adjusted(), ctx)).toBeNull();
  });

  it('ignores an event for an unknown payment', async () => {
    h.findByChargePaymentId.mockResolvedValue(null);
    expect(await applyPaymentEvent('adyen', adjusted(), ctx)).toBeNull();
    expect(h.matchPendingAdjustment).not.toHaveBeenCalled();
  });

  it('ignores an adjustment that is not pending, foreign or without a reference', async () => {
    h.matchPendingAdjustment.mockResolvedValue(null);
    expect(await applyPaymentEvent('adyen', adjusted(), ctx)).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      { paymentRecordId: 9, status: 'pre_authorized', operationRef: 'ADJ1' },
      'Adjustment webhook ignored: no matching pending adjustment',
    );
    h.matchPendingAdjustment.mockClear();
    const withoutRef = adjusted() as Extract<NormalizedPaymentEvent, { type: 'payment.adjusted' }>;
    delete withoutRef.operationRef;
    expect(await applyPaymentEvent('adyen', withoutRef, ctx)).toBeNull();
    // A top-up payment of the record is not the hold.
    expect(await applyPaymentEvent('adyen', adjusted({ paymentId: 'TOPUP1' }), ctx)).toBeNull();
    expect(h.matchPendingAdjustment).not.toHaveBeenCalled();
    expect(h.settleAdjustedHold).not.toHaveBeenCalled();
  });
});

describe('applyPaymentEvent: async provider confirmations (P10a)', () => {
  const base = { eventId: 'evt_x', paymentId: 'PSP1', operationRef: 'MOD1', occurredAt: at };
  const hold = {
    id: 9,
    status: 'pre_authorized',
    providerPaymentId: 'PSP1',
    pendingOperationRef: null,
    refundedAmountCents: 0,
  };
  const captured = {
    ...hold,
    status: 'captured',
    pendingOperation: 'capture',
    pendingOperationRef: 'MOD1',
  };
  const cancelHold = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    h.findByChargePaymentId.mockResolvedValue(captured);
    h.findRecord.mockImplementation((id: number) => Promise.resolve({ id, status: 'changed' }));
    h.confirmOperation.mockResolvedValue(false);
    h.failPendingCapture.mockResolvedValue(null);
    h.markAuthorisationEnded.mockResolvedValue(false);
    h.markCaptured.mockResolvedValue(false);
    h.markHoldFailed.mockResolvedValue(false);
    cancelHold.mockResolvedValue({ state: 'pending', operationRef: 'CANCELREF' });
    getPaymentProvider.mockResolvedValue({ id: 'adyen', cancelHold });
  });

  describe('payment.captured', () => {
    const event: NormalizedPaymentEvent = { ...base, type: 'payment.captured', amountCents: 4000 };

    it('confirms the pending capture with the same reference', async () => {
      h.confirmOperation.mockResolvedValue(true);
      const notice = await applyPaymentEvent('adyen', event, ctx);
      expect(h.findByChargePaymentId).toHaveBeenCalledWith('adyen', 'PSP1');
      expect(h.confirmOperation).toHaveBeenCalledWith(9, 'capture', 'MOD1');
      expect(notice).toEqual({ kind: 'record_changed', record: { id: 9, status: 'changed' } });
    });

    it('captures an open hold when the confirmation arrives before the capture was recorded', async () => {
      h.findByChargePaymentId.mockResolvedValue(hold);
      h.markCaptured.mockResolvedValue(true);
      const notice = await applyPaymentEvent('adyen', event, ctx);
      expect(h.markCaptured).toHaveBeenCalledWith(9, { capturedCents: 4000, failureReason: null });
      expect(notice).toMatchObject({ kind: 'record_changed' });
    });

    it('ignores a capture of a failed record (a CAPTURE after CAPTURE_FAILED does not revive it)', async () => {
      h.findByChargePaymentId.mockResolvedValue({ ...captured, status: 'failed' });
      expect(await applyPaymentEvent('adyen', event, ctx)).toBeNull();
      expect(h.markCaptured).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        { paymentRecordId: 9, status: 'failed', operationRef: 'MOD1' },
        'Capture webhook ignored: no matching pending capture',
      );
    });

    it('does nothing for a payment without a record', async () => {
      h.findByChargePaymentId.mockResolvedValue(null);
      expect(await applyPaymentEvent('adyen', event, ctx)).toBeNull();
      expect(h.confirmOperation).not.toHaveBeenCalled();
    });
  });

  describe('payment.capture_failed', () => {
    const event: NormalizedPaymentEvent = {
      ...base,
      type: 'payment.capture_failed',
      reason: 'Insufficient balance',
    };

    it('fails the capture with the matching reference and returns the notice', async () => {
      const failed = { ...captured, status: 'failed' };
      h.failPendingCapture.mockResolvedValue(failed);
      const notice = await applyPaymentEvent('adyen', event, ctx);
      expect(h.failPendingCapture).toHaveBeenCalledWith(
        9,
        'MOD1',
        'Adyen capture failed: Insufficient balance',
      );
      expect(notice).toEqual({
        kind: 'capture_failed',
        record: failed,
        reason: 'Insufficient balance',
      });
    });

    it('fails an open hold when the failure arrives before the capture was recorded', async () => {
      h.findByChargePaymentId.mockResolvedValue(hold);
      h.markHoldFailed.mockResolvedValue(true);
      h.findRecord.mockResolvedValue({ id: 9, status: 'failed' });
      const notice = await applyPaymentEvent('adyen', event, ctx);
      expect(h.markHoldFailed).toHaveBeenCalledWith(
        9,
        'Adyen capture failed: Insufficient balance',
      );
      expect(notice).toMatchObject({ kind: 'capture_failed', record: { status: 'failed' } });
    });

    it('logs an error for a failure it cannot apply (foreign reference or refunded record)', async () => {
      h.findByChargePaymentId.mockResolvedValue({ ...captured, refundedAmountCents: 500 });
      expect(await applyPaymentEvent('adyen', event, ctx)).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ paymentRecordId: 9, refundedAmountCents: 500 }),
        'Capture failure webhook not applied: no matching capture of an unrefunded record',
      );
    });

    it('uses a reason without a provider reason', async () => {
      await applyPaymentEvent('adyen', { ...event, reason: null }, ctx);
      expect(h.failPendingCapture).toHaveBeenCalledWith(9, 'MOD1', 'Adyen capture failed');
    });
  });

  describe('payment.cancelled and payment.cancel_failed', () => {
    const cancelled: NormalizedPaymentEvent = { ...base, type: 'payment.cancelled' };

    it('confirms the pending cancel with the same reference', async () => {
      h.findByChargePaymentId.mockResolvedValue({ ...hold, status: 'cancelled' });
      h.confirmOperation.mockResolvedValue(true);
      expect(await applyPaymentEvent('adyen', cancelled, ctx)).toMatchObject({
        kind: 'record_changed',
      });
      expect(h.confirmOperation).toHaveBeenCalledWith(9, 'cancel', 'MOD1');
      expect(h.markAuthorisationEnded).not.toHaveBeenCalled();
    });

    it('ends an open hold the provider let expire, without a confirmation lookup', async () => {
      h.findByChargePaymentId.mockResolvedValue(hold);
      h.markAuthorisationEnded.mockResolvedValue(true);
      await applyPaymentEvent('adyen', { ...cancelled, expired: true }, ctx);
      expect(h.confirmOperation).not.toHaveBeenCalled();
      expect(h.markAuthorisationEnded).toHaveBeenCalledWith(9, 'Adyen authorisation expired');
    });

    it('ends an open hold cancelled outside EVtivity', async () => {
      h.findByChargePaymentId.mockResolvedValue(hold);
      h.markAuthorisationEnded.mockResolvedValue(true);
      await applyPaymentEvent('adyen', cancelled, ctx);
      expect(h.markAuthorisationEnded).toHaveBeenCalledWith(9, 'Adyen cancelled the authorisation');
    });

    it('ignores the cancellation of a top-up payment of the record', async () => {
      h.findByChargePaymentId.mockResolvedValue({ ...captured, providerPaymentId: 'OTHER' });
      expect(await applyPaymentEvent('adyen', cancelled, ctx)).toBeNull();
      expect(h.markAuthorisationEnded).not.toHaveBeenCalled();
    });

    it('clears a failed pending cancel and logs it at error', async () => {
      h.confirmOperation.mockResolvedValue(true);
      const notice = await applyPaymentEvent(
        'adyen',
        { ...base, type: 'payment.cancel_failed', reason: 'Already captured' },
        ctx,
      );
      expect(h.confirmOperation).toHaveBeenCalledWith(9, 'cancel', 'MOD1');
      expect(notice).toMatchObject({ kind: 'record_changed' });
      expect(logger.error).toHaveBeenCalledWith(
        { paymentRecordId: 9, operationRef: 'MOD1', reason: 'Already captured' },
        'Cancel of the hold failed at the provider; the authorisation stays until it expires',
      );
    });

    it('ignores a cancel failure without a matching pending cancel', async () => {
      expect(
        await applyPaymentEvent(
          'adyen',
          { ...base, type: 'payment.cancel_failed', reason: null },
          ctx,
        ),
      ).toBeNull();
    });
  });

  describe('payment.refund_failed and duplicates', () => {
    const failed: NormalizedPaymentEvent = {
      ...base,
      type: 'payment.refund_failed',
      refundId: 'MOD1',
      amountCents: 700,
      reason: 'Refund rejected',
    };

    it('marks the ledger entry failed and returns the notice', async () => {
      const record = { id: 9, status: 'captured' };
      h.settleRefund.mockResolvedValue({
        status: 'applied',
        record,
        entry: { refundId: 'MOD1', paymentId: 'PSP1', amountCents: 700, state: 'failed' },
      });
      const notice = await applyPaymentEvent('adyen', failed, ctx);
      expect(h.settleRefund).toHaveBeenCalledWith(9, {
        refundId: 'MOD1',
        paymentId: 'PSP1',
        amountCents: 700,
        outcome: 'failed',
      });
      expect(notice).toEqual({
        kind: 'refund_failed',
        record,
        amountCents: 700,
        reason: 'Refund rejected',
      });
    });

    it('returns nothing for an entry settled before', async () => {
      h.settleRefund.mockResolvedValue({ status: 'already_settled' });
      expect(await applyPaymentEvent('adyen', failed, ctx)).toBeNull();
    });

    it('logs an error for a confirmed refund the record cannot take', async () => {
      h.settleRefund.mockResolvedValue({ status: 'not_refundable', recordStatus: 'failed' });
      const notice = await applyPaymentEvent(
        'adyen',
        {
          ...base,
          type: 'payment.refunded',
          refundId: 'MOD1',
          amountCents: 700,
          cumulativeRefundedCents: null,
          capturedCents: null,
        },
        ctx,
      );
      expect(notice).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        { paymentRecordId: 9, refundId: 'MOD1', status: 'failed' },
        'Refund confirmed by the provider for a record that cannot take it; check the payment',
      );
    });

    it('warns about an increment refund without an amount', async () => {
      expect(
        await applyPaymentEvent(
          'adyen',
          {
            ...base,
            type: 'payment.refunded',
            refundId: null,
            amountCents: null,
            cumulativeRefundedCents: null,
            capturedCents: null,
          },
          ctx,
        ),
      ).toBeNull();
      expect(h.settleRefund).not.toHaveBeenCalled();
    });
  });

  describe('payment.authorized (orphan guest authorisations, O4)', () => {
    const authorised = (merchantReference: string): NormalizedPaymentEvent => ({
      eventId: 'evt_auth',
      type: 'payment.authorized',
      paymentId: 'PSPAUTH',
      amountCents: 5000,
      merchantReference,
      occurredAt: at,
    });

    beforeEach(() => {
      h.findByChargePaymentId.mockResolvedValue(null);
    });

    it('ignores an authorisation of a recorded payment', async () => {
      h.findByChargePaymentId.mockResolvedValue(hold);
      expect(await applyPaymentEvent('adyen', authorised('guest_tok'), ctx)).toBeNull();
      expect(h.attachGuestAuthorisation).not.toHaveBeenCalled();
    });

    it('attaches the authorisation to a waiting guest session', async () => {
      h.attachGuestAuthorisation.mockResolvedValue('attached');
      await applyPaymentEvent('adyen', authorised('guest_tok'), ctx);
      expect(h.attachGuestAuthorisation).toHaveBeenCalledWith({
        provider: 'adyen',
        sessionToken: 'tok',
        paymentId: 'PSPAUTH',
      });
      expect(cancelHold).not.toHaveBeenCalled();
    });

    it.each(['already_attached', 'missing'])('leaves a %s session alone', async (outcome) => {
      h.attachGuestAuthorisation.mockResolvedValue(outcome);
      await applyPaymentEvent('adyen', authorised('guest_tok'), ctx);
      expect(cancelHold).not.toHaveBeenCalled();
    });

    it('cancels an orphan authorisation with the cancel key of its payment', async () => {
      h.attachGuestAuthorisation.mockResolvedValue('orphan');
      await applyPaymentEvent('adyen', authorised('guest_tok'), ctx);
      expect(getPaymentProvider).toHaveBeenCalledWith('adyen');
      expect(cancelHold).toHaveBeenCalledWith({
        paymentId: 'PSPAUTH',
        merchantReference: 'guest_tok',
        idempotencyKey: 'cancel_PSPAUTH',
      });
    });

    it('fails open when the orphan cancel fails', async () => {
      h.attachGuestAuthorisation.mockResolvedValue('orphan');
      cancelHold.mockRejectedValue(new Error('Adyen down'));
      await expect(applyPaymentEvent('adyen', authorised('guest_tok'), ctx)).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionToken: 'tok', paymentId: 'PSPAUTH' }),
        'Failed to cancel an orphan guest authorisation; it expires by itself',
      );
    });

    it.each(['sess_s1', 'method_setup_d1_a1', 'topup_42'])(
      'leaves a %s authorisation to the request that made it',
      async (reference) => {
        await applyPaymentEvent('adyen', authorised(reference), ctx);
        expect(h.attachGuestAuthorisation).not.toHaveBeenCalled();
        expect(cancelHold).not.toHaveBeenCalled();
      },
    );
  });

  it('returns a dispute notice for a recorded payment', async () => {
    const notice = await applyPaymentEvent(
      'adyen',
      {
        eventId: 'evt_d',
        type: 'payment.disputed',
        paymentId: 'PSP1',
        disputeId: 'CB1',
        reason: 'fraud',
        occurredAt: at,
      },
      ctx,
    );
    expect(notice).toEqual({
      kind: 'disputed',
      record: captured,
      disputeId: 'CB1',
      reason: 'fraud',
    });
  });
});
