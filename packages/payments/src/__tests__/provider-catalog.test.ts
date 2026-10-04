// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

const { query } = vi.hoisted(() => ({
  query: vi.fn((..._args: unknown[]) => Promise.resolve([{ legacy: 0, hosts: [] }])),
}));

vi.mock('@evtivity/database', () => ({
  db: {},
  settings: {},
  sitePaymentConfigs: {},
  client: query,
}));

import { createPaymentRegistry } from '../create-registry.js';
import { describePaymentProviders } from '../provider-catalog.js';
import { PaymentProviderRegistry } from '../registry.js';
import type { PaymentSettings } from '../settings.js';
import type { PaymentProvider } from '../types.js';
import { PROCESS_VERSION_WATCH_KEY } from '../provider-switch-guard.js';
import type { ProcessWatchStore } from '../provider-switch-guard.js';
import { defaultSimulatedSettings, emptyAdyenSettings } from './helpers/settings.js';

const KEY = 'test-encryption-key-32chars-long!';

function settings(overrides: Partial<PaymentSettings> = {}): PaymentSettings {
  return {
    provider: 'none',
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

const STRIPE_KEYS = {
  secretKey: 'sk_test_catalog',
  publishableKey: 'pk_test_catalog',
  webhookSecret: null,
  connectWebhookSecret: null,
};

const ADYEN_KEYS = emptyAdyenSettings({
  apiKey: 'adyen-api-key',
  merchantAccount: 'EVtivityECOM',
  clientKey: 'test_CLIENTKEY',
});

/** A fresh, clean process-version watch: the guard allows the switch. */
function cleanWatch(): ProcessWatchStore {
  const state = JSON.stringify({ checkedAt: new Date().toISOString(), legacySeenAt: null });
  return {
    get: (key: string) => Promise.resolve(key === PROCESS_VERSION_WATCH_KEY ? state : null),
    set: () => Promise.resolve('OK'),
  };
}

function registry(value: PaymentSettings, allowSimulated: boolean): PaymentProviderRegistry {
  return createPaymentRegistry({
    encryptionKey: KEY,
    allowSimulated,
    readSettings: () => Promise.resolve(value),
  });
}

describe('describePaymentProviders', () => {
  it('lists configured Stripe as selectable with its capabilities', async () => {
    const entries = await describePaymentProviders(
      registry(settings({ stripe: STRIPE_KEYS }), false),
      cleanWatch(),
    );
    expect(entries.find((e) => e.id === 'stripe')).toEqual({
      id: 'stripe',
      configured: true,
      selectable: true,
      reason: null,
      upgradePending: null,
      capabilities: {
        savedMethods: true,
        clientActions: true,
        nativeMobileSheet: true,
        marketplaceSplit: 'destination_charge',
      },
    });
  });

  it('lists Stripe without keys as not configured, with its static capabilities', async () => {
    const entries = await describePaymentProviders(registry(settings(), false), cleanWatch());
    expect(entries.find((e) => e.id === 'stripe')).toEqual({
      id: 'stripe',
      configured: false,
      selectable: false,
      reason: 'not_configured',
      upgradePending: null,
      capabilities: {
        savedMethods: true,
        clientActions: true,
        nativeMobileSheet: true,
        marketplaceSplit: 'destination_charge',
      },
    });
    expect(entries.find((e) => e.id === 'adyen')).toMatchObject({
      configured: false,
      selectable: false,
      reason: 'not_configured',
      upgradePending: null,
      capabilities: { nativeMobileSheet: false, marketplaceSplit: 'none' },
    });
  });

  it('lists configured Adyen as selectable when the provider-switch guard allows it', async () => {
    const entries = await describePaymentProviders(
      registry(settings({ adyen: ADYEN_KEYS }), false),
      cleanWatch(),
    );
    expect(entries.find((e) => e.id === 'adyen')).toEqual({
      id: 'adyen',
      configured: true,
      selectable: true,
      reason: null,
      upgradePending: null,
      capabilities: {
        savedMethods: true,
        clientActions: true,
        nativeMobileSheet: false,
        marketplaceSplit: 'none',
      },
    });
  });

  it('lists the simulated provider only where it is registered', async () => {
    const without = await describePaymentProviders(registry(settings(), false), cleanWatch());
    expect(without.map((e) => e.id)).toEqual(['stripe', 'adyen']);

    const withSimulated = await describePaymentProviders(registry(settings(), true), cleanWatch());
    expect(withSimulated.find((e) => e.id === 'simulated')).toEqual({
      id: 'simulated',
      configured: true,
      selectable: true,
      reason: null,
      upgradePending: null,
      capabilities: {
        savedMethods: true,
        clientActions: true,
        nativeMobileSheet: false,
        marketplaceSplit: 'none',
      },
    });
  });

  it('assumes no capabilities for a plugin provider that cannot be built', async () => {
    const r = new PaymentProviderRegistry({
      encryptionKey: KEY,
      readSettings: () => Promise.resolve(settings()),
    });
    r.register({ id: 'plugin', create: () => Promise.resolve(null) });
    expect(await describePaymentProviders(r, cleanWatch())).toEqual([
      {
        id: 'plugin',
        configured: false,
        selectable: false,
        reason: 'not_configured',
        upgradePending: null,
        capabilities: {
          savedMethods: false,
          clientActions: false,
          nativeMobileSheet: false,
          marketplaceSplit: 'none',
        },
      },
    ]);
  });

  it('lists a configured plugin provider as selectable (the guard covers only Adyen)', async () => {
    const r = new PaymentProviderRegistry({
      encryptionKey: KEY,
      readSettings: () => Promise.resolve(settings()),
    });
    const provider = {
      id: 'plugin',
      capabilities: {
        savedMethods: true,
        clientActions: false,
        nativeMobileSheet: false,
        marketplaceSplit: 'none',
      },
    } as unknown as PaymentProvider;
    r.register({ id: 'plugin', create: () => Promise.resolve(provider) });
    expect((await describePaymentProviders(r, cleanWatch()))[0]).toMatchObject({
      configured: true,
      selectable: true,
      reason: null,
      upgradePending: null,
    });
  });

  it('throws errors other than a missing configuration (P9)', async () => {
    const r = new PaymentProviderRegistry({
      encryptionKey: KEY,
      readSettings: () => Promise.reject(new Error('decrypt failed')),
    });
    r.register({ id: 'plugin', create: () => Promise.resolve(null) });
    await expect(describePaymentProviders(r, cleanWatch())).rejects.toThrow('decrypt failed');
  });
});
