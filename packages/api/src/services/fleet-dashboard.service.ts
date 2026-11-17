// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, desc, eq, inArray, lt, gte, or, sql, type SQL } from 'drizzle-orm';
import {
  chargingSessions,
  client,
  db,
  fleets,
  inOperatorStation,
  invoices,
  loadFleetCreditExposure,
} from '@evtivity/database';
import { inCompanyCurrency } from '@evtivity/services/company-currency';
import type { FleetReader } from '../lib/fleet-reader.js';
import { fleetPaidSessionCondition } from '../lib/fleet-scope.js';
import { sessionsAtSites } from '../lib/session-site-scope.js';
import { fillDates, type CalendarDayRange } from '../lib/date-range.js';

/** The latest fleet invoices the dashboard lists. */
export const FLEET_DASHBOARD_INVOICE_LIMIT = 5;

export interface FleetSummaryOptions {
  /** The fleets the summary covers (one picked fleet, or every fleet the reader sees). */
  fleetIds: string[] | 'all';
  range: CalendarDayRange;
  timeZone: string;
  companyCurrency: string;
  /** Costs, the credit limit and invoices (payments:read). */
  money: boolean;
  /** The credit limit and the fleet invoices span every site: all-site operators and fleet users. */
  billing: boolean;
}

export interface FleetSummaryDay {
  date: string;
  sessions: number;
  energyWh: number;
  costCents?: number;
}

/**
 * The sessions of the fleets the reader sees: for an operator the sessions of
 * the fleets' members and RFID cards at its sites, for a fleet user the
 * sessions billed to its fleets on account (every site). The rule of the fleet
 * session list, over a set of fleets.
 */
function fleetsSessionFilter(fleetIds: string[] | 'all', reader: FleetReader): SQL {
  if (reader.kind === 'fleets') {
    const ids = fleetIds === 'all' ? reader.fleetIds : fleetIds;
    return and(
      fleetPaidSessionCondition(ids),
      inOperatorStation(chargingSessions.stationId),
    ) as SQL;
  }
  const members =
    fleetIds === 'all'
      ? sql`${chargingSessions.driverId} IN (select driver_id from fleet_drivers)`
      : sql`${chargingSessions.driverId} IN (select driver_id from fleet_drivers where fleet_id IN ${fleetIds})`;
  const cards =
    fleetIds === 'all'
      ? sql`${chargingSessions.tokenId} IN (select id from driver_tokens where fleet_id IS NOT NULL)`
      : sql`${chargingSessions.tokenId} IN (select id from driver_tokens where fleet_id IN ${fleetIds})`;
  return and(
    or(members, cards),
    inOperatorStation(chargingSessions.stationId),
    reader.siteIds != null ? sessionsAtSites(reader.siteIds) : undefined,
  ) as SQL;
}

/** The fleets a summary of every fleet covers, for the credit limit and invoices. */
async function summaryFleetIds(fleetIds: string[] | 'all', reader: FleetReader): Promise<string[]> {
  if (fleetIds !== 'all') return fleetIds;
  if (reader.kind === 'fleets') return reader.fleetIds;
  const rows = await db.select({ id: fleets.id }).from(fleets);
  return rows.map((r) => r.id);
}

/**
 * What the Dashboard fleet cards and charts show: sessions, energy and (with
 * money) cost over the range per day, the share of the credit limit used and
 * the latest fleet invoices. One reply for every fleet item.
 */
