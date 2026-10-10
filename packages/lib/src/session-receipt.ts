// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { notificationMoney, notificationTaxRate, TaxLinesValue } from './notification-values.js';
import { costContainsTax } from './price-display.js';
import type { CostDimension } from './price-display.js';
import { dimensionGrossCents, pricedSessionFromBreakdown } from './pricing-engine.js';
import { storedCostBreakdown } from './session-tax.js';

/** An ended session as the session.Completed and session.Receipt notifications describe it. */
export interface SessionReceiptInput {
  siteName: string | null;
  /** The station's OCPP identity. */
  stationId: string;
  transactionId: string;
  energyDeliveredWh: number;
  finalCostCents: number | null;
  /** The stored split of the cost (charging_sessions.net_cents and tax_cents). */
  netCents: number | null;
  taxCents: number | null;
  /**
   * The stored breakdown (charging_sessions.cost_breakdown). Its tariff and
   * tax lines are shown only when it is for the final cost.
   */
  costBreakdown: unknown;
  /**
   * What the session's payment record collected (payment_records
   * captured_amount_cents of a captured card or prepaid record, top-ups
   * included). Below the final cost when the provider declined the top-up
   * above the hold. Null without a collected payment.
   */
  capturedCents: number | null;
  currency: string;
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

const COLLECTED_STATUSES = new Set(['captured', 'partially_refunded', 'refunded']);

/**
 * What a session's payment record collected, for `capturedCents`: its
 * captured_amount_cents once the payment was captured (a later refund does
 * not change what the receipt says was charged). Null for a record that
 * collected nothing (open, cancelled, failed) and without a record.
 */
export function receiptCapturedCents(status: unknown, capturedAmountCents: unknown): number | null {
  if (typeof status !== 'string' || !COLLECTED_STATUSES.has(status)) return null;
  if (capturedAmountCents == null) return null;
  const cents = Number(capturedAmountCents);
  return Number.isFinite(cents) ? cents : null;
}

/** Receipt line variables and the cost dimension each one shows. */
const RECEIPT_LINES: readonly [string, CostDimension][] = [
  ['energyCostFormatted', 'energyCostCents'],
  ['timeCostFormatted', 'timeCostCents'],
  ['sessionFeeFormatted', 'sessionFeeCents'],
  ['idleCostFormatted', 'idleFeeCents'],
  ['reservationFeeFormatted', 'reservationHoldingFeeCents'],
];

/**
 * The tariff and tax lines of a receipt from the stored breakdown, through
 * the pricing engine (never recomputed). Each line is the gross amount of a
 * cost dimension (tax included, so the lines add up to the total), empty when
 * the session did not bill it or only the total is known. `taxRatePercent` is
 * the rate when all tax was charged at one rate; `taxLinesFormatted` lists the
 * tax per rate when there are several.
 */
function receiptLines(input: SessionReceiptInput, includesTax: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { taxRatePercent: '', taxLinesFormatted: '' };
  for (const [name] of RECEIPT_LINES) out[name] = '';
  const breakdown = storedCostBreakdown({
    costCents: input.finalCostCents,
    costBreakdown: input.costBreakdown,
  });
  if (breakdown == null) return out;
  const priced = pricedSessionFromBreakdown(breakdown);
  const dimensions = dimensionGrossCents(priced);
  if (dimensions != null) {
    for (const [name, dimension] of RECEIPT_LINES) {
      const cents = dimensions[dimension];
      if (cents > 0) out[name] = notificationMoney(cents, input.currency);
    }
  }
  if (!includesTax) return out;
  const taxed = priced.taxLines.filter((line) => line.taxCents > 0);
  const [only] = taxed;
  if (taxed.length === 1 && only != null) out['taxRatePercent'] = notificationTaxRate(only.taxRate);
  if (taxed.length > 1) out['taxLinesFormatted'] = new TaxLinesValue(taxed, input.currency);
  return out;
}

/**
 * The template variables of session.Completed and session.Receipt: the OCPP
 * settlement sends them when a session ends, and the operator re-bill of a
 * session the CSMS gave up ending sends session.Receipt with them.
 *
 * The "incl. tax" label (`costIncludesTax`) and the tax amount come from the
 * tax stored with the cost (charging_sessions.tax_cents), not from a tariff
 * rate, so a session whose tariffs charged no tax never reads "incl. tax".
 * `partiallyPaid` is set when the payment collected less than the final cost
 * (a declined top-up above the hold): `chargedFormatted` is what was charged
 * and `unpaidFormatted` what is still owed.
 */
export function sessionReceiptVariables(input: SessionReceiptInput): Record<string, unknown> {
  const startedAt = new Date(input.startedAt);
  const endedAt = new Date(input.endedAt);
  const includesTax = costContainsTax(input.finalCostCents, input.taxCents);
  const finalCents = input.finalCostCents ?? 0;
  const captured = input.notCharged ? null : input.capturedCents;
  const partiallyPaid = captured != null && captured < finalCents;
  const unpaidCents = partiallyPaid ? finalCents - captured : 0;
  return {
    siteName: input.siteName ?? '',
    stationId: input.stationId,
    transactionId: input.transactionId,
    energyDeliveredWh: input.energyDeliveredWh,
    finalCostCents: input.finalCostCents,
    costFormatted: notificationMoney(finalCents, input.currency),
    costIncludesTax: includesTax,
    taxCents: includesTax ? (input.taxCents ?? 0) : 0,
    taxFormatted: includesTax ? notificationMoney(input.taxCents ?? 0, input.currency) : '',
    netFormatted:
      includesTax && input.netCents != null
        ? notificationMoney(input.netCents, input.currency)
        : '',
    ...receiptLines(input, includesTax),
    partiallyPaid,
    chargedCents: input.notCharged ? 0 : partiallyPaid ? captured : finalCents,
    chargedFormatted: partiallyPaid ? notificationMoney(captured, input.currency) : '',
    unpaidCents,
    unpaidFormatted: partiallyPaid ? notificationMoney(unpaidCents, input.currency) : '',
    currency: input.currency,
    durationMinutes: Math.round((endedAt.getTime() - startedAt.getTime()) / 60000),
    // ISO strings: formatDateVariables formats string dates only, and a raw
    // query row carries postgres text while other callers pass a Date.
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    notCharged: input.notCharged,
    // Templates test `{{#if billedTo}}` for the account wording.
    billingMode: input.billingMode ?? '',
    billedTo: input.billingMode === 'account' ? (input.billedTo ?? '') : '',
  };
}
