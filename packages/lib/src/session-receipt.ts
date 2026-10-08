// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { notificationMoney } from './notification-values.js';
import { costIncludesTax } from './price-display.js';

/** An ended session as the session.Completed and session.Receipt notifications describe it. */
export interface SessionReceiptInput {
  siteName: string | null;
  /** The station's OCPP identity. */
  stationId: string;
  transactionId: string;
  energyDeliveredWh: number;
  finalCostCents: number | null;
  currency: string;
  tariffTaxRate: string | null;
  startedAt: string | Date;
  endedAt: string | Date;
  /** The hold was released because the cost is below the provider minimum charge. */
  notCharged: boolean;
  /**
   * How the session is paid (its write-once stamp `charging_sessions.billing_mode`):
   * 'account' is billed to the fleet named by `billedTo`, no card is charged.
   * Null: no stamp (older, prepaid, roaming or free vend sessions).
   */
  billingMode: 'card' | 'account' | null;
  /** The name of the fleet an account session is billed to; null otherwise. */
  billedTo: string | null;
}

/**
 * The receipt billing of an ended session from its write-once stamp
 * (`charging_sessions.billing_mode`): account only without a payment record
 * (billed to the fleet, no card charged); one with a record (an operator
 * hold) was paid by card.
 */
export function receiptBilling(
  mode: unknown,
  fleetName: string | null,
  hasPaymentRecord: boolean,
): Pick<SessionReceiptInput, 'billingMode' | 'billedTo'> {
  if (mode === 'account' && !hasPaymentRecord)
    return { billingMode: 'account', billedTo: fleetName };
  return { billingMode: mode === 'card' || mode === 'account' ? 'card' : null, billedTo: null };
}

/**
 * The template variables of session.Completed and session.Receipt: the OCPP
 * settlement sends them when a session ends, and the operator re-bill of a
 * session the CSMS gave up ending sends session.Receipt with them.
 */
export function sessionReceiptVariables(input: SessionReceiptInput): Record<string, unknown> {
  const startedAt = new Date(input.startedAt);
  const endedAt = new Date(input.endedAt);
  return {
    siteName: input.siteName ?? '',
    stationId: input.stationId,
    transactionId: input.transactionId,
    energyDeliveredWh: input.energyDeliveredWh,
    finalCostCents: input.finalCostCents,
    costFormatted: notificationMoney(input.finalCostCents ?? 0, input.currency),
    costIncludesTax: costIncludesTax(input.finalCostCents, input.tariffTaxRate),
    currency: input.currency,
    durationMinutes: Math.round((endedAt.getTime() - startedAt.getTime()) / 60000),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    notCharged: input.notCharged,
    // Templates test `{{#if billedTo}}` for the account wording.
    billingMode: input.billingMode ?? '',
    billedTo: input.billingMode === 'account' ? (input.billedTo ?? '') : '',
  };
}
