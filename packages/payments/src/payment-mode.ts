// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * How a charging session is paid (plan B2.6). One definition for the payment
 * gate on TransactionEvent Started and the settlement on Ended, in this
 * order of precedence:
 *
 * - `roaming`: an OCPI roaming session; the eMSP bills through the CDR.
 * - `free_vend`: the site's free vend; nothing is charged.
 * - `prepaid`: the session's token holds a prepaid balance (OCPP 2.1 C17);
 *   the balance is debited at the end, no card hold.
 * - `account`: a driver session billed to a fleet (charge on account): the
 *   session's write-once stamp `billing_mode = 'account'`. No card, no hold,
 *   no payment record; the fleet invoice bills it.
 * - `card`: a driver session, paid with the driver's saved card (hold at
 *   the start, capture at the end).
 * - `guest`: a guest checkout or ad hoc payment session (guest_sessions row);
 *   the hold was placed at checkout and the worker finalizes it.
 * - `anonymous`: none of the above; the gate stops it.
 */
export type SessionPaymentMode =
  | 'roaming'
  | 'free_vend'
  | 'prepaid'
  | 'account'
  | 'card'
  | 'guest'
  | 'anonymous';

export interface SessionPaymentFacts {
  isRoaming: boolean;
  freeVend: boolean;
  /** The session's token has a prepaid balance (`driver_tokens.prepaid_balance_cents` set). */
  prepaid: boolean;
  /** The session is billed to a fleet account (`charging_sessions.billing_mode = 'account'`). */
  account: boolean;
  driverId: string | null;
  /** A guest_sessions row matched the session's token. */
  guestSession: boolean;
}

export function classifySessionPayment(facts: SessionPaymentFacts): SessionPaymentMode {
  if (facts.isRoaming) return 'roaming';
  if (facts.freeVend) return 'free_vend';
  if (facts.prepaid) return 'prepaid';
  if (facts.account && facts.driverId != null) return 'account';
  if (facts.driverId != null) return 'card';
  if (facts.guestSession) return 'guest';
  return 'anonymous';
}
