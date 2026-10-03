// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, type SQL } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { revenueFromGrossGroups } from '@evtivity/lib';
import type { TaxTotals } from '@evtivity/lib';

/**
 * The one revenue definition. The dashboard, site and station metrics, the
 * revenue and driver activity reports, the dashboard snapshot worker, and the
 * Prometheus revenue gauge all read revenue through queryRevenue, so they
 * agree on what counts.
 *
 * Revenue is what was billed in the company currency, minus refunds:
 *
 * - An ended session: its final cost (final_cost_cents) minus the amount
 *   refunded on its payment record, never below 0. Active sessions (no final
 *   cost yet) are not revenue: their running cost is an estimate. Dated by
 *   the session start, attributed to the session's station.
 * - A reservation fee (cancellation or no-show payment record, captured or
 *   refunded): the amount captured minus the amount refunded. Dated by the
 *   charge, attributed to the reservation's station.
 *
 * Every amount includes tax. A session without a refund counts the net
 * amount and tax stored with its final cost (net_cents, tax_cents, written by
 * the one cost assembly in @evtivity/database session-pricing; exact per
 * tariff segment). A partly refunded session and a fee are split at their
 * rate (revenueFromGrossGroups in @evtivity/lib/price-display): the session
 * at its tariff snapshot rate (tariff_tax_rate), a fee at the rate it was
 * taxed at (payment_records.tax_rate).
 */
function revenueItemsSql(companyCurrency: string): SQL {
  return sql`
    SELECT cs.started_at AS occurred_at,
           cs.station_id,
           st.site_id,
           cs.driver_id,
           coalesce(cs.tariff_tax_rate, 0)::text AS tax_rate,
           greatest(cs.final_cost_cents - coalesce(pr.refunded_amount_cents, 0), 0) AS gross_cents,
           CASE WHEN coalesce(pr.refunded_amount_cents, 0) = 0 AND cs.net_cents IS NOT NULL
                THEN cs.net_cents END AS net_cents,
           CASE WHEN coalesce(pr.refunded_amount_cents, 0) = 0 AND cs.net_cents IS NOT NULL
                THEN cs.tax_cents END AS tax_cents,
           'session'::text AS source
    FROM charging_sessions cs
    JOIN charging_stations st ON st.id = cs.station_id
    LEFT JOIN payment_records pr ON pr.session_id = cs.id
    WHERE cs.final_cost_cents IS NOT NULL
      AND upper(cs.currency) = ${companyCurrency}
    UNION ALL
    SELECT pr.created_at AS occurred_at,
           r.station_id,
           st.site_id,
           pr.driver_id,
           coalesce(pr.tax_rate, 0)::text AS tax_rate,
           greatest(coalesce(pr.captured_amount_cents, 0) - pr.refunded_amount_cents, 0) AS gross_cents,
           NULL::integer AS net_cents,
           NULL::integer AS tax_cents,
           'fee'::text AS source
    FROM payment_records pr
    LEFT JOIN reservations r ON r.id = pr.reservation_id
    LEFT JOIN charging_stations st ON st.id = r.station_id
    WHERE pr.charge_type <> 'session'
      AND pr.status IN ('captured', 'partially_refunded', 'refunded')
      AND upper(pr.currency) = ${companyCurrency}
  `;
}

/**
 * Columns of a revenue item, for the `key` and `where` of queryRevenue:
 * when it happened (session start or fee charge), its station, site, and
 * driver.
 */
export const revenueItem = {
  occurredAt: sql.raw('ri.occurred_at'),
  stationId: sql.raw('ri.station_id'),
  siteId: sql.raw('ri.site_id'),
  driverId: sql.raw('ri.driver_id'),
} as const;

