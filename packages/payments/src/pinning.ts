// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PaymentProviderNotConfiguredError } from './errors.js';
import type { PaymentProviderRegistry } from './registry.js';
import type { PaymentProvider, PaymentProviderId } from './types.js';

/**
 * Provider pinning (D-P2) for the schema before the P4 expand. Saved methods,
 * driver customers and payment records keep their provider ids in the
 * `stripe_*` columns and have no `provider` column yet, so the provider a
 * stored id belongs to is derived here, in one place: the simulated provider
 * mints `cus_sim_`, `pm_sim_` and `pi_sim_` ids, everything else stored so
 * far is Stripe. P4 adds `payment_records.provider` and
 * `driver_payment_methods.provider`, backfills them with this rule, and
 * replaces this module with a column read.
 *
 * New payments can therefore only go to providers whose ids this rule can
 * tell apart (STORABLE_PROVIDER_IDS) until P4.
 */
export const STORABLE_PROVIDER_IDS: readonly PaymentProviderId[] = ['stripe', 'simulated'];

const SIMULATED_PREFIXES = ['cus_sim_', 'pm_sim_', 'pi_sim_'];

export interface StoredPaymentIds {
  customerId?: string | null;
  methodId?: string | null;
  paymentId?: string | null;
}

/** The provider that created a stored customer, method or payment id. */
export function providerOfStoredIds(ids: StoredPaymentIds): PaymentProviderId {
  const values = [ids.customerId, ids.methodId, ids.paymentId];
  const simulated = values.some(
    (v) => v != null && SIMULATED_PREFIXES.some((prefix) => v.startsWith(prefix)),
  );
  return simulated ? 'simulated' : 'stripe';
}

/** The provider a stored payment or method is pinned to (throws when this process cannot use it). */
export function pinnedProvider(
  registry: PaymentProviderRegistry,
  ids: StoredPaymentIds,
): Promise<PaymentProvider> {
  return registry.getPaymentProvider(providerOfStoredIds(ids));
}

/**
 * The provider for new payments (`payments.provider`), or null when payments
 * are off or the selected provider has no credentials. A provider whose ids
 * cannot be stored before P4 is refused (fail loud).
 */
export async function activeProvider(
  registry: PaymentProviderRegistry,
): Promise<PaymentProvider | null> {
  const provider = await registry.getActivePaymentProvider();
  if (provider != null && !STORABLE_PROVIDER_IDS.includes(provider.id)) {
    throw new PaymentProviderNotConfiguredError(
      provider.id,
      `Payment provider ${provider.id} needs the provider columns of the P4 data model`,
    );
  }
  return provider;
}
