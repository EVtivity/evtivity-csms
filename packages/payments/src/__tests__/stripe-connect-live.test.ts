// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Stripe Connect contract test against real Stripe test mode: destination
// charges, the platform fee on capture and top-up, transfer reversals and
// application fee refunds on refunds. Runs only when STRIPE_TEST_SECRET_KEY
// holds a test-mode key and STRIPE_TEST_CONNECTED_ACCOUNT a connected account
// (acct_) of that platform with card_payments and transfers active; skipped
// otherwise (CI has neither).
//
// The session and refund services run for real against the real
// StripePaymentProvider. Only their database is replaced: payment records
// live in an in-memory store with the same transition guards, and the
// session, method and site-config reads answer from the scenario.

import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import Stripe from 'stripe';
import { incrementalPlatformFeeCents, platformFeeCents } from '@evtivity/lib';

vi.mock('@evtivity/database', async () => (await import('./helpers/session-db.js')).databaseMock);
vi.mock('../settings.js', async () => (await import('./helpers/session-db.js')).settingsMock);
vi.mock('../payment-records.js', async () => (await import('./helpers/memory-records.js')).records);

import { StripePaymentProvider } from '../providers/stripe/index.js';
import {
  authorizeSessionHold,
  cancelSessionHold,
  captureSessionHold,
  retryShortfallForRecord,
  settleSessionPayment,
} from '../session-payments.js';
import { refundPaymentRecord } from '../refunds.js';
import type { PaymentContext } from '../context.js';
import type { PaymentProviderRegistry } from '../registry.js';
import { memoryRecords } from './helpers/memory-records.js';
import { sessionDb } from './helpers/session-db.js';

const secretKey = process.env['STRIPE_TEST_SECRET_KEY'] ?? '';
const connectedAccount = process.env['STRIPE_TEST_CONNECTED_ACCOUNT'] ?? '';
const enabled = /^(sk|rk)_test_/.test(secretKey) && /^acct_/.test(connectedAccount);

const TAX = 0.19;
const FEE_PERCENT = 10;
const HOLD_CENTS = 2000;

