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
  // Sort by priority descending so highest-priority restrictions are checked first
  const sorted = [...tariffs].sort((a, b) => b.priority - a.priority);

  for (const tariff of sorted) {
    if (tariff.restrictions == null || tariff.priority === 0) {
      continue;
    }
    if (tariffMatchesNow(tariff.restrictions, now, holidays, sessionEnergyKwh, timezone)) {
      return tariff;
    }
  }

  // Fall back to the default (priority 0) tariff
  const defaultTariff = sorted.find((t) => t.isDefault && t.priority === 0);
  return defaultTariff ?? null;
}
