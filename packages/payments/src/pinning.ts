// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PaymentContext } from './context.js';
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

/**
 * The provider for new payments as a process decides whether to start one:
 * null when payments are off, and also when the selected provider is one this
 * process cannot use (no credentials, or simulated with
 * PAYMENTS_ALLOW_SIMULATED=false), logged at warn so a page or a session start
 * never fails on a misconfigured setting. The payment calls themselves fail
 * loud. Any other error (a key that cannot be decrypted) is rethrown.
 */
export async function resolveActiveProvider(ctx: PaymentContext): Promise<PaymentProvider | null> {
  try {
    return await activeProvider(ctx.registry);
  } catch (err) {
    if (!(err instanceof PaymentProviderNotConfiguredError)) throw err;
    ctx.logger.warn({ err, providerId: err.providerId }, 'Active payment provider not available');
    return null;
  }
}
