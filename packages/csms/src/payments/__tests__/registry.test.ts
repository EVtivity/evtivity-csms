// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@stripe/stripe-js/pure', () => ({ loadStripe: vi.fn(() => Promise.resolve(null)) }));
vi.mock('@adyen/adyen-web', () => ({ AdyenCheckout: vi.fn(), Card: vi.fn() }));

import { isPaymentModuleRegistered, loadPaymentModule } from '../registry';

describe('payment provider registry', () => {
  it('returns null for an unknown provider id', () => {
    expect(loadPaymentModule('bogus')).toBeNull();
    expect(isPaymentModuleRegistered('bogus')).toBe(false);
  });

  it('ignores object prototype keys', () => {
    expect(loadPaymentModule('constructor')).toBeNull();
    expect(loadPaymentModule('__proto__')).toBeNull();
    expect(loadPaymentModule('toString')).toBeNull();
  });

  it('loads the Stripe module with card setup', async () => {
    const module = await loadPaymentModule('stripe');
    expect(module?.id).toBe('stripe');
    expect(module?.CardSetup).toBeTypeOf('function');
  });

  it('loads the test provider module with card setup', async () => {
    expect(isPaymentModuleRegistered('simulated')).toBe(true);
    const module = await loadPaymentModule('simulated');
    expect(module?.id).toBe('simulated');
    expect(module?.CardSetup).toBeTypeOf('function');
  });

  it('loads the Adyen module with card setup', async () => {
    expect(isPaymentModuleRegistered('adyen')).toBe(true);
    const module = await loadPaymentModule('adyen');
    expect(module?.id).toBe('adyen');
    expect(module?.CardSetup).toBeTypeOf('function');
  });
});
