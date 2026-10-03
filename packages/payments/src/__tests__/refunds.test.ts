// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const tx = { tag: 'tx' };
  return {
    tx,
    transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    lockSessionRecord: vi.fn(),
    markRefunded: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({ db: { transaction: h.transaction } }));
vi.mock('../payment-records.js', () => ({
  lockSessionRecord: h.lockSessionRecord,
  markRefunded: h.markRefunded,
}));

import type Stripe from 'stripe';
import { refundPaymentRecord } from '../refunds.js';
import { StripePaymentProvider } from '../providers/stripe/index.js';
import { fakeClient } from './helpers/fake-stripe.js';
import { PaymentProviderNotConfiguredError } from '../errors.js';
import type { PaymentContext } from '../context.js';
import type { PaymentRecord } from '../payment-records.js';
import type { PaymentProviderRegistry } from '../registry.js';

function record(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 42,
    sessionId: 's1',
    driverId: 'd1',
    sitePaymentConfigId: null,
    stripePaymentIntentId: 'pi_1',
    stripeCustomerId: 'cus_1',
    stripePaymentMethodId: 'pm_1',
    paymentSource: 'web_portal',
    currency: 'EUR',
    preAuthAmountCents: 5000,
    capturedAmountCents: 3000,
    refundedAmountCents: 0,
    status: 'captured',
    failureReason: null,
    lastActorUserId: null,
    lastActionReason: null,
    metadata: null,
    chargeType: 'session',
    reservationId: null,
    taxRate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const refund = vi.fn();
const getPaymentProvider = vi.fn();
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx: PaymentContext = {
  registry: { getPaymentProvider } as unknown as PaymentProviderRegistry,
  logger,
};

beforeEach(() => {
  refund.mockResolvedValue({ state: 'succeeded', refundId: 're_1', amountCents: 0 });
  getPaymentProvider.mockResolvedValue({ id: 'stripe', refund });
  h.markRefunded.mockImplementation((id: number, input: { full: boolean }) =>
    Promise.resolve(record({ id, status: input.full ? 'refunded' : 'partially_refunded' })),
  );
});

describe('refundPaymentRecord', () => {
  it('refunds the remaining amount by default inside a transaction with the row locked', async () => {
    h.lockSessionRecord.mockResolvedValue(record());
    const outcome = await refundPaymentRecord(
      { sessionId: 's1', actorUserId: 'u1', actionReason: (full) => (full ? 'Full' : 'Partial') },
      ctx,
    );
    expect(h.transaction).toHaveBeenCalledOnce();
    expect(h.lockSessionRecord).toHaveBeenCalledWith(h.tx, 's1');
    expect(getPaymentProvider).toHaveBeenCalledWith('stripe');
    expect(refund).toHaveBeenCalledWith({
      paymentId: 'pi_1',
      amountCents: 3000,
      currency: 'EUR',
      merchantReference: 'sess_s1',
      idempotencyKey: 'refund_pi_1_42_0_3000',
    });
    expect(h.markRefunded).toHaveBeenCalledWith(
      42,
      { refundedTotalCents: 3000, full: true, actorUserId: 'u1', actionReason: 'Full' },
      h.tx,
    );
    expect(outcome).toMatchObject({ status: 'refunded', refundedNowCents: 3000, full: true });
  });

  it('refunds part of a partially refunded record with a key over the refunded total', async () => {
    h.lockSessionRecord.mockResolvedValue(
      record({ status: 'partially_refunded', refundedAmountCents: 1000 }),
    );
    const outcome = await refundPaymentRecord({ sessionId: 's1', amountCents: 500 }, ctx);
    expect(refund).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 500, idempotencyKey: 'refund_pi_1_42_1000_500' }),
    );
    expect(h.markRefunded).toHaveBeenCalledWith(
      42,
      { refundedTotalCents: 1500, full: false, actorUserId: null, actionReason: null },
      h.tx,
    );
    expect(outcome).toMatchObject({ status: 'refunded', refundedNowCents: 500, full: false });
  });

  it('pins the simulated provider from the stored ids', async () => {
    h.lockSessionRecord.mockResolvedValue(
      record({ stripePaymentIntentId: 'pi_sim_1', stripeCustomerId: null }),
    );
    await refundPaymentRecord({ sessionId: 's1' }, ctx);
    expect(getPaymentProvider).toHaveBeenCalledWith('simulated');
  });

  it.each([[null], ['pre_authorized'], ['refunded'], ['failed']])(
    'returns no_captured_payment for status %s',
    async (status) => {
      h.lockSessionRecord.mockResolvedValue(
        status == null ? null : record({ status: status as PaymentRecord['status'] }),
      );
      expect(await refundPaymentRecord({ sessionId: 's1' }, ctx)).toEqual({
        status: 'no_captured_payment',
      });
      expect(refund).not.toHaveBeenCalled();
    },
  );

  it('returns missing_payment_id without a payment id', async () => {
    h.lockSessionRecord.mockResolvedValue(record({ stripePaymentIntentId: null }));
    expect(await refundPaymentRecord({ sessionId: 's1' }, ctx)).toEqual({
      status: 'missing_payment_id',
    });
  });

  it('returns nothing_refundable when everything is refunded or nothing captured', async () => {
    h.lockSessionRecord.mockResolvedValue(
      record({ status: 'partially_refunded', refundedAmountCents: 3000 }),
    );
    expect(await refundPaymentRecord({ sessionId: 's1' }, ctx)).toEqual({
      status: 'nothing_refundable',
      remainingCents: 0,
    });
    h.lockSessionRecord.mockResolvedValue(record({ capturedAmountCents: null }));
    expect(await refundPaymentRecord({ sessionId: 's1' }, ctx)).toEqual({
      status: 'nothing_refundable',
      remainingCents: 0,
    });
    expect(refund).not.toHaveBeenCalled();
  });

  it.each([[3001], [0], [-5]])(
    'returns exceeds_remaining with the currency for %i cents',
    async (amountCents) => {
      h.lockSessionRecord.mockResolvedValue(record());
      expect(await refundPaymentRecord({ sessionId: 's1', amountCents }, ctx)).toEqual({
        status: 'exceeds_remaining',
        remainingCents: 3000,
        requestedCents: amountCents,
        currency: 'EUR',
      });
      expect(refund).not.toHaveBeenCalled();
    },
  );

  it('returns not_configured when the pinned provider is not configured', async () => {
    h.lockSessionRecord.mockResolvedValue(record());
    getPaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('stripe'));
    expect(await refundPaymentRecord({ sessionId: 's1' }, ctx)).toEqual({
      status: 'not_configured',
      providerId: 'stripe',
    });
    expect(h.markRefunded).not.toHaveBeenCalled();
  });

  it('propagates other provider lookup errors', async () => {
    h.lockSessionRecord.mockResolvedValue(record());
    getPaymentProvider.mockRejectedValue(new Error('boom'));
    await expect(refundPaymentRecord({ sessionId: 's1' }, ctx)).rejects.toThrow('boom');
    expect(h.markRefunded).not.toHaveBeenCalled();
  });

  it('propagates a provider refund failure and writes nothing', async () => {
    h.lockSessionRecord.mockResolvedValue(record());
    refund.mockRejectedValue(new Error('card_declined'));
    await expect(refundPaymentRecord({ sessionId: 's1' }, ctx)).rejects.toThrow('card_declined');
    expect(h.markRefunded).not.toHaveBeenCalled();
  });

  it('throws when the locked record cannot be marked refunded', async () => {
    h.lockSessionRecord.mockResolvedValue(record());
    h.markRefunded.mockResolvedValue(null);
    await expect(refundPaymentRecord({ sessionId: 's1' }, ctx)).rejects.toThrow(
      'Payment record 42 could not be marked refunded',
    );
  });
});

