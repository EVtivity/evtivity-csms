// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The provider contract: every PaymentProvider passes these scenarios. New
// providers (Adyen, plugins) add a harness here.

import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';

vi.mock('@evtivity/database', () => ({ db: {}, settings: {}, sitePaymentConfigs: {} }));

import { StripePaymentProvider } from '../providers/stripe/index.js';
import { SimulatedPaymentProvider } from '../providers/simulated/index.js';
import { WebhookNotConfiguredError, WebhookSignatureError } from '../errors.js';
import type { PaymentProvider } from '../types.js';
import { fakeClient } from './helpers/fake-stripe.js';
import { fakeAdyenProvider } from '../testing/fake-adyen.js';

const KEY = 'test-encryption-key-32chars-long!';
const BROWSER = {
  origin: 'https://portal.example.com',
  returnUrl: 'https://portal.example.com/return',
};
/** Adyen Card component state.data with the documented test card, plus the setup currency. */
const ADYEN_CARD = {
  paymentMethod: {
    type: 'scheme',
    encryptedCardNumber: 'test_4111111111111111',
    encryptedExpiryMonth: 'test_03',
    encryptedExpiryYear: 'test_2030',
    encryptedSecurityCode: 'test_737',
  },
  currency: 'USD',
};

interface Harness {
  name: string;
  make(): PaymentProvider;
  /** submitMethodSetup payload that saves an approving method. */
  methodPayload: unknown;
}

const harnesses: Harness[] = [
  {
    name: 'stripe (fake client)',
    make: () =>
      new StripePaymentProvider({
        client: fakeClient() as unknown as Stripe,
        publishableKey: 'pk_test_1',
        webhookSecret: 'whsec_test',
        connectWebhookSecret: null,
      }),
    methodPayload: { paymentMethodId: 'pm_1' },
  },
  {
    name: 'simulated sync',
    make: () => new SimulatedPaymentProvider({ encryptionKey: KEY }),
    methodPayload: { testCard: '4242424242424242' },
  },
  {
    name: 'simulated async',
    make: () =>
      new SimulatedPaymentProvider({
        encryptionKey: KEY,
        resultMode: 'async',
        events: { deliver: () => Promise.resolve() },
      }),
    methodPayload: { testCard: '4242424242424242' },
  },
  {
    name: 'adyen (fake Adyen server)',
    make: () => fakeAdyenProvider().provider,
    methodPayload: ADYEN_CARD,
  },
  {
    name: 'adyen with authorization adjustment (fake Adyen server)',
    make: () => fakeAdyenProvider({ authorisationAdjustment: true }).provider,
    methodPayload: ADYEN_CARD,
  },
];

describe.each(harnesses)('provider contract: $name', ({ make, methodPayload }) => {
  it('describes itself consistently', () => {
    const provider = make();
    expect(provider.clientConfig().provider).toBe(provider.id);
    expect(provider.webhookPath).toBe(`payments/${provider.id}`);
    const ack = provider.webhookAck();
    expect(ack.status).toBeGreaterThanOrEqual(200);
    expect(ack.status).toBeLessThan(300);
    if (provider.capabilities.shortfall === 'adjust_hold') {
      expect(typeof provider.adjustHold).toBe('function');
    }
    if (provider.capabilities.stateLookup) {
      expect(typeof provider.getPaymentState).toBe('function');
    }
  });

  it('saves a method, holds, captures, tops up, refunds and cancels', async () => {
    const provider = make();
    const sync = provider.capabilities.modificationResults === 'sync';
    const { customerId } = await provider.createCustomer({
      email: 'driver@example.com',
      name: 'Driver One',
      idempotencyKey: 'customer_d1',
    });
    const setup = await provider.submitMethodSetup({
      customerId,
      payload: methodPayload,
      browser: BROWSER,
      idempotencyKey: 'method_d1',
    });
    expect(setup.status).toBe('saved');
    if (setup.status !== 'saved') return;
    const verified = await provider.verifyMethod({ methodId: setup.method.methodId, customerId });
    expect(verified.methodId).toBe(setup.method.methodId);

    const hold = await provider.authorizeHold({
      idempotencyKey: 'preauth_s1',
      method: { kind: 'saved', customerId, methodId: setup.method.methodId },
      initiator: 'merchant',
      merchantReference: 'sess_s1',
      amountCents: 5000,
      currency: 'USD',
      payoutAccountId: null,
    });
    expect(hold.status).toBe('authorized');
    if (hold.status !== 'authorized') return;
    expect(hold.authorizedCents).toBeLessThanOrEqual(5000);

    const capture = await provider.capture({
      idempotencyKey: 'capture_1',
      paymentId: hold.paymentId,
      amountCents: 4000,
      currency: 'USD',
      merchantReference: 'sess_s1',
      payoutAccountId: null,
      feeTax: 0,
      platformFeePercent: 0,
    });
    expect(capture.state).toBe(sync ? 'succeeded' : 'pending');
    if (capture.state === 'succeeded') expect(capture.capturedCents).toBe(4000);

    const topUp = await provider.chargeShortfall({
      idempotencyKey: 'topup_1',
      originalPaymentId: hold.paymentId,
      method: { customerId, methodId: setup.method.methodId },
      capturedCents: 5000,
      finalCostCents: 5600,
      currency: 'USD',
      feeTax: 0,
      platformFeePercent: 0,
      description: 'Charging session shortfall',
    });
    expect(topUp.amountCents).toBe(600);

    const refund = await provider.refund({
      idempotencyKey: 'refund_1',
      paymentId: hold.paymentId,
      amountCents: 700,
      currency: 'USD',
      merchantReference: 'sess_s1',
    });
    expect(refund.state).toBe(sync ? 'succeeded' : 'pending');

    const cancel = await provider.cancelHold({
      paymentId: hold.paymentId,
      merchantReference: 'sess_s1',
      idempotencyKey: 'cancel_1',
    });
    expect(cancel.state).toBe(sync ? 'succeeded' : 'pending');
  });

  it('refuses an unsigned webhook', () => {
    const provider = make();
    let error: unknown = null;
    try {
      provider.verifyWebhook('{}', {});
    } catch (err) {
      error = err;
    }
    expect(
      error instanceof WebhookSignatureError || error instanceof WebhookNotConfiguredError,
    ).toBe(true);
  });
});
