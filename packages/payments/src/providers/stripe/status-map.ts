// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PaymentStatus } from '../../types.js';

/**
 * Local `payment_records.status` values consistent with a PaymentIntent
 * status. Several per status: a refund keeps the intent `succeeded`, and a
 * declined hold can leave it `canceled` or absent.
 */
const ACCEPTABLE: Record<string, ReadonlySet<PaymentStatus>> = {
  requires_payment_method: new Set(['pending']),
  requires_confirmation: new Set(['pending']),
  requires_action: new Set(['pending']),
  processing: new Set(['pending']),
  requires_capture: new Set(['pre_authorized']),
  succeeded: new Set(['captured', 'partially_refunded', 'refunded']),
  canceled: new Set(['cancelled', 'failed']),
};

/** Null for a status with no mapping (reconciliation skips it). */
export function acceptableLocalStatuses(stripeStatus: string): ReadonlySet<PaymentStatus> | null {
  return ACCEPTABLE[stripeStatus] ?? null;
}
