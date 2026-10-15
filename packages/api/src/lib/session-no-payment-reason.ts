// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Why a charging session has no payment record (GET /v1/sessions/:id
 * `noPaymentReason`), in the order the payment gate and the settlement decide
 * how a session is paid (`classifySessionPayment` in @evtivity/payments, the
 * OCPP payment gate and `stopSessionForPayment`):
 *
 * - `free_vend`: the site's free vend; nothing is charged.
 * - `roaming`: an OCPI roaming session; the eMSP bills it through the CDR.
 * - `account_credit_limit`: an account session the fleet credit limit refused at its start.
 * - `account_billed`: billed to a fleet account, on the fleet invoice or the driver's member invoice.
 * - `guest`: a guest checkout; the guest session holds the payment.
 * - `anonymous`: no driver and no guest checkout; the gate stops such a session.
 * - `no_payment_method`: the gate stopped the session, the driver had no saved payment method.
 * - `payment_failed`: the gate stopped the session, the hold or the prepaid check failed.
 * - `pending`: the session is still running; a prepaid debit or a hold may still come.
 * - `no_cost`: the session cost nothing (free tariff), so nothing was charged.
 * - `payments_off`: no payment provider is active now (payments.provider none or not usable).
 * - `prepaid_not_debited`: a prepaid token session whose balance debit was not recorded.
 * - `not_held`: no hold was placed at the start (payments were off or the provider was unavailable then).
 */
export const NO_PAYMENT_REASONS = [
  'free_vend',
  'roaming',
  'account_credit_limit',
  'account_billed',
  'guest',
  'anonymous',
  'no_payment_method',
  'payment_failed',
  'pending',
  'no_cost',
  'payments_off',
  'prepaid_not_debited',
  'not_held',
] as const;
export type NoPaymentReason = (typeof NO_PAYMENT_REASONS)[number];

export interface NoPaymentFacts {
  hasPaymentRecord: boolean;
  status: string;
  freeVend: boolean;
  isRoaming: boolean;
  billingMode: string | null;
  stoppedReason: string | null;
  /** A guest_sessions row is linked to the session. */
  guestSession: boolean;
  driverId: string | null;
  /** The session's token holds a prepaid balance. */
  prepaidToken: boolean;
  finalCostCents: number | null;
  currentCostCents: number | null;
}

/**
 * The reason, or null when the session has a payment record. `paymentsOff`
 * resolves whether no payment provider is active now; it is called only for a
 * card session that reaches that check.
 */
export async function noPaymentReason(
  facts: NoPaymentFacts,
  paymentsOff: () => Promise<boolean>,
): Promise<NoPaymentReason | null> {
  if (facts.hasPaymentRecord) return null;
  if (facts.freeVend) return 'free_vend';
  if (facts.isRoaming) return 'roaming';
  if (facts.billingMode === 'account') {
    return facts.stoppedReason === 'AccountCreditLimit' && facts.status === 'faulted'
      ? 'account_credit_limit'
      : 'account_billed';
  }
  if (facts.guestSession) return 'guest';
  if (facts.driverId == null) return 'anonymous';
  if (facts.stoppedReason === 'MissingPaymentMethod') return 'no_payment_method';
  if (facts.stoppedReason === 'PaymentFailed') return 'payment_failed';

  const active = facts.status === 'active';
  if (facts.prepaidToken) {
    if (active) return 'pending';
    return costCents(facts) > 0 ? 'prepaid_not_debited' : 'no_cost';
  }
  if (active) return (await paymentsOff()) ? 'payments_off' : 'pending';
  if (costCents(facts) <= 0) return 'no_cost';
  return (await paymentsOff()) ? 'payments_off' : 'not_held';
}

function costCents(facts: NoPaymentFacts): number {
  return facts.finalCostCents ?? facts.currentCostCents ?? 0;
}
