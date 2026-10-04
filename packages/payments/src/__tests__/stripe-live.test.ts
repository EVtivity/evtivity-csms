// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Contract test of StripePaymentProvider against real Stripe test mode. Runs
// only when STRIPE_TEST_SECRET_KEY holds a test-mode key (sk_test_ or
// rk_test_); CI has none, so it is skipped there. Stripe Connect (destination
// charges, platform fee, reversals) is in stripe-connect-live.test.ts. The
// last block runs the session and refund services on a session paid as hold
// plus top-up, with payment records in memory.

import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import Stripe from 'stripe';

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/session-db.js')).databaseMock,
  settings: {},
  sitePaymentConfigs: {},
}));
vi.mock('../settings.js', async () => (await import('./helpers/session-db.js')).settingsMock);
vi.mock('../payment-records.js', async () => (await import('./helpers/memory-records.js')).records);

import { StripePaymentProvider } from '../providers/stripe/index.js';
import { authorizeSessionHold, settleSessionPayment } from '../session-payments.js';
import { refundKey } from '../idempotency-keys.js';
import { refundPaymentRecord } from '../refunds.js';
import type { PaymentContext } from '../context.js';
import type { PaymentProviderRegistry } from '../registry.js';
import { memoryRecords } from './helpers/memory-records.js';
import { sessionDb } from './helpers/session-db.js';
import {
  PaymentDeclinedError,
  PaymentMethodOwnershipError,
  WebhookSignatureError,
} from '../errors.js';

const secretKey = process.env['STRIPE_TEST_SECRET_KEY'] ?? '';
const isTestKey = /^(sk|rk)_test_/.test(secretKey);
const WEBHOOK_SECRET = 'whsec_contract_test_only';

