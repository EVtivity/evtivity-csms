// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  netFromGross,
  parseSessionCostBreakdown,
  reconcileCostBreakdown,
} from './price-display.js';
import type { SessionCostBreakdown } from './price-display.js';

/**
 * How an amount charged is split into net and tax: the session's stored cost
 * split (charging_sessions.cost_breakdown, exact per tariff segment), or the
 * one rate it was taxed at (a fraction, 0.19) for a fee or a session without
 * a stored split.
 */
export type ChargeTax = number | SessionCostBreakdown;

/**
 * The tax of a session's charges: its stored cost split when it is for the
 * final cost, else its tariff snapshot rate.
 */
export function sessionChargeTax(session: {
  finalCostCents: number | null;
  tariffTaxRate: string | number | null;
  costBreakdown: unknown;
}): ChargeTax {
  const breakdown = parseSessionCostBreakdown(session.costBreakdown);
  if (breakdown != null && breakdown.grossCents === session.finalCostCents) return breakdown;
  return Number(session.tariffTaxRate ?? 0);
}

/**
 * The net amount in `grossCents`. With a stored split: its net for the whole
 * amount, else the split reconciled to the part charged (shared over the
 * rates in proportion to their gross).
 */
export function netOfCharge(grossCents: number, tax: ChargeTax): number {
  if (typeof tax === 'number') return netFromGross(grossCents, tax);
  if (grossCents === tax.grossCents) return tax.netCents;
  return reconcileCostBreakdown(tax, grossCents, 0).netCents;
}

/**
 * Stripe Connect platform fee (application_fee_amount): a percent of the net
 * amount actually charged, tax excluded. Tax is owed to the tax authority, so
 * the platform takes no share of it. The fee is computed when the amount is
 * known (capture, top-up, a fee charge), never on a pre-authorization hold.
 *
 * `grossCents` is the amount charged with tax included and `tax` how it
 * splits (netOfCharge: the session's stored split, or one rate). `feePercent`
 * is 0 to 100.
 */
export function platformFeeCents(grossCents: number, tax: ChargeTax, feePercent: number): number {
  if (!(feePercent > 0) || !(grossCents > 0)) return 0;
  const fee = Math.round((netOfCharge(grossCents, tax) * feePercent) / 100);
  return Math.min(fee, grossCents);
}

/**
 * Fee for raising the amount charged on a session from `chargedBeforeCents` to
 * `chargedAfterCents`: a capture after nothing, a top-up after a capture, a
 * retried top-up after a partial capture. The fees of successive charges add
 * up to platformFeeCents of the total, whatever the split, so the platform
 * earns the same on a session paid in one capture or in a capture plus a
 * top-up. Never negative and never more than the increment itself.
 */
export function incrementalPlatformFeeCents(
  chargedBeforeCents: number,
  chargedAfterCents: number,
  tax: ChargeTax,
  feePercent: number,
): number {
  const increment = chargedAfterCents - chargedBeforeCents;
  if (increment <= 0) return 0;
  const fee =
    platformFeeCents(chargedAfterCents, tax, feePercent) -
    platformFeeCents(chargedBeforeCents, tax, feePercent);
  return Math.min(Math.max(fee, 0), increment);
}
