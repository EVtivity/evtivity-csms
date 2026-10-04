// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Contract test of AdyenPaymentProvider against a real Adyen TEST account
// (Checkout API v72). Runs only when ADYEN_TEST_API_KEY and
// ADYEN_TEST_MERCHANT_ACCOUNT are set (ADYEN_TEST_CLIENT_KEY is optional and
// only echoed by clientConfig); CI has none, so it is skipped there. Never
// commit or log the key.
//
// Card data goes server-side as Adyen's documented test values: the test card
// number, expiry and CVC with a `test_` prefix in the encrypted fields
// (https://docs.adyen.com/development-resources/test-cards-and-credentials/test-card-numbers).
// Refusals are forced with `holderName`
// (https://docs.adyen.com/development-resources/testing/result-codes).
//
// Modifications (capture, cancel, refund, adjustment) are asynchronous at
// Adyen: the test asserts the synchronous `received` answer and its
// pspReference. The outcome arrives by webhook, which needs the webhook route
// and a public tunnel (plan P10 Part L). The last block runs the session and
// refund services against Adyen with payment records in memory: the pending
// capture, cancel and refund each carry Adyen's real modification reference,
// which is what the webhook later matches.

import crypto from 'node:crypto';
import { afterAll, describe, it, expect, vi } from 'vitest';

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/session-db.js')).databaseMock,
  settings: {},
  sitePaymentConfigs: {},
}));
vi.mock('../settings.js', async () => (await import('./helpers/session-db.js')).settingsMock);
vi.mock('../payment-records.js', async () => (await import('./helpers/memory-records.js')).records);

import { AdyenPaymentProvider } from '../providers/adyen/index.js';
import type { AdyenProviderOptions } from '../providers/adyen/index.js';
import { AdyenApiError } from '../providers/adyen/client.js';
import {
  PaymentDeclinedError,
  PaymentMethodOwnershipError,
  PaymentOperationNotSupportedError,
  PaymentValidationError,
} from '../errors.js';
import type { BrowserContext } from '../types.js';
import { authorizeSessionHold, settleSessionPayment } from '../session-payments.js';
import { refundPaymentRecord } from '../refunds.js';
import type { PaymentContext } from '../context.js';
import type { PaymentProviderRegistry } from '../registry.js';
import { memoryRecords } from './helpers/memory-records.js';
import { sessionDb } from './helpers/session-db.js';

const apiKey = process.env['ADYEN_TEST_API_KEY'] ?? '';
const merchantAccount = process.env['ADYEN_TEST_MERCHANT_ACCOUNT'] ?? '';
const clientKey = process.env['ADYEN_TEST_CLIENT_KEY'] ?? 'test_unused';
const enabled = apiKey !== '' && merchantAccount !== '';

const BROWSER: BrowserContext = {
  origin: 'http://localhost:7101',
  returnUrl: 'http://localhost:7101/payments/return',
  info: {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    acceptHeader: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    language: 'en-US',
    colorDepth: 24,
    screenHeight: 900,
    screenWidth: 1440,
    timeZoneOffset: 0,
    javaEnabled: false,
  },
};

/** Card component state.data with Adyen's test-encrypted values. */
function card(number: string, holderName?: string): { paymentMethod: Record<string, string> } {
  return {
    paymentMethod: {
      type: 'scheme',
      encryptedCardNumber: `test_${number}`,
      encryptedExpiryMonth: 'test_03',
      encryptedExpiryYear: 'test_2030',
      encryptedSecurityCode: 'test_737',
      ...(holderName != null ? { holderName } : {}),
    },
  };
}

const VISA = '4111111111111111';
/** 3DS2 test card (challenge). */
const VISA_3DS2 = '4917610000000000';

/** An Adyen pspReference: 16 upper-case letters and digits. */
const PSP = /^[A-Z0-9]{16}$/;