describe.skipIf(!isTestKey)('StripePaymentProvider against Stripe test mode', () => {
  // A unique run id keeps idempotency keys from replaying earlier runs.
  const run = crypto.randomUUID();
  const key = (name: string) => `contract_${run}_${name}`;
  let client: Stripe;
  let provider: StripePaymentProvider;
  let customerId: string;
  let methodId: string;

  beforeAll(async () => {
    client = new Stripe(secretKey, { maxNetworkRetries: 3 });
    provider = new StripePaymentProvider({
      client,
      publishableKey: 'pk_test_unused',
      webhookSecret: WEBHOOK_SECRET,
      connectWebhookSecret: null,
    });
    ({ customerId } = await provider.createCustomer({
      email: 'contract-test@example.com',
      name: 'Contract Test',
      idempotencyKey: key('customer'),
    }));
    // The browser confirms a SetupIntent in production; the test attaches a
    // Stripe test method server-side instead.
    const attached = await client.paymentMethods.attach('pm_card_visa', { customer: customerId });
    methodId = attached.id;
  }, 60_000);

  it('connects', async () => {
    await expect(provider.testConnection()).resolves.toBeUndefined();
  });

  it('starts web and native method setup', async () => {
    const web = await provider.startMethodSetup({
      customerId,
      channel: 'web',
      currency: 'USD',
      countryCode: 'US',
    });
    expect(web).toMatchObject({ provider: 'stripe', customerId });
    const webSecret = (web as { clientSecret: string }).clientSecret;
    expect(webSecret).toMatch(/^seti_/);
    // allowed_payment_method_types (endive) keeps the SetupIntent card-only.
    const setupIntent = await client.setupIntents.retrieve(webSecret.split('_secret_')[0] ?? '');
    expect(setupIntent.payment_method_types).toEqual(['card']);
    const native = await provider.startMethodSetup({
      customerId,
      channel: 'native',
      currency: 'USD',
      countryCode: 'US',
      nativeSdkVersion: '2024-06-20',
    });
    expect((native as { ephemeralKey?: string }).ephemeralKey).toMatch(/^ek_test_/);
  });

  it('verifies the method server-side and refuses another customer', async () => {
    const details = await provider.verifyMethod({ methodId, customerId });
    expect(details).toMatchObject({ methodId, customerId, brand: 'visa', last4: '4242' });
    const other = await provider.createCustomer({
      email: 'other@example.com',
      name: 'Other',
      idempotencyKey: key('customer_other'),
    });
    await expect(
      provider.verifyMethod({ methodId, customerId: other.customerId }),
    ).rejects.toBeInstanceOf(PaymentMethodOwnershipError);
  });

  it('recognizes an unknown customer', async () => {
    const err = await provider
      .startMethodSetup({
        customerId: 'cus_does_not_exist',
        channel: 'web',
        currency: 'USD',
        countryCode: 'US',
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(provider.isUnknownCustomerError(err)).toBe(true);
  });

  it('holds, captures part, tops up, reconciles and refunds', async () => {
    const hold = await provider.authorizeHold({
      idempotencyKey: key('preauth'),
      method: { kind: 'saved', customerId, methodId },
      initiator: 'merchant',
      merchantReference: `sess_${run}`,
      amountCents: 2000,
      currency: 'USD',
      payoutAccountId: null,
    });
    expect(hold).toMatchObject({ status: 'authorized', authorizedCents: 2000 });
    if (hold.status !== 'authorized') return;

    // A retry with the same key returns the same hold.
    const again = await provider.authorizeHold({
      idempotencyKey: key('preauth'),
      method: { kind: 'saved', customerId, methodId },
      initiator: 'merchant',
      merchantReference: `sess_${run}`,
      amountCents: 2000,
      currency: 'USD',
      payoutAccountId: null,
    });
    expect(again).toMatchObject({ paymentId: hold.paymentId });

    const held = await provider.getPaymentState(hold.paymentId);
    expect(held.providerStatus).toBe('requires_capture');
    expect([...(held.acceptableLocalStatuses ?? [])]).toEqual(['pre_authorized']);

    const capture = await provider.capture({
      idempotencyKey: key('capture'),
      paymentId: hold.paymentId,
      amountCents: 1500,
      currency: 'USD',
      merchantReference: `sess_${run}`,
      payoutAccountId: null,
      feeTax: 0.1,
      platformFeePercent: 10,
    });
    // No destination on the intent, so no application fee even with a percent.
    expect(capture).toEqual({ state: 'succeeded', capturedCents: 1500, applicationFeeCents: 0 });

    const captured = await provider.getPaymentState(hold.paymentId);
    expect(captured).toMatchObject({ providerStatus: 'succeeded', capturedCents: 1500 });

    const topUp = await provider.chargeShortfall({
      idempotencyKey: key('topup'),
      originalPaymentId: hold.paymentId,
      capturedCents: 1500,
      finalCostCents: 2300,
      currency: 'USD',
      feeTax: 0.1,
      platformFeePercent: 10,
      description: 'Contract test shortfall',
    });
    expect(topUp).toMatchObject({ amountCents: 800, applicationFeeCents: 0 });
    expect((await provider.getPaymentState(topUp.paymentId)).providerStatus).toBe('succeeded');

    const refund = await provider.refund({
      idempotencyKey: key('refund'),
      paymentId: hold.paymentId,
      amountCents: 500,
      currency: 'USD',
      merchantReference: `sess_${run}`,
    });
    expect(refund).toMatchObject({ state: 'succeeded', amountCents: 500 });
    expect((refund as { refundId: string }).refundId).toMatch(/^re_/);
  }, 60_000);

  it('cancels a hold', async () => {
    const hold = await provider.authorizeHold({
      idempotencyKey: key('preauth_cancel'),
      method: { kind: 'saved', customerId, methodId },
      initiator: 'merchant',
      merchantReference: `sess_${run}_c`,
      amountCents: 1000,
      currency: 'USD',
      payoutAccountId: null,
    });
    if (hold.status !== 'authorized') throw new Error('expected a hold');
    expect(
      await provider.cancelHold({
        paymentId: hold.paymentId,
        merchantReference: `sess_${run}_c`,
        idempotencyKey: key('cancel'),
      }),
    ).toEqual({ state: 'succeeded' });
    expect((await provider.getPaymentState(hold.paymentId)).providerStatus).toBe('canceled');
  }, 60_000);

  it('places a guest hold on a one-time method', async () => {
    const hold = await provider.authorizeHold({
      idempotencyKey: key('guest'),
      method: { kind: 'one_time', payload: 'pm_card_mastercard' },
      initiator: 'shopper',
      merchantReference: `guest_${run}`,
      amountCents: 1200,
      currency: 'USD',
      payoutAccountId: null,
      receiptEmail: 'guest@example.com',
    });
    expect(hold).toMatchObject({ status: 'authorized', authorizedCents: 1200 });
  }, 60_000);

  it('charges a saved card immediately', async () => {
    const charge = await provider.chargeSavedMethod({
      idempotencyKey: key('fee'),
      customerId,
      methodId,
      grossCents: 550,
      currency: 'USD',
      feeTaxRate: 0.1,
      platformFeePercent: 10,
      payoutAccountId: null,
      description: 'Contract test fee',
      metadata: { test: 'contract' },
    });
    expect(charge).toMatchObject({ amountCents: 550, applicationFeeCents: 0 });
    expect((await provider.getPaymentState(charge.paymentId)).providerStatus).toBe('succeeded');
  }, 60_000);

  it('declines a card that fails off session and one that needs authentication', async () => {
    const failing = await client.paymentMethods.attach('pm_card_chargeCustomerFail', {
      customer: customerId,
    });
    const declined = await provider
      .authorizeHold({
        idempotencyKey: key('declined'),
        method: { kind: 'saved', customerId, methodId: failing.id },
        initiator: 'merchant',
        merchantReference: `sess_${run}_d`,
        amountCents: 1000,
        currency: 'USD',
        payoutAccountId: null,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(declined).toBeInstanceOf(PaymentDeclinedError);

    const sca = await client.paymentMethods.attach('pm_card_authenticationRequired', {
      customer: customerId,
    });
    const offSession = await provider
      .authorizeHold({
        idempotencyKey: key('sca_off'),
        method: { kind: 'saved', customerId, methodId: sca.id },
        initiator: 'merchant',
        merchantReference: `sess_${run}_s`,
        amountCents: 1000,
        currency: 'USD',
        payoutAccountId: null,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(offSession).toBeInstanceOf(PaymentDeclinedError);
    expect((offSession as PaymentDeclinedError).code).toBe('authentication_required');

    const onSession = await provider.authorizeHold({
      idempotencyKey: key('sca_on'),
      method: { kind: 'saved', customerId, methodId: sca.id },
      initiator: 'shopper',
      merchantReference: `sess_${run}_s2`,
      amountCents: 1000,
      currency: 'USD',
      payoutAccountId: null,
    });
    expect(onSession.status).toBe('action_required');
  }, 60_000);

  it('verifies a signed webhook and refuses a forged one', () => {
    const payload = JSON.stringify({
      id: `evt_${run}`,
      object: 'event',
      created: Math.floor(Date.now() / 1000),
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_contract', last_payment_error: { message: 'Declined' } } },
    });
    const header = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    expect(provider.verifyWebhook(payload, { 'stripe-signature': header })).toMatchObject([
      { type: 'payment.failed', paymentId: 'pi_contract', reason: 'Declined' },
    ]);
    const forged = client.webhooks.generateTestHeaderString({ payload, secret: 'whsec_wrong' });
    expect(() => provider.verifyWebhook(payload, { 'stripe-signature': forged })).toThrow(
      WebhookSignatureError,
    );
    // A signature older than the default 300 s tolerance is refused.
    const stale = client.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });
    expect(() => provider.verifyWebhook(payload, { 'stripe-signature': stale })).toThrow(
      WebhookSignatureError,
    );
  });

  it('detaches a method', async () => {
    const extra = await client.paymentMethods.attach('pm_card_visa', { customer: customerId });
    await provider.detachMethod({ customerId, methodId: extra.id });
    const after = await client.paymentMethods.retrieve(extra.id);
    expect(after.customer).toBeNull();
  }, 60_000);

  describe('refunds of a session paid as hold plus top-up (services)', () => {
    // The session and refund services run against the real provider with
    // payment records in memory (helpers/memory-records.ts) and the session
    // reads answered by helpers/session-db.ts. No site config: no Connect.
    const HOLD = 2000;
    let ctx: PaymentContext;

    beforeAll(() => {
      sessionDb.method = { id: 1, provider: 'stripe', customerId, methodId };
      sessionDb.sitePaymentConfig = null;
      sessionDb.platformFeePercent = 0;
      ctx = {
        registry: {
          getPaymentProvider: () => Promise.resolve(provider),
          settings: () => Promise.resolve({ preAuthAmountCents: HOLD }),
        } as unknown as PaymentProviderRegistry,
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      };
    });

    /** A held session, settled at `finalCostCents`. Returns the hold and top-up ids. */
    async function settled(
      name: string,
      finalCostCents: number,
    ): Promise<{ sessionId: string; intentId: string; topUpId: string }> {
      const sessionId = `${run}_${name}`;
      sessionDb.current = { sessionId, finalCostCents, siteId: 'site-1' };
      const held = await authorizeSessionHold(
        { sessionId, driverId: 'd1', methodRowId: null, siteId: null, trigger: 'projection_gate' },
        ctx,
      );
      if (held.outcome !== 'authorized') throw new Error(`hold ${held.outcome}`);
      expect(await settleSessionPayment(sessionId, ctx)).toMatchObject({
        status: 'captured',
        capturedCents: finalCostCents,
      });
      const metadata = memoryRecords.bySession(sessionId)?.metadata as {
        topUps?: Array<{ paymentId: string; amountCents: number }>;
      } | null;
      expect(metadata?.topUps).toEqual([
        {
          paymentId: expect.stringMatching(/^pi_/),
          amountCents: finalCostCents - HOLD,
          refundedCents: 0,
        },
      ]);
      return {
        sessionId,
        intentId: held.paymentId,
        topUpId: metadata?.topUps?.[0]?.paymentId ?? '',
      };
    }

    async function chargeRefunded(intentId: string): Promise<number> {
      const intent = await client.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
      return (intent.latest_charge as Stripe.Charge).amount_refunded;
    }

    it('refunds both charges in full with the default amount', async () => {
      const { sessionId, intentId, topUpId } = await settled('topup_full', 2600);
      const outcome = await refundPaymentRecord({ sessionId }, ctx);
      expect(outcome).toMatchObject({
        status: 'refunded',
        refundedNowCents: 2600,
        full: true,
        refunds: [
          { paymentId: intentId, kind: 'hold', amountCents: HOLD },
          { paymentId: topUpId, kind: 'top_up', amountCents: 600 },
        ],
      });
      expect(await chargeRefunded(intentId)).toBe(HOLD);
      expect(await chargeRefunded(topUpId)).toBe(600);
      expect(memoryRecords.bySession(sessionId)).toMatchObject({
        status: 'refunded',
        refundedAmountCents: 2600,
      });
      // Nothing is left to refund.
      expect(await refundPaymentRecord({ sessionId }, ctx)).toEqual({
        status: 'no_captured_payment',
      });
    }, 120_000);

    it('refunds partial amounts spanning the hold and the top-up, then the rest', async () => {
      const { sessionId, intentId, topUpId } = await settled('topup_partials', 2600);
      expect(await refundPaymentRecord({ sessionId, amountCents: 1500 }, ctx)).toMatchObject({
        refunds: [{ paymentId: intentId, amountCents: 1500 }],
      });
      expect(await refundPaymentRecord({ sessionId, amountCents: 800 }, ctx)).toMatchObject({
        refunds: [
          { paymentId: intentId, amountCents: 500 },
          { paymentId: topUpId, amountCents: 300 },
        ],
        full: false,
      });
      expect(await chargeRefunded(intentId)).toBe(HOLD);
      expect(await chargeRefunded(topUpId)).toBe(300);
      expect(await refundPaymentRecord({ sessionId }, ctx)).toMatchObject({
        refundedNowCents: 300,
        full: true,
        refunds: [{ paymentId: topUpId, amountCents: 300 }],
      });
      expect(await chargeRefunded(topUpId)).toBe(600);
      expect((await client.refunds.list({ payment_intent: intentId })).data).toHaveLength(2);
      expect((await client.refunds.list({ payment_intent: topUpId })).data).toHaveLength(2);
    }, 120_000);

    it('replays a spanning refund request without refunding twice', async () => {
      const { sessionId, intentId, topUpId } = await settled('topup_replay', 2600);
      const parts = { refundedSoFarCents: 0, amountCents: 2300, ledgerEntries: 0 };
      expect(await refundPaymentRecord({ sessionId, amountCents: 2300 }, ctx)).toMatchObject({
        refundedNowCents: 2300,
      });
      const holdReplay = await provider.refund({
        paymentId: intentId,
        amountCents: HOLD,
        currency: 'USD',
        merchantReference: `sess_${sessionId}`,
        idempotencyKey: refundKey(intentId, parts),
      });
      const topUpReplay = await provider.refund({
        paymentId: topUpId,
        amountCents: 300,
        currency: 'USD',
        merchantReference: `sess_${sessionId}`,
        idempotencyKey: refundKey(intentId, parts, 1),
      });
      const holdRefunds = (await client.refunds.list({ payment_intent: intentId })).data;
      const topUpRefunds = (await client.refunds.list({ payment_intent: topUpId })).data;
      expect(holdRefunds).toHaveLength(1);
      expect(topUpRefunds).toHaveLength(1);
      expect(holdReplay).toMatchObject({ refundId: holdRefunds[0]?.id });
      expect(topUpReplay).toMatchObject({ refundId: topUpRefunds[0]?.id });
    }, 120_000);
  });
});
