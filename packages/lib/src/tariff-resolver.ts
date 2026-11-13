// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TariffRestrictions } from './tariff-restrictions.js';
import { tariffMatchesNow } from './tariff-restrictions.js';
import type { TariffContext, TariffScope } from './tariff-scope.js';
import { tariffAppliesTo, tariffSpecificity } from './tariff-scope.js';

/**
 * A tariff as the resolver reads it. `chargingType` and `siteIds` (its
 * scope, `tariff-scope.ts`) default to Both and All Sites.
 */
export interface TariffWithRestrictions extends TariffScope {
  id: string;
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  idleFeePricePerMinute: string | null;
  reservationFeePerMinute: string | null;
  taxRate: string | null;
  restrictions: TariffRestrictions | null;
  priority: number;
  isDefault: boolean;
}

export function resolveActiveTariff(
  tariffs: TariffWithRestrictions[],
  now: Date,
  holidays: Date[],
  sessionEnergyKwh: number,
  /**
   * Site timezone (IANA, e.g. 'America/Los_Angeles'). When provided, time-of-
   * day, day-of-week, date-range, and holiday matching are evaluated in this
   * timezone -- so a station in PT does not flip to off-peak at 03:00 UTC
   * because the server happens to live in UTC. When omitted, the server's
   * local time is used (legacy callers).
   */
  timezone?: string,
  /**
   * The charging kind and site the price is for. Only tariffs whose scope
   * applies are candidates (an unknown kind gets the Both tariffs, an
   * unknown site the All Sites tariffs). Omitted: kind and site unknown.
   */
  context?: TariffContext,
): TariffWithRestrictions | null {
  const sorted = tariffs.filter((t) => tariffAppliesTo(t, context)).sort(compareTariffs);

  for (const tariff of sorted) {
    if (tariff.restrictions == null || tariff.priority === 0) {
      continue;
    }
    if (tariffMatchesNow(tariff.restrictions, now, holidays, sessionEnergyKwh, timezone)) {
      return tariff;
    }
  }

  // Priority 0: an unrestricted AC, DC or Selected Sites tariff in scope
  // (more specific first, owner decision D-A), else the default. The API
  // keeps exactly one active default per group with tariffs (Both, All
  // Sites); a group written before that rule may have none, and the caller
  // then tries the next pricing group.
  return sorted.find((t) => t.priority === 0 && (t.isDefault || tariffSpecificity(t) > 0)) ?? null;
}

/**
 * The order the resolver checks tariffs in: priority descending (highest
 * first); among energy-threshold tariffs (priority 50) the highest threshold
 * first, so the highest threshold the session reached wins; then the more
 * specific scope first (AC or DC before Both, Selected Sites before All
 * Sites, owner decision D-A); then by id, so the result never depends on
 * the order the database returned the rows in.
 */
export function compareTariffs(
  a: Pick<TariffWithRestrictions, 'id' | 'priority' | 'restrictions' | 'chargingType' | 'siteIds'>,
  b: Pick<TariffWithRestrictions, 'id' | 'priority' | 'restrictions' | 'chargingType' | 'siteIds'>,
): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const thresholdA = a.restrictions?.energyThresholdKwh ?? 0;
  const thresholdB = b.restrictions?.energyThresholdKwh ?? 0;
  if (thresholdA !== thresholdB) return thresholdB - thresholdA;
  const specificity = tariffSpecificity(b) - tariffSpecificity(a);
  if (specificity !== 0) return specificity;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
