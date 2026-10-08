// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const tx = { tag: 'tx' };
  return {
    tx,
    transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    lockSessionRecord: vi.fn(),
    lockRecord: vi.fn(),
    markRefunded: vi.fn(),
    addPendingRefunds: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({ db: { transaction: h.transaction } }));
vi.mock('../payment-records.js', () => ({
  lockSessionRecord: h.lockSessionRecord,
  lockRecord: h.lockRecord,
  markRefunded: h.markRefunded,
  addPendingRefunds: h.addPendingRefunds,
}));

import type Stripe from 'stripe';
import { refundPaymentRecord } from '../refunds.js';
import { StripePaymentProvider } from '../providers/stripe/index.js';
import { SimulatedPaymentProvider } from '../providers/simulated/index.js';
import type { SimulatedWebhookDelivery } from '../providers/simulated/index.js';
import { fakeAdyenProvider, MODIFICATION_PSP } from '../testing/index.js';
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
    invoiceId: null,
    provider: 'stripe',
    providerPaymentId: 'pi_1',
    providerCustomerId: 'cus_1',
    providerPaymentMethodId: 'pm_1',
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
    pendingOperation: null,
    pendingOperationRef: null,
    pendingOperationAt: null,
    providerRefunds: [],
    providerState: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** A succeeded ledger entry as the service appends it. */
