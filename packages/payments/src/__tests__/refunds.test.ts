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

import { refundPaymentRecord } from '../refunds.js';
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
