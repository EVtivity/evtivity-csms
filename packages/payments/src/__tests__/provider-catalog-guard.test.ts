// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The provider select and the provider-switch guard: a configured Adyen that
// new payments can use is listed as requiring the upgrade while processes of
// a release before v0.1.38 are connected, with the guard's details.

const { query } = vi.hoisted(() => ({
  query: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(),
}));

// The shared release guard runs for real on the mocked client.
vi.mock('../../../database/src/config.js', () => ({ client: query }));
vi.mock('@evtivity/database', async () => ({
  db: {},
  settings: {},
  sitePaymentConfigs: {},
  client: query,
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../database/src/lib/process-versions.js',
  )),
}));

import { createPaymentRegistry } from '../create-registry.js';
import { describePaymentProviders } from '../provider-catalog.js';
import { PROCESS_VERSION_WATCH_KEY } from '../../../database/src/lib/process-versions.js';
import type { ProcessWatchStore } from '../../../database/src/lib/process-versions.js';
import type { PaymentSettings } from '../settings.js';
import { defaultSimulatedSettings, emptyAdyenSettings } from './helpers/settings.js';

const KEY = 'test-encryption-key-32chars-long!';

const SETTINGS: PaymentSettings = {
  provider: 'none',
  preAuthAmountCents: 5000,
  stripe: {
    secretKey: 'sk_test_catalog',
    publishableKey: 'pk_test_catalog',
    webhookSecret: null,
    connectWebhookSecret: null,
  },
  adyen: emptyAdyenSettings({
    apiKey: 'adyen-api-key',
    merchantAccount: 'EVtivityECOM',
    clientKey: 'test_CLIENTKEY',
  }),
  simulated: defaultSimulatedSettings(),
};

function watch(state: object | null): ProcessWatchStore {
  return {
    get: (key: string) =>
      Promise.resolve(
        key === PROCESS_VERSION_WATCH_KEY && state != null ? JSON.stringify(state) : null,
      ),
    set: () => Promise.resolve('OK'),
  };
}

const registry = createPaymentRegistry({
  encryptionKey: KEY,
  allowSimulated: false,
  readSettings: () => Promise.resolve(SETTINGS),
});

beforeEach(() => {
  query.mockReset();
});

describe('describePaymentProviders with the provider-switch guard', () => {
  it('lists Adyen as selectable when the guard allows it', async () => {
    query.mockResolvedValue([]);
    const entries = await describePaymentProviders(
      registry,
      watch({ checkedAt: new Date().toISOString(), legacySeenAt: null }),
    );
    expect(entries.find((e) => e.id === 'adyen')).toMatchObject({
      configured: true,
      selectable: true,
      reason: null,
      upgradePending: null,
    });
  });

  it('lists Adyen as requiring the upgrade while an old process is connected', async () => {
    query.mockResolvedValue([{ name: 'postgres.js', connections: 2, hosts: ['10.0.0.7'] }]);
    const checkedAt = new Date().toISOString();
    const entries = await describePaymentProviders(
      registry,
      watch({ checkedAt, legacySeenAt: null }),
    );
    expect(entries.find((e) => e.id === 'adyen')).toMatchObject({
      configured: true,
      selectable: false,
      reason: 'requires_upgrade',
      upgradePending: {
        legacyConnections: 2,
        hosts: ['10.0.0.7'],
        lastLegacySeenAt: null,
        watchCheckedAt: checkedAt,
      },
    });
    // Stripe is never guarded: still selectable, and the check ran once (Adyen).
    expect(entries.find((e) => e.id === 'stripe')).toMatchObject({
      selectable: true,
      upgradePending: null,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('lists Adyen as requiring the upgrade without a watch result', async () => {
    query.mockResolvedValue([]);
    const entries = await describePaymentProviders(registry, watch(null));
    expect(entries.find((e) => e.id === 'adyen')).toMatchObject({
      selectable: false,
      reason: 'requires_upgrade',
      upgradePending: { legacyConnections: 0, watchCheckedAt: null },
    });
  });
});
