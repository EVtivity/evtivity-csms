// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { isTariffFree, resolveActiveTariff } from '@evtivity/lib';
import type { TariffRestrictions, TariffWithRestrictions } from '@evtivity/lib';
import type { TariffPriceSnapshot } from './session-pricing.js';

/**
 * The one tariff resolver. OCPP (session pricing, the 2.1 Authorize tariff),
 * the API (portal pricing, starts, station messages, reservation fees, the
 * pricing pages) and the worker (tariff boundary job, no-show fees) all
 * resolve a station's tariff here, so a driver is shown and charged the same
 * price everywhere.
 *
 * Every function takes the caller's postgres client (the shared `client` of
 * @evtivity/database in production), like session-pricing.
 *
 * Group order: driver > fleet (oldest membership) > station > site > default.
 * Within the group, the active tariff whose restrictions match at the given
 * time in the site's timezone wins, else the group's default tariff
 * (resolveActiveTariff in @evtivity/lib).
 */

export type PricingGroupSource = 'driver' | 'fleet' | 'station' | 'site' | 'default';

export interface ResolvedPricingGroup {
  id: string;
  name: string;
  source: PricingGroupSource;
}

/** An active tariff of a pricing group, with its display name. */
export type GroupTariff = TariffWithRestrictions & { name: string };

/** The tariff that applies to a driver at a station at a time. */
export interface StationTariff extends TariffPriceSnapshot {
  name: string;
  restrictions: TariffRestrictions | null;
  priority: number;
  isDefault: boolean;
  pricingGroup: ResolvedPricingGroup;
  /** Site timezone the restrictions were evaluated in (null = server local time). */
  timezone: string | null;
}

/** A station's pricing group, its active tariffs and the site timezone. */
export interface StationPricing {
  group: ResolvedPricingGroup;
  timezone: string | null;
  tariffs: GroupTariff[];
}

export interface TariffQuery {
  stationUuid: string;
  driverUuid: string | null;
  /** Default: now. */
  at?: Date;
  /**
   * Energy the session has delivered so far, in kWh, for energy-threshold
   * restrictions. Default 0.
   */
  sessionEnergyKwh?: number;
}

const SOURCES: Record<number, PricingGroupSource> = {
  1: 'driver',
  2: 'fleet',
  3: 'station',
  4: 'site',
  5: 'default',
};

interface PricingRow {
  group_id: string;
  group_name: string;
  group_priority: number;
  timezone: string | null;
  id: string | null;
  name: string | null;
  price_per_kwh: string | null;
  price_per_minute: string | null;
  price_per_session: string | null;
  idle_fee_price_per_minute: string | null;
  reservation_fee_per_minute: string | null;
  tax_rate: string | null;
  restrictions: TariffRestrictions | null;
  priority: number | null;
  is_default: boolean | null;
}

function toGroupTariff(r: {
  id: string;
  name: string | null;
  price_per_kwh: string | null;
  price_per_minute: string | null;
  price_per_session: string | null;
  idle_fee_price_per_minute: string | null;
  reservation_fee_per_minute: string | null;
  tax_rate: string | null;
  restrictions: TariffRestrictions | null;
  priority: number | null;
  is_default: boolean | null;
}): GroupTariff {
  return {
    id: r.id,
    name: r.name ?? '',
    pricePerKwh: r.price_per_kwh,
    pricePerMinute: r.price_per_minute,
    pricePerSession: r.price_per_session,
    idleFeePricePerMinute: r.idle_fee_price_per_minute,
    reservationFeePerMinute: r.reservation_fee_per_minute,
    taxRate: r.tax_rate,
    restrictions: r.restrictions ?? null,
    priority: r.priority ?? 0,
    isDefault: r.is_default === true,
  };
}

/**
 * The station's pricing group (for the driver, when given), its active
 * tariffs and the site timezone, in one round trip. Null when no group
 * applies. A group without active tariffs has `tariffs: []`.
 *
 * fleet_drivers has no unique constraint on driver_id (a driver can belong to
 * several fleets): the oldest membership wins, so the same driver and station
 * always resolve to the same group.
 */
