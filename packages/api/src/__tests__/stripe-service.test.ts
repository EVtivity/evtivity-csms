// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// -- DB mock helpers --

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}

function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'delete',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const result = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(result).then(onFulfilled, onRejected);
    }
    return Promise.resolve([]).then(onFulfilled, onRejected);
  };
  chain['catch'] = (onRejected?: (r: unknown) => unknown) => Promise.resolve([]).catch(onRejected);
  return chain;
}

// -- Hoisted mocks --

const { mockDecryptString, mockStripeInstance, mockConstructEvent } = vi.hoisted(() => {
  const mockDecryptString = vi.fn().mockReturnValue('sk_test_decrypted');
  const mockConstructEvent = vi
    .fn()
    .mockReturnValue({ id: 'evt_test', type: 'payment_intent.succeeded' });
  const mockStripeInstance = {
    paymentIntents: {
      create: vi.fn().mockResolvedValue({ id: 'pi_test', status: 'requires_capture' }),
      capture: vi.fn().mockResolvedValue({ id: 'pi_test', status: 'succeeded' }),
      cancel: vi.fn().mockResolvedValue({ id: 'pi_test', status: 'canceled' }),
      retrieve: vi.fn().mockResolvedValue({
        id: 'pi_test',
        amount: 5000,
        application_fee_amount: null,
        transfer_data: null,
      }),
    },
    refunds: {
      create: vi.fn().mockResolvedValue({ id: 're_test' }),
    },
    setupIntents: {
      create: vi.fn().mockResolvedValue({ id: 'seti_test' }),
    },
    customers: {
      create: vi.fn().mockResolvedValue({ id: 'cus_test' }),
    },
    paymentMethods: {
      detach: vi.fn().mockResolvedValue({ id: 'pm_test' }),
      retrieve: vi
        .fn()
        .mockResolvedValue({ id: 'pm_test', card: { brand: 'visa', last4: '4242' } }),
    },
    webhooks: {
      constructEvent: mockConstructEvent,
    },
  };
  return { mockDecryptString, mockStripeInstance, mockConstructEvent };
});

// -- Config mock --

const mockConfig = vi.hoisted(() => ({
  SETTINGS_ENCRYPTION_KEY: 'test-encryption-key',
  COOKIE_DOMAIN: undefined as string | undefined,
}));

vi.mock('../lib/config.js', () => ({
  config: mockConfig,
}));

// -- Mocks --

const {
  mockGetCompanyCurrency,
  mockGetPlatformFeePercent,
  mockClearPlatformFeeCache,
  mockClearStripeWebhookSecretCache,
} = vi.hoisted(() => ({
  mockGetCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  mockGetPlatformFeePercent: vi.fn((_siteId: string | null) => Promise.resolve(0)),
  mockClearPlatformFeeCache: vi.fn(),
  mockClearStripeWebhookSecretCache: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
  },
  getCompanyCurrency: mockGetCompanyCurrency,
  getPlatformFeePercent: mockGetPlatformFeePercent,
  clearPlatformFeeCache: mockClearPlatformFeeCache,
  clearStripeWebhookSecretCache: mockClearStripeWebhookSecretCache,
  settings: {},
  sitePaymentConfigs: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  decryptString: mockDecryptString,
}));

vi.mock('stripe', () => {
  function MockStripe() {
    return mockStripeInstance;
  }
  return { default: MockStripe };
});

// -- Import under test (after mocks) --

import {
  getStripeConfig,
  isPaymentEnabled,
  createPreAuthorization,
  capturePayment,
  chargeSavedCard,
  cancelPaymentIntent,
  createRefund,
  createSetupIntent,
  createCustomer,
  detachPaymentMethod,
  retrievePaymentMethod,
  clearConfigCache,
  verifyWebhookSignature,
} from '../services/stripe.service.js';
import type { StripeConfig } from '../services/stripe.service.js';

// -- Helpers --

function platformSettingsRows() {
  return [
    { key: 'stripe.secretKeyEnc', value: 'encrypted_key' },
    { key: 'stripe.publishableKey', value: 'pk_test_123' },
    { key: 'stripe.preAuthAmountCents', value: 5000 },
    { key: 'stripe.platformFeePercent', value: 0 },
  ];
}

function sitePaymentConfigRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'config-1',
    siteId: 'site-1',
    isEnabled: true,
    stripeConnectedAccountId: 'acct_connected',
    preAuthAmountCents: 8000,
    ...overrides,
  };
}

function feeConfig(overrides: Partial<StripeConfig> = {}): StripeConfig {
  return {
    stripe: mockStripeInstance as unknown as StripeConfig['stripe'],
    publishableKey: 'pk_test',
    currency: 'USD',
    preAuthAmountCents: 5000,
    configId: null,
    connectedAccountId: null,
    platformFeePercent: 0,
    ...overrides,
  };
}

// -- Tests --

describe('stripe.service', () => {
  beforeEach(() => {
    mockConfig.SETTINGS_ENCRYPTION_KEY = 'test-encryption-key';
    clearConfigCache();
    setupDbResults();
    vi.clearAllMocks();
  });

  describe('getStripeConfig', () => {
    it('returns null when no platform settings exist', async () => {
      setupDbResults([]);
      const config = await getStripeConfig(null);
      expect(config).toBeNull();
    });

    it('returns config from platform settings', async () => {
      setupDbResults(platformSettingsRows());
      const config = await getStripeConfig(null);
      expect(config).not.toBeNull();
      expect(config!.publishableKey).toBe('pk_test_123');
      expect(config!.currency).toBe('EUR');
      expect(config!.preAuthAmountCents).toBe(5000);
      expect(config!.connectedAccountId).toBeNull();
      expect(config!.configId).toBeNull();
      expect(mockDecryptString).toHaveBeenCalledWith('encrypted_key', 'test-encryption-key');
    });

    it('uses site config override when siteId provided and site has enabled config', async () => {
      setupDbResults(platformSettingsRows(), [sitePaymentConfigRow()]);
      const config = await getStripeConfig('site-1');
      expect(config).not.toBeNull();
      expect(config!.connectedAccountId).toBe('acct_connected');
      expect(config!.currency).toBe('EUR');
      expect(config!.preAuthAmountCents).toBe(8000);
      expect(config!.configId).toBe('config-1');
    });

    it('returns cached config on second call', async () => {
      setupDbResults(platformSettingsRows());
      const first = await getStripeConfig(null);
      expect(first).not.toBeNull();

      // Second call should not query DB again
      setupDbResults([]);
      const second = await getStripeConfig(null);
      expect(second).toEqual(first);
      expect(second!.stripe).toBe(first!.stripe);
    });

    it('applies a company currency change to a cached config', async () => {
      setupDbResults(platformSettingsRows());
      const first = await getStripeConfig(null);
      expect(first!.currency).toBe('EUR');

      mockGetCompanyCurrency.mockResolvedValue('GBP');
      try {
        setupDbResults([]);
        const second = await getStripeConfig(null);
        expect(second!.currency).toBe('GBP');
        expect(second!.stripe).toBe(first!.stripe);
      } finally {
        mockGetCompanyCurrency.mockResolvedValue('EUR');
      }
    });

    it('clearConfigCache clears cache so next call refetches', async () => {
      setupDbResults(platformSettingsRows());
      const first = await getStripeConfig(null);
      expect(first).not.toBeNull();

      clearConfigCache();
      setupDbResults([]);
      const second = await getStripeConfig(null);
      expect(second).toBeNull();
    });
  });

  describe('isPaymentEnabled', () => {
    it('returns true when platform stripe settings exist', async () => {
      setupDbResults(platformSettingsRows());
      const result = await isPaymentEnabled();
      expect(result).toBe(true);
    });

    it('returns false when no platform settings exist', async () => {
      setupDbResults([]);
      const result = await isPaymentEnabled();
      expect(result).toBe(false);
    });
  });

  describe('createPreAuthorization', () => {
    function makeConfig(overrides: Partial<StripeConfig> = {}): StripeConfig {
      return {
        stripe: mockStripeInstance as unknown as StripeConfig['stripe'],
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: null,
        connectedAccountId: null,
        platformFeePercent: 0,
        ...overrides,
      };
    }

    it('calls stripe.paymentIntents.create with correct params', async () => {
      const config = makeConfig();
      await createPreAuthorization(config, 'cus_123', 'pm_456');

      expect(mockStripeInstance.paymentIntents.create).toHaveBeenCalledWith(
        {
          amount: 5000,
          currency: 'usd',
          customer: 'cus_123',
          payment_method: 'pm_456',
          capture_method: 'manual',
          confirm: true,
          off_session: true,
        },
        undefined,
      );
    });

    it('makes a destination charge without a platform fee on the hold', async () => {
      const config = makeConfig({
        connectedAccountId: 'acct_connected',
        platformFeePercent: 10,
        preAuthAmountCents: 10000,
      });
      await createPreAuthorization(config, 'cus_123', 'pm_456');

      const call = mockStripeInstance.paymentIntents.create.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call['amount']).toBe(10000);
      expect(call['on_behalf_of']).toBe('acct_connected');
      expect(call['transfer_data']).toEqual({ destination: 'acct_connected' });
      // The fee is a percent of the net amount actually charged, set at capture.
      expect(call['application_fee_amount']).toBeUndefined();
    });

    it('passes idempotencyKey when provided', async () => {
      const config = makeConfig();
      await createPreAuthorization(config, 'cus_123', 'pm_456', undefined, 'preauth_abc123');

      expect(mockStripeInstance.paymentIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 5000,
          customer: 'cus_123',
          payment_method: 'pm_456',
        }),
        { idempotencyKey: 'preauth_abc123' },
      );
    });
  });

  describe('capturePayment', () => {
    it('calls capture with amount', async () => {
      const config = {
        stripe: mockStripeInstance as unknown as StripeConfig['stripe'],
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: null,
        connectedAccountId: null,
        platformFeePercent: 0,
      };
      await capturePayment(config, 'pi_test', 3500, undefined, 0);

      expect(mockStripeInstance.paymentIntents.capture).toHaveBeenCalledWith(
        'pi_test',
        { amount_to_capture: 3500 },
        undefined,
      );
    });

    it('sets the platform fee of the net amount captured on a destination charge', async () => {
      mockStripeInstance.paymentIntents.retrieve.mockResolvedValueOnce({
        id: 'pi_test',
        amount: 5000,
        application_fee_amount: null,
        transfer_data: { destination: 'acct_connected' },
      });
      const config = feeConfig({ connectedAccountId: 'acct_connected', platformFeePercent: 10 });
      const result = await capturePayment(config, 'pi_test', 3570, 'capture_1', 0.19);

      // 3570 gross at 19% is 3000 net; 10% of net is 300.
      expect(result.applicationFeeCents).toBe(300);
      expect(mockStripeInstance.paymentIntents.capture).toHaveBeenCalledWith(
        'pi_test',
        { amount_to_capture: 3570, application_fee_amount: 300 },
        { idempotencyKey: 'capture_1' },
      );
    });

    it('sets no fee when the hold is not a destination charge', async () => {
      const config = feeConfig({ connectedAccountId: 'acct_connected', platformFeePercent: 10 });
      await capturePayment(config, 'pi_test', 3570, 'capture_2', 0.19);

      expect(mockStripeInstance.paymentIntents.capture).toHaveBeenCalledWith(
        'pi_test',
        { amount_to_capture: 3570 },
        { idempotencyKey: 'capture_2' },
      );
    });

    it('passes idempotencyKey when provided', async () => {
      const config = {
        stripe: mockStripeInstance as unknown as StripeConfig['stripe'],
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: null,
        connectedAccountId: null,
        platformFeePercent: 0,
      };
      await capturePayment(config, 'pi_test', 3500, 'capture_xyz789', 0);

      expect(mockStripeInstance.paymentIntents.capture).toHaveBeenCalledWith(
        'pi_test',
        { amount_to_capture: 3500 },
        { idempotencyKey: 'capture_xyz789' },
      );
    });
  });

  describe('createRefund', () => {
    const config = {
      stripe: mockStripeInstance as unknown as StripeConfig['stripe'],
      publishableKey: 'pk_test',
      currency: 'USD',
      preAuthAmountCents: 5000,
      configId: null,
      connectedAccountId: null,
      platformFeePercent: 0,
    };

    it('calls refunds.create with payment intent', async () => {
      await createRefund(config, 'pi_test');
      expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
        { payment_intent: 'pi_test' },
        { idempotencyKey: expect.stringMatching(/^refund_pi_test_/) },
      );
    });

    it('calls refunds.create with amount when provided', async () => {
      await createRefund(config, 'pi_test', 2000);
      expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
        { payment_intent: 'pi_test', amount: 2000 },
        { idempotencyKey: expect.stringMatching(/^refund_pi_test_/) },
      );
    });

    it('uses requestId in idempotency key when provided', async () => {
      await createRefund(config, 'pi_test', 2000, 'req_abc123');
      expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
        { payment_intent: 'pi_test', amount: 2000 },
        { idempotencyKey: 'refund_pi_test_req_abc123' },
      );
    });

    it('generates unique idempotency keys per call when requestId is omitted', async () => {
      await createRefund(config, 'pi_test');
      await createRefund(config, 'pi_test');
      const calls = mockStripeInstance.refunds.create.mock.calls;
      const key1 = (calls[0]![1] as { idempotencyKey: string }).idempotencyKey;
      const key2 = (calls[1]![1] as { idempotencyKey: string }).idempotencyKey;
      expect(key1).toMatch(/^refund_pi_test_/);
      expect(key2).toMatch(/^refund_pi_test_/);
      expect(key1).not.toBe(key2);
    });

    it('reverses the transfer for a destination charge', async () => {
      mockStripeInstance.paymentIntents.retrieve.mockResolvedValueOnce({
        id: 'pi_dest',
        transfer_data: { destination: 'acct_x' },
        application_fee_amount: null,
      });

      await createRefund(config, 'pi_dest', 1000);

      expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payment_intent: 'pi_dest',
          amount: 1000,
          reverse_transfer: true,
        }),
        expect.anything(),
      );
      const call = mockStripeInstance.refunds.create.mock.calls[0]![0] as Record<string, unknown>;
      expect(call['refund_application_fee']).toBeUndefined();
    });

    it('refunds the application fee when the intent has one', async () => {
      mockStripeInstance.paymentIntents.retrieve.mockResolvedValueOnce({
        id: 'pi_fee',
        transfer_data: { destination: 'acct_x' },
        application_fee_amount: 250,
      });

      await createRefund(config, 'pi_fee');

      expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payment_intent: 'pi_fee',
          reverse_transfer: true,
          refund_application_fee: true,
        }),
        expect.anything(),
      );
    });

    it('does not reverse transfer for a non-destination charge', async () => {
      mockStripeInstance.paymentIntents.retrieve.mockResolvedValueOnce({
        id: 'pi_plain',
        transfer_data: null,
        application_fee_amount: null,
      });

      await createRefund(config, 'pi_plain');

      const call = mockStripeInstance.refunds.create.mock.calls[0]![0] as Record<string, unknown>;
      expect(call['reverse_transfer']).toBeUndefined();
      expect(call['refund_application_fee']).toBeUndefined();
    });
  });

  describe('retrievePaymentMethod', () => {
    it('retrieves a payment method by id', async () => {
      const config: StripeConfig = {
        stripe: mockStripeInstance as unknown as StripeConfig['stripe'],
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: null,
        connectedAccountId: null,
        platformFeePercent: 0,
      };

      const result = await retrievePaymentMethod(config, 'pm_retrieve_test');

      expect(mockStripeInstance.paymentMethods.retrieve).toHaveBeenCalledWith('pm_retrieve_test');
      expect(result).toEqual({ id: 'pm_test', card: { brand: 'visa', last4: '4242' } });
    });
  });

  describe('createCustomer', () => {
    it('calls customers.create with email and name', async () => {
      const config = {
        stripe: mockStripeInstance as unknown as StripeConfig['stripe'],
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: null,
        connectedAccountId: null,
        platformFeePercent: 0,
      };
      await createCustomer(config, 'test@example.com', 'Test User');

      expect(mockStripeInstance.customers.create).toHaveBeenCalledWith({
        email: 'test@example.com',
        name: 'Test User',
      });
    });
  });

  describe('cancelPaymentIntent', () => {
    it('calls paymentIntents.cancel with the intent id', async () => {
      const config: StripeConfig = {
        stripe: mockStripeInstance as unknown as StripeConfig['stripe'],
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: null,
        connectedAccountId: null,
        platformFeePercent: 0,
      };
      const result = await cancelPaymentIntent(config, 'pi_cancel_test');

      expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith('pi_cancel_test');
      expect(result).toEqual({ id: 'pi_test', status: 'canceled' });
    });
  });

  describe('createSetupIntent', () => {
    it('calls setupIntents.create with customer and card payment method', async () => {
      const config: StripeConfig = {
        stripe: mockStripeInstance as unknown as StripeConfig['stripe'],
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: null,
        connectedAccountId: null,
        platformFeePercent: 0,
      };
      const result = await createSetupIntent(config, 'cus_setup_test');

      expect(mockStripeInstance.setupIntents.create).toHaveBeenCalledWith({
        customer: 'cus_setup_test',
        payment_method_types: ['card'],
      });
      expect(result).toEqual({ id: 'seti_test' });
    });
  });

  describe('detachPaymentMethod', () => {
    it('calls paymentMethods.detach with the payment method id', async () => {
      const config: StripeConfig = {
        stripe: mockStripeInstance as unknown as StripeConfig['stripe'],
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: null,
        connectedAccountId: null,
        platformFeePercent: 0,
      };
      const result = await detachPaymentMethod(config, 'pm_detach_test');

      expect(mockStripeInstance.paymentMethods.detach).toHaveBeenCalledWith('pm_detach_test');
      expect(result).toEqual({ id: 'pm_test' });
    });
  });

  describe('verifyWebhookSignature', () => {
    it('calls webhooks.constructEvent with body, signature, and secret', () => {
      const result = verifyWebhookSignature('raw-body', 'sig-header', 'whsec_test');

      expect(mockConstructEvent).toHaveBeenCalledWith('raw-body', 'sig-header', 'whsec_test');
      expect(result).toEqual({ id: 'evt_test', type: 'payment_intent.succeeded' });
    });
  });

  describe('createPreAuthorization (additional coverage)', () => {
    function makeConfig(overrides: Partial<StripeConfig> = {}): StripeConfig {
      return {
        stripe: mockStripeInstance as unknown as StripeConfig['stripe'],
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: null,
        connectedAccountId: null,
        platformFeePercent: 0,
        ...overrides,
      };
    }

    it('uses explicit amountCents when provided', async () => {
      const config = makeConfig();
      await createPreAuthorization(config, 'cus_123', 'pm_456', 7500);

      expect(mockStripeInstance.paymentIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 7500,
        }),
        undefined,
      );
    });

    it('does not add platform fee when connectedAccountId is set but platformFeePercent is 0', async () => {
      const config = makeConfig({
        connectedAccountId: 'acct_test',
        platformFeePercent: 0,
      });
      await createPreAuthorization(config, 'cus_123', 'pm_456');

      const call = mockStripeInstance.paymentIntents.create.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call['on_behalf_of']).toBe('acct_test');
      expect(call['transfer_data']).toEqual({ destination: 'acct_test' });
      expect(call['application_fee_amount']).toBeUndefined();
    });
  });

  describe('getStripeConfig (additional coverage)', () => {
    it('uses the company currency for the platform and every site', async () => {
      mockGetCompanyCurrency.mockResolvedValue('GBP');
      try {
        setupDbResults(platformSettingsRows());
        const platform = await getStripeConfig(null);
        setupDbResults(platformSettingsRows(), [sitePaymentConfigRow()]);
        const site = await getStripeConfig('site-1');
        expect(platform!.currency).toBe('GBP');
        expect(site!.currency).toBe('GBP');
      } finally {
        mockGetCompanyCurrency.mockResolvedValue('EUR');
      }
    });

    it('uses default preAuthAmountCents 5000 when setting is missing', async () => {
      setupDbResults([
        { key: 'stripe.secretKeyEnc', value: 'encrypted_key' },
        { key: 'stripe.publishableKey', value: 'pk_test_123' },
      ]);
      const config = await getStripeConfig(null);
      expect(config).not.toBeNull();
      expect(config!.preAuthAmountCents).toBe(5000);
    });

    it('uses default platformFeePercent 0 when setting is missing', async () => {
      setupDbResults([
        { key: 'stripe.secretKeyEnc', value: 'encrypted_key' },
        { key: 'stripe.publishableKey', value: 'pk_test_123' },
      ]);
      const config = await getStripeConfig(null);
      expect(config).not.toBeNull();
      expect(config!.platformFeePercent).toBe(0);
    });

    it('returns platform defaults when site config exists but is disabled', async () => {
      setupDbResults(platformSettingsRows(), [sitePaymentConfigRow({ isEnabled: false })]);
      const config = await getStripeConfig('site-1');
      expect(config).not.toBeNull();
      expect(config!.connectedAccountId).toBeNull();
      expect(config!.currency).toBe('EUR');
      expect(config!.configId).toBeNull();
    });

    it('handles site config with null stripeConnectedAccountId', async () => {
      setupDbResults(platformSettingsRows(), [
        sitePaymentConfigRow({ stripeConnectedAccountId: null }),
      ]);
      const config = await getStripeConfig('site-1');
      expect(config).not.toBeNull();
      expect(config!.connectedAccountId).toBeNull();
    });

    it('returns null when secretKeyEnc is missing', async () => {
      setupDbResults([{ key: 'stripe.publishableKey', value: 'pk_test_123' }]);
      const config = await getStripeConfig(null);
      expect(config).toBeNull();
    });

    it('returns null when publishableKey is missing', async () => {
      setupDbResults([{ key: 'stripe.secretKeyEnc', value: 'encrypted_key' }]);
      const config = await getStripeConfig(null);
      expect(config).toBeNull();
    });

    it('returns null when secretKeyEnc is the empty string (seed default)', async () => {
      setupDbResults([
        { key: 'stripe.secretKeyEnc', value: '' },
        { key: 'stripe.publishableKey', value: 'pk_test_123' },
      ]);
      const config = await getStripeConfig(null);
      expect(config).toBeNull();
    });

    it('returns null when publishableKey is the empty string (seed default)', async () => {
      setupDbResults([
        { key: 'stripe.secretKeyEnc', value: 'encrypted_key' },
        { key: 'stripe.publishableKey', value: '' },
      ]);
      const config = await getStripeConfig(null);
      expect(config).toBeNull();
    });

    it('returns null when both keys are empty strings', async () => {
      setupDbResults([
        { key: 'stripe.secretKeyEnc', value: '' },
        { key: 'stripe.publishableKey', value: '' },
      ]);
      const config = await getStripeConfig(null);
      expect(config).toBeNull();
    });

    it('throws when SETTINGS_ENCRYPTION_KEY is not set', async () => {
      mockConfig.SETTINGS_ENCRYPTION_KEY = '';
      setupDbResults(platformSettingsRows());
      await expect(getStripeConfig(null)).rejects.toThrow(
        'SETTINGS_ENCRYPTION_KEY environment variable is required',
      );
    });

    it('throws when SETTINGS_ENCRYPTION_KEY is empty', async () => {
      mockConfig.SETTINGS_ENCRYPTION_KEY = '';
      setupDbResults(platformSettingsRows());
      await expect(getStripeConfig(null)).rejects.toThrow(
        'SETTINGS_ENCRYPTION_KEY environment variable is required',
      );
    });

    it('caches separate entries for different siteIds', async () => {
      setupDbResults(platformSettingsRows(), [sitePaymentConfigRow()]);
      const siteConfig = await getStripeConfig('site-1');
      expect(siteConfig).not.toBeNull();
      expect(siteConfig!.connectedAccountId).toBe('acct_connected');

      clearConfigCache();
      setupDbResults(platformSettingsRows());
      const platformConfig = await getStripeConfig(null);
      expect(platformConfig).not.toBeNull();
      expect(platformConfig!.connectedAccountId).toBeNull();
    });

    it('returns platform config when site query returns empty array', async () => {
      setupDbResults(platformSettingsRows(), []);
      const config = await getStripeConfig('site-1');
      expect(config).not.toBeNull();
      expect(config!.connectedAccountId).toBeNull();
      expect(config!.currency).toBe('EUR');
    });

    it('reads the fee percent of the site from getPlatformFeePercent, also when cached', async () => {
      mockGetPlatformFeePercent.mockResolvedValue(7.5);
      try {
        setupDbResults(platformSettingsRows(), [sitePaymentConfigRow()]);
        const config = await getStripeConfig('site-1');
        expect(config!.platformFeePercent).toBe(7.5);
        expect(mockGetPlatformFeePercent).toHaveBeenCalledWith('site-1');
        mockGetPlatformFeePercent.mockResolvedValue(3);
        const cached = await getStripeConfig('site-1');
        expect(cached!.platformFeePercent).toBe(3);
      } finally {
        mockGetPlatformFeePercent.mockResolvedValue(0);
      }
    });

    it('clears the fee percent cache with the config cache', () => {
      clearConfigCache('site-1');
      expect(mockClearPlatformFeeCache).toHaveBeenCalled();
    });
  });

  describe('chargeSavedCard', () => {
    const input = {
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      grossCents: 1190,
      taxRate: 0.19,
      description: 'Reservation cancellation fee',
      metadata: { reservationId: 'res_1', type: 'reservation_cancellation_fee' },
      idempotencyKey: 'cancellation-fee-res_1',
    };

    it('charges the gross amount off-session on the platform account', async () => {
      await chargeSavedCard(feeConfig(), input);
      expect(mockStripeInstance.paymentIntents.create).toHaveBeenCalledWith(
        {
          amount: 1190,
          currency: 'usd',
          customer: 'cus_1',
          payment_method: 'pm_1',
          confirm: true,
          off_session: true,
          description: 'Reservation cancellation fee',
          metadata: { reservationId: 'res_1', type: 'reservation_cancellation_fee' },
        },
        { idempotencyKey: 'cancellation-fee-res_1' },
      );
    });

    it('routes through the connected account with the fee of the net amount', async () => {
      await chargeSavedCard(
        feeConfig({ connectedAccountId: 'acct_1', platformFeePercent: 10 }),
        input,
      );
      const call = mockStripeInstance.paymentIntents.create.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(call['on_behalf_of']).toBe('acct_1');
      expect(call['transfer_data']).toEqual({ destination: 'acct_1' });
      // 1190 gross at 19% is 1000 net; 10% is 100.
      expect(call['application_fee_amount']).toBe(100);
    });
  });

  describe('clearConfigCache', () => {
    it('evicts only the named site entry, leaving the platform cache intact', async () => {
      setupDbResults(platformSettingsRows(), [sitePaymentConfigRow()]);
      const siteFirst = await getStripeConfig('site-1');
      expect(siteFirst).not.toBeNull();

      setupDbResults(platformSettingsRows());
      const platformFirst = await getStripeConfig(null);
      expect(platformFirst).not.toBeNull();

      // Evict only site-1. The platform entry stays cached.
      clearConfigCache('site-1');

      setupDbResults([]);
      const platformAgain = await getStripeConfig(null);
      expect(platformAgain).toEqual(platformFirst);

      // site-1 must refetch (queries run again).
      setupDbResults(platformSettingsRows(), [sitePaymentConfigRow({ preAuthAmountCents: 9000 })]);
      const siteAgain = await getStripeConfig('site-1');
      expect(siteAgain!.preAuthAmountCents).toBe(9000);
    });

    it('drops the cached webhook signing secret on a full clear only', () => {
      mockClearStripeWebhookSecretCache.mockClear();
      clearConfigCache('site-1');
      expect(mockClearStripeWebhookSecretCache).not.toHaveBeenCalled();
      clearConfigCache();
      expect(mockClearStripeWebhookSecretCache).toHaveBeenCalledTimes(1);
    });

    it('evicts the platform entry when called with null', async () => {
      setupDbResults(platformSettingsRows());
      const first = await getStripeConfig(null);
      expect(first).not.toBeNull();

      clearConfigCache(null);

      setupDbResults([]);
      const second = await getStripeConfig(null);
      expect(second).toBeNull();
    });
  });
});
