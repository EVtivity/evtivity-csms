// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({ db: {}, settings: {}, sitePaymentConfigs: {} }));

import {
  ADYEN_PROVIDER_ID,
  AdyenPaymentProvider,
  adyenProviderFactory,
} from '../providers/adyen/index.js';
import { AdyenApiError, adyenCheckoutBaseUrl } from '../providers/adyen/client.js';
import {
  PaymentDeclinedError,
  PaymentMethodOwnershipError,
  PaymentOperationNotSupportedError,
  PaymentProviderNotConfiguredError,
  PaymentProviderUnavailableError,
  PaymentValidationError,
} from '../errors.js';
import type { AuthorizeHoldInput, PaymentProvider } from '../types.js';
import {
  adyenOptions,
  fakeAdyen,
  fakeAdyenProvider,
  MERCHANT,
  MODIFICATION_PSP,
  PAYMENT_PSP,
  TOKEN_ID,
} from './helpers/fake-adyen.js';
import { emptyAdyenSettings } from './helpers/settings.js';

const TEST_BASE = 'https://checkout-test.adyen.com/v72';
const BROWSER = {
  origin: 'https://portal.example.com',
  returnUrl: 'https://portal.example.com/return',
  info: { userAgent: 'Mozilla/5.0', acceptHeader: 'text/html' },
};
const CARD = {
  paymentMethod: { type: 'scheme', encryptedCardNumber: 'test_4111111111111111' },
};
const SHOPPER = 'evt_shopper_1';

