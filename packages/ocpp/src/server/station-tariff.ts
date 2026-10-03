// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { resolveActiveTariff } from '@evtivity/lib';
import type { TariffRestrictions, TariffWithRestrictions } from '@evtivity/lib';

/** The tariff a session at a station is priced with, as the cost calculator takes it. */
export interface StationTariff {
  id: string;
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  idleFeePricePerMinute: string | null;
  reservationFeePerMinute: string | null;
  taxRate: string | null;
}

const HOLIDAY_CACHE_TTL_MS = 60_000;
let holidayCache: { dates: Date[]; loadedAt: number } | null = null;

/** Pricing holidays, cached for 60 seconds. */
export async function loadPricingHolidays(sql: postgres.Sql): Promise<Date[]> {
  const now = Date.now();
  if (holidayCache != null && now - holidayCache.loadedAt < HOLIDAY_CACHE_TTL_MS) {
    return holidayCache.dates;
  }
  const rows = await sql`SELECT date FROM pricing_holidays`;
  const dates = rows.map((r) => new Date(r.date as string));
  holidayCache = { dates, loadedAt: now };
  return dates;
}

export function clearPricingHolidayCache(): void {
  holidayCache = null;
}

/**
 * The pricing group of a session in one round trip: driver > fleet > station >
 * site > default. A driver can belong to several fleets; the oldest membership
 * wins so the same driver and station always resolve to the same group.
 */
export async function resolvePricingGroupId(
  sql: postgres.Sql,
  stationUuid: string,
  driverUuid: string | null,
): Promise<string | null> {
  const rows = await sql`
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
    )
    SELECT id FROM (
      SELECT id, priority FROM driver_group
      UNION ALL SELECT id, priority FROM fleet_group
      UNION ALL SELECT id, priority FROM station_group
      UNION ALL SELECT id, priority FROM site_group
      UNION ALL SELECT id, priority FROM default_group
    ) groups
    ORDER BY priority
    LIMIT 1
  `;
  return (rows[0]?.id as string | undefined) ?? null;
}

/**
 * The tariff that applies now to a driver at a station: the pricing group's
 * tariff whose restrictions (time of day, day of week, dates, holidays) match
 * in the site's timezone, else the group's default tariff. Session pricing and
 * the OCPP 2.1 Authorize tariff both use it, so the driver is shown the price
 * the session is billed at.
 */
export async function resolveStationTariff(
  sql: postgres.Sql,
  stationUuid: string,
  driverUuid: string | null,
  now: Date = new Date(),
): Promise<StationTariff | null> {
  const groupId = await resolvePricingGroupId(sql, stationUuid, driverUuid);
  if (groupId == null) return null;

  const rows = await sql`
    SELECT id, price_per_kwh, price_per_minute, price_per_session,
           idle_fee_price_per_minute, reservation_fee_per_minute, tax_rate,
           restrictions, priority, is_default
    FROM tariffs
    WHERE pricing_group_id = ${groupId} AND is_active = true
  `;
  if (rows.length === 0) return null;

  const tariffs: TariffWithRestrictions[] = rows.map((r) => ({
    id: r.id as string,
    pricePerKwh: r.price_per_kwh as string | null,
    pricePerMinute: r.price_per_minute as string | null,
    pricePerSession: r.price_per_session as string | null,
    idleFeePricePerMinute: r.idle_fee_price_per_minute as string | null,
    reservationFeePerMinute: r.reservation_fee_per_minute as string | null,
    taxRate: r.tax_rate as string | null,
    restrictions: r.restrictions as TariffRestrictions | null,
    priority: r.priority as number,
    isDefault: r.is_default as boolean,
  }));

  const holidays = await loadPricingHolidays(sql);
  const tzRows = await sql<Array<{ timezone: string | null }>>`
    SELECT s.timezone
    FROM charging_stations cs
    LEFT JOIN sites s ON s.id = cs.site_id
    WHERE cs.id = ${stationUuid}
    LIMIT 1
  `;
  const timezone = tzRows[0]?.timezone ?? undefined;
  const resolved = resolveActiveTariff(tariffs, now, holidays, 0, timezone);
  if (resolved == null) return null;

  return {
    id: resolved.id,
    pricePerKwh: resolved.pricePerKwh,
    pricePerMinute: resolved.pricePerMinute,
    pricePerSession: resolved.pricePerSession,
    idleFeePricePerMinute: resolved.idleFeePricePerMinute,
    reservationFeePerMinute: resolved.reservationFeePerMinute,
    taxRate: resolved.taxRate,
  };
}
