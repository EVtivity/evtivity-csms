// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe, StripeCardElementOptions } from '@stripe/stripe-js';

// One loadStripe per publishable key: Elements must keep the same `stripe` promise for its lifetime.
const stripeByKey = new Map<string, Promise<Stripe | null>>();

export function getStripe(publishableKey: string): Promise<Stripe | null> {
  let promise = stripeByKey.get(publishableKey);
  if (promise == null) {
    promise = loadStripe(publishableKey);
    stripeByKey.set(publishableKey, promise);
  }
  return promise;
}

/** Reads a non-empty string field from a provider config or session. */
export function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** CardElement styles that follow the light or dark theme. */
export function cardElementOptions(): StripeCardElementOptions {
  const dark = document.documentElement.classList.contains('dark');
  return {
    style: {
      base: {
        fontSize: '16px',
        color: dark ? '#f8fafc' : '#020817',
        '::placeholder': { color: dark ? '#94a3b8' : '#64748b' },
      },
    },
  };
}