function hold(overrides: Partial<AuthorizeHoldInput> = {}): AuthorizeHoldInput {
  return {
    idempotencyKey: 'preauth_s1',
    method: { kind: 'saved', customerId: SHOPPER, methodId: TOKEN_ID },
    initiator: 'merchant',
    merchantReference: 'sess_s1',
    amountCents: 5000,
    currency: 'EUR',
    payoutAccountId: null,
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('Expected a rejection');
}

describe('AdyenPaymentProvider: identity and configuration', () => {
  it('reports the B6.3 capabilities without IDR', () => {
    const { provider } = fakeAdyenProvider();
    expect(provider.id).toBe(ADYEN_PROVIDER_ID);
    expect(provider.webhookPath).toBe('payments/adyen');
    expect(provider.capabilities).toMatchObject({
      modificationResults: 'async',
      shortfall: 'top_up',
      stateLookup: false,
      marketplaceSplit: 'none',
      clientActions: true,
      manualCapture: true,
    });
    const currencies = provider.capabilities.currencies as readonly string[];
    expect(currencies).toContain('EUR');
    expect(currencies).toContain('USD');
    expect(currencies).not.toContain('IDR');
    expect('getPaymentState' in provider).toBe(false);
  });

  it('switches the shortfall to adjust_hold behind adyen.authorisationAdjustment (D-A1)', () => {
    const { provider } = fakeAdyenProvider({ authorisationAdjustment: true });
    expect(provider.capabilities.shortfall).toBe('adjust_hold');
  });

  it('uses the test endpoint, or the live endpoint with the URL prefix', () => {
    expect(fakeAdyenProvider().provider.baseUrl).toBe(TEST_BASE);
    const live = fakeAdyenProvider({
      environment: 'live',
      liveUrlPrefix: '1797a841fbb37ca7-AdyenDemo',
    }).provider;
    expect(live.baseUrl).toBe(
      'https://1797a841fbb37ca7-AdyenDemo-checkout-live.adyenpayments.com/checkout/v72',
    );
    expect(() => adyenCheckoutBaseUrl('live', null)).toThrow(PaymentValidationError);
    expect(() => adyenCheckoutBaseUrl('live', 'https://evil.example.com/')).toThrow(
      PaymentValidationError,
    );
  });

  it('sends live requests to the prefixed live URL', async () => {
    const { provider, adyen } = fakeAdyenProvider({
      environment: 'live',
      liveUrlPrefix: '1797a841fbb37ca7-AdyenDemo',
    });
    await provider.testConnection();
    // URL lowercases the host name; DNS names are case-insensitive.
    expect(adyen.last().url).toBe(
      'https://1797a841fbb37ca7-adyendemo-checkout-live.adyenpayments.com/checkout/v72/paymentMethods',
    );
    expect(adyen.last().headers['x-api-key']).toBe('AQE_test_key');
  });

  it('gives the client key and the SDK environment of the region', () => {
    expect(fakeAdyenProvider().provider.clientConfig()).toEqual({
      provider: 'adyen',
      clientKey: 'test_CLIENTKEY',
      environment: 'test',
    });
    const live = (liveRegion: 'eu' | 'us' | 'au' | 'nea' | 'in') => {
      const config = fakeAdyenProvider({
        environment: 'live',
        liveUrlPrefix: 'abc123-Company',
        liveRegion,
      }).provider.clientConfig() as Record<string, unknown>;
      return config['environment'];
    };
    expect(live('eu')).toBe('live');
    expect(live('us')).toBe('live-us');
    expect(live('au')).toBe('live-au');
    expect(live('nea')).toBe('live-nea');
    expect(live('in')).toBe('live-in');
  });

  it('tests the connection with /paymentMethods and the API key header', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    await provider.testConnection();
    const call = adyen.last();
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${TEST_BASE}/paymentMethods`);
    expect(call.headers['x-api-key']).toBe('AQE_test_key');
    expect(call.headers['idempotency-key']).toBeUndefined();
    expect(call.body).toEqual({ merchantAccount: MERCHANT });
  });
});

describe('adyenProviderFactory', () => {
  const base = {
    provider: 'adyen',
    preAuthAmountCents: 5000,
    stripe: { secretKey: null, publishableKey: null, webhookSecret: null },
  };
  const configured = {
    apiKey: 'AQE_key',
    merchantAccount: MERCHANT,
    clientKey: 'test_CLIENTKEY',
  };

  it('is not configured without an API key, merchant account or client key', async () => {
    expect(await adyenProviderFactory.create({ ...base, adyen: emptyAdyenSettings() })).toBeNull();
    for (const missing of ['apiKey', 'merchantAccount', 'clientKey'] as const) {
      const adyen = emptyAdyenSettings({ ...configured, [missing]: null });
      expect(await adyenProviderFactory.create({ ...base, adyen })).toBeNull();
    }
  });

  it('is not configured when live without a valid URL prefix', async () => {
    const adyen = emptyAdyenSettings({ ...configured, environment: 'live' });
    expect(await adyenProviderFactory.create({ ...base, adyen })).toBeNull();
    const bad = emptyAdyenSettings({ ...configured, environment: 'live', liveUrlPrefix: 'a.b/c' });
    expect(await adyenProviderFactory.create({ ...base, adyen: bad })).toBeNull();
  });

  it('builds a provider from the decrypted settings', async () => {
    const built = await adyenProviderFactory.create({
      ...base,
      adyen: emptyAdyenSettings({ ...configured, authorisationAdjustment: true }),
    });
    expect(built).toBeInstanceOf(AdyenPaymentProvider);
    expect(built?.capabilities.shortfall).toBe('adjust_hold');
  });
});

describe('customers and saved methods', () => {
  it('derives a shopperReference without PII and without an Adyen call', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    const a = await provider.createCustomer({
      email: 'driver@example.com',
      name: 'Driver One',
      idempotencyKey: 'customer_d1',
    });
    const b = await provider.createCustomer({
      email: 'other@example.com',
      name: 'Other',
      idempotencyKey: 'customer_d1',
    });
    expect(a.customerId).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(b).toEqual(a);
    expect(a.customerId).not.toContain('driver');
    expect(adyen.calls).toHaveLength(0);
    expect((provider as PaymentProvider).isUnknownCustomerError(new Error('x'))).toBe(false);
  });

  it('starts a setup with /paymentMethods for the shopper and a zero amount', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    const session = await provider.startMethodSetup({
      customerId: SHOPPER,
      channel: 'web',
      currency: 'eur',
      countryCode: 'NL',
    });
    expect(adyen.last().body).toEqual({
      merchantAccount: MERCHANT,
      countryCode: 'NL',
      amount: { value: 0, currency: 'EUR' },
      shopperReference: SHOPPER,
      allowedPaymentMethods: ['scheme'],
      channel: 'Web',
    });
    expect(session).toMatchObject({
      provider: 'adyen',
      clientKey: 'test_CLIENTKEY',
      environment: 'test',
      customerId: SHOPPER,
      countryCode: 'NL',
      currency: 'EUR',
    });
    expect((session as Record<string, unknown>)['paymentMethodsResponse']).toBeDefined();
  });

  it('stores a card with a zero-value authorization', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    const step = await provider.submitMethodSetup({
      customerId: SHOPPER,
      payload: { ...CARD, currency: 'EUR' },
      browser: BROWSER,
      idempotencyKey: 'method_d1',
    });
    const call = adyen.last();
    expect(call.url).toBe(`${TEST_BASE}/payments`);
    expect(call.headers['idempotency-key']).toBe('method_d1');
    expect(call.body).toEqual({
      merchantAccount: MERCHANT,
      reference: 'method_d1',
      amount: { value: 0, currency: 'EUR' },
      paymentMethod: CARD.paymentMethod,
      shopperReference: SHOPPER,
      storePaymentMethod: true,
      shopperInteraction: 'Ecommerce',
      recurringProcessingModel: 'UnscheduledCardOnFile',
      channel: 'Web',
      origin: BROWSER.origin,
      returnUrl: BROWSER.returnUrl,
      browserInfo: BROWSER.info,
    });
    expect(step).toEqual({
      status: 'saved',
      method: { methodId: TOKEN_ID, customerId: SHOPPER, brand: 'visa', last4: '1111' },
    });
  });

  it('needs the browser context and the setup currency', async () => {
    const { provider } = fakeAdyenProvider();
    const base = { customerId: SHOPPER, idempotencyKey: 'method_d1' };
    await expect(
      provider.submitMethodSetup({ ...base, payload: { ...CARD, currency: 'EUR' } }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
    await expect(
      provider.submitMethodSetup({ ...base, payload: CARD, browser: BROWSER }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
    await expect(
      provider.submitMethodSetup({ ...base, payload: { currency: 'EUR' }, browser: BROWSER }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
  });

  it('returns the 3DS action, a refusal, and the details step', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    const action = { type: 'threeDS2', subtype: 'fingerprint', token: 'tok' };
    adyen.next(
      { body: { resultCode: 'IdentifyShopper', action } },
      { body: { resultCode: 'Refused', refusalReason: 'Refused', refusalReasonCode: '2' } },
    );
    const input = {
      customerId: SHOPPER,
      payload: { ...CARD, currency: 'EUR' },
      browser: BROWSER,
      idempotencyKey: 'method_d1',
    };
    expect(await provider.submitMethodSetup(input)).toEqual({
      status: 'action_required',
      action: { provider: 'adyen', data: action },
    });
    expect(await provider.submitMethodSetup(input)).toEqual({
      status: 'refused',
      reason: 'Refused',
    });

    const details = { details: { threeDSResult: 'eyJ0cmFuc1N0YXR1cyI6IlkifQ==' } };
    adyen.next({
      body: {
        resultCode: 'Authorised',
        pspReference: 'V4HZ4RBFJGXXGN82',
        additionalData: {
          'tokenization.storedPaymentMethodId': TOKEN_ID,
          'tokenization.shopperReference': SHOPPER,
          paymentMethod: 'mc',
        },
      },
    });
    const saved = await provider.continueMethodSetup({
      customerId: SHOPPER,
      details,
      idempotencyKey: 'method_d1_details',
    });
    const detailsCall = adyen.calls.at(-2);
    expect(detailsCall?.url).toBe(`${TEST_BASE}/payments/details`);
    expect(detailsCall?.body).toEqual(details);
    // No cardSummary in the response (the Customer Area default): the last
    // four come from the shopper's stored methods; the response brand wins.
    expect(adyen.last().method).toBe('GET');
    expect(adyen.last().path).toBe('/v72/storedPaymentMethods');
    expect(adyen.last().query).toEqual({ shopperReference: SHOPPER, merchantAccount: MERCHANT });
    expect(saved).toEqual({
      status: 'saved',
      method: { methodId: TOKEN_ID, customerId: SHOPPER, brand: 'mc', last4: '1111' },
    });
  });

  it('takes the brand from the stored methods and refuses a token they do not list', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    const input = {
      customerId: SHOPPER,
      payload: { ...CARD, currency: 'EUR' },
      browser: BROWSER,
      idempotencyKey: 'method_d1',
    };
    adyen.next({
      body: {
        resultCode: 'Authorised',
        pspReference: 'V4HZ4RBFJGXXGN82',
        additionalData: { 'tokenization.storedPaymentMethodId': TOKEN_ID },
      },
    });
    expect(await provider.submitMethodSetup(input)).toEqual({
      status: 'saved',
      method: { methodId: TOKEN_ID, customerId: SHOPPER, brand: 'visa', last4: '1111' },
    });
    adyen.next(
      {
        body: {
          resultCode: 'Authorised',
          pspReference: 'V4HZ4RBFJGXXGN82',
          additionalData: { 'tokenization.storedPaymentMethodId': 'OTHERTOKEN' },
        },
      },
      { body: { storedPaymentMethods: [] } },
    );
    await expect(provider.submitMethodSetup(input)).rejects.toBeInstanceOf(
      PaymentMethodOwnershipError,
    );
  });

  it('refuses a token of another shopper and fails loud without a token id', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    const input = {
      customerId: SHOPPER,
      payload: { ...CARD, currency: 'EUR' },
      browser: BROWSER,
      idempotencyKey: 'method_d1',
    };
    adyen.next(
      {
        body: {
          resultCode: 'Authorised',
          additionalData: {
            'tokenization.storedPaymentMethodId': TOKEN_ID,
            'tokenization.shopperReference': 'evt_someone_else',
          },
        },
      },
      { body: { resultCode: 'Authorised', additionalData: {} } },
    );
    await expect(provider.submitMethodSetup(input)).rejects.toBeInstanceOf(
      PaymentMethodOwnershipError,
    );
    await expect(provider.submitMethodSetup(input)).rejects.toBeInstanceOf(
      PaymentProviderNotConfiguredError,
    );
  });

  it('verifies a method among the shopper tokens', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    expect(await provider.verifyMethod({ methodId: TOKEN_ID, customerId: SHOPPER })).toEqual({
      methodId: TOKEN_ID,
      customerId: SHOPPER,
      brand: 'visa',
      last4: '1111',
    });
    const call = adyen.last();
    expect(call.method).toBe('GET');
    expect(call.path).toBe('/v72/storedPaymentMethods');
    expect(call.query).toEqual({ shopperReference: SHOPPER, merchantAccount: MERCHANT });
    await expect(
      provider.verifyMethod({ methodId: 'OTHERTOKEN', customerId: SHOPPER }),
    ).rejects.toBeInstanceOf(PaymentMethodOwnershipError);
  });

  it('deletes a token for the shopper', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    await provider.detachMethod({ customerId: SHOPPER, methodId: TOKEN_ID });
    const call = adyen.last();
    expect(call.method).toBe('DELETE');
    expect(call.path).toBe(`/v72/storedPaymentMethods/${TOKEN_ID}`);
    expect(call.query).toEqual({ shopperReference: SHOPPER, merchantAccount: MERCHANT });
  });
});

describe('holds', () => {
  it('pre-authorizes a saved card off session (ContAuth, UnscheduledCardOnFile)', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({
      body: {
        pspReference: PAYMENT_PSP,
        resultCode: 'Authorised',
        amount: { value: 5000, currency: 'EUR' },
        adjustAuthorisationData: 'BQABAQA+fbc==...',
      },
    });
    const result = await provider.authorizeHold(
      hold({ receiptEmail: 'driver@example.com', metadata: { sessionId: 's1' } }),
    );
    const call = adyen.last();
    expect(call.url).toBe(`${TEST_BASE}/payments`);
    expect(call.headers['idempotency-key']).toBe('preauth_s1');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body).toEqual({
      merchantAccount: MERCHANT,
      reference: 'sess_s1',
      amount: { value: 5000, currency: 'EUR' },
      additionalData: { authorisationType: 'PreAuth', manualCapture: 'true' },
      paymentMethod: { type: 'scheme', storedPaymentMethodId: TOKEN_ID },
      shopperReference: SHOPPER,
      shopperInteraction: 'ContAuth',
      recurringProcessingModel: 'UnscheduledCardOnFile',
      shopperEmail: 'driver@example.com',
      metadata: { sessionId: 's1' },
    });
    expect(result).toEqual({
      status: 'authorized',
      paymentId: PAYMENT_PSP,
      authorizedCents: 5000,
      providerState: { adjustAuthorisationData: 'BQABAQA+fbc==...' },
    });
  });

  it('uses Ecommerce and CardOnFile with the browser when the shopper is present', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    await provider.authorizeHold(
      hold({
        initiator: 'shopper',
        method: { kind: 'saved', customerId: SHOPPER, methodId: TOKEN_ID, browser: BROWSER },
      }),
    );
    expect(adyen.last().body).toMatchObject({
      shopperInteraction: 'Ecommerce',
      recurringProcessingModel: 'CardOnFile',
      channel: 'Web',
      origin: BROWSER.origin,
      returnUrl: BROWSER.returnUrl,
      browserInfo: BROWSER.info,
    });
    await expect(provider.authorizeHold(hold({ initiator: 'shopper' }))).rejects.toBeInstanceOf(
      PaymentValidationError,
    );
  });

  it('sends the CVC from the stored-card component with the shopper present', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    const saved = (paymentMethod: Record<string, unknown>) =>
      hold({
        initiator: 'shopper',
        method: {
          kind: 'saved',
          customerId: SHOPPER,
          methodId: TOKEN_ID,
          browser: { origin: BROWSER.origin, returnUrl: BROWSER.returnUrl },
          payload: { paymentMethod, browserInfo: BROWSER.info },
        },
      });
    await provider.authorizeHold(
      saved({
        type: 'scheme',
        storedPaymentMethodId: TOKEN_ID,
        encryptedSecurityCode: 'test_737',
        encryptedCardNumber: 'ignored',
      }),
    );
    expect(adyen.last().body).toMatchObject({
      paymentMethod: {
        type: 'scheme',
        storedPaymentMethodId: TOKEN_ID,
        encryptedSecurityCode: 'test_737',
      },
      shopperInteraction: 'Ecommerce',
      recurringProcessingModel: 'CardOnFile',
      browserInfo: BROWSER.info,
    });
    expect(
      (adyen.last().body?.['paymentMethod'] as Record<string, unknown>)['encryptedCardNumber'],
    ).toBeUndefined();

    const calls = adyen.calls.length;
    await expect(
      provider.authorizeHold(
        saved({ storedPaymentMethodId: 'OTHERTOKEN', encryptedSecurityCode: 'test_737' }),
      ),
    ).rejects.toBeInstanceOf(PaymentValidationError);
    await expect(
      provider.authorizeHold(saved({ storedPaymentMethodId: TOKEN_ID })),
    ).rejects.toBeInstanceOf(PaymentValidationError);
    expect(adyen.calls.length).toBe(calls);
  });

  it('holds a one-time card from the component without storing it', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    await provider.authorizeHold(
      hold({
        initiator: 'shopper',
        merchantReference: 'guest_tok1',
        method: {
          kind: 'one_time',
          payload: { ...CARD, browserInfo: BROWSER.info },
          browser: { origin: BROWSER.origin, returnUrl: BROWSER.returnUrl },
        },
      }),
    );
    const body = adyen.last().body ?? {};
    expect(body['paymentMethod']).toEqual(CARD.paymentMethod);
    expect(body['shopperInteraction']).toBe('Ecommerce');
    expect(body['browserInfo']).toEqual(BROWSER.info);
    expect(body['reference']).toBe('guest_tok1');
    expect(body['storePaymentMethod']).toBeUndefined();
    expect(body['shopperReference']).toBeUndefined();
  });

  it('returns a 3DS action to a present shopper and continues with /payments/details', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    const action = { type: 'redirect', url: 'https://test.adyen.com/hpp/3d/validate.shtml' };
    adyen.next({ body: { resultCode: 'RedirectShopper', action } });
    const first = await provider.authorizeHold(
      hold({
        initiator: 'shopper',
        method: { kind: 'one_time', payload: CARD, browser: BROWSER },
      }),
    );
    expect(first).toEqual({
      status: 'action_required',
      paymentId: null,
      action: { provider: 'adyen', data: action },
    });

    adyen.next({
      body: {
        pspReference: PAYMENT_PSP,
        resultCode: 'Authorised',
        amount: { value: 5000, currency: 'EUR' },
      },
    });
    const done = await provider.continueHold({
      paymentId: null,
      details: { details: { redirectResult: 'X6XtfGC3!Y...' } },
      idempotencyKey: 'preauth_s1_details',
    });
    expect(adyen.last().url).toBe(`${TEST_BASE}/payments/details`);
    expect(adyen.last().headers['idempotency-key']).toBe('preauth_s1_details');
    expect(done).toEqual({ status: 'authorized', paymentId: PAYMENT_PSP, authorizedCents: 5000 });
  });

  it('declines an action on a merchant-initiated hold', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({ body: { resultCode: 'ChallengeShopper', action: { type: 'threeDS2' } } });
    const err = await rejection(provider.authorizeHold(hold()));
    expect(err).toBeInstanceOf(PaymentDeclinedError);
    expect((err as PaymentDeclinedError).code).toBe('authentication_required');
  });

  it('maps a refusal to PaymentDeclinedError with the refusal reason', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({
      body: {
        pspReference: 'FD4SM6KD8HSLMS82',
        resultCode: 'Refused',
        refusalReason: 'Not enough balance',
        refusalReasonCode: '12',
      },
    });
    const err = await rejection(provider.authorizeHold(hold()));
    expect(err).toBeInstanceOf(PaymentDeclinedError);
    expect((err as PaymentDeclinedError).message).toBe('Not enough balance');
    expect((err as PaymentDeclinedError).code).toBe('12');
    expect((err as PaymentDeclinedError).retryable).toBe(false);

    adyen.next({
      body: { resultCode: 'Error', refusalReason: 'Acquirer Error', refusalReasonCode: '4' },
    });
    const error = await rejection(provider.authorizeHold(hold()));
    expect((error as PaymentDeclinedError).retryable).toBe(true);
  });

  it('keeps cents as Adyen minor units and refuses IDR (D-A3)', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    await provider.authorizeHold(hold({ amountCents: 1234, currency: 'usd' }));
    expect(adyen.last().body?.['amount']).toEqual({ value: 1234, currency: 'USD' });
    const calls = adyen.calls.length;
    await expect(provider.authorizeHold(hold({ currency: 'IDR' }))).rejects.toBeInstanceOf(
      PaymentValidationError,
    );
    await expect(provider.authorizeHold(hold({ amountCents: 12.5 }))).rejects.toBeInstanceOf(
      PaymentValidationError,
    );
    expect(adyen.calls).toHaveLength(calls);
  });

  it('refuses a payout account: no split payments (D-A2)', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    await expect(
      provider.authorizeHold(hold({ payoutAccountId: 'BA00000000000000000000001' })),
    ).rejects.toBeInstanceOf(PaymentValidationError);
    await expect(
      provider.capture({
        idempotencyKey: 'capture_1',
        paymentId: PAYMENT_PSP,
        amountCents: 100,
        currency: 'EUR',
        merchantReference: 'sess_s1',
        payoutAccountId: 'BA1',
        feeTax: 0,
        platformFeePercent: 5,
      }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
    await expect(
      provider.chargeSavedMethod({
        idempotencyKey: 'resfee_1',
        customerId: SHOPPER,
        methodId: TOKEN_ID,
        grossCents: 500,
        currency: 'EUR',
        feeTaxRate: 0,
        platformFeePercent: 5,
        payoutAccountId: 'BA1',
        description: 'Reservation fee',
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
    expect(adyen.calls).toHaveLength(0);
  });
});

describe('modifications (async)', () => {
  it('captures and returns pending with the modification pspReference', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    const result = await provider.capture({
      idempotencyKey: 'capture_pr1',
      paymentId: PAYMENT_PSP,
      amountCents: 4321,
      currency: 'EUR',
      merchantReference: 'sess_s1',
      payoutAccountId: null,
      feeTax: 0,
      platformFeePercent: 0,
    });
    const call = adyen.last();
    expect(call.url).toBe(`${TEST_BASE}/payments/${PAYMENT_PSP}/captures`);
    expect(call.headers['idempotency-key']).toBe('capture_pr1');
    expect(call.body).toEqual({
      merchantAccount: MERCHANT,
      amount: { value: 4321, currency: 'EUR' },
      reference: 'sess_s1',
    });
    expect(result).toEqual({ state: 'pending', operationRef: MODIFICATION_PSP });
  });

  it('fails loud when Adyen does not accept a modification', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({ body: { status: 'unknown' } });
    await expect(
      provider.refund({
        idempotencyKey: 'refund_1',
        paymentId: PAYMENT_PSP,
        amountCents: 100,
        currency: 'EUR',
        merchantReference: 'sess_s1',
      }),
    ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
  });

  it('cancels by pspReference, or by merchant reference without one', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    expect(
      await provider.cancelHold({
        paymentId: PAYMENT_PSP,
        merchantReference: 'sess_s1',
        idempotencyKey: 'cancel_pr1',
      }),
    ).toEqual({ state: 'pending', operationRef: MODIFICATION_PSP });
    expect(adyen.last().url).toBe(`${TEST_BASE}/payments/${PAYMENT_PSP}/cancels`);
    expect(adyen.last().body).toEqual({ merchantAccount: MERCHANT, reference: 'sess_s1' });

    await provider.cancelHold({
      paymentId: null,
      merchantReference: 'guest_tok1',
      idempotencyKey: 'cancel_guest_tok1',
    });
    expect(adyen.last().url).toBe(`${TEST_BASE}/cancels`);
    expect(adyen.last().headers['idempotency-key']).toBe('cancel_guest_tok1');
    expect(adyen.last().body).toEqual({
      merchantAccount: MERCHANT,
      paymentReference: 'guest_tok1',
      reference: 'cancel_guest_tok1',
    });
  });

  it('refunds an amount and needs one', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    const result = await provider.refund({
      idempotencyKey: 'refund_pr1_req1',
      paymentId: PAYMENT_PSP,
      amountCents: 700,
      currency: 'EUR',
      merchantReference: 'sess_s1',
    });
    expect(adyen.last().url).toBe(`${TEST_BASE}/payments/${PAYMENT_PSP}/refunds`);
    expect(adyen.last().body).toEqual({
      merchantAccount: MERCHANT,
      amount: { value: 700, currency: 'EUR' },
      reference: 'sess_s1',
    });
    expect(result).toEqual({ state: 'pending', operationRef: MODIFICATION_PSP });
    await expect(
      provider.refund({
        idempotencyKey: 'refund_all',
        paymentId: PAYMENT_PSP,
        currency: 'EUR',
        merchantReference: 'sess_s1',
      }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
  });
});

describe('authorization adjustment (D-A1)', () => {
  const input = {
    idempotencyKey: 'adjust_pr1_7000',
    paymentId: PAYMENT_PSP,
    newTotalCents: 7000,
    currency: 'EUR',
  };

  it('is refused while adyen.authorisationAdjustment is off', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    await expect(provider.adjustHold(input)).rejects.toBeInstanceOf(
      PaymentOperationNotSupportedError,
    );
    expect(adyen.calls).toHaveLength(0);
  });

  it('sends the new total and returns pending without the blob', async () => {
    const { provider, adyen } = fakeAdyenProvider({ authorisationAdjustment: true });
    const result = await provider.adjustHold(input);
    const call = adyen.last();
    expect(call.url).toBe(`${TEST_BASE}/payments/${PAYMENT_PSP}/amountUpdates`);
    expect(call.headers['idempotency-key']).toBe('adjust_pr1_7000');
    expect(call.body).toEqual({
      merchantAccount: MERCHANT,
      amount: { value: 7000, currency: 'EUR' },
      reference: 'adjust_pr1_7000',
      industryUsage: 'delayedCharge',
    });
    expect(result).toEqual({ state: 'pending', operationRef: MODIFICATION_PSP });
  });

  it('adjusts synchronously with the blob and returns the new blob', async () => {
    const { provider, adyen } = fakeAdyenProvider({ authorisationAdjustment: true });
    adyen.next({
      body: {
        merchantAccount: MERCHANT,
        paymentPspReference: PAYMENT_PSP,
        pspReference: 'NC6HT9CRT65ZGN82',
        status: 'Authorised',
        adjustAuthorisationData: 'BQABAQArqht7L...',
        amount: { currency: 'EUR', value: 7000 },
      },
    });
    const result = await provider.adjustHold({
      ...input,
      providerState: { adjustAuthorisationData: 'BQABAQA+fbc==...' },
    });
    expect(adyen.last().body?.['adjustAuthorisationData']).toBe('BQABAQA+fbc==...');
    expect(result).toEqual({
      state: 'succeeded',
      authorizedCents: 7000,
      providerState: { adjustAuthorisationData: 'BQABAQArqht7L...' },
    });
  });

  it('declines a refused synchronous adjustment', async () => {
    const { provider, adyen } = fakeAdyenProvider({ authorisationAdjustment: true });
    adyen.next({ body: { pspReference: 'NC6HT9CRT65ZGN82', status: 'Refused' } });
    await expect(provider.adjustHold(input)).rejects.toBeInstanceOf(PaymentDeclinedError);
  });
});

describe('merchant-initiated charges', () => {
  it('charges a shortfall on the hold method with immediate capture', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({ body: { pspReference: 'TOPUP000000001', resultCode: 'Authorised' } });
    const result = await provider.chargeShortfall({
      idempotencyKey: 'topup_pr1',
      originalPaymentId: PAYMENT_PSP,
      method: { customerId: SHOPPER, methodId: TOKEN_ID },
      capturedCents: 5000,
      finalCostCents: 5600,
      currency: 'EUR',
      feeTax: 0,
      platformFeePercent: 0,
      description: 'Charging session shortfall',
    });
    expect(adyen.last().headers['idempotency-key']).toBe('topup_pr1');
    expect(adyen.last().body).toEqual({
      merchantAccount: MERCHANT,
      reference: 'topup_pr1',
      amount: { value: 600, currency: 'EUR' },
      paymentMethod: { type: 'scheme', storedPaymentMethodId: TOKEN_ID },
      shopperReference: SHOPPER,
      shopperInteraction: 'ContAuth',
      recurringProcessingModel: 'UnscheduledCardOnFile',
      captureDelayHours: 0,
      metadata: { originalPaymentId: PAYMENT_PSP },
    });
    expect(result).toEqual({
      paymentId: 'TOPUP000000001',
      amountCents: 600,
      applicationFeeCents: 0,
    });
  });

  it('needs the hold method and a positive shortfall', async () => {
    const { provider } = fakeAdyenProvider();
    const base = {
      idempotencyKey: 'topup_pr1',
      originalPaymentId: PAYMENT_PSP,
      capturedCents: 5000,
      finalCostCents: 5600,
      currency: 'EUR',
      feeTax: 0,
      platformFeePercent: 0,
      description: 'x',
    };
    await expect(provider.chargeShortfall(base)).rejects.toBeInstanceOf(PaymentValidationError);
    await expect(
      provider.chargeShortfall({
        ...base,
        finalCostCents: 5000,
        method: { customerId: SHOPPER, methodId: TOKEN_ID },
      }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
  });

  it('charges a saved method and declines a refusal or an authentication request', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    const input = {
      idempotencyKey: 'resfee_r1',
      customerId: SHOPPER,
      methodId: TOKEN_ID,
      grossCents: 500,
      currency: 'EUR',
      feeTaxRate: 0,
      platformFeePercent: 0,
      payoutAccountId: null,
      description: 'Reservation fee',
      metadata: { reservationId: 'r1' },
    };
    expect(await provider.chargeSavedMethod(input)).toEqual({
      paymentId: PAYMENT_PSP,
      amountCents: 500,
      applicationFeeCents: 0,
    });
    expect(adyen.last().body).toMatchObject({
      reference: 'resfee_r1',
      captureDelayHours: 0,
      metadata: { reservationId: 'r1' },
    });
    adyen.next(
      { body: { resultCode: 'Refused', refusalReason: 'Expired Card', refusalReasonCode: '6' } },
      { body: { resultCode: 'IdentifyShopper', action: { type: 'threeDS2' } } },
    );
    const refused = await rejection(provider.chargeSavedMethod(input));
    expect((refused as PaymentDeclinedError).message).toBe('Expired Card');
    const action = await rejection(provider.chargeSavedMethod(input));
    expect((action as PaymentDeclinedError).code).toBe('authentication_required');
  });
});

describe('HTTP errors and retries', () => {
  const capture = {
    idempotencyKey: 'capture_pr1',
    paymentId: PAYMENT_PSP,
    amountCents: 100,
    currency: 'EUR',
    merchantReference: 'sess_s1',
    payoutAccountId: null,
    feeTax: 0,
    platformFeePercent: 0,
  };

  it('retries a 5xx with the same idempotency key, then reports unavailable', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const adyen = fakeAdyen();
    const provider = new AdyenPaymentProvider(adyenOptions(adyen, { sleep }));
    const error = {
      status: 500,
      body: { status: 500, errorCode: '901', message: 'Internal error', errorType: 'internal' },
    };
    adyen.next(error, error, error);
    const err = await rejection(provider.capture(capture));
    expect(err).toBeInstanceOf(PaymentProviderUnavailableError);
    expect((err as Error).message).toContain('Internal error');
    expect(adyen.calls).toHaveLength(3);
    expect(adyen.calls.every((c) => c.headers['idempotency-key'] === 'capture_pr1')).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('recovers when a retry succeeds (network error, 429, transient 422)', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next(
      { networkError: true },
      { status: 429, body: { status: 429, message: 'Too many requests' } },
    );
    expect((await provider.capture(capture)).state).toBe('pending');
    expect(adyen.calls).toHaveLength(3);

    adyen.next({
      status: 422,
      headers: { 'transient-error': 'true' },
      body: { status: 422, errorCode: '704', message: 'request already processed or in progress' },
    });
    expect((await provider.capture(capture)).state).toBe('pending');
  });

  it('does not retry a POST without an idempotency key', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({ networkError: true });
    await expect(provider.testConnection()).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    expect(adyen.calls).toHaveLength(1);
  });

  it('throws AdyenApiError for a 4xx, without retrying', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({
      status: 422,
      body: {
        status: 422,
        errorCode: '167',
        message: 'Original pspReference required for this operation',
        errorType: 'validation',
        pspReference: 'XYZ',
      },
    });
    const err = await rejection(provider.capture(capture));
    expect(err).toBeInstanceOf(AdyenApiError);
    expect(err).toMatchObject({ status: 422, errorCode: '167', errorType: 'validation' });
    expect(adyen.calls).toHaveLength(1);

    adyen.next({
      status: 401,
      body: {
        status: 401,
        errorCode: '000',
        message: 'HTTP Status Response - Unauthorized',
        errorType: 'security',
      },
    });
    await expect(provider.testConnection()).rejects.toBeInstanceOf(AdyenApiError);
  });

  it('rejects a body that is not JSON and an idempotency key over 64 characters', async () => {
    const { provider, adyen } = fakeAdyenProvider();
    adyen.next({ status: 200, body: '<html>ok</html>' });
    await expect(provider.testConnection()).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    await expect(
      provider.capture({ ...capture, idempotencyKey: 'k'.repeat(65) }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
  });
});