export async function getFleetDashboardSummary(reader: FleetReader, options: FleetSummaryOptions) {
  const { range, timeZone, money } = options;
  const scope = and(
    fleetsSessionFilter(options.fleetIds, reader),
    gte(chargingSessions.startedAt, range.since),
    lt(chargingSessions.startedAt, range.until),
  );
  const cost = sql<
    string | number
  >`coalesce(sum(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents}, 0)) filter (where ${inCompanyCurrency(chargingSessions.currency, options.companyCurrency)}), 0)::bigint`;
  const day = sql<string>`((${chargingSessions.startedAt} AT TIME ZONE ${timeZone})::date)::text`;
  const rows = await db
    .select({
      date: day,
      sessions: sql<string | number>`count(*)::int`,
      energyWh: sql<
        string | number
      >`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)::float8`,
      costCents: cost,
    })
    .from(chargingSessions)
    .where(scope)
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const history: FleetSummaryDay[] = fillDates(
    range.dates,
    rows.map((r) => ({
      date: r.date,
      sessions: Number(r.sessions),
      energyWh: Number(r.energyWh),
      costCents: Number(r.costCents),
    })),
    (date) => ({ date, sessions: 0, energyWh: 0, costCents: 0 }),
  ).map((d) => (money ? d : { date: d.date, sessions: d.sessions, energyWh: d.energyWh }));

  const totals = history.reduce(
    (acc, d) => ({
      sessions: acc.sessions + d.sessions,
      energyWh: acc.energyWh + d.energyWh,
      costCents: acc.costCents + (d.costCents ?? 0),
    }),
    { sessions: 0, energyWh: 0, costCents: 0 },
  );

  const summary: {
    sessionCount: number;
    energyWh: number;
    history: FleetSummaryDay[];
    costCents?: number;
    currency?: string;
    creditLimit?: {
      fleetId: string;
      fleetName: string;
      limitCents: number;
      exposureCents: number;
      usedPercent: number;
      fleetCount: number;
    } | null;
    invoices?: Awaited<ReturnType<typeof latestFleetInvoices>>;
  } = { sessionCount: totals.sessions, energyWh: totals.energyWh, history };
  if (!money) return summary;
  summary.costCents = totals.costCents;
  summary.currency = options.companyCurrency;
  if (!options.billing) return summary;
  const ids = await summaryFleetIds(options.fleetIds, reader);
  summary.creditLimit = await creditLimitUsed(ids);
  summary.invoices = await latestFleetInvoices(ids);
  return summary;
}

/**
 * The credit limit used: of the fleets with a limit, the one that used the
 * largest share of it (its exposure over its limit), named, so the card on
 * every fleet shows the fleet closest to its limit. Null when none has a limit.
 */
async function creditLimitUsed(fleetIds: string[]) {
  if (fleetIds.length === 0) return null;
  const limited = await db
    .select({ id: fleets.id, name: fleets.name, limitCents: fleets.creditLimitCents })
    .from(fleets)
    .where(and(inArray(fleets.id, fleetIds), sql`${fleets.creditLimitCents} IS NOT NULL`));
  if (limited.length === 0) return null;
  const exposures = await Promise.all(limited.map((f) => loadFleetCreditExposure(client, f.id)));
  const shares = limited.map((f, i) => {
    const limitCents = f.limitCents ?? 0;
    const exposureCents = exposures[i]?.totalCents ?? 0;
    return {
      fleetId: f.id,
      fleetName: f.name,
      limitCents,
      exposureCents,
      share: limitCents > 0 ? exposureCents / limitCents : 0,
    };
  });
  // The highest share; a tie goes to the fleet name first in order, so the answer is stable.
  const top = shares.reduce((best, f) =>
    f.share > best.share ||
    (f.share === best.share && f.fleetName.localeCompare(best.fleetName) < 0)
      ? f
      : best,
  );
  return {
    fleetId: top.fleetId,
    fleetName: top.fleetName,
    limitCents: top.limitCents,
    exposureCents: top.exposureCents,
    usedPercent: Math.round(top.share * 1000) / 10,
    fleetCount: limited.length,
  };
}

/** The newest fleet invoices and credit notes of the fleets, never member invoices. */
async function latestFleetInvoices(fleetIds: string[]) {
  if (fleetIds.length === 0) return [];
  return db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      fleetId: invoices.fleetId,
      fleetName: fleets.name,
      kind: invoices.kind,
      status: invoices.status,
      totalCents: invoices.totalCents,
      currency: invoices.currency,
      issuedAt: invoices.issuedAt,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .innerJoin(fleets, eq(invoices.fleetId, fleets.id))
    .where(
      and(
        inArray(invoices.fleetId, fleetIds),
        eq(invoices.memberBilled, false),
        sql`${invoices.status} <> 'draft'`,
      ),
    )
    .orderBy(desc(invoices.createdAt), desc(invoices.id))
    .limit(FLEET_DASHBOARD_INVOICE_LIMIT);
}
