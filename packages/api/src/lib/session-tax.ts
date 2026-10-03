// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { parseSessionCostBreakdown, sessionCostTax } from '@evtivity/lib';
import type { SessionCostBreakdown, SessionCostTax } from '@evtivity/lib';

/**
 * A session's stored cost breakdown (charging_sessions.cost_breakdown), when
 * it is for the cost shown (`costCents`, the final cost or else the running
 * cost). Null when there is none or it belongs to another amount, so callers
 * show the total only instead of a split that does not add up.
 */
export function storedCostBreakdown(session: {
  costCents: number | null;
  costBreakdown: unknown;
}): SessionCostBreakdown | null {
  if (session.costCents == null) return null;
  const breakdown = parseSessionCostBreakdown(session.costBreakdown);
  return breakdown != null && breakdown.grossCents === session.costCents ? breakdown : null;
}

/**
 * The net amount and the tax contained in a session's cost, read from its
 * stored breakdown (`sessionCostTax` in `@evtivity/lib/price-display`). Null
 * when the cost contains no tax or no breakdown is stored for it.
 */
export function storedSessionCostTax(session: {
  costCents: number | null;
  costBreakdown: unknown;
}): SessionCostTax | null {
  return sessionCostTax(storedCostBreakdown(session));
}