/** Condition: revenue items at one of the sites (an operator's site access). */
export function revenueAtSites(siteIds: readonly string[]): SQL {
  if (siteIds.length === 0) return sql`false`;
  return sql`${revenueItem.siteId} IN (${sql.join(
    siteIds.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

/** Revenue of a group of items, in cents of the company currency. */
export interface RevenueTotals extends TaxTotals {
  /** Ended sessions billed in the company currency. */
  sessionCount: number;
  /** Revenue of those sessions, tax included (grossCents without fees). */
  sessionGrossCents: number;
  /** Billed sessions plus reservation fee charges. */
  itemCount: number;
}

export const EMPTY_REVENUE: RevenueTotals = {
  netCents: 0,
  taxCents: 0,
  grossCents: 0,
  sessionCount: 0,
  sessionGrossCents: 0,
  itemCount: 0,
};

/** Revenue items of one key, tax rate, amount, and source, as the database returns them. */
export interface RevenueRow {
  key: string | null;
  taxRate: string;
  grossCents: number | string;
  /** The stored net amount and tax of the amount, when known (null splits at the rate). */
  netCents?: number | string | null;
  taxCents?: number | string | null;
  source: string;
  count: number | string;
}

/** Revenue per key from grouped revenue rows. */
export function aggregateRevenueRows(
  rows: readonly RevenueRow[],
): Map<string | null, RevenueTotals> {
  const byKey = new Map<string | null, RevenueRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.key);
    if (list == null) byKey.set(row.key, [row]);
    else list.push(row);
  }
  const result = new Map<string | null, RevenueTotals>();
  for (const [key, list] of byKey) {
    const stored = list.filter((r) => r.netCents != null && r.taxCents != null);
    const split = revenueFromGrossGroups(
      list
        .filter((r) => r.netCents == null || r.taxCents == null)
        .map((r) => ({
          taxRate: Number(r.taxRate),
          grossCents: Number(r.grossCents),
          count: Number(r.count),
        })),
    );
    for (const r of stored) {
      const count = Number(r.count);
      split.netCents += Number(r.netCents) * count;
      split.taxCents += Number(r.taxCents) * count;
      split.grossCents += Number(r.grossCents) * count;
    }
    let sessionCount = 0;
    let sessionGrossCents = 0;
    let itemCount = 0;
    for (const r of list) {
      const count = Number(r.count);
      itemCount += count;
      if (r.source === 'session') {
        sessionCount += count;
        sessionGrossCents += Number(r.grossCents) * count;
      }
    }
    result.set(key, { ...split, sessionCount, sessionGrossCents, itemCount });
  }
  return result;
}

/** The sum of several revenue totals. */
export function sumRevenue(totals: Iterable<RevenueTotals>): RevenueTotals {
  const sum = { ...EMPTY_REVENUE };
  for (const t of totals) {
    sum.netCents += t.netCents;
    sum.taxCents += t.taxCents;
    sum.grossCents += t.grossCents;
    sum.sessionCount += t.sessionCount;
    sum.sessionGrossCents += t.sessionGrossCents;
    sum.itemCount += t.itemCount;
  }
  return sum;
}

/**
 * Revenue in the company currency, grouped by `key` (an expression over
 * `revenueItem` columns, such as a day or a site id; omitted for one total
 * under the key null) and filtered by `where` (conditions over the same
 * columns). The map has an entry only for keys with revenue items.
 */
export async function queryRevenue(input: {
  companyCurrency: string;
  key?: SQL | undefined;
  where?: readonly SQL[] | undefined;
}): Promise<Map<string | null, RevenueTotals>> {
  const key = input.key ?? sql`NULL::text`;
  const where =
    input.where != null && input.where.length > 0
      ? sql`WHERE ${sql.join([...input.where], sql` AND `)}`
      : sql``;
  const rows = await db.execute<{
    key: string | null;
    tax_rate: string;
    gross_cents: string | number;
    net_cents: string | number | null;
    tax_cents: string | number | null;
    source: string;
    count: string | number;
  }>(sql`
    SELECT (${key})::text AS key, ri.tax_rate, ri.gross_cents, ri.net_cents, ri.tax_cents,
           ri.source, count(*) AS count
    FROM (${revenueItemsSql(input.companyCurrency)}) AS ri
    ${where}
    GROUP BY 1, 2, 3, 4, 5, 6
  `);
  return aggregateRevenueRows(
    rows.map((r) => ({
      key: r.key,
      taxRate: r.tax_rate,
      grossCents: r.gross_cents,
      netCents: r.net_cents,
      taxCents: r.tax_cents,
      source: r.source,
      count: r.count,
    })),
  );
}

/** queryRevenue without a key: the total. */
export async function queryRevenueTotal(input: {
  companyCurrency: string;
  where?: readonly SQL[] | undefined;
}): Promise<RevenueTotals> {
  const byKey = await queryRevenue(input);
  return byKey.get(null) ?? EMPTY_REVENUE;
}