function ledgerEntry(refundId: string, paymentId: string, amountCents: number): unknown {
  return {
    refundId,
    paymentId,
    amountCents,
    state: 'succeeded',
    requestedAt: expect.any(String) as unknown,
    settledAt: expect.any(String) as unknown,
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

describe('refundPaymentRecord with an async provider', () => {
  beforeEach(() => {
    refund.mockReset();
    h.markRefunded.mockClear();
    h.addPendingRefunds.mockReset();
    h.addPendingRefunds.mockImplementation((id: number) => Promise.resolve(record({ id })));
  });

  it('refuses a refund while the capture is not confirmed (O3), without a provider call', async () => {
    h.lockSessionRecord.mockResolvedValue(
      record({ provider: 'adyen', pendingOperation: 'capture', pendingOperationRef: 'CAP1' }),
    );
    expect(await refundPaymentRecord({ sessionId: 's1' }, ctx)).toEqual({
      status: 'operation_pending',
      operation: 'capture',
    });
    expect(refund).not.toHaveBeenCalled();
    expect(h.markRefunded).not.toHaveBeenCalled();
  });

  it('lists a pending refund in the ledger and leaves the refunded total', async () => {
    h.lockSessionRecord.mockResolvedValue(record({ provider: 'adyen' }));
    refund.mockResolvedValue({ state: 'pending', operationRef: 'RF1' });
    const outcome = await refundPaymentRecord(
      { sessionId: 's1', amountCents: 1000, actorUserId: 'u1', actionReason: () => 'Partial' },
      ctx,
    );
    expect(h.markRefunded).not.toHaveBeenCalled();
    expect(h.addPendingRefunds).toHaveBeenCalledWith(
      42,
      [{ refundId: 'RF1', paymentId: 'pi_1', amountCents: 1000 }],
      { actorUserId: 'u1', actionReason: 'Partial' },
      h.tx,
    );
    expect(outcome).toMatchObject({
      status: 'refunded',
      refundStatus: 'pending',
      refundedNowCents: 0,
      pendingCents: 1000,
      full: false,
      refunds: [{ paymentId: 'pi_1', refundId: 'RF1', state: 'pending', amountCents: 1000 }],
    });
  });

  it('counts pending refunds as refunded for the remaining amount and the key', async () => {
    h.lockSessionRecord.mockResolvedValue(
      record({
        provider: 'adyen',
        providerRefunds: [
          {
            refundId: 'RF1',
            paymentId: 'pi_1',
            amountCents: 1000,
            state: 'pending',
            requestedAt: '2026-10-03T10:00:00.000Z',
          },
          {
            refundId: 'RF0',
            paymentId: 'pi_1',
            amountCents: 500,
            state: 'failed',
            requestedAt: '2026-10-03T09:00:00.000Z',
          },
        ],
      }),
    );
    expect(await refundPaymentRecord({ sessionId: 's1', amountCents: 2500 }, ctx)).toMatchObject({
      status: 'exceeds_remaining',
      remainingCents: 2000,
    });
    refund.mockResolvedValue({ state: 'pending', operationRef: 'RF2' });
    await refundPaymentRecord({ sessionId: 's1' }, ctx);
    expect(refund).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 2000, idempotencyKey: 'refund_pi_1_1000_2000_2' }),
    );
  });

  it('allocates around pending top-up refunds', async () => {
    h.lockSessionRecord.mockResolvedValue(
      record({
        provider: 'adyen',
        capturedAmountCents: 3000,
        metadata: { topUps: [{ paymentId: 'TOP1', amountCents: 1000, refundedCents: 0 }] },
        providerRefunds: [
          {
            refundId: 'RF1',
            paymentId: 'pi_1',
            amountCents: 2000,
            state: 'pending',
            requestedAt: '2026-10-03T10:00:00.000Z',
          },
        ],
      }),
    );
    refund.mockResolvedValue({ state: 'pending', operationRef: 'RF2' });
    await refundPaymentRecord({ sessionId: 's1', amountCents: 500 }, ctx);
    expect(refund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: 'TOP1',
        amountCents: 500,
        idempotencyKey: 'refund_pi_1_2000_500_1_topup_1',
      }),
    );
  });
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
      idempotencyKey: 'refund_pi_1_0_3000_0',
    });
    expect(h.markRefunded).toHaveBeenCalledWith(
      42,
      {
        refundedTotalCents: 3000,
        full: true,
        actorUserId: 'u1',
        actionReason: 'Full',
        ledger: [ledgerEntry('re_1', 'pi_1', 3000)],
      },
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
      expect.objectContaining({ amountCents: 500, idempotencyKey: 'refund_pi_1_1000_500_0' }),
    );
    expect(h.markRefunded).toHaveBeenCalledWith(
      42,
      {
        refundedTotalCents: 1500,
        full: false,
        actorUserId: null,
        actionReason: null,
        ledger: [ledgerEntry('re_1', 'pi_1', 500)],
      },
      h.tx,
    );
    expect(outcome).toMatchObject({ status: 'refunded', refundedNowCents: 500, full: false });
  });

  it('pins the provider column of the record', async () => {
    h.lockSessionRecord.mockResolvedValue(
      record({ provider: 'simulated', providerPaymentId: 'pi_sim_1', providerCustomerId: null }),
    );
    await refundPaymentRecord({ sessionId: 's1' }, ctx);
    expect(getPaymentProvider).toHaveBeenCalledWith('simulated');
  });

  it('returns not_configured for a record without a provider', async () => {
    h.lockSessionRecord.mockResolvedValue(record({ provider: null }));
    expect(await refundPaymentRecord({ sessionId: 's1' }, ctx)).toEqual({
      status: 'not_configured',
      providerId: 'unknown',
    });
    expect(refund).not.toHaveBeenCalled();
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
    h.lockSessionRecord.mockResolvedValue(record({ providerPaymentId: null }));
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
      { paymentId: 'pi_1', amountCents: 2000, key: 'refund_pi_1_0_3000_0' },
      { paymentId: 'pi_t1', amountCents: 600, key: 'refund_pi_1_0_3000_0_topup_1' },
      { paymentId: 'pi_t2', amountCents: 400, key: 'refund_pi_1_0_3000_0_topup_2' },
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
        ledger: [
          ledgerEntry('re_1', 'pi_1', 2000),
          ledgerEntry('re_1', 'pi_t1', 600),
          ledgerEntry('re_1', 'pi_t2', 400),
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
      { paymentId: 'pi_1', amountCents: 1500, key: 'refund_pi_1_0_1500_0' },
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
      { paymentId: 'pi_1', amountCents: 2000, key: 'refund_pi_1_0_2300_0' },
      { paymentId: 'pi_t1', amountCents: 300, key: 'refund_pi_1_0_2300_0_topup_1' },
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
      { paymentId: 'pi_t1', amountCents: 300, key: 'refund_pi_1_2300_500_0_topup_1' },
      { paymentId: 'pi_t2', amountCents: 200, key: 'refund_pi_1_2300_500_0_topup_2' },
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

  describe('a capture above the hold with no listed top-up (retry top-up before v0.1.37)', () => {
    // Hold 2000 captured, a retry top-up of 500 whose id was never stored.
    const unlisted = (overrides: Partial<PaymentRecord> = {}): PaymentRecord =>
      record({ preAuthAmountCents: 2000, capturedAmountCents: 2500, metadata: null, ...overrides });

    it('refuses a refund above what the known charges hold, before any provider call', async () => {
      h.lockSessionRecord.mockResolvedValue(unlisted());
      const outcome = await refundPaymentRecord({ sessionId: 's1' }, ctx);
      expect(outcome).toEqual({
        status: 'top_up_unknown',
        refundableCents: 2000,
        unlistedCents: 500,
        currency: 'EUR',
      });
      expect(refund).not.toHaveBeenCalled();
      expect(h.markRefunded).not.toHaveBeenCalled();
    });

    it('counts what was already refunded from the hold', async () => {
      h.lockSessionRecord.mockResolvedValue(
        unlisted({ status: 'partially_refunded', refundedAmountCents: 1500 }),
      );
      const outcome = await refundPaymentRecord({ sessionId: 's1', amountCents: 600 }, ctx);
      expect(outcome).toMatchObject({ status: 'top_up_unknown', refundableCents: 500 });
      expect(refund).not.toHaveBeenCalled();
    });

    it('refunds an amount the hold covers', async () => {
      h.lockSessionRecord.mockResolvedValue(unlisted());
      const outcome = await refundPaymentRecord({ sessionId: 's1', amountCents: 2000 }, ctx);
      expect(refundCalls()).toEqual([
        { paymentId: 'pi_1', amountCents: 2000, key: 'refund_pi_1_0_2000_0' },
      ]);
      expect(outcome).toMatchObject({ status: 'refunded', refundedNowCents: 2000, full: false });
    });
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
        refunds: [
          {
            paymentId: 'pi_1',
            kind: 'hold',
            amountCents: 2000,
            refundId: 're_1',
            state: 'succeeded',
          },
        ],
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
      connectWebhookSecret: null,
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
        { idempotencyKey: 'refund_pi_1_0_3000_0' },
      ],
      [
        { payment_intent: 'pi_t1', amount: 600 },
        { idempotencyKey: 'refund_pi_1_0_3000_0_topup_1' },
      ],
      [
        { payment_intent: 'pi_t2', amount: 400, reverse_transfer: true },
        { idempotencyKey: 'refund_pi_1_0_3000_0_topup_2' },
      ],
    ]);
  });
});

