// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Stripe from 'stripe';

vi.mock('@evtivity/database', () => ({ db: {}, settings: {}, sitePaymentConfigs: {} }));

import { StripePaymentProvider } from '../providers/stripe/index.js';
import { PaymentProviderPermissionError } from '../errors.js';
import { FakeStripeError, fakeStripeModule, stripeRecorder } from '../testing/index.js';

const DOMAIN = 'portal.example.com';

function provider(): StripePaymentProvider {
  const FakeStripe = fakeStripeModule().default;
  return new StripePaymentProvider({
    client: new FakeStripe() as unknown as Stripe,
    publishableKey: 'pk_test_1',
    webhookSecret: null,
    connectWebhookSecret: null,
  });
}

function calls(): string[] {
  return stripeRecorder.calls.map((c) => c.call);
}

describe('Stripe payment method domains', () => {
  beforeEach(() => {
    stripeRecorder.reset();
  });

  it('registers a new domain on the platform account', async () => {
    stripeRecorder.seedPaymentMethodDomain({ id: 'pmd_other', domain_name: 'other.example.com' });

    const status = await provider().registerPaymentMethodDomain(DOMAIN);

    expect(calls()).toEqual(['paymentMethodDomains.list', 'paymentMethodDomains.create']);
    expect(stripeRecorder.calls[1]?.args).toEqual([{ domain_name: DOMAIN, enabled: true }]);
    // Destination charges: no Stripe-Account header (connected account) on the call.
    expect(stripeRecorder.calls[1]?.options).toBeUndefined();
    expect(status).toEqual({
      id: 'pmd_fake_1',
      domain: DOMAIN,
      enabled: true,
      applePay: { status: 'inactive', errorMessage: null },
      googlePay: { status: 'active', errorMessage: null },
    });
  });

  it('enables a disabled registration and re-checks an enabled one', async () => {
    stripeRecorder.seedPaymentMethodDomain({ id: 'pmd_1', domain_name: DOMAIN, enabled: false });

    expect((await provider().registerPaymentMethodDomain(DOMAIN)).enabled).toBe(true);
    await provider().registerPaymentMethodDomain(DOMAIN);

    expect(calls()).toEqual([
      'paymentMethodDomains.list',
      'paymentMethodDomains.update',
      'paymentMethodDomains.list',
      'paymentMethodDomains.validate',
    ]);
  });

  it("reads the registration with Stripe's reason for an inactive wallet", async () => {
    stripeRecorder.seedPaymentMethodDomain({
      id: 'pmd_1',
      domain_name: DOMAIN,
      apple_pay: {
        status: 'inactive',
        status_details: { error_message: 'The domain is not reachable over https.' },
      },
    });

    expect(await provider().getPaymentMethodDomain(DOMAIN)).toMatchObject({
      id: 'pmd_1',
      applePay: { status: 'inactive', errorMessage: 'The domain is not reachable over https.' },
      googlePay: { status: 'active', errorMessage: null },
    });
    expect(await provider().getPaymentMethodDomain('unknown.example.com')).toBeNull();
  });

  it('names the missing permission of a restricted key', async () => {
    stripeRecorder.callFailures.set('paymentMethodDomains.create', [
      new FakeStripeError('StripePermissionError', 'The provided key does not have access', {
        statusCode: 403,
      }),
    ]);

    const error = await provider()
      .registerPaymentMethodDomain(DOMAIN)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PaymentProviderPermissionError);
    expect((error as PaymentProviderPermissionError).permission).toBe(
      'Payment Method Domains: write',
    );
  });
});
