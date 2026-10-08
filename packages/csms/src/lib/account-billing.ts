// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The billing state of an account session (charge on account): from its invoice. */
export type AccountBillingState = 'unbilled' | 'invoiced' | 'paid';

/** No invoice yet is unbilled, an issued invoice is invoiced, a paid one is paid. */
export function accountBillingState(invoiceStatus: string | null | undefined): AccountBillingState {
  if (invoiceStatus === 'paid') return 'paid';
  if (invoiceStatus === 'issued') return 'invoiced';
  return 'unbilled';
}

/**
 * Whether the session is billed to its fleet: stamped account and without a
 * payment record. One with a record (an operator hold) was paid by card, and
 * the fleet invoice leaves it out.
 */
export function isBilledOnAccount(session: {
  billingMode?: string | null;
  paymentRecord?: unknown;
}): boolean {
  return session.billingMode === 'account' && session.paymentRecord == null;
}
