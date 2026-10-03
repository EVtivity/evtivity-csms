// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({ db: {}, settings: {}, sitePaymentConfigs: {} }));

import {
  activeProvider,
  pinnedProvider,
  providerOfStoredIds,
  STORABLE_PROVIDER_IDS,
} from '../pinning.js';
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

describe('providerOfStoredIds', () => {
  it('maps simulated prefixes on any id to simulated', () => {
    expect(providerOfStoredIds({ customerId: 'cus_sim_1' })).toBe('simulated');
    expect(providerOfStoredIds({ methodId: 'pm_sim_1' })).toBe('simulated');
    expect(providerOfStoredIds({ paymentId: 'pi_sim_1' })).toBe('simulated');
    expect(providerOfStoredIds({ customerId: 'cus_1', paymentId: 'pi_sim_1' })).toBe('simulated');
  });

  it('maps everything else to stripe', () => {
    expect(providerOfStoredIds({})).toBe('stripe');
    expect(providerOfStoredIds({ customerId: null, methodId: null, paymentId: null })).toBe(
      'stripe',
    );
    expect(providerOfStoredIds({ customerId: 'cus_1', methodId: 'pm_1', paymentId: 'pi_1' })).toBe(
      'stripe',
    );
    expect(providerOfStoredIds({ paymentId: 'xpi_sim_1' })).toBe('stripe');
  });
});

describe('pinnedProvider', () => {
  it('asks the registry for the provider of the stored ids', async () => {
    const r = registry(null);
    expect((await pinnedProvider(r.registry, { methodId: 'pm_sim_1' })).id).toBe('simulated');
    expect(r.getPaymentProvider).toHaveBeenLastCalledWith('simulated');
    expect((await pinnedProvider(r.registry, { paymentId: 'pi_1' })).id).toBe('stripe');
    expect(r.getPaymentProvider).toHaveBeenLastCalledWith('stripe');
  });
});

describe('activeProvider', () => {
  it('lists stripe and simulated as storable', () => {
    expect(STORABLE_PROVIDER_IDS).toEqual(['stripe', 'simulated']);
  });

  it('returns null when payments are off', async () => {
    expect(await activeProvider(registry(null).registry)).toBeNull();
  });

  it.each([['stripe'], ['simulated']])('returns the storable provider %s', async (id) => {
    const provider = { id } as unknown as PaymentProvider;
    expect(await activeProvider(registry(provider).registry)).toBe(provider);
  });

  it('refuses a provider whose ids cannot be stored yet', async () => {
    const provider = { id: 'adyen' } as unknown as PaymentProvider;
    const promise = activeProvider(registry(provider).registry);
    await expect(promise).rejects.toBeInstanceOf(PaymentProviderNotConfiguredError);
    await expect(promise).rejects.toMatchObject({
      providerId: 'adyen',
      message: 'Payment provider adyen needs the provider columns of the P4 data model',
    });
  });
});