function refId(ref: string | { id: string } | null | undefined): string | null {
  if (ref == null) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

describe.skipIf(!enabled)('Stripe Connect against Stripe test mode', () => {
  const run = crypto.randomUUID();
  const key = (name: string) => `connect_${run}_${name}`;
  let client: Stripe;
  let provider: StripePaymentProvider;
  let customerId: string;
  let ctx: PaymentContext;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeAll(async () => {
    client = new Stripe(secretKey, { maxNetworkRetries: 3 });
    provider = new StripePaymentProvider({
      client,
      publishableKey: 'pk_test_unused',
      webhookSecret: null,
    });
    ({ customerId } = await provider.createCustomer({
      email: 'connect-contract-test@example.com',
      name: 'Connect Contract Test',
      idempotencyKey: key('customer'),
    }));
    const method = await client.paymentMethods.attach('pm_card_visa', { customer: customerId });
    sessionDb.method = { id: 1, customerId, methodId: method.id };
    ctx = {
      registry: {
        getPaymentProvider: () => Promise.resolve(provider),
        settings: () => Promise.resolve({ preAuthAmountCents: HOLD_CENTS }),
      } as unknown as PaymentProviderRegistry,
      logger,
    };
  }, 60_000);

  beforeEach(() => {
    sessionDb.sitePaymentConfig = {
      configId: 7,
      payoutAccountId: connectedAccount,
      preAuthAmountCents: HOLD_CENTS,
    };
    sessionDb.platformFeePercent = FEE_PERCENT;
  });

  /** A new session; its hold goes through authorizeSessionHold. */
  async function hold(name: string, finalCostCents: number | null): Promise<string> {
    sessionDb.current = { sessionId: `${run}_${name}`, finalCostCents, siteId: 'site-1' };
    const outcome = await authorizeSessionHold(
      {
        sessionId: sessionDb.current.sessionId,
        driverId: 'd1',
        methodRowId: null,
        siteId: 'site-1',
        trigger: 'projection_gate',
      },
      ctx,
    );
    if (outcome.outcome !== 'authorized') throw new Error(`hold ${outcome.outcome}`);
    return outcome.paymentId;
  }

  async function chargeOf(intentId: string): Promise<Stripe.Charge> {
    const intent = await client.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
    return intent.latest_charge as Stripe.Charge;
  }

  /** The charge's transfer and application fee, as Stripe holds them now. */
  async function connectObjects(charge: Stripe.Charge): Promise<{
    transfer: Stripe.Transfer | null;
    fee: Stripe.ApplicationFee | null;
  }> {
    const transferId = refId(charge.transfer);
    const feeId = refId(charge.application_fee);
    return {
      transfer: transferId != null ? await client.transfers.retrieve(transferId) : null,
      fee: feeId != null ? await client.applicationFees.retrieve(feeId) : null,
    };
  }

  it('places a destination hold without a fee and captures part of it with the platform fee', async () => {
    const intentId = await hold('partial', 1500);
    const held = await client.paymentIntents.retrieve(intentId);
    expect(held).toMatchObject({
      status: 'requires_capture',
      amount: HOLD_CENTS,
      on_behalf_of: connectedAccount,
      transfer_data: { destination: connectedAccount },
      application_fee_amount: null,
    });

    const settled = await settleSessionPayment(sessionDb.current?.sessionId ?? '', ctx);
    expect(settled).toMatchObject({ mode: 'card', status: 'captured', capturedCents: 1500 });

    const expectedFee = platformFeeCents(1500, TAX, FEE_PERCENT);
    expect(expectedFee).toBeGreaterThan(0);
    const captured = await client.paymentIntents.retrieve(intentId);
    expect(captured).toMatchObject({
      status: 'succeeded',
      amount_received: 1500,
      application_fee_amount: expectedFee,
    });
    const charge = await chargeOf(intentId);
    expect(charge).toMatchObject({ amount_captured: 1500, on_behalf_of: connectedAccount });
    // Stripe transfers the whole charge to the connected account, then takes
    // the application fee back from the payment it created there.
    const { transfer, fee } = await connectObjects(charge);
    expect(transfer).toMatchObject({ destination: connectedAccount, amount: 1500 });
    expect(refId(transfer?.source_transaction)).toBe(charge.id);
    expect(fee).toMatchObject({ amount: expectedFee, amount_refunded: 0 });
    expect(refId(fee?.account)).toBe(connectedAccount);
    expect(refId(fee?.originating_transaction)).toBe(charge.id);
    expect(refId(fee?.charge)).toBe(refId(transfer?.destination_payment));
  }, 120_000);

  it('refunds part, replays the refund, then refunds the rest with reversals and fee refunds', async () => {
    const intentId = await hold('refund', 1500);
    await settleSessionPayment(sessionDb.current?.sessionId ?? '', ctx);
    const sessionId = sessionDb.current?.sessionId ?? '';
    const record = memoryRecords.bySession(sessionId);
    const expectedFee = platformFeeCents(1500, TAX, FEE_PERCENT);

    const partial = await refundPaymentRecord({ sessionId, amountCents: 500 }, ctx);
    expect(partial).toMatchObject({ status: 'refunded', refundedNowCents: 500, full: false });
    const charge = await chargeOf(intentId);
    const afterPartial = await connectObjects(charge);
    const refunds = await client.refunds.list({ payment_intent: intentId });
    expect(refunds.data).toHaveLength(1);
    const partialRefund = refunds.data[0];
    expect(partialRefund).toMatchObject({ amount: 500, status: 'succeeded' });
    // reverse_transfer: a reversal of the transfer, linked to the refund.
    expect(refId(partialRefund?.transfer_reversal)).toMatch(/^trr_/);
    const reversed = afterPartial.transfer?.amount_reversed ?? 0;
    const feeRefunded = afterPartial.fee?.amount_refunded ?? 0;
    // Stripe prorates both: the transfer (the whole charge) is reversed by the
    // refunded amount and the fee by its share of it.
    expect(reversed).toBe(500);
    expect(feeRefunded).toBe(Math.round((expectedFee * 500) / 1500));
    expect(feeRefunded).toBeGreaterThan(0);
    const feeRefunds = await client.applicationFees.listRefunds(afterPartial.fee?.id ?? '');
    expect(feeRefunds.data).toHaveLength(1);

    // A retry of the same request (same refunded total and amount) reuses the refund.
    const replay = await provider.refund({
      paymentId: intentId,
      amountCents: 500,
      currency: 'USD',
      merchantReference: `sess_${sessionId}`,
      idempotencyKey: `refund_${intentId}_${String(record?.id)}_0_500`,
    });
    expect(replay).toMatchObject({ refundId: partialRefund?.id });
    expect((await client.refunds.list({ payment_intent: intentId })).data).toHaveLength(1);

    const rest = await refundPaymentRecord({ sessionId }, ctx);
    expect(rest).toMatchObject({ status: 'refunded', refundedNowCents: 1000, full: true });
    expect(memoryRecords.bySession(sessionId)).toMatchObject({
      status: 'refunded',
      refundedAmountCents: 1500,
    });
    const after = await connectObjects(await chargeOf(intentId));
    expect(after.transfer?.amount_reversed).toBe(after.transfer?.amount);
    expect(after.transfer?.reversed).toBe(true);
    expect(after.fee).toMatchObject({
      amount: expectedFee,
      amount_refunded: expectedFee,
      refunded: true,
    });
    expect((await client.transfers.listReversals(after.transfer?.id ?? '')).data).toHaveLength(2);
  }, 120_000);

  it('refunds a destination charge in full in one request', async () => {
    const intentId = await hold('full_refund', null);
    const sessionId = sessionDb.current?.sessionId ?? '';
    // Operator capture of 1800 (captureSessionHold), then one full refund.
    const captured = await captureSessionHold({ sessionId, amountCents: 1800 }, ctx);
    expect(captured).toMatchObject({ status: 'captured' });
    const expectedFee = platformFeeCents(1800, TAX, FEE_PERCENT);
    expect((await client.paymentIntents.retrieve(intentId)).application_fee_amount).toBe(
      expectedFee,
    );

    const refunded = await refundPaymentRecord({ sessionId }, ctx);
    expect(refunded).toMatchObject({ status: 'refunded', refundedNowCents: 1800, full: true });
    const charge = await chargeOf(intentId);
    expect(charge).toMatchObject({ refunded: true, amount_refunded: 1800 });
    const { transfer, fee } = await connectObjects(charge);
    expect(transfer).toMatchObject({ amount: 1800, amount_reversed: 1800, reversed: true });
    expect(fee).toMatchObject({
      amount: expectedFee,
      amount_refunded: expectedFee,
      refunded: true,
    });
  }, 120_000);

  it('captures without an application fee when the site fee is 0, still transferring', async () => {
    sessionDb.platformFeePercent = 0;
    const intentId = await hold('fee0', 1200);
    const settled = await settleSessionPayment(sessionDb.current?.sessionId ?? '', ctx);
    expect(settled).toMatchObject({ mode: 'card', status: 'captured', capturedCents: 1200 });
    const intent = await client.paymentIntents.retrieve(intentId);
    expect(intent).toMatchObject({
      status: 'succeeded',
      amount_received: 1200,
      application_fee_amount: null,
      transfer_data: { destination: connectedAccount },
    });
    const charge = await chargeOf(intentId);
    expect(charge.application_fee ?? null).toBeNull();
    const { transfer } = await connectObjects(charge);
    expect(transfer).toMatchObject({ destination: connectedAccount, amount: 1200 });
  }, 120_000);

  it('tops up a shortfall on the same destination with the incremental fee, once across a replay', async () => {
    const intentId = await hold('topup', 2600);
    const sessionId = sessionDb.current?.sessionId ?? '';
    // The provider charges but the record update fails: the settlement is replayed.
    memoryRecords.failNextCapturedUpdate();
    const first = await settleSessionPayment(sessionId, ctx);
    expect(first).toMatchObject({
      mode: 'card',
      status: 'captured',
      capturedCents: 2600,
      recorded: false,
    });
    expect(memoryRecords.bySession(sessionId)?.status).toBe('pre_authorized');
    const second = await settleSessionPayment(sessionId, ctx);
    expect(second).toMatchObject({ status: 'captured', capturedCents: 2600, recorded: true });
    const record = memoryRecords.bySession(sessionId);
    const topUps = (record?.metadata as { topUps?: Array<{ paymentId: string }> } | null)?.topUps;
    expect(record?.metadata).toEqual({
      topUps: [{ paymentId: expect.stringMatching(/^pi_/), amountCents: 600, refundedCents: 0 }],
    });
    const topUpId = topUps?.[0]?.paymentId ?? '';

    const captureFee = incrementalPlatformFeeCents(0, HOLD_CENTS, TAX, FEE_PERCENT);
    const topUpFee = incrementalPlatformFeeCents(HOLD_CENTS, 2600, TAX, FEE_PERCENT);
    expect(captureFee + topUpFee).toBe(platformFeeCents(2600, TAX, FEE_PERCENT));
    expect((await client.paymentIntents.retrieve(intentId)).application_fee_amount).toBe(
      captureFee,
    );
    const topUp = await client.paymentIntents.retrieve(topUpId);
    expect(topUp).toMatchObject({
      status: 'succeeded',
      amount: 600,
      customer: customerId,
      on_behalf_of: connectedAccount,
      transfer_data: { destination: connectedAccount },
      application_fee_amount: topUpFee,
    });
    const { transfer, fee } = await connectObjects(await chargeOf(topUpId));
    expect(transfer).toMatchObject({ destination: connectedAccount, amount: 600 });
    expect(fee).toMatchObject({ amount: topUpFee });
    expect(refId(fee?.account)).toBe(connectedAccount);

    // One capture and one top-up despite the replay.
    const intents = await client.paymentIntents.list({ customer: customerId, limit: 100 });
    expect(
      intents.data.filter((pi) => pi.description === `Top-up for session ${sessionId}`),
    ).toHaveLength(1);
    const held = await connectObjects(await chargeOf(intentId));
    expect(held.fee).toMatchObject({ amount: captureFee });
    const fees = await client.applicationFees.list({ charge: refId(held.fee?.charge) ?? '' });
    expect(fees.data).toHaveLength(1);
  }, 120_000);

  it('cancels a destination hold', async () => {
    const intentId = await hold('cancel', null);
    const record = memoryRecords.bySession(sessionDb.current?.sessionId ?? '');
    if (record == null) throw new Error('no record');
    await cancelSessionHold(record, 'test', ctx);
    expect(memoryRecords.bySession(record.sessionId ?? '')?.status).toBe('cancelled');
    const intent = await client.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
    expect(intent).toMatchObject({
      status: 'canceled',
      amount_received: 0,
      application_fee_amount: null,
      transfer_data: { destination: connectedAccount },
    });
    const charge = intent.latest_charge as Stripe.Charge | null;
    expect(charge?.transfer ?? null).toBeNull();
    expect(charge?.application_fee ?? null).toBeNull();
  }, 120_000);

  it('charges no fee and makes no transfer when the site config is disabled', async () => {
    // getSitePaymentConfig returns only enabled configs; the platform percent still applies.
    sessionDb.sitePaymentConfig = null;
    const intentId = await hold('disabled', 1500);
    const held = await client.paymentIntents.retrieve(intentId);
    expect(held.on_behalf_of).toBeNull();
    expect(held.transfer_data).toBeNull();
    expect(
      memoryRecords.bySession(sessionDb.current?.sessionId ?? '')?.sitePaymentConfigId,
    ).toBeNull();

    const settled = await settleSessionPayment(sessionDb.current?.sessionId ?? '', ctx);
    expect(settled).toMatchObject({ mode: 'card', status: 'captured', capturedCents: 1500 });
    const intent = await client.paymentIntents.retrieve(intentId);
    expect(intent).toMatchObject({
      status: 'succeeded',
      amount_received: 1500,
      application_fee_amount: null,
    });
    const charge = await chargeOf(intentId);
    expect(charge.transfer ?? null).toBeNull();
    expect(charge.application_fee ?? null).toBeNull();
    expect(charge.on_behalf_of ?? null).toBeNull();
  }, 120_000);

  it('retries a destination hold and its capture without duplicates', async () => {
    const sessionId = `${run}_retry`;
    const holdInput = {
      idempotencyKey: `preauth_${sessionId}`,
      method: { kind: 'saved' as const, customerId, methodId: sessionDb.method?.methodId ?? '' },
      initiator: 'merchant' as const,
      merchantReference: `sess_${sessionId}`,
      amountCents: HOLD_CENTS,
      currency: 'USD',
      payoutAccountId: connectedAccount,
    };
    const first = await provider.authorizeHold(holdInput);
    const again = await provider.authorizeHold(holdInput);
    if (first.status !== 'authorized') throw new Error('expected a hold');
    expect(again).toMatchObject({ status: 'authorized', paymentId: first.paymentId });

    // The session service sees its record and never calls the provider again.
    sessionDb.current = { sessionId, finalCostCents: 1000, siteId: 'site-1' };
    const recorded = await authorizeSessionHold(
      { sessionId, driverId: 'd1', methodRowId: null, siteId: 'site-1', trigger: 'portal_start' },
      ctx,
    );
    expect(recorded).toMatchObject({ outcome: 'authorized', paymentId: first.paymentId });
    const replayed = await authorizeSessionHold(
      {
        sessionId,
        driverId: 'd1',
        methodRowId: null,
        siteId: 'site-1',
        trigger: 'projection_gate',
      },
      ctx,
    );
    expect(replayed).toMatchObject({ outcome: 'exists', status: 'pre_authorized' });

    const captureInput = {
      idempotencyKey: key('retry_capture'),
      paymentId: first.paymentId,
      amountCents: 1000,
      currency: 'USD',
      merchantReference: `sess_${sessionId}`,
      payoutAccountId: null,
      feeTax: TAX,
      platformFeePercent: FEE_PERCENT,
    };
    const expectedFee = platformFeeCents(1000, TAX, FEE_PERCENT);
    expect(await provider.capture(captureInput)).toMatchObject({
      applicationFeeCents: expectedFee,
    });
    expect(await provider.capture(captureInput)).toMatchObject({
      applicationFeeCents: expectedFee,
    });
    const charge = await chargeOf(first.paymentId);
    expect(charge.amount_captured).toBe(1000);
    const { transfer, fee } = await connectObjects(charge);
    expect(transfer?.amount).toBe(1000);
    expect(fee?.amount).toBe(expectedFee);
    const fees = await client.applicationFees.list({ charge: refId(fee?.charge) ?? '' });
    expect(fees.data).toHaveLength(1);
    const transfers = await client.transfers.list({ destination: connectedAccount, limit: 100 });
    expect(transfers.data.filter((t) => refId(t.source_transaction) === charge.id)).toHaveLength(1);
  }, 120_000);

  function currentSession(): string {
    return sessionDb.current?.sessionId ?? '';
  }

  /** The top-up ids the record lists, in charge order. */
  function topUpIds(sessionId: string): string[] {
    const metadata = memoryRecords.bySession(sessionId)?.metadata as {
      topUps?: Array<{ paymentId: string }>;
    } | null;
    return (metadata?.topUps ?? []).map((t) => t.paymentId);
  }

  /** Charge, transfer reversal and fee refund of one intent, after a refund. */
  async function refundedState(intentId: string): Promise<{
    refunded: number;
    captured: number;
    reversed: number;
    transfer: number;
    feeRefunded: number;
    fee: number;
  }> {
    const charge = await chargeOf(intentId);
    const { transfer, fee } = await connectObjects(charge);
    return {
      refunded: charge.amount_refunded,
      captured: charge.amount_captured,
      reversed: transfer?.amount_reversed ?? 0,
      transfer: transfer?.amount ?? 0,
      feeRefunded: fee?.amount_refunded ?? 0,
      fee: fee?.amount ?? 0,
    };
  }

  it('refunds a session paid as hold plus top-up in full: both destination charges', async () => {
    const intentId = await hold('topup_full_refund', 2600);
    const sessionId = currentSession();
    await settleSessionPayment(sessionId, ctx);
    const [topUpId] = topUpIds(sessionId);
    if (topUpId == null) throw new Error('no top-up recorded');

    const refunded = await refundPaymentRecord({ sessionId }, ctx);
    expect(refunded).toMatchObject({
      status: 'refunded',
      refundedNowCents: 2600,
      full: true,
      refunds: [
        { paymentId: intentId, kind: 'hold', amountCents: HOLD_CENTS },
        { paymentId: topUpId, kind: 'top_up', amountCents: 600 },
      ],
    });
    expect(memoryRecords.bySession(sessionId)).toMatchObject({
      status: 'refunded',
      refundedAmountCents: 2600,
      metadata: { topUps: [{ paymentId: topUpId, amountCents: 600, refundedCents: 600 }] },
    });
    // Each charge is refunded in full with its own transfer reversed and fee refunded.
    for (const id of [intentId, topUpId]) {
      const state = await refundedState(id);
      expect(state.refunded).toBe(state.captured);
      expect(state.reversed).toBe(state.transfer);
      expect(state.fee).toBeGreaterThan(0);
      expect(state.feeRefunded).toBe(state.fee);
    }
  }, 120_000);

  it('refunds a top-up session in partial refunds spanning the hold and the top-up', async () => {
    const intentId = await hold('topup_partial_refunds', 2600);
    const sessionId = currentSession();
    await settleSessionPayment(sessionId, ctx);
    const [topUpId] = topUpIds(sessionId);
    if (topUpId == null) throw new Error('no top-up recorded');

    const first = await refundPaymentRecord({ sessionId, amountCents: 2300 }, ctx);
    expect(first).toMatchObject({ status: 'refunded', refundedNowCents: 2300, full: false });
    expect((await refundedState(intentId)).refunded).toBe(HOLD_CENTS);
    const topUpAfterFirst = await refundedState(topUpId);
    expect(topUpAfterFirst).toMatchObject({ refunded: 300, reversed: 300 });
    expect(topUpAfterFirst.feeRefunded).toBe(Math.round((topUpAfterFirst.fee * 300) / 600));

    const rest = await refundPaymentRecord({ sessionId }, ctx);
    expect(rest).toMatchObject({
      status: 'refunded',
      refundedNowCents: 300,
      full: true,
      refunds: [{ paymentId: topUpId, kind: 'top_up', amountCents: 300 }],
    });
    const topUp = await refundedState(topUpId);
    expect(topUp).toMatchObject({ refunded: 600, reversed: 600 });
    expect(topUp.feeRefunded).toBe(topUp.fee);
    expect((await client.refunds.list({ payment_intent: intentId })).data).toHaveLength(1);
    expect((await client.refunds.list({ payment_intent: topUpId })).data).toHaveLength(2);
  }, 120_000);

  it('records a retry top-up and refunds it with the hold', async () => {
    // A 30 cent top-up is below Stripe's minimum and declined; the operator
    // retry charges the shortfall once the final cost is 2600.
    const intentId = await hold('retry_topup_refund', 2030);
    const sessionId = currentSession();
    const settled = await settleSessionPayment(sessionId, ctx);
    expect(settled).toMatchObject({ status: 'captured', capturedCents: HOLD_CENTS });
    expect(topUpIds(sessionId)).toEqual([]);
    const record = memoryRecords.bySession(sessionId);
    if (record == null || sessionDb.current == null) throw new Error('no record');
    sessionDb.current.finalCostCents = 2600;
    const retried = await retryShortfallForRecord({ recordId: record.id, actorUserId: 'u1' }, ctx);
    expect(retried).toMatchObject({ status: 'recovered', shortfallCents: 600 });
    const [topUpId] = topUpIds(sessionId);
    expect(topUpId).toBe((retried as { topUpId: string }).topUpId);
    expect((await client.paymentIntents.retrieve(topUpId ?? '')).transfer_data).toMatchObject({
      destination: connectedAccount,
    });

    const refunded = await refundPaymentRecord({ sessionId }, ctx);
    expect(refunded).toMatchObject({ status: 'refunded', refundedNowCents: 2600, full: true });
    expect((await refundedState(intentId)).refunded).toBe(HOLD_CENTS);
    const topUp = await refundedState(topUpId ?? '');
    expect(topUp).toMatchObject({ refunded: 600, reversed: 600 });
  }, 120_000);
});