describe.skipIf(!enabled)('AdyenPaymentProvider against an Adyen TEST account', () => {
  // A short unique run id keeps idempotency keys (max 64 characters, kept by
  // Adyen 7 to 14 days) from replaying earlier runs.
  const run = crypto.randomBytes(6).toString('hex');
  const key = (name: string) => `live_${run}_${name}`;
  const options = (overrides: Partial<AdyenProviderOptions> = {}): AdyenProviderOptions => ({
    apiKey,
    merchantAccount,
    clientKey,
    environment: 'test',
    liveUrlPrefix: null,
    liveRegion: 'eu',
    hmacKey: null,
    hmacKeyPrevious: null,
    webhookUsername: null,
    webhookPassword: null,
    authorisationAdjustment: false,
    ...overrides,
  });
  const provider = new AdyenPaymentProvider(options());
  const adjusting = new AdyenPaymentProvider(options({ authorisationAdjustment: true }));

  async function saveCard(customerId: string, name: string, number = VISA) {
    const step = await provider.submitMethodSetup({
      customerId,
      payload: { ...card(number), currency: 'USD' },
      browser: BROWSER,
      idempotencyKey: key(name),
    });
    if (step.status !== 'saved') throw new Error(`expected a saved method, got ${step.status}`);
    return step.method;
  }

  async function failure(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => null,
      (e: unknown) => e,
    );
  }

  it('connects and refuses an unknown merchant account', async () => {
    await expect(provider.testConnection()).resolves.toBeUndefined();
    const wrong = new AdyenPaymentProvider(options({ merchantAccount: `NoSuchAccount${run}` }));
    expect(await failure(wrong.testConnection())).toBeInstanceOf(AdyenApiError);
    expect(provider.clientConfig()).toEqual({ provider: 'adyen', clientKey, environment: 'test' });
  });

  it('starts method setup with the card payment methods', async () => {
    const { customerId } = await provider.createCustomer({
      email: 'unused@example.com',
      name: 'Unused',
      idempotencyKey: key('customer_setup'),
    });
    const setup = await provider.startMethodSetup({
      customerId,
      channel: 'web',
      currency: 'USD',
      countryCode: 'US',
    });
    expect(setup).toMatchObject({ provider: 'adyen', customerId, currency: 'USD' });
    // allowedPaymentMethods keeps the setup card-only (the account also has Klarna).
    const response = (setup as Record<string, unknown>)['paymentMethodsResponse'];
    expect(response).toEqual({
      paymentMethods: [expect.objectContaining({ type: 'scheme' }) as unknown],
    });
  });

  it('saves a card by zero-value authorization, lists, replays and deletes it', async () => {
    const { customerId } = await provider.createCustomer({
      email: 'unused@example.com',
      name: 'Unused',
      idempotencyKey: key('customer_save'),
    });
    const method = await saveCard(customerId, 'method_save');
    // The token id comes synchronously in tokenization.storedPaymentMethodId.
    expect(method).toEqual({
      methodId: expect.stringMatching(PSP),
      customerId,
      brand: 'visa',
      last4: '1111',
    });

    // The same key replays the stored response: the same token, no second card.
    const replay = await saveCard(customerId, 'method_save');
    expect(replay.methodId).toBe(method.methodId);

    expect(await provider.verifyMethod({ methodId: method.methodId, customerId })).toEqual({
      methodId: method.methodId,
      customerId,
      brand: 'visa',
      last4: '1111',
    });
    // Another shopperReference never sees the token.
    const other = await provider.createCustomer({
      email: 'unused@example.com',
      name: 'Unused',
      idempotencyKey: key('customer_other'),
    });
    expect(
      await failure(
        provider.verifyMethod({ methodId: method.methodId, customerId: other.customerId }),
      ),
    ).toBeInstanceOf(PaymentMethodOwnershipError);

    await provider.detachMethod({ customerId, methodId: method.methodId });
    expect(
      await failure(provider.verifyMethod({ methodId: method.methodId, customerId })),
    ).toBeInstanceOf(PaymentMethodOwnershipError);
  }, 60_000);

  it('asks for 3DS when saving a 3DS2 card', async () => {
    const step = await provider.submitMethodSetup({
      customerId: `evt_${run}_3ds`,
      payload: { ...card(VISA_3DS2), currency: 'USD' },
      browser: BROWSER,
      idempotencyKey: key('method_3ds'),
    });
    expect(step.status).toBe('action_required');
    if (step.status !== 'action_required') return;
    expect(step.action.provider).toBe('adyen');
    expect(step.action.data).toMatchObject({ paymentMethodType: 'scheme' });
  }, 60_000);

  it('holds a saved card off session, replays, captures part and refunds', async () => {
    const customerId = `evt_${run}_hold`;
    const method = await saveCard(customerId, 'method_hold');
    const holdInput = {
      idempotencyKey: key('preauth'),
      method: { kind: 'saved' as const, customerId, methodId: method.methodId },
      initiator: 'merchant' as const,
      merchantReference: `sess_${run}`,
      amountCents: 2000,
      currency: 'USD',
      payoutAccountId: null,
    };
    const hold = await provider.authorizeHold(holdInput);
    expect(hold).toMatchObject({ status: 'authorized', authorizedCents: 2000 });
    if (hold.status !== 'authorized') return;
    expect(hold.paymentId).toMatch(PSP);

    // The same Idempotency-Key returns the same authorization.
    expect(await provider.authorizeHold(holdInput)).toEqual(hold);

    // Off: the shortfall is a top-up, and adjustHold is refused before any call.
    expect(provider.capabilities.shortfall).toBe('top_up');
    expect(
      await failure(
        provider.adjustHold({
          idempotencyKey: key('adjust_off'),
          paymentId: hold.paymentId,
          newTotalCents: 2500,
          currency: 'USD',
        }),
      ),
    ).toBeInstanceOf(PaymentOperationNotSupportedError);

    const capture = await provider.capture({
      idempotencyKey: key('capture'),
      paymentId: hold.paymentId,
      amountCents: 1500,
      currency: 'USD',
      merchantReference: `sess_${run}`,
      payoutAccountId: null,
      feeTax: 0,
      platformFeePercent: 0,
    });
    expect(capture.state).toBe('pending');
    if (capture.state !== 'pending') return;
    expect(capture.operationRef).toMatch(PSP);
    expect(capture.operationRef).not.toBe(hold.paymentId);

    // A replayed capture is the same modification.
    expect(
      await provider.capture({
        idempotencyKey: key('capture'),
        paymentId: hold.paymentId,
        amountCents: 1500,
        currency: 'USD',
        merchantReference: `sess_${run}`,
        payoutAccountId: null,
        feeTax: 0,
        platformFeePercent: 0,
      }),
    ).toEqual(capture);

    const partial = await provider.refund({
      idempotencyKey: key('refund_partial'),
      paymentId: hold.paymentId,
      amountCents: 500,
      currency: 'USD',
      merchantReference: `sess_${run}`,
    });
    expect(partial.state).toBe('pending');
    const rest = await provider.refund({
      idempotencyKey: key('refund_rest'),
      paymentId: hold.paymentId,
      amountCents: 1000,
      currency: 'USD',
      merchantReference: `sess_${run}`,
    });
    expect(rest.state).toBe('pending');
    if (partial.state !== 'pending' || rest.state !== 'pending') return;
    expect(rest.operationRef).not.toBe(partial.operationRef);
  }, 90_000);

  it('tops up a shortfall on the saved card and refunds it in full', async () => {
    const customerId = `evt_${run}_topup`;
    const method = await saveCard(customerId, 'method_topup');
    const hold = await provider.authorizeHold({
      idempotencyKey: key('preauth_topup'),
      method: { kind: 'saved', customerId, methodId: method.methodId },
      initiator: 'merchant',
      merchantReference: `sess_${run}_t`,
      amountCents: 1500,
      currency: 'USD',
      payoutAccountId: null,
    });
    if (hold.status !== 'authorized') throw new Error('expected a hold');
    await provider.capture({
      idempotencyKey: key('capture_topup'),
      paymentId: hold.paymentId,
      amountCents: 1500,
      currency: 'USD',
      merchantReference: `sess_${run}_t`,
      payoutAccountId: null,
      feeTax: 0,
      platformFeePercent: 0,
    });
    const topUp = await provider.chargeShortfall({
      idempotencyKey: key('topup'),
      originalPaymentId: hold.paymentId,
      method: { customerId, methodId: method.methodId },
      capturedCents: 1500,
      finalCostCents: 2300,
      currency: 'USD',
      feeTax: 0,
      platformFeePercent: 0,
      description: 'Live test shortfall',
    });
    expect(topUp).toMatchObject({ amountCents: 800, applicationFeeCents: 0 });
    expect(topUp.paymentId).toMatch(PSP);
    // The top-up is captured at once (captureDelayHours 0), so it can be refunded in full.
    const refund = await provider.refund({
      idempotencyKey: key('refund_topup'),
      paymentId: topUp.paymentId,
      amountCents: 800,
      currency: 'USD',
      merchantReference: `sess_${run}_t`,
    });
    expect(refund.state).toBe('pending');
  }, 90_000);

  it('charges a saved card immediately', async () => {
    const customerId = `evt_${run}_fee`;
    const method = await saveCard(customerId, 'method_fee');
    const charge = await provider.chargeSavedMethod({
      idempotencyKey: key('fee'),
      customerId,
      methodId: method.methodId,
      grossCents: 550,
      currency: 'USD',
      feeTaxRate: 0,
      platformFeePercent: 0,
      payoutAccountId: null,
      description: 'Live test fee',
      metadata: { test: 'live' },
    });
    expect(charge).toMatchObject({ amountCents: 550, applicationFeeCents: 0 });
    expect(charge.paymentId).toMatch(PSP);
  }, 60_000);

  it('sends an authorization adjustment when it is on', async () => {
    const customerId = `evt_${run}_adjust`;
    const method = await saveCard(customerId, 'method_adjust');
    const hold = await adjusting.authorizeHold({
      idempotencyKey: key('preauth_adjust'),
      method: { kind: 'saved', customerId, methodId: method.methodId },
      initiator: 'merchant',
      merchantReference: `sess_${run}_a`,
      amountCents: 2000,
      currency: 'USD',
      payoutAccountId: null,
    });
    if (hold.status !== 'authorized') throw new Error('expected a hold');
    expect(adjusting.capabilities.shortfall).toBe('adjust_hold');
    const adjust = adjusting.adjustHold({
      idempotencyKey: key('adjust'),
      paymentId: hold.paymentId,
      newTotalCents: 2500,
      currency: 'USD',
      ...(hold.providerState != null ? { providerState: hold.providerState } : {}),
    });
    const result = await adjust;
    // With the adjustAuthorisationData blob (Adyen Support enables "Synchronous
    // authorization adjustment") the answer is Authorised; without it Adyen
    // answers `received` and confirms with AUTHORISATION_ADJUSTMENT.
    if (hold.providerState == null) {
      expect(result.state).toBe('pending');
      if (result.state === 'pending') expect(result.operationRef).toMatch(PSP);
    } else {
      expect(result).toMatchObject({ state: 'succeeded', authorizedCents: 2500 });
    }
    // Release the hold.
    const cancel = await adjusting.cancelHold({
      paymentId: hold.paymentId,
      merchantReference: `sess_${run}_a`,
      idempotencyKey: key('cancel_adjust'),
    });
    expect(cancel.state).toBe('pending');
  }, 90_000);

  it('holds a saved card with the shopper present and the CVC', async () => {
    const customerId = `evt_${run}_present`;
    const method = await saveCard(customerId, 'method_present');
    const input = {
      method: { kind: 'saved' as const, customerId, methodId: method.methodId, browser: BROWSER },
      initiator: 'shopper' as const,
      merchantReference: `sess_${run}_p`,
      amountCents: 1000,
      currency: 'USD',
      payoutAccountId: null,
    };
    // Without the CVC an Adyen account on its defaults answers 422 "Required
    // field 'cvc' is not provided." (seen on the owner's TEST account), so the
    // stored-card component's encryptedSecurityCode goes along.
    const hold = await provider.authorizeHold({
      ...input,
      idempotencyKey: key('preauth_present'),
      method: {
        ...input.method,
        payload: {
          paymentMethod: {
            type: 'scheme',
            storedPaymentMethodId: method.methodId,
            encryptedSecurityCode: 'test_737',
          },
        },
      },
    });
    expect(hold).toMatchObject({ status: 'authorized', authorizedCents: 1000 });
  }, 60_000);

  it('places a guest hold on a one-time card in minor units and cancels it', async () => {
    const hold = await provider.authorizeHold({
      idempotencyKey: key('guest'),
      method: { kind: 'one_time', payload: card(VISA), browser: BROWSER },
      initiator: 'shopper',
      merchantReference: `guest_${run}`,
      amountCents: 1234,
      currency: 'EUR',
      payoutAccountId: null,
      receiptEmail: 'guest@example.com',
    });
    // 1234 cents is EUR 12.34: Adyen minor units, returned unchanged.
    expect(hold).toMatchObject({ status: 'authorized', authorizedCents: 1234 });
    if (hold.status !== 'authorized') return;
    const cancel = await provider.cancelHold({
      paymentId: hold.paymentId,
      merchantReference: `guest_${run}`,
      idempotencyKey: key('cancel_guest'),
    });
    expect(cancel.state).toBe('pending');
  }, 60_000);

  it('cancels a hold by merchant reference when the pspReference is unknown', async () => {
    const reference = `guest_${run}_lost`;
    const hold = await provider.authorizeHold({
      idempotencyKey: key('guest_lost'),
      method: { kind: 'one_time', payload: card(VISA), browser: BROWSER },
      initiator: 'shopper',
      merchantReference: reference,
      amountCents: 900,
      currency: 'USD',
      payoutAccountId: null,
    });
    expect(hold.status).toBe('authorized');
    const cancel = await provider.cancelHold({
      paymentId: null,
      merchantReference: reference,
      idempotencyKey: key('cancel_lost'),
    });
    expect(cancel.state).toBe('pending');
    if (cancel.state === 'pending') expect(cancel.operationRef).toMatch(PSP);
  }, 60_000);

  it('returns the 3DS action for a one-time 3DS2 card with the shopper present', async () => {
    const hold = await provider.authorizeHold({
      idempotencyKey: key('guest_3ds'),
      method: { kind: 'one_time', payload: card(VISA_3DS2), browser: BROWSER },
      initiator: 'shopper',
      merchantReference: `guest_${run}_3ds`,
      amountCents: 1000,
      currency: 'USD',
      payoutAccountId: null,
    });
    expect(hold.status).toBe('action_required');
    if (hold.status !== 'action_required') return;
    expect(hold.action.provider).toBe('adyen');
    expect(hold.action.data).toMatchObject({ paymentMethodType: 'scheme' });
  }, 60_000);

  it.each([
    { holderName: 'BLOCK_CARD', reason: 'Blocked Card', code: '5', retryable: false },
    {
      holderName: 'NOT_ENOUGH_BALANCE',
      reason: 'Not enough balance',
      code: '12',
      retryable: false,
    },
    { holderName: 'CVC_DECLINED', reason: 'CVC Declined', code: '24', retryable: false },
    { holderName: 'ERROR', reason: 'Acquirer Error', code: '4', retryable: true },
  ])(
    'maps the $holderName test refusal to PaymentDeclinedError',
    async ({ holderName, reason, code, retryable }) => {
      const err = await failure(
        provider.authorizeHold({
          idempotencyKey: key(`refuse_${holderName}`),
          method: { kind: 'one_time', payload: card(VISA, holderName), browser: BROWSER },
          initiator: 'shopper',
          merchantReference: `guest_${run}_r`,
          amountCents: 1000,
          currency: 'USD',
          payoutAccountId: null,
        }),
      );
      expect(err).toBeInstanceOf(PaymentDeclinedError);
      expect(err).toMatchObject({ message: reason, code, retryable });
    },
    60_000,
  );

  it('refuses IDR and a payout account before calling Adyen', async () => {
    const base = {
      method: { kind: 'one_time' as const, payload: card(VISA), browser: BROWSER },
      initiator: 'shopper' as const,
      merchantReference: `guest_${run}_x`,
      amountCents: 1000,
    };
    expect(
      await failure(
        provider.authorizeHold({
          ...base,
          idempotencyKey: key('idr'),
          currency: 'IDR',
          payoutAccountId: null,
        }),
      ),
    ).toBeInstanceOf(PaymentValidationError);
    expect(
      await failure(
        provider.authorizeHold({
          ...base,
          idempotencyKey: key('payout'),
          currency: 'USD',
          payoutAccountId: 'BA00000000000000000000001',
        }),
      ),
    ).toBeInstanceOf(PaymentValidationError);
  });
});

