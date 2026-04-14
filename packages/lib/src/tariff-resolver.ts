// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TariffRestrictions } from './tariff-restrictions.js';
import { tariffMatchesNow } from './tariff-restrictions.js';

export interface TariffWithRestrictions {
  id: string;
  currency: string;
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
): TariffWithRestrictions | null {
  // Sort by priority descending so highest-priority restrictions are checked first
  const sorted = [...tariffs].sort((a, b) => b.priority - a.priority);

  for (const tariff of sorted) {
    if (tariff.restrictions == null || tariff.priority === 0) {
      continue;
    }
    if (tariffMatchesNow(tariff.restrictions, now, holidays, sessionEnergyKwh)) {
      return tariff;
    }
  }

  // Fall back to the default (priority 0) tariff
  const defaultTariff = sorted.find((t) => t.isDefault && t.priority === 0);
  return defaultTariff ?? null;
}