describe('refundPaymentRecord with top-ups', () => {
  // Hold pi_1 captured 2000, top-ups pi_t1 600 and pi_t2 400: captured 3000.
  function topUpRecord(
    overrides: Partial<PaymentRecord> = {},
    refunded: [number, number] = [0, 0],
  ): PaymentRecord {
    return record({
      preAuthAmountCents: 2000,
      capturedAmountCents: 3000,
      metadata: {
        topUps: [
          { paymentId: 'pi_t1', amountCents: 600, refundedCents: refunded[0] },
          { paymentId: 'pi_t2', amountCents: 400, refundedCents: refunded[1] },
        ],
      },
      ...overrides,
    });
  }

  function refundCalls(): Array<{ paymentId: string; amountCents: number; key: string }> {
    return refund.mock.calls.map((c) => {
      const input = c[0] as { paymentId: string; amountCents: number; idempotencyKey: string };
      return {
        paymentId: input.paymentId,
        amountCents: input.amountCents,
        key: input.idempotencyKey,
      };
    });
  }

  beforeEach(() => {
    refund.mockReset();
    refund.mockResolvedValue({ state: 'succeeded', refundId: 're_1', amountCents: 0 });
    h.markRefunded.mockClear();
  });

  it('refunds every charge in full, the hold first, each with its own key', async () => {
    h.lockSessionRecord.mockResolvedValue(topUpRecord());
    const outcome = await refundPaymentRecord({ sessionId: 's1' }, ctx);
    expect(refundCalls()).toEqual([
      { paymentId: 'pi_1', amountCents: 2000, key: 'refund_pi_1_42_0_3000' },
      { paymentId: 'pi_t1', amountCents: 600, key: 'refund_pi_1_42_0_3000_topup_1' },
      { paymentId: 'pi_t2', amountCents: 400, key: 'refund_pi_1_42_0_3000_topup_2' },
    ]);
    expect(h.markRefunded).toHaveBeenCalledWith(
      42,
      {
        refundedTotalCents: 3000,
        full: true,
        actorUserId: null,
        actionReason: null,
        topUps: [
          { paymentId: 'pi_t1', amountCents: 600, refundedCents: 600 },
          { paymentId: 'pi_t2', amountCents: 400, refundedCents: 400 },
        ],
      },
      h.tx,
    );
    expect(outcome).toMatchObject({
      status: 'refunded',
      refundedNowCents: 3000,
      full: true,
      refunds: [
        { paymentId: 'pi_1', kind: 'hold', amountCents: 2000 },
        { paymentId: 'pi_t1', kind: 'top_up', amountCents: 600 },
        { paymentId: 'pi_t2', kind: 'top_up', amountCents: 400 },
      ],
    });
  });

  it('refunds a partial amount within the hold from the hold only', async () => {
    h.lockSessionRecord.mockResolvedValue(topUpRecord());
    await refundPaymentRecord({ sessionId: 's1', amountCents: 1500 }, ctx);
    expect(refundCalls()).toEqual([
      { paymentId: 'pi_1', amountCents: 1500, key: 'refund_pi_1_42_0_1500' },
    ]);
    expect(h.markRefunded).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        refundedTotalCents: 1500,
        full: false,
        topUps: [
          { paymentId: 'pi_t1', amountCents: 600, refundedCents: 0 },
          { paymentId: 'pi_t2', amountCents: 400, refundedCents: 0 },
        ],
      }),
      h.tx,
    );
  });

  it('spans a partial amount over the hold and the first top-up', async () => {
    h.lockSessionRecord.mockResolvedValue(topUpRecord());
    await refundPaymentRecord({ sessionId: 's1', amountCents: 2300 }, ctx);
    expect(refundCalls()).toEqual([
      { paymentId: 'pi_1', amountCents: 2000, key: 'refund_pi_1_42_0_2300' },
      { paymentId: 'pi_t1', amountCents: 300, key: 'refund_pi_1_42_0_2300_topup_1' },
    ]);
    expect(h.markRefunded).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        refundedTotalCents: 2300,
        full: false,
        topUps: [
          { paymentId: 'pi_t1', amountCents: 600, refundedCents: 300 },
          { paymentId: 'pi_t2', amountCents: 400, refundedCents: 0 },
        ],
      }),
      h.tx,
    );
  });

  it('continues a repeated partial refund where the last one stopped', async () => {
    // Earlier: 2300 refunded (hold 2000, pi_t1 300).
    h.lockSessionRecord.mockResolvedValue(
      topUpRecord({ status: 'partially_refunded', refundedAmountCents: 2300 }, [300, 0]),
    );
    await refundPaymentRecord({ sessionId: 's1', amountCents: 500 }, ctx);
    expect(refundCalls()).toEqual([
      { paymentId: 'pi_t1', amountCents: 300, key: 'refund_pi_1_42_2300_500_topup_1' },
      { paymentId: 'pi_t2', amountCents: 200, key: 'refund_pi_1_42_2300_500_topup_2' },
    ]);
    expect(h.markRefunded).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        refundedTotalCents: 2800,
        full: false,
        topUps: [
          { paymentId: 'pi_t1', amountCents: 600, refundedCents: 600 },
          { paymentId: 'pi_t2', amountCents: 400, refundedCents: 200 },
        ],
      }),
      h.tx,
    );
  });

  it('replays a request with the same keys, so the provider reuses its refunds', async () => {
    h.lockSessionRecord.mockResolvedValue(topUpRecord());
    await refundPaymentRecord({ sessionId: 's1', amountCents: 2300 }, ctx);
    const first = refundCalls();
    refund.mockClear();
    await refundPaymentRecord({ sessionId: 's1', amountCents: 2300 }, ctx);
    expect(refundCalls()).toEqual(first);
  });

  it('allocates a legacy topUpIntentId record: the hold captured at most the hold', async () => {
    h.lockSessionRecord.mockResolvedValue(
      record({
        preAuthAmountCents: 2000,
        capturedAmountCents: 2600,
        metadata: { topUpIntentId: 'pi_legacy' },
      }),
    );
    await refundPaymentRecord({ sessionId: 's1' }, ctx);
    expect(refundCalls()).toEqual([
      { paymentId: 'pi_1', amountCents: 2000, key: 'refund_pi_1_42_0_2600' },
      { paymentId: 'pi_legacy', amountCents: 600, key: 'refund_pi_1_42_0_2600_topup_1' },
    ]);
    expect(h.markRefunded).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        refundedTotalCents: 2600,
        full: true,
        topUps: [{ paymentId: 'pi_legacy', amountCents: 600, refundedCents: 600 }],
      }),
      h.tx,
    );
  });

  it('records the charges refunded before a later charge fails, then throws', async () => {
    h.lockSessionRecord.mockResolvedValue(topUpRecord());
    refund
      .mockResolvedValueOnce({ state: 'succeeded', refundId: 're_1', amountCents: 2000 })
      .mockRejectedValueOnce(new Error('insufficient connected balance'));
    await expect(refundPaymentRecord({ sessionId: 's1' }, ctx)).rejects.toThrow(
      'insufficient connected balance',
    );
    expect(refund).toHaveBeenCalledTimes(2);
    expect(h.markRefunded).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        refundedTotalCents: 2000,
        full: false,
        topUps: [
          { paymentId: 'pi_t1', amountCents: 600, refundedCents: 0 },
          { paymentId: 'pi_t2', amountCents: 400, refundedCents: 0 },
        ],
      }),
      h.tx,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentRecordId: 42,
        refunds: [{ paymentId: 'pi_1', kind: 'hold', amountCents: 2000 }],
      }),
      'Refund failed after earlier charges of the payment were refunded; those are recorded',
    );
  });

  it('writes nothing when the first charge refund fails', async () => {
    h.lockSessionRecord.mockResolvedValue(topUpRecord());
    refund.mockRejectedValueOnce(new Error('card_declined'));
    await expect(refundPaymentRecord({ sessionId: 's1' }, ctx)).rejects.toThrow('card_declined');
    expect(refund).toHaveBeenCalledOnce();
    expect(h.markRefunded).not.toHaveBeenCalled();
  });

  it('sets the Connect flags of each charge from its own intent (Stripe)', async () => {
    const client = fakeClient();
    const intents: Record<string, Record<string, unknown>> = {
      // Hold on a destination with a fee; the top-up made after the site
      // config was disabled has neither.
      pi_1: { transfer_data: { destination: 'acct_1' }, application_fee_amount: 150 },
      pi_t1: { transfer_data: null, application_fee_amount: null },
      pi_t2: { transfer_data: { destination: 'acct_1' }, application_fee_amount: null },
    };
    client.paymentIntents.retrieve.mockImplementation((id: unknown) =>
      Promise.resolve(intents[String(id)]),
    );
    const stripe = new StripePaymentProvider({
      client: client as unknown as Stripe,
      publishableKey: 'pk_test_1',
      webhookSecret: null,
    });
    getPaymentProvider.mockResolvedValue(stripe);
    h.lockSessionRecord.mockResolvedValue(topUpRecord());
    await refundPaymentRecord({ sessionId: 's1' }, ctx);
    expect(client.refunds.create.mock.calls).toEqual([
      [
        {
          payment_intent: 'pi_1',
          amount: 2000,
          reverse_transfer: true,
          refund_application_fee: true,
        },
        { idempotencyKey: 'refund_pi_1_42_0_3000' },
      ],
      [
        { payment_intent: 'pi_t1', amount: 600 },
        { idempotencyKey: 'refund_pi_1_42_0_3000_topup_1' },
      ],
      [
        { payment_intent: 'pi_t2', amount: 400, reverse_transfer: true },
        { idempotencyKey: 'refund_pi_1_42_0_3000_topup_2' },
      ],
    ]);
  });
});