export async function loadStationPricing(
  q: Pick<TariffQuery, 'stationUuid' | 'driverUuid'>,
  sql: postgres.Sql,
): Promise<StationPricing | null> {
  const driverUuid = q.driverUuid ?? '';
  const rows = await sql<PricingRow[]>`
    WITH driver_group AS (
      SELECT pgd.pricing_group_id AS id, 1 AS priority
      FROM pricing_group_drivers pgd
      WHERE pgd.driver_id = ${driverUuid}
      LIMIT 1
    ),
    fleet_group AS (
      SELECT pgf.pricing_group_id AS id, 2 AS priority
      FROM pricing_group_fleets pgf
      JOIN fleet_drivers fd ON fd.fleet_id = pgf.fleet_id
      WHERE fd.driver_id = ${driverUuid}
      ORDER BY fd.created_at ASC, fd.id ASC
      LIMIT 1
    ),
    station_group AS (
      SELECT pgs.pricing_group_id AS id, 3 AS priority
      FROM pricing_group_stations pgs
      WHERE pgs.station_id = ${q.stationUuid}
      LIMIT 1
    ),
    site_group AS (
      SELECT pgsit.pricing_group_id AS id, 4 AS priority
      FROM pricing_group_sites pgsit
      JOIN charging_stations cs ON cs.site_id = pgsit.site_id
      WHERE cs.id = ${q.stationUuid}
      LIMIT 1
    ),
    default_group AS (
      SELECT pg.id, 5 AS priority
      FROM pricing_groups pg
      WHERE pg.is_default = true
      LIMIT 1
    ),
    winner AS (
      SELECT id, priority FROM (
        SELECT id, priority FROM driver_group
        UNION ALL SELECT id, priority FROM fleet_group
        UNION ALL SELECT id, priority FROM station_group
        UNION ALL SELECT id, priority FROM site_group
        UNION ALL SELECT id, priority FROM default_group
      ) groups
      ORDER BY priority
      LIMIT 1
    )
    SELECT pg.id AS group_id, pg.name AS group_name, w.priority AS group_priority,
           tz.timezone,
           t.id, t.name, t.price_per_kwh, t.price_per_minute, t.price_per_session,
           t.idle_fee_price_per_minute, t.reservation_fee_per_minute, t.tax_rate,
           t.restrictions, t.priority, t.is_default
    FROM winner w
    JOIN pricing_groups pg ON pg.id = w.id
    LEFT JOIN LATERAL (
      SELECT s.timezone
      FROM charging_stations cs
      LEFT JOIN sites s ON s.id = cs.site_id
      WHERE cs.id = ${q.stationUuid}
      LIMIT 1
    ) tz ON true
    LEFT JOIN tariffs t ON t.pricing_group_id = pg.id AND t.is_active = true
  `;
  const first = rows[0];
  if (first == null) return null;
  return {
    group: {
      id: first.group_id,
      name: first.group_name,
      source: SOURCES[first.group_priority] ?? 'default',
    },
    timezone: first.timezone ?? null,
    tariffs: rows.flatMap((r) => (r.id != null ? [toGroupTariff({ ...r, id: r.id })] : [])),
  };
}

/**
 * The tariff that applies to the driver at the station at `at` (default now),
 * evaluated in the site timezone. Null when no group applies, the group has no
 * active tariff, or no tariff matches and the group has no default.
 */
export async function resolveStationTariff(
  q: TariffQuery,
  sql: postgres.Sql,
): Promise<StationTariff | null> {
  const pricing = await loadStationPricing(q, sql);
  if (pricing == null || pricing.tariffs.length === 0) return null;
  const holidays = await getPricingHolidays(sql);
  const current = resolveActiveTariff(
    pricing.tariffs,
    q.at ?? new Date(),
    holidays,
    q.sessionEnergyKwh ?? 0,
    pricing.timezone ?? undefined,
  );
  if (current == null) return null;
  const match = pricing.tariffs.find((t) => t.id === current.id);
  if (match == null) return null;
  return {
    id: match.id,
    name: match.name,
    pricePerKwh: match.pricePerKwh,
    pricePerMinute: match.pricePerMinute,
    pricePerSession: match.pricePerSession,
    idleFeePricePerMinute: match.idleFeePricePerMinute,
    reservationFeePerMinute: match.reservationFeePerMinute,
    taxRate: match.taxRate,
    restrictions: match.restrictions,
    priority: match.priority,
    isDefault: match.isDefault,
    pricingGroup: pricing.group,
    timezone: pricing.timezone,
  };
}

/**
 * Every active tariff of a pricing group, and the one that applies at `at`
 * (in `timezone` when given, else server local time). The pricing pages use
 * it for the schedule and a station's active tariff.
 */
export async function resolveGroupTariffs(
  groupId: string,
  opts: { at: Date; timezone?: string | null; sessionEnergyKwh?: number },
  sql: postgres.Sql,
): Promise<{ tariffs: GroupTariff[]; current: GroupTariff | null }> {
  const rows = await sql<
    Array<{
      id: string;
      name: string | null;
      price_per_kwh: string | null;
      price_per_minute: string | null;
      price_per_session: string | null;
      idle_fee_price_per_minute: string | null;
      reservation_fee_per_minute: string | null;
      tax_rate: string | null;
      restrictions: TariffRestrictions | null;
      priority: number | null;
      is_default: boolean | null;
    }>
  >`
    SELECT id, name, price_per_kwh, price_per_minute, price_per_session,
           idle_fee_price_per_minute, reservation_fee_per_minute, tax_rate,
           restrictions, priority, is_default
    FROM tariffs
    WHERE pricing_group_id = ${groupId} AND is_active = true
  `;
  const tariffs = rows.map(toGroupTariff);
  return { tariffs, current: pickTariff(tariffs, opts, await getPricingHolidays(sql)) };
}

