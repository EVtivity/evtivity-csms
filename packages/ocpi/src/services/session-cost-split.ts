// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Net and tax of a charging session's cost for OCPI Sessions and CDRs.
//
// The amount charged (`final_cost_cents`, or `current_cost_cents` while
// charging) includes tax and is the source of truth: the gross sent to the
// partner always equals it. Its split into net and tax per tax rate, and per
// cost dimension, is the breakdown the one cost assembly
// (@evtivity/database session-pricing) stored with it
// (charging_sessions.cost_breakdown). Nothing is recomputed here. The tax
// math is in @evtivity/lib/price-display.

import {
  chargedCostBreakdown,
  componentTaxLines,
  parseSessionCostBreakdown,
  splitDimensionByTaxLines,
  taxTotals,
} from '@evtivity/lib/price-display';
import type { SessionCostBreakdown, TaxLine } from '@evtivity/lib/price-display';
import { sessionIdleMinutesAt } from '@evtivity/database';
import type { OcpiCdrCost } from '../lib/ocpi-price.js';

/** The `charging_sessions` columns the cost split reads. */
export interface SessionCostSource {
  id: string;
  status: string;
  currentCostCents: number | null;
  finalCostCents: number | null;
  tariffTaxRate: string | null;
  idleStartedAt: Date | null;
  idleMinutes: string;
  costBreakdown: unknown;
}

/** Idle minutes of a session at `at` (sessionIdleMinutesAt of the cost assembly). */
export function idleMinutesAt(session: SessionCostSource, at: Date): number {
  return sessionIdleMinutesAt(
    { idleStartedAt: session.idleStartedAt, idleMinutes: Number(session.idleMinutes) },
    at,
  );
}

/**
 * The stored breakdown of `grossCents`, or, when none is stored for that
 * amount (a cost written outside the cost assembly), the amount split at the
 * session's snapshot tax rate without dimensions.
 */
function breakdownFor(session: SessionCostSource, grossCents: number): SessionCostBreakdown {
  const stored = parseSessionCostBreakdown(session.costBreakdown);
  if (stored != null && stored.grossCents === grossCents) return stored;
  const rate = session.tariffTaxRate != null ? Number(session.tariffTaxRate) : 0;
  return chargedCostBreakdown(grossCents, rate, 'net');
}

/**
 * The cost of a session as OCPI reports it: the final cost once completed,
 * the running cost before. Null when the session has no cost yet.
 */
export function ocpiSessionCost(session: SessionCostSource): TaxLine[] | null {
  const grossCents =
    session.status === 'completed' ? session.finalCostCents : session.currentCostCents;
  if (grossCents == null) return null;
  return breakdownFor(session, grossCents).taxLines;
}

/**
 * The costs of a completed session for its CDR. The total is the final cost.
 * The dimension costs are included when the stored breakdown has its billed
 * components, so they always add up to the final cost.
 */
export function ocpiCdrCost(session: SessionCostSource): OcpiCdrCost {
  const breakdown = breakdownFor(session, session.finalCostCents ?? 0);
  const cost: OcpiCdrCost = { total: breakdown.taxLines };
  const taxLines = componentTaxLines(breakdown);
  if (taxLines == null) return cost;

  const dimensions = [
    ['energy', 'energyCostCents'],
    ['time', 'timeCostCents'],
    ['fixed', 'sessionFeeCents'],
    ['parking', 'idleFeeCents'],
    ['reservation', 'reservationHoldingFeeCents'],
  ] as const;
  for (const [key, dimension] of dimensions) {
    const lines = splitDimensionByTaxLines(taxLines, dimension, breakdown.basis);
    if (taxTotals(lines).netCents !== 0) cost[key] = lines;
  }
  return cost;
}
