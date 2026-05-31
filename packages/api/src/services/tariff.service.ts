// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, sql } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { tariffs, pricingHolidays, chargingStations, sites } from '@evtivity/database';
import { resolveActiveTariff, isTariffFree as isTariffFreeShared } from '@evtivity/lib';
import type { TariffRestrictions, TariffWithRestrictions } from '@evtivity/lib';

export interface ResolvedTariff {
  id: string;
  name: string;
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

interface ResolvedGroup {
  groupId: string;
  groupName: string;
}

export async function resolveTariffGroup(
  stationUuid: string,
  driverUuid?: string | null,
): Promise<ResolvedGroup | null> {
  // Single round-trip 5-tier resolution: driver > fleet > station > site >
  // default. Each branch is a CTE that emits at most one row with its
  // priority number; the final SELECT joins to pricing_groups for the name,
  // orders by priority, and returns the winner. Replaces five sequential
  // round-trips with one.
  //
  // fleet_drivers has no unique constraint on driverId -- a driver can
  // belong to multiple fleets. ORDER BY fd.created_at picks the oldest
  // membership deterministically.
  const rows = await db.execute<{ group_id: string; group_name: string }>(sql`
    WITH driver_group AS (
      SELECT pgd.pricing_group_id AS id, 1 AS priority
      FROM pricing_group_drivers pgd
      WHERE pgd.driver_id = ${driverUuid ?? ''}
      LIMIT 1
    ),
    fleet_group AS (
      SELECT pgf.pricing_group_id AS id, 2 AS priority
      FROM pricing_group_fleets pgf
      JOIN fleet_drivers fd ON fd.fleet_id = pgf.fleet_id
      WHERE fd.driver_id = ${driverUuid ?? ''}
      ORDER BY fd.created_at ASC
      LIMIT 1
    ),
    station_group AS (
      SELECT pgs.pricing_group_id AS id, 3 AS priority
      FROM pricing_group_stations pgs
      WHERE pgs.station_id = ${stationUuid}
      LIMIT 1
    ),
    site_group AS (
      SELECT pgsit.pricing_group_id AS id, 4 AS priority
      FROM pricing_group_sites pgsit
      JOIN charging_stations cs ON cs.site_id = pgsit.site_id
      WHERE cs.id = ${stationUuid}
      LIMIT 1
    ),
    default_group AS (
      SELECT pg.id, 5 AS priority
      FROM pricing_groups pg
      WHERE pg.is_default = true
      LIMIT 1
    ),
    winner AS (
      SELECT id FROM (
        SELECT id, priority FROM driver_group
        UNION ALL SELECT id, priority FROM fleet_group
        UNION ALL SELECT id, priority FROM station_group
        UNION ALL SELECT id, priority FROM site_group
        UNION ALL SELECT id, priority FROM default_group
      ) groups
      ORDER BY priority
      LIMIT 1
    )
    SELECT pg.id AS group_id, pg.name AS group_name
    FROM winner w
    JOIN pricing_groups pg ON pg.id = w.id
  `);
  const row = rows[0];
  if (row == null) return null;
  return { groupId: row.group_id, groupName: row.group_name };
}

// Holidays change rarely (operators add them in CSMS, then leave them alone)
// but resolveTariff() is called by every portal pricing endpoint hit, every
// authenticated-start request, and the reservation no-show cron. Match the
// 60s TTL cache used by the OCPP event-projection loader so a flurry of
// portal page loads doesn't fan out into one DB roundtrip per request.
let holidayCache: { dates: Date[]; loadedAt: number } | null = null;
const HOLIDAY_CACHE_TTL_MS = 60_000;

async function loadHolidays(): Promise<Date[]> {
  const now = Date.now();
  if (holidayCache != null && now - holidayCache.loadedAt < HOLIDAY_CACHE_TTL_MS) {
    return holidayCache.dates;
  }
  const rows = await db.select({ date: pricingHolidays.date }).from(pricingHolidays);
  const dates = rows.map((r) => new Date(r.date));
  holidayCache = { dates, loadedAt: now };
  return dates;
}

/** Drop the in-process holiday cache. Called from the holidays mutation
 * endpoints so a freshly added or deleted holiday takes effect immediately
 * on the pod that handled the mutation, instead of after the 60s TTL. */
export function clearHolidayCache(): void {
  holidayCache = null;
}

export function isTariffFree(tariff: ResolvedTariff | null): boolean {
  return isTariffFreeShared(tariff);
}

export async function resolveTariff(
  stationUuid: string,
  driverUuid: string | null,
): Promise<ResolvedTariff | null> {
  const group = await resolveTariffGroup(stationUuid, driverUuid);
  if (group == null) return null;

  // Active tariffs, holidays, and site timezone are independent after the
  // group is resolved -- fan them out so dispatch latency is bounded by the
  // slowest single query instead of the sum.
  const [activeTariffs, holidays, siteTzRows] = await Promise.all([
    db
      .select({
        id: tariffs.id,
        name: tariffs.name,
        currency: tariffs.currency,
        pricePerKwh: tariffs.pricePerKwh,
        pricePerMinute: tariffs.pricePerMinute,
        pricePerSession: tariffs.pricePerSession,
        idleFeePricePerMinute: tariffs.idleFeePricePerMinute,
        reservationFeePerMinute: tariffs.reservationFeePerMinute,
        taxRate: tariffs.taxRate,
        restrictions: tariffs.restrictions,
        priority: tariffs.priority,
        isDefault: tariffs.isDefault,
      })
      .from(tariffs)
      .where(and(eq(tariffs.pricingGroupId, group.groupId), eq(tariffs.isActive, true))),
    loadHolidays(),
    db
      .select({ timezone: sites.timezone })
      .from(chargingStations)
      .leftJoin(sites, eq(chargingStations.siteId, sites.id))
      .where(eq(chargingStations.id, stationUuid))
      .limit(1),
  ]);

  if (activeTariffs.length === 0) return null;

  const now = new Date();
  // Resolve in the SITE's timezone so time-of-day and holiday boundaries fire
  // where the driver actually plugs in, not where the server lives. Falls
  // back to server-local time when the station has no site or the site has
  // no timezone column populated.
  const timezone = siteTzRows[0]?.timezone ?? undefined;

  const tariffInputs: TariffWithRestrictions[] = activeTariffs.map((t) => ({
    id: t.id,
    currency: t.currency,
    pricePerKwh: t.pricePerKwh,
    pricePerMinute: t.pricePerMinute,
    pricePerSession: t.pricePerSession,
    idleFeePricePerMinute: t.idleFeePricePerMinute,
    reservationFeePerMinute: t.reservationFeePerMinute,
    taxRate: t.taxRate,
    restrictions: t.restrictions as TariffRestrictions | null,
    priority: t.priority,
    isDefault: t.isDefault,
  }));

  const resolved = resolveActiveTariff(tariffInputs, now, holidays, 0, timezone);
  if (resolved == null) return null;

  const match = activeTariffs.find((t) => t.id === resolved.id);
  if (match == null) return null;

  return {
    id: match.id,
    name: match.name,
    currency: match.currency,
    pricePerKwh: match.pricePerKwh,
    pricePerMinute: match.pricePerMinute,
    pricePerSession: match.pricePerSession,
    idleFeePricePerMinute: match.idleFeePricePerMinute,
    reservationFeePerMinute: match.reservationFeePerMinute,
    taxRate: match.taxRate,
    restrictions: match.restrictions as TariffRestrictions | null,
    priority: match.priority,
    isDefault: match.isDefault,
  };
}