describe('refundPaymentRecord of a reservation fee', () => {
  /** A captured cancellation fee: 5.00 net plus 19% tax, charged as one payment. */
  function feeRecord(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
    return record({
      id: 7,
      sessionId: null,
      chargeType: 'reservation_cancellation',
      reservationId: 'rsv_1',
      taxRate: '0.19',
      preAuthAmountCents: null,
      capturedAmountCents: 595,
      providerPaymentId: 'pi_fee',
      ...overrides,
    });
  }

  beforeEach(() => {
    refund.mockReset();
    refund.mockResolvedValue({ state: 'succeeded', refundId: 're_fee', amountCents: 0 });
    h.lockSessionRecord.mockReset();
    h.lockRecord.mockReset();
    h.markRefunded.mockClear();
    h.addPendingRefunds.mockReset();
    h.addPendingRefunds.mockImplementation((id: number) => Promise.resolve(feeRecord({ id })));
  });

  it('answers not_found for a missing record or a session record, without a provider call', async () => {
    h.lockRecord.mockResolvedValueOnce(null);
    expect(await refundPaymentRecord({ feeRecordId: 7 }, ctx)).toEqual({ status: 'not_found' });
    h.lockRecord.mockResolvedValueOnce(record());
    expect(await refundPaymentRecord({ feeRecordId: 42 }, ctx)).toEqual({ status: 'not_found' });
    expect(h.lockSessionRecord).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
    expect(h.markRefunded).not.toHaveBeenCalled();
  });

  it('refunds the fee in full by its record id with the request key and the fee reference', async () => {
    h.lockRecord.mockResolvedValue(feeRecord());
    const outcome = await refundPaymentRecord(
      { feeRecordId: 7, actorUserId: 'u1', actionReason: (full) => (full ? 'Full' : 'Partial') },
      ctx,
    );
    expect(h.lockRecord).toHaveBeenCalledWith(h.tx, 7);
    expect(refund).toHaveBeenCalledWith({
      paymentId: 'pi_fee',
      amountCents: 595,
      currency: 'EUR',
      merchantReference: 'cancellation-fee-rsv_1',
      idempotencyKey: 'refund_pi_fee_0_595_0',
    });
    expect(h.markRefunded).toHaveBeenCalledWith(
      7,
      {
        refundedTotalCents: 595,
        full: true,
        actorUserId: 'u1',
        actionReason: 'Full',
        ledger: [ledgerEntry('re_fee', 'pi_fee', 595)],
      },
      h.tx,
    );
    expect(outcome).toMatchObject({ status: 'refunded', refundedNowCents: 595, full: true });
  });

  it('applies the partial-refund rules of a session refund', async () => {
    const ledger = [
      {
        refundId: 're_0',
        paymentId: 'pi_fee',
        amountCents: 100,
        state: 'succeeded' as const,
        requestedAt: '2026-10-03T10:00:00.000Z',
        settledAt: '2026-10-03T10:00:00.000Z',
      },
    ];
    h.lockRecord.mockResolvedValue(
      feeRecord({
        status: 'partially_refunded',
        refundedAmountCents: 100,
        providerRefunds: ledger,
      }),
    );
    expect(await refundPaymentRecord({ feeRecordId: 7, amountCents: 496 }, ctx)).toEqual({
      status: 'exceeds_remaining',
      remainingCents: 495,
      requestedCents: 496,
      currency: 'EUR',
    });
    expect(refund).not.toHaveBeenCalled();

    const outcome = await refundPaymentRecord({ feeRecordId: 7, amountCents: 200 }, ctx);
    expect(refund).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 200, idempotencyKey: 'refund_pi_fee_100_200_1' }),
    );
    expect(h.markRefunded).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ refundedTotalCents: 300, full: false }),
      h.tx,
    );
    expect(outcome).toMatchObject({ status: 'refunded', full: false });

    h.lockRecord.mockResolvedValue(feeRecord({ status: 'refunded', refundedAmountCents: 595 }));
    expect(await refundPaymentRecord({ feeRecordId: 7 }, ctx)).toEqual({
      status: 'no_captured_payment',
    });
  });

  it('reverses the transfer and refunds the platform fee of a Stripe destination charge', async () => {
    const client = fakeClient();
    client.paymentIntents.retrieve.mockResolvedValue({
      transfer_data: { destination: 'acct_1' },
      application_fee_amount: 50,
    });
    client.refunds.create.mockResolvedValue({ id: 're_stripe', amount: 595 });
    getPaymentProvider.mockResolvedValue(
      new StripePaymentProvider({
        client: client as unknown as Stripe,
        publishableKey: 'pk_test_1',
        webhookSecret: null,
        connectWebhookSecret: null,
      }),
    );
    h.lockRecord.mockResolvedValue(feeRecord());
    const outcome = await refundPaymentRecord({ feeRecordId: 7 }, ctx);
    expect(client.refunds.create.mock.calls).toEqual([
      [
        {
          payment_intent: 'pi_fee',
          amount: 595,
          reverse_transfer: true,
          refund_application_fee: true,
        },
        { idempotencyKey: 'refund_pi_fee_0_595_0' },
      ],
    ]);
    expect(outcome).toMatchObject({
      status: 'refunded',
      refundStatus: 'succeeded',
      refunds: [{ paymentId: 'pi_fee', refundId: 're_stripe', state: 'succeeded' }],
    });
  });

  it('lists an Adyen fee refund as pending under the fee reference until the webhook confirms it', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    getPaymentProvider.mockResolvedValue(provider);
    h.lockRecord.mockResolvedValue(
      feeRecord({
        provider: 'adyen',
        chargeType: 'reservation_no_show',
        providerPaymentId: 'PSPFEE',
      }),
    );
    const outcome = await refundPaymentRecord(
      { feeRecordId: 7, amountCents: 300, actorUserId: 'u1', actionReason: () => 'Partial' },
      ctx,
    );
    const call = adyen.last();
    expect(call.path).toMatch(/\/payments\/PSPFEE\/refunds$/);
    expect(call.headers['idempotency-key']).toBe('refund_PSPFEE_0_300_0');
    expect(call.body).toMatchObject({
      amount: { value: 300, currency: 'EUR' },
      reference: 'no-show-fee-rsv_1',
    });
    expect(h.markRefunded).not.toHaveBeenCalled();
    expect(h.addPendingRefunds).toHaveBeenCalledWith(
      7,
      [{ refundId: MODIFICATION_PSP, paymentId: 'PSPFEE', amountCents: 300 }],
      { actorUserId: 'u1', actionReason: 'Partial' },
      h.tx,
    );
    expect(outcome).toMatchObject({
      status: 'refunded',
      refundStatus: 'pending',
      pendingCents: 300,
      refundedNowCents: 0,
    });
  });

  it('uses fee_<paymentId> as the reference of a fee whose reservation was deleted', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    getPaymentProvider.mockResolvedValue(provider);
    h.lockRecord.mockResolvedValue(
      feeRecord({ provider: 'adyen', reservationId: null, providerPaymentId: 'PSPFEE' }),
    );
    await refundPaymentRecord({ feeRecordId: 7, amountCents: 100 }, ctx);
    expect(adyen.last().body).toMatchObject({ reference: 'fee_PSPFEE' });
  });

  it('refunds a simulated fee charge synchronously', async () => {
    getPaymentProvider.mockResolvedValue(
      new SimulatedPaymentProvider({ encryptionKey: 'test-encryption-key-32chars-long!' }),
    );
    h.lockRecord.mockResolvedValue(
      feeRecord({ provider: 'simulated', providerPaymentId: 'pi_sim_approve_595_abc' }),
    );
    const outcome = await refundPaymentRecord({ feeRecordId: 7 }, ctx);
    expect(h.markRefunded).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        refundedTotalCents: 595,
        full: true,
        ledger: [
          expect.objectContaining({ paymentId: 'pi_sim_approve_595_abc', state: 'succeeded' }),
        ],
      }),
      h.tx,
    );
    expect(outcome).toMatchObject({ status: 'refunded', refundStatus: 'succeeded' });
  });

  it('confirms a simulated async fee refund by webhook', async () => {
    const deliveries: SimulatedWebhookDelivery[] = [];
    getPaymentProvider.mockResolvedValue(
      new SimulatedPaymentProvider({
        encryptionKey: 'test-encryption-key-32chars-long!',
        resultMode: 'async',
        events: {
          deliver: (d) => {
            deliveries.push(d);
            return Promise.resolve();
          },
        },
      }),
    );
    h.lockRecord.mockResolvedValue(
      feeRecord({ provider: 'simulated', providerPaymentId: 'pi_sim_approve_595_abc' }),
    );
    const outcome = await refundPaymentRecord({ feeRecordId: 7, amountCents: 200 }, ctx);
    expect(outcome).toMatchObject({
      status: 'refunded',
      refundStatus: 'pending',
      pendingCents: 200,
    });
    expect(h.addPendingRefunds).toHaveBeenCalledWith(
      7,
      [expect.objectContaining({ paymentId: 'pi_sim_approve_595_abc', amountCents: 200 })],
      expect.anything(),
      h.tx,
    );
    expect(JSON.stringify(deliveries)).toContain('payment.refunded');
  });
});
