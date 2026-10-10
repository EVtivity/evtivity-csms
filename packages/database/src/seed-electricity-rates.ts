// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Seeded electricity rate periods (the operator's wholesale cost, see
// features/electricity-cost.md). Every seeded site gets the same two periods:
// a flat Standard default and a weekday evening peak. A site that already has
// periods is never touched, so an operator's rates survive a seed rerun.

import { sql } from 'drizzle-orm';
import {
  calculateElectricityCostCents,
  deriveElectricityRatePriority,
  resolveElectricityRate,
} from '@evtivity/lib';
import type { ElectricityRatePeriod, ElectricityRatePeriodRestrictions } from '@evtivity/lib';
import type { db as Database } from './config.js';

export interface SeedElectricityRatePeriod {
  name: string;
  ratePerKwh: string;
  restrictions: ElectricityRatePeriodRestrictions | null;
  priority: number;
  isDefault: boolean;
}

const STANDARD_RESTRICTIONS = null;
const WEEKDAY_PEAK_RESTRICTIONS: ElectricityRatePeriodRestrictions = {
  timeRange: { startTime: '16:00', endTime: '21:00' },
  daysOfWeek: [1, 2, 3, 4, 5],
};

export const SEED_ELECTRICITY_RATE_PERIODS: readonly SeedElectricityRatePeriod[] = [
  {
    name: 'Standard',
    ratePerKwh: '0.120000',
    restrictions: STANDARD_RESTRICTIONS,
    priority: deriveElectricityRatePriority(STANDARD_RESTRICTIONS),
    isDefault: true,
  },
  {
    name: 'Weekday Peak',
    ratePerKwh: '0.220000',
    restrictions: WEEKDAY_PEAK_RESTRICTIONS,
    priority: deriveElectricityRatePriority(WEEKDAY_PEAK_RESTRICTIONS),
    isDefault: false,
  },
];

/** Insert rows of the seeded periods for one site (a site created by the seed). */
export function seedElectricityRateRows(
  siteId: string,
): Array<SeedElectricityRatePeriod & { siteId: string }> {
  return SEED_ELECTRICITY_RATE_PERIODS.map((period) => ({ ...period, siteId }));
}

/**
 * Give an existing site the seeded periods when it has none. Returns the number
 * of periods inserted: 0 when the site is missing or already has any period, so
 * operator edits and deletions of single periods are never overwritten.
 */
export async function ensureSiteElectricityRates(
  database: Pick<typeof Database, 'execute'>,
  siteId: string,
): Promise<number> {
  const periods = JSON.stringify(SEED_ELECTRICITY_RATE_PERIODS);
  const inserted = await database.execute(sql`
    INSERT INTO site_electricity_rate_periods
      (site_id, name, rate_per_kwh, restrictions, priority, is_default)
    SELECT ${siteId}, p.name, p."ratePerKwh", p.restrictions, p.priority, p."isDefault"
    FROM jsonb_to_recordset(${periods}::jsonb)
      AS p(name varchar, "ratePerKwh" numeric, restrictions jsonb, priority integer, "isDefault" boolean)
    WHERE EXISTS (SELECT 1 FROM sites WHERE id = ${siteId})
      AND NOT EXISTS (SELECT 1 FROM site_electricity_rate_periods WHERE site_id = ${siteId})
    RETURNING id
  `);
  return inserted.length;
}

/**
 * The operator's electricity cost of a seeded session, the way the session end
 * projection computes it: the site's period in force when the session ended (in
 * the site timezone), priced by the pricing engine. Null when no period applies
 * or no energy was delivered, as the projection leaves the column null then.
 */
export function seedSessionElectricityCostCents(
  periods: ElectricityRatePeriod[],
  energyWh: number,
  endedAt: Date,
  timezone: string | undefined,
): number | null {
  if (energyWh <= 0) return null;
  const rate = resolveElectricityRate(periods, endedAt, timezone);
  if (rate == null) return null;
  return calculateElectricityCostCents(energyWh, rate.ratePerKwh);
}