/** The tariff of `tariffs` that applies at `opts.at`. */
export function pickTariff(
  tariffs: GroupTariff[],
  opts: { at: Date; timezone?: string | null; sessionEnergyKwh?: number },
  holidays: Date[],
): GroupTariff | null {
  if (tariffs.length === 0) return null;
  const current = resolveActiveTariff(
    tariffs,
    opts.at,
    holidays,
    opts.sessionEnergyKwh ?? 0,
    opts.timezone ?? undefined,
  );
  return current == null ? null : (tariffs.find((t) => t.id === current.id) ?? null);
}

/**
 * Whether charging at the station is free for the driver: the site has free
 * vend (checked first, no tariff lookup), or no tariff applies, or every
 * price component of the tariff is zero. The reservation holding fee counts
 * only for the holder of the reservation (`reserved`).
 */
export async function isStationChargingFree(
  q: TariffQuery & { reserved: boolean; freeVend: boolean },
  sql: postgres.Sql,
): Promise<boolean> {
  if (q.freeVend) return true;
  return isTariffFree(await resolveStationTariff(q, sql), { reserved: q.reserved });
}

/** What prices a driver at every station, for display next to the billing fleet. */
export type DriverPricingSource =
  | { source: 'driver'; pricingGroupId: string; pricingGroupName: string }
  | {
      source: 'fleet';
      fleetId: string;
      fleetName: string;
      pricingGroupId: string;
      pricingGroupName: string;
    };

/**
 * The driver steps of loadStationPricing: a driver pricing group wins, else
 * the fleet of the oldest membership in a fleet with a pricing group (same
 * order and tie-break as loadStationPricing). Null when neither applies (the
 * station, site or default group prices the driver).
 */
export async function resolveDriverPricingSource(
  sql: postgres.Sql,
  driverId: string,
): Promise<DriverPricingSource | null> {
  const rows = await sql<
    Array<{
      source: 'driver' | 'fleet';
      fleet_id: string | null;
      fleet_name: string | null;
      group_id: string;
      group_name: string;
    }>
  >`
    WITH driver_group AS (
      SELECT 'driver'::text AS source, NULL::text AS fleet_id, NULL::text AS fleet_name,
             pgd.pricing_group_id AS group_id, 1 AS priority
      FROM pricing_group_drivers pgd
      WHERE pgd.driver_id = ${driverId}
      LIMIT 1
    ),
    fleet_group AS (
      SELECT 'fleet'::text AS source, f.id AS fleet_id, f.name AS fleet_name,
             pgf.pricing_group_id AS group_id, 2 AS priority
      FROM pricing_group_fleets pgf
      JOIN fleet_drivers fd ON fd.fleet_id = pgf.fleet_id
      JOIN fleets f ON f.id = pgf.fleet_id
      WHERE fd.driver_id = ${driverId}
      ORDER BY fd.created_at ASC, fd.id ASC
      LIMIT 1
    )
    SELECT s.source, s.fleet_id, s.fleet_name, s.group_id, pg.name AS group_name
    FROM (SELECT * FROM driver_group UNION ALL SELECT * FROM fleet_group) s
    JOIN pricing_groups pg ON pg.id = s.group_id
    ORDER BY s.priority
    LIMIT 1
  `;
  const row = rows[0];
  if (row == null) return null;
  if (row.source === 'fleet' && row.fleet_id != null) {
    return {
      source: 'fleet',
      fleetId: row.fleet_id,
      fleetName: row.fleet_name ?? '',
      pricingGroupId: row.group_id,
      pricingGroupName: row.group_name,
    };
  }
  return { source: 'driver', pricingGroupId: row.group_id, pricingGroupName: row.group_name };
}

const HOLIDAY_TTL_MS = 60_000;
let holidayCache: { dates: Date[]; loadedAt: number } | null = null;

/**
 * Pricing holidays, cached for 60 seconds per process. The holidays routes
 * clear the cache of the API pod that handled the change; other processes
 * pick it up within the TTL.
 */
export async function getPricingHolidays(sql: postgres.Sql): Promise<Date[]> {
  const now = Date.now();
  if (holidayCache != null && now - holidayCache.loadedAt < HOLIDAY_TTL_MS) {
    return holidayCache.dates;
  }
  const rows = await sql<Array<{ date: string | Date }>>`SELECT date FROM pricing_holidays`;
  const dates = rows.map((r) => new Date(r.date));
  holidayCache = { dates, loadedAt: now };
  return dates;
}

/** Drop the cached pricing holidays (after a holiday is added or deleted). */
export function clearTariffResolutionCache(): void {
  holidayCache = null;
}
