// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({ db: {}, settings: {}, sitePaymentConfigs: {} }));

import { PaymentProviderRegistry } from '../registry.js';
import type { PaymentProviderFactory } from '../registry.js';
import { createPaymentRegistry } from '../create-registry.js';
import { PaymentProviderNotConfiguredError } from '../errors.js';
import type { PaymentSettings } from '../settings.js';
import type { PaymentProvider } from '../types.js';
import { defaultSimulatedSettings, emptyAdyenSettings } from './helpers/settings.js';

const KEY = 'test-encryption-key-32chars-long!';

function settings(overrides: Partial<PaymentSettings> = {}): PaymentSettings {
  return {
    provider: 'fake',
    preAuthAmountCents: 5000,
    stripe: {
      secretKey: null,
      publishableKey: null,
      webhookSecret: null,
      connectWebhookSecret: null,
    },
    adyen: emptyAdyenSettings(),
    simulated: defaultSimulatedSettings(),
    ...overrides,
  };
}

function fakeFactory(
  id: string,
  configured = true,
): PaymentProviderFactory & { create: ReturnType<typeof vi.fn> } {
  return {
    id,
    create: vi.fn((_s: PaymentSettings) =>
      Promise.resolve(configured ? ({ id } as unknown as PaymentProvider) : null),
    ),
  };
}

describe('PaymentProviderRegistry', () => {
  it('rejects a duplicate id and the reserved none', () => {
    const registry = new PaymentProviderRegistry({ encryptionKey: KEY });
    registry.register(fakeFactory('fake'));
    expect(() => registry.register(fakeFactory('fake'))).toThrow('already registered');
    expect(() => registry.register(fakeFactory('none'))).toThrow('reserved');
    expect(registry.registeredIds()).toEqual(['fake']);
    expect(registry.isRegistered('fake')).toBe(true);
    expect(registry.isRegistered('stripe')).toBe(false);
  });

  it('returns no active provider when payments are off', async () => {
    const readSettings = vi.fn(() => Promise.resolve(settings({ provider: 'none' })));
    const registry = new PaymentProviderRegistry({ encryptionKey: KEY, readSettings });
    registry.register(fakeFactory('fake'));
    expect(await registry.getActivePaymentProvider()).toBeNull();
    expect(readSettings).toHaveBeenCalledWith(KEY);
  });

  it('returns null for an active provider without credentials', async () => {
    const registry = new PaymentProviderRegistry({
      encryptionKey: KEY,
      readSettings: () => Promise.resolve(settings()),
    });
    registry.register(fakeFactory('fake', false));
    expect(await registry.getActivePaymentProvider()).toBeNull();
    await expect(registry.getPaymentProvider('fake')).rejects.toBeInstanceOf(
      PaymentProviderNotConfiguredError,
    );
  });

  it('fails loud on a selected provider this process does not have', async () => {
    const registry = new PaymentProviderRegistry({
      encryptionKey: KEY,
      readSettings: () => Promise.resolve(settings({ provider: 'adyen' })),
    });
    await expect(registry.getActivePaymentProvider()).rejects.toThrow('not available');
    await expect(registry.getPaymentProvider('simulated')).rejects.toBeInstanceOf(
      PaymentProviderNotConfiguredError,
    );
  });

  it('reuses a provider while the settings are unchanged and rebuilds after', async () => {
    let current = settings();
    const registry = new PaymentProviderRegistry({
      encryptionKey: KEY,
      readSettings: () => Promise.resolve(current),
    });
    const factory = fakeFactory('fake');
    registry.register(factory);
    const a = await registry.getActivePaymentProvider();
    const b = await registry.getPaymentProvider('fake');
    expect(b).toBe(a);
    expect(factory.create).toHaveBeenCalledTimes(1);

    current = settings();
    await registry.getPaymentProvider('fake');
    expect(factory.create).toHaveBeenCalledTimes(2);

    registry.clearCache();
    await registry.getPaymentProvider('fake');
    expect(factory.create).toHaveBeenCalledTimes(3);
  });
});

describe('createPaymentRegistry', () => {
  const readSettings = () =>
    Promise.resolve(
      settings({
        provider: 'simulated',
        stripe: {
          secretKey: 'sk_test_x',
          publishableKey: 'pk_test_x',
          webhookSecret: null,
          connectWebhookSecret: null,
        },
      }),
    );

  it('registers Stripe and, when allowed, the simulated provider', async () => {
    const registry = createPaymentRegistry({
      encryptionKey: KEY,
      allowSimulated: true,
      readSettings,
    });
    expect(registry.registeredIds()).toEqual(['stripe', 'adyen', 'simulated']);
    expect((await registry.getActivePaymentProvider())?.id).toBe('simulated');
    expect((await registry.getPaymentProvider('stripe')).id).toBe('stripe');
  });

  it('refuses the simulated provider when PAYMENTS_ALLOW_SIMULATED is false', async () => {
    const registry = createPaymentRegistry({
      encryptionKey: KEY,
      allowSimulated: false,
      readSettings,
    });
    expect(registry.registeredIds()).toEqual(['stripe', 'adyen']);
    await expect(registry.getActivePaymentProvider()).rejects.toBeInstanceOf(
      PaymentProviderNotConfiguredError,
    );
    await expect(registry.getPaymentProvider('simulated')).rejects.toBeInstanceOf(
      PaymentProviderNotConfiguredError,
    );
  });

  it('builds the Adyen provider when it is configured', async () => {
    let adyen = emptyAdyenSettings();
    const registry = createPaymentRegistry({
      encryptionKey: KEY,
      allowSimulated: false,
      readSettings: () => Promise.resolve(settings({ provider: 'adyen', adyen })),
    });
    await expect(registry.getPaymentProvider('adyen')).rejects.toBeInstanceOf(
      PaymentProviderNotConfiguredError,
    );
    expect(await registry.getActivePaymentProvider()).toBeNull();

    adyen = emptyAdyenSettings({
      apiKey: 'AQE_key',
      merchantAccount: 'TestMerchant',
      clientKey: 'test_CLIENTKEY',
    });
    const provider = await registry.getPaymentProvider('adyen');
    expect(provider.id).toBe('adyen');
    expect((await registry.getActivePaymentProvider())?.id).toBe('adyen');
  });

  it('builds the simulated provider from the simulated settings', async () => {
    let current = settings({ provider: 'simulated' });
    const registry = createPaymentRegistry({
      encryptionKey: KEY,
      allowSimulated: true,
      readSettings: () => Promise.resolve(current),
      simulated: { events: { deliver: () => Promise.resolve() } },
    });
    const sync = await registry.getPaymentProvider('simulated');
    expect(sync.capabilities.modificationResults).toBe('sync');

    current = settings({
      provider: 'simulated',
      simulated: { resultMode: 'async', asyncDelaySeconds: 1, randomFailureRate: 0 },
    });
    const async = await registry.getPaymentProvider('simulated');
    expect(async.capabilities.modificationResults).toBe('async');
    expect(async).not.toBe(sync);

    // A new settings read with the same simulated values reuses the provider.
    current = { ...current };
    expect(await registry.getPaymentProvider('simulated')).toBe(async);
  });
});
