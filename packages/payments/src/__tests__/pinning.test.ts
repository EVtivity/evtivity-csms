// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({ db: {}, settings: {}, sitePaymentConfigs: {} }));

import * as pinning from '../pinning.js';
import { activeProvider, pinnedProvider } from '../pinning.js';
import { PaymentProviderNotConfiguredError } from '../errors.js';
import type { PaymentProviderRegistry } from '../registry.js';
import type { PaymentProvider } from '../types.js';

function registry(active: PaymentProvider | null): {
  registry: PaymentProviderRegistry;
  getPaymentProvider: ReturnType<typeof vi.fn>;
} {
  const getPaymentProvider = vi.fn((id: string) =>
    Promise.resolve({ id } as unknown as PaymentProvider),
  );
  return {
    getPaymentProvider,
    registry: {
      getPaymentProvider,
      getActivePaymentProvider: vi.fn(() => Promise.resolve(active)),
    } as unknown as PaymentProviderRegistry,
  };
}

describe('pinnedProvider', () => {
  it('asks the registry for the provider stored on the row', async () => {
    const r = registry(null);
    expect((await pinnedProvider(r.registry, 'simulated')).id).toBe('simulated');
    expect(r.getPaymentProvider).toHaveBeenLastCalledWith('simulated');
    expect((await pinnedProvider(r.registry, 'stripe')).id).toBe('stripe');
    expect(r.getPaymentProvider).toHaveBeenLastCalledWith('stripe');
  });

  it('rejects a row without a provider', async () => {
    const r = registry(null);
    const promise = pinnedProvider(r.registry, null);
    await expect(promise).rejects.toBeInstanceOf(PaymentProviderNotConfiguredError);
    await expect(promise).rejects.toMatchObject({ providerId: 'unknown' });
    expect(r.getPaymentProvider).not.toHaveBeenCalled();
  });

  it('no longer derives the provider from id prefixes', () => {
    expect('providerOfStoredIds' in pinning).toBe(false);
  });
});

describe('activeProvider', () => {
  it('returns null when payments are off', async () => {
    expect(await activeProvider(registry(null).registry)).toBeNull();
  });

  it.each([['stripe'], ['simulated'], ['adyen']])(
    'returns the selected provider %s',
    async (id) => {
      const provider = { id } as unknown as PaymentProvider;
      expect(await activeProvider(registry(provider).registry)).toBe(provider);
    },
  );

  it('no longer limits new payments to a list of providers', () => {
    expect('STORABLE_PROVIDER_IDS' in pinning).toBe(false);
  });
});
