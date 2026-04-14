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

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
  },
  settings: {},
  sitePaymentConfigs: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

vi.mock('@evtivity/lib', () => ({
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
  cancelPaymentIntent,
  createRefund,
  createSetupIntent,
  createCustomer,
  detachPaymentMethod,
  clearConfigCache,
  verifyWebhookSignature,
} from '../services/stripe.service.js';
import type { StripeConfig } from '../services/stripe.service.js';

// -- Helpers --

function platformSettingsRows() {
  return [
    { key: 'stripe.secretKeyEnc', value: 'encrypted_key' },
    { key: 'stripe.publishableKey', value: 'pk_test_123' },
    { key: 'stripe.currency', value: 'USD' },
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
    currency: 'EUR',
    preAuthAmountCents: 8000,
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
      expect(config!.currency).toBe('USD');
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
      expect(second).toBe(first);
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

      expect(mockStripeInstance.paymentIntents.create).toHaveBeenCalledWith({
        amount: 5000,
        currency: 'usd',
        customer: 'cus_123',
        payment_method: 'pm_456',
        capture_method: 'manual',
        confirm: true,
        off_session: true,
      });
    });

    it('includes connected account and platform fee when configured', async () => {
      const config = makeConfig({
        connectedAccountId: 'acct_connected',
        platformFeePercent: 10,
        preAuthAmountCents: 10000,
      });
      await createPreAuthorization(config, 'cus_123', 'pm_456');

      expect(mockStripeInstance.paymentIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 10000,
          on_behalf_of: 'acct_connected',
          transfer_data: { destination: 'acct_connected' },
          application_fee_amount: 1000,
        }),
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
      await capturePayment(config, 'pi_test', 3500);

      expect(mockStripeInstance.paymentIntents.capture).toHaveBeenCalledWith('pi_test', {
        amount_to_capture: 3500,
      });
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
        { idempotencyKey: 'refund_pi_test_full' },
      );
    });

    it('calls refunds.create with amount when provided', async () => {
      await createRefund(config, 'pi_test', 2000);
      expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
        { payment_intent: 'pi_test', amount: 2000 },
        { idempotencyKey: 'refund_pi_test_2000' },
      );
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
    it('uses default currency USD when stripe.currency setting is missing', async () => {
      setupDbResults([
        { key: 'stripe.secretKeyEnc', value: 'encrypted_key' },
        { key: 'stripe.publishableKey', value: 'pk_test_123' },
        { key: 'stripe.preAuthAmountCents', value: 3000 },
      ]);
      const config = await getStripeConfig(null);
      expect(config).not.toBeNull();
      expect(config!.currency).toBe('USD');
    });

    it('uses default preAuthAmountCents 5000 when setting is missing', async () => {
      setupDbResults([
        { key: 'stripe.secretKeyEnc', value: 'encrypted_key' },
        { key: 'stripe.publishableKey', value: 'pk_test_123' },
        { key: 'stripe.currency', value: 'GBP' },
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
      expect(config!.currency).toBe('USD');
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
      setupDbResults([
        { key: 'stripe.publishableKey', value: 'pk_test_123' },
        { key: 'stripe.currency', value: 'USD' },
      ]);
      const config = await getStripeConfig(null);
      expect(config).toBeNull();
    });

    it('returns null when publishableKey is missing', async () => {
      setupDbResults([
        { key: 'stripe.secretKeyEnc', value: 'encrypted_key' },
        { key: 'stripe.currency', value: 'USD' },
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
      expect(config!.currency).toBe('USD');
    });
  });
});
