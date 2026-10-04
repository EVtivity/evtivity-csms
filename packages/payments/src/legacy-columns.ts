// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PaymentProviderId } from './types.js';

/**
 * The dual write of the P4 expand release. Every id written to a provider
 * column (`provider_payment_id`, `provider_customer_id`,
 * `provider_payment_method_id`, `driver_payment_customers`) is also written
 * to its `stripe_*` column, because pods of the previous release read only
 * those during the rolling upgrade. P8 drops the `stripe_*` columns and this
 * module.
 *
 * Only Stripe and simulated ids go into `stripe_*` columns. Pods of the
 * previous release pin a `stripe_*` id by prefix (simulated or Stripe), so an
 * id of another provider (Adyen) there would be sent to Stripe. Its
 * `stripe_*` columns stay NULL instead (plan P10, guard layer 2).
 */
const STRIPE_COLUMN_PROVIDERS: ReadonlySet<PaymentProviderId> = new Set(['stripe', 'simulated']);

/** Whether ids of this provider are also written to the `stripe_*` columns. */
export function writesStripeColumns(providerId: PaymentProviderId): boolean {
  return STRIPE_COLUMN_PROVIDERS.has(providerId);
}

/** The value for a `stripe_*` column next to a provider id: the id, or null for other providers. */
export function stripeColumnValue(providerId: PaymentProviderId, id: string | null): string | null {
  return writesStripeColumns(providerId) ? id : null;
}
