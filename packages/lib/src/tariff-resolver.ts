// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TariffRestrictions } from './tariff-restrictions.js';
import { tariffMatchesNow } from './tariff-restrictions.js';

export interface TariffWithRestrictions {
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
): TariffWithRestrictions | null {
  const sorted = [...tariffs].sort(compareTariffs);

  for (const tariff of sorted) {
    if (tariff.restrictions == null || tariff.priority === 0) {
      continue;
    }
    if (tariffMatchesNow(tariff.restrictions, now, holidays, sessionEnergyKwh, timezone)) {
      return tariff;
    }
  }

  // Fall back to the default (priority 0) tariff. The API keeps exactly one
  // active default per group with tariffs; a group written before that rule
  // may have none, and the caller then tries the next pricing group.
  return sorted.find((t) => t.isDefault && t.priority === 0) ?? null;
}

/**
 * The order the resolver checks tariffs in: priority descending (highest
 * first); among energy-threshold tariffs (priority 50) the highest threshold
 * first, so the highest threshold the session reached wins; then by id, so
 * the result never depends on the order the database returned the rows in.
 */
export function compareTariffs(
  a: Pick<TariffWithRestrictions, 'id' | 'priority' | 'restrictions'>,
  b: Pick<TariffWithRestrictions, 'id' | 'priority' | 'restrictions'>,
): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const thresholdA = a.restrictions?.energyThresholdKwh ?? 0;
  const thresholdB = b.restrictions?.energyThresholdKwh ?? 0;
  if (thresholdA !== thresholdB) return thresholdB - thresholdA;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
