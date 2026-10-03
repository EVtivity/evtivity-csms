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
  };
});

vi.mock('@evtivity/database', () => ({
  db: { insert: h.insert, delete: () => ({ where: h.deleteWhere }), transaction: h.transaction },
  webhookEvents: { eventId: 'we.event_id' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, value: unknown) => ({ op: 'eq', col, value }),
}));
vi.mock('../payment-records.js', () => ({
  findByPaymentId: h.findByPaymentId,
  findByChargePaymentId: h.findByChargePaymentId,
  lockRecord: h.lockRecord,
  markOpenPaymentFailed: h.markOpenPaymentFailed,
  markRefunded: h.markRefunded,
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
  h.findByChargePaymentId.mockImplementation((id: string) => h.findByPaymentId(id) as unknown);
  h.markOpenPaymentFailed.mockResolvedValue(true);
  h.markRefunded.mockResolvedValue({ id: 5, status: 'partially_refunded' });
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
    expect(h.deleteWhere).toHaveBeenCalledWith({ op: 'eq', col: 'we.event_id', value: 'evt_9' });
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
    expect(result).toEqual({ ack, applied: 2, duplicates: 1 });
    expect(h.inserts.map((c) => c.values)).toEqual([
      { eventId: 'evt_1', eventType: 'payment_intent.payment_failed' },
      { eventId: 'evt_2', eventType: 'customer.created' },
      { eventId: 'evt_3', eventType: 'payment.refunded' },
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
      expect(h.findByPaymentId).toHaveBeenCalledWith('pi_1');
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

    it('does not apply an increment-only refund', async () => {
      await applyPaymentEvent(
        'adyen',
        refunded({ cumulativeRefundedCents: null, refundId: 're_1', amountCents: 500 }),
        ctx,
      );
      expect(h.markRefunded).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        { paymentId: 'pi_1', refundId: 're_1', amountCents: 500 },
        'Refund webhook without a cumulative total not applied',
      );
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
        stripePaymentIntentId: 'pi_1',
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
      expect(h.findByChargePaymentId).toHaveBeenCalledWith('pi_top');
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

    it('maps a legacy topUpIntentId record and caps a charge at its capture', async () => {
      const legacy = topUpRecord({ metadata: { topUpIntentId: 'pi_top' } });
      h.findByChargePaymentId.mockResolvedValue(legacy);
      h.lockRecord.mockResolvedValue(legacy);
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
      h.lockRecord.mockResolvedValueOnce(topUpRecord({ stripePaymentIntentId: 'pi_other' }));
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

  it('warns on an async confirmation it does not handle', async () => {
    await applyPaymentEvent(
      'adyen',
      {
        type: 'payment.captured',
        eventId: 'evt_c',
        paymentId: 'pi_1',
        occurredAt: at,
        amountCents: 1,
      },
      ctx,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { type: 'payment.captured', paymentId: 'pi_1' },
      'Payment webhook event not handled by synchronous providers',
    );
    expect(h.findByPaymentId).not.toHaveBeenCalled();
  });
});