describe.skipIf(!enabled)('payment services against Adyen: async results (P10a)', () => {
  const run = crypto.randomBytes(6).toString('hex');
  const key = (name: string) => `async_${run}_${name}`;
  const provider = new AdyenPaymentProvider({
    apiKey,
    merchantAccount,
    clientKey,
    environment: 'test',
    liveUrlPrefix: null,
    liveRegion: 'eu',
    hmacKey: null,
    hmacKeyPrevious: null,
    webhookUsername: null,
    webhookPassword: null,
    authorisationAdjustment: false,
  });
  const ctx: PaymentContext = {
    registry: {
      getPaymentProvider: () => Promise.resolve(provider),
      settings: () => Promise.resolve({ preAuthAmountCents: 2000 }),
    } as unknown as PaymentProviderRegistry,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const saved: Array<{ customerId: string; methodId: string }> = [];

  // The stored cards are deleted again; the holds lapse or settle at Adyen.
  afterAll(async () => {
    for (const method of saved) await provider.detachMethod(method);
  });

  async function heldSession(name: string, finalCostCents: number): Promise<string> {
    const customerId = `evt_${run}_${name}`;
    const step = await provider.submitMethodSetup({
      customerId,
      payload: { ...card(VISA), currency: 'USD' },
      browser: BROWSER,
      idempotencyKey: key(`method_${name}`),
    });
    if (step.status !== 'saved') throw new Error(`expected a saved method, got ${step.status}`);
    saved.push({ customerId, methodId: step.method.methodId });
    sessionDb.method = { id: 1, provider: 'adyen', customerId, methodId: step.method.methodId };
    const sessionId = `s_${run}_${name}`;
    sessionDb.current = { sessionId, finalCostCents, siteId: 'site_async' };
    const hold = await authorizeSessionHold(
      { sessionId, driverId: 'd1', methodRowId: null, siteId: null, trigger: 'projection_gate' },
      ctx,
    );
    expect(hold).toMatchObject({ outcome: 'authorized', paymentId: expect.stringMatching(PSP) });
    return sessionId;
  }

  it('records a pending capture, refuses a refund until it is confirmed, then lists a pending refund', async () => {
    const sessionId = await heldSession('capture', 1200);
    expect(await settleSessionPayment(sessionId, ctx)).toMatchObject({
      mode: 'card',
      status: 'captured',
      capturedCents: 1200,
      recorded: true,
    });
    const captured = memoryRecords.bySession(sessionId);
    expect(captured).toMatchObject({ status: 'captured', pendingOperation: 'capture' });
    // Adyen's modification reference, not the payment's: the webhook matches it.
    expect(captured?.pendingOperationRef).toMatch(PSP);
    expect(captured?.pendingOperationRef).not.toBe(captured?.providerPaymentId);

    // O3: no refund before the capture is confirmed, and no Adyen call.
    expect(await refundPaymentRecord({ sessionId, amountCents: 500 }, ctx)).toEqual({
      status: 'operation_pending',
      operation: 'capture',
    });

    // The CAPTURE webhook (Part L, through a tunnel) clears the pending capture.
    memoryRecords.confirmPending(sessionId);
    const refund = await refundPaymentRecord({ sessionId, amountCents: 500 }, ctx);
    expect(refund).toMatchObject({
      status: 'refunded',
      refundStatus: 'pending',
      refundedNowCents: 0,
      pendingCents: 500,
    });
    const refunded = memoryRecords.bySession(sessionId);
    expect(refunded).toMatchObject({ status: 'captured', refundedAmountCents: 0 });
    expect(refunded?.providerRefunds).toEqual([
      expect.objectContaining({
        refundId: expect.stringMatching(PSP) as unknown,
        paymentId: captured?.providerPaymentId,
        amountCents: 500,
        state: 'pending',
      }),
    ]);

    // The pending refund counts as refunded: what is left is 1200 - 500.
    expect(await refundPaymentRecord({ sessionId, amountCents: 800 }, ctx)).toMatchObject({
      status: 'exceeds_remaining',
      remainingCents: 700,
    });
  }, 90_000);

  it('records a pending cancel for a session that cost nothing', async () => {
    const sessionId = await heldSession('cancel', 0);
    expect(await settleSessionPayment(sessionId, ctx)).toMatchObject({
      mode: 'card',
      status: 'cancelled',
      recorded: true,
    });
    const cancelled = memoryRecords.bySession(sessionId);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      capturedAmountCents: 0,
      pendingOperation: 'cancel',
    });
    expect(cancelled?.pendingOperationRef).toMatch(PSP);
  }, 90_000);
});
