// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PaymentProviderNotConfiguredError } from './errors.js';
import type { PaymentProviderRegistry } from './registry.js';
import type { PaymentProvider } from './types.js';

/**
 * Provider pinning (D-P2). Saved methods, driver customers, guest sessions and
 * payment records store the provider that minted their ids in a `provider`
 * column (P4), so a stored payment is always finished, refunded or detached
 * by that provider, whatever provider is active now.
 */

/**
 * The provider a stored payment or method is pinned to, from its `provider`
 * column. Rejects with PaymentProviderNotConfiguredError when the row has no
 * provider or this process cannot use it.
 */
export function pinnedProvider(
  registry: PaymentProviderRegistry,
  providerId: string | null,
): Promise<PaymentProvider> {
  if (providerId == null) {
    return Promise.reject(
      new PaymentProviderNotConfiguredError('unknown', 'Stored payment has no provider'),
    );
  }
  return registry.getPaymentProvider(providerId);
}

/**
 * The provider for new payments (`payments.provider`), or null when payments
 * are off or the selected provider has no credentials.
 */
export function activeProvider(registry: PaymentProviderRegistry): Promise<PaymentProvider | null> {
  return registry.getActivePaymentProvider();
}
