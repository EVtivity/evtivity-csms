// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, asc, count, eq, gt, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  loadElectricityRatePeriodsForSite,
  sites,
} from '@evtivity/database';
import { computeSessionElectricityCost } from '@evtivity/lib';
import { inCompanyCurrency } from './company-currency.js';

// Electricity cost of sessions that ended without one (features/electricity-cost.md,
// "Recalculate"). The one writer of charging_sessions.electricity_cost_cents
// after session end: it fills a missing cost from the site's current rate
// periods through computeSessionElectricityCost, the computation the session
// end projection uses, and never overwrites a cost.

/** Sessions read and written per statement. */
export const RECALCULATE_CHUNK_SIZE = 500;
/**
 * Costs written per call at most. A call returns `remaining`, so a caller
 * repeats it for a site with more sessions; each call stays short.
 */
export const RECALCULATE_MAX_UPDATES = 5000;

/**
 * Condition on charging_sessions: the sessions the revenue definition marks
 * cost missing (session-revenue.ts): a billed session (it has a final cost) in
 * the company currency, not an account session still unpaid, that delivered
 * energy and has no electricity cost. The dashboard notice counts these, the
 * sessions list filter (`costMissing=true`) shows them and the recalculation
 * fills them, so the three agree.
 */
export function sessionCostMissing(companyCurrency: string): SQL {
  return and(
    isNotNull(chargingSessions.finalCostCents),
    inCompanyCurrency(chargingSessions.currency, companyCurrency),
    isNull(chargingSessions.electricityCostCents),
    sql`coalesce(${chargingSessions.energyDeliveredWh}, 0) > 0`,
    // Billed on account and not paid yet: not revenue, so not cost missing.
    sql`NOT (${chargingSessions.billingMode} IS NOT DISTINCT FROM 'account'
      AND ${chargingSessions.finalCostCents} > 0
      AND NOT EXISTS (SELECT 1 FROM payment_records pr WHERE pr.session_id = ${chargingSessions.id})
      AND NOT EXISTS (SELECT 1 FROM invoices inv
                      WHERE inv.id = ${chargingSessions.invoiceId} AND inv.status = 'paid'))`,
  ) as SQL;
}

/** Sessions at the site without an electricity cost (sessionCostMissing). */
export async function countSiteCostMissingSessions(
  siteId: string,
  companyCurrency: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .where(and(eq(chargingStations.siteId, siteId), sessionCostMissing(companyCurrency)));
  return row?.n ?? 0;
}

export interface RecalculateElectricityCostResult {
  /** Sessions without an electricity cost before the call. */
  before: number;
  /** Sessions that got an electricity cost in this call. */
  updated: number;
  /**
   * Sessions still without an electricity cost: more than one call writes, or
   * no rate period matches their end time.
   */
  remaining: number;
}

/**
 * Fills the electricity cost of the site's billed sessions that have none
 * (sessionCostMissing), from the site's current rate periods at each session's
 * end time in the site timezone. Never overwrites a cost (the UPDATE is guarded
 * by `electricity_cost_cents IS NULL`), so a rerun or a concurrent call writes
 * each cost once. Reads and writes in chunks of `chunkSize`, by id, and stops
 * after `maxUpdates` costs.
 */
export async function recalculateSiteElectricityCost(
  siteId: string,
  options: { companyCurrency: string; chunkSize?: number; maxUpdates?: number },
): Promise<RecalculateElectricityCostResult> {
  const chunkSize = options.chunkSize ?? RECALCULATE_CHUNK_SIZE;
  const maxUpdates = options.maxUpdates ?? RECALCULATE_MAX_UPDATES;
  const missing = sessionCostMissing(options.companyCurrency);

  const before = await countSiteCostMissingSessions(siteId, options.companyCurrency);
  if (before === 0) return { before, updated: 0, remaining: 0 };

  // The operator may have just edited the rates: read them without the cache.
  const [periods, [site]] = await Promise.all([
    loadElectricityRatePeriodsForSite(siteId),
    db.select({ timezone: sites.timezone }).from(sites).where(eq(sites.id, siteId)),
  ]);
  if (periods.length === 0 || site == null) return { before, updated: 0, remaining: before };

  let updated = 0;
  let cursor: string | null = null;
  while (updated < maxUpdates) {
    const rows = await db
      .select({
        id: chargingSessions.id,
        endedAt: chargingSessions.endedAt,
        energyWh: chargingSessions.energyDeliveredWh,
      })
      .from(chargingSessions)
      .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
      .where(
        and(
          eq(chargingStations.siteId, siteId),
          missing,
          isNotNull(chargingSessions.endedAt),
          cursor != null ? gt(chargingSessions.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(chargingSessions.id))
      .limit(chunkSize);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]?.id ?? cursor;

    const costs: SQL[] = [];
    for (const row of rows) {
      if (row.endedAt == null || costs.length >= maxUpdates - updated) continue;
      const cost = computeSessionElectricityCost({
        periods,
        endedAt: row.endedAt,
        energyWh: Number(row.energyWh ?? 0),
        timezone: site.timezone,
      });
      if (cost.costCents != null) costs.push(sql`(${row.id}::text, ${cost.costCents}::integer)`);
    }
    if (costs.length > 0) {
      const written = await db.execute(sql`
        UPDATE charging_sessions cs
        SET electricity_cost_cents = v.cost, updated_at = now()
        FROM (VALUES ${sql.join(costs, sql`, `)}) AS v(id, cost)
        WHERE cs.id = v.id AND cs.electricity_cost_cents IS NULL
        RETURNING cs.id
      `);
      updated += written.length;
    }
    if (rows.length < chunkSize) break;
  }

  const remaining = await countSiteCostMissingSessions(siteId, options.companyCurrency);
  return { before, updated, remaining };
}
