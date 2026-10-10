// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { DEFAULT_TIMEZONE, isTariffFree, resolveActiveTariff } from '@evtivity/lib';
import type { TariffRestrictions, TariffWithRestrictions } from '@evtivity/lib';
import type { TariffPriceSnapshot } from './session-pricing.js';
import { isSplitBillingEnabled } from './pricing-settings.js';

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
 * Within a group, the active tariff whose restrictions match at the given
 * time in the site's timezone wins, else the group's default tariff
 * (resolveActiveTariff in @evtivity/lib). A group without a tariff that
 * applies passes to the next group.
 */

/**
 * Where the pricing group came from: an assignment step of the chain, or
 * `session`, the group a running session snapshotted at its start.
 */
export type PricingGroupSource = 'driver' | 'fleet' | 'station' | 'site' | 'default' | 'session';

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
  /**
   * Timezone the restrictions were evaluated in: the site's, or the
   * system.timezone setting for a station without a site (finding B22).
   */
  timezone: string;
}

/**
 * A station's pricing group, its active tariffs and the timezone its time
 * restrictions are evaluated in: the site's, else the system.timezone
 * setting (a station without a site), as the pricing schedule endpoint does.
 */
export interface StationPricing {
  group: ResolvedPricingGroup;
  timezone: string;
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
  /**
   * Resolve only within this pricing group (the group a running session
   * snapshotted at its start, charging_sessions.pricing_group_id).
   */
  pricingGroupId?: string | null;
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
  timezone: string;
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
 * The pricing groups that apply to the driver at the station, in resolution
 * order (driver > fleet > station > site > default), each with its active
 * tariffs, and the timezone (the site's, else system.timezone), in one round
 * trip. A group that appears at
 * two steps is listed once, at the first. A group without active tariffs is
 * listed with `tariffs: []`.
 *
 * fleet_drivers has no unique constraint on driver_id (a driver can belong to
 * several fleets): the oldest membership wins, so the same driver and station
 * always resolve to the same group.
 */
export async function loadStationPricingChain(
  q: Pick<TariffQuery, 'stationUuid' | 'driverUuid'>,
  sql: postgres.Sql,
): Promise<StationPricing[]> {
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
    chain AS (
      SELECT id, priority FROM driver_group
      UNION ALL SELECT id, priority FROM fleet_group
      UNION ALL SELECT id, priority FROM station_group
      UNION ALL SELECT id, priority FROM site_group
      UNION ALL SELECT id, priority FROM default_group
    )
    SELECT pg.id AS group_id, pg.name AS group_name, c.priority AS group_priority,
           COALESCE(tz.timezone, sys_tz.timezone, ${DEFAULT_TIMEZONE}) AS timezone,
           t.id, t.name, t.price_per_kwh, t.price_per_minute, t.price_per_session,
           t.idle_fee_price_per_minute, t.reservation_fee_per_minute, t.tax_rate,
           t.restrictions, t.priority, t.is_default
    FROM chain c
    JOIN pricing_groups pg ON pg.id = c.id
    LEFT JOIN LATERAL (
      SELECT s.timezone
      FROM charging_stations cs
      LEFT JOIN sites s ON s.id = cs.site_id
      WHERE cs.id = ${q.stationUuid}
      LIMIT 1
    ) tz ON true
    LEFT JOIN LATERAL (
      SELECT value #>> '{}' AS timezone
      FROM settings
      WHERE key = 'system.timezone' AND jsonb_typeof(value) = 'string'
    ) sys_tz ON true
    LEFT JOIN tariffs t ON t.pricing_group_id = pg.id AND t.is_active = true
    ORDER BY c.priority, t.id
  `;
  return groupRows(rows);
}

/** Rows of loadStationPricingChain (ordered by step) as one entry per group. */
function groupRows(rows: PricingRow[]): StationPricing[] {
  const chain: StationPricing[] = [];
  const stepOf = new Map<string, number>();
  for (const r of rows) {
    const step = stepOf.get(r.group_id);
    if (step != null && step !== r.group_priority) continue;
    let entry = chain.find((p) => p.group.id === r.group_id);
    if (entry == null) {
      stepOf.set(r.group_id, r.group_priority);
      entry = {
        group: {
          id: r.group_id,
          name: r.group_name,
          source: SOURCES[r.group_priority] ?? 'default',
        },
        timezone: r.timezone,
        tariffs: [],
      };
      chain.push(entry);
    }
    if (r.id != null) entry.tariffs.push(toGroupTariff({ ...r, id: r.id }));
  }
  return chain;
}

/**
 * The first pricing group of the chain with active tariffs (null when none
 * has one). Callers that list a group's tariffs (OCPI connector tariffs, the
 * station's active tariff page) use it; billing resolves through the whole
 * chain (resolveStationTariff).
 */
export async function loadStationPricing(
  q: Pick<TariffQuery, 'stationUuid' | 'driverUuid'>,
  sql: postgres.Sql,
): Promise<StationPricing | null> {
  const chain = await loadStationPricingChain(q, sql);
  return chain.find((p) => p.tariffs.length > 0) ?? null;
}

/**
 * One pricing group with its active tariffs and the station's timezone (the
 * site's, else system.timezone):
 * the group a session snapshotted at its start (charging_sessions.
 * pricing_group_id). Null when the group no longer exists.
 */
export async function loadGroupPricingAtStation(
  groupId: string,
  stationUuid: string,
  sql: postgres.Sql,
): Promise<StationPricing | null> {
  const rows = await sql<PricingRow[]>`
    SELECT pg.id AS group_id, pg.name AS group_name, 0 AS group_priority,
           COALESCE(tz.timezone, sys_tz.timezone, ${DEFAULT_TIMEZONE}) AS timezone,
           t.id, t.name, t.price_per_kwh, t.price_per_minute, t.price_per_session,
           t.idle_fee_price_per_minute, t.reservation_fee_per_minute, t.tax_rate,
           t.restrictions, t.priority, t.is_default
    FROM pricing_groups pg
    LEFT JOIN LATERAL (
      SELECT s.timezone
      FROM charging_stations cs
      LEFT JOIN sites s ON s.id = cs.site_id
      WHERE cs.id = ${stationUuid}
      LIMIT 1
    ) tz ON true
    LEFT JOIN LATERAL (
      SELECT value #>> '{}' AS timezone
      FROM settings
      WHERE key = 'system.timezone' AND jsonb_typeof(value) = 'string'
    ) sys_tz ON true
    LEFT JOIN tariffs t ON t.pricing_group_id = pg.id AND t.is_active = true
    WHERE pg.id = ${groupId}
    ORDER BY t.id
  `;
  const [pricing] = groupRows(rows);
  if (pricing == null) return null;
  return { ...pricing, group: { ...pricing.group, source: 'session' } };
}

/** The first group of `chain` with a tariff that applies, and that tariff. */
export function pickFromChain(
  chain: StationPricing[],
  opts: { at: Date; sessionEnergyKwh?: number },
  holidays: Date[],
): { pricing: StationPricing; tariff: GroupTariff } | null {
  for (const pricing of chain) {
    const tariff = pickTariff(
      pricing.tariffs,
      { at: opts.at, timezone: pricing.timezone, sessionEnergyKwh: opts.sessionEnergyKwh ?? 0 },
      holidays,
    );
    if (tariff != null) return { pricing, tariff };
  }
  return null;
}

function toStationTariff(pricing: StationPricing, match: GroupTariff): StationTariff {
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
 * The tariff that applies to the driver at the station at `at` (default now),
 * evaluated in the site timezone. The groups are tried in order (driver >
 * fleet > station > site > default): a group without active tariffs, or
 * without one that matches (a group without a default tariff, written before
 * the API required one), passes to the next group. Null when no group has a
 * tariff that applies.
 *
 * With `pricingGroupId` (the group a session snapshotted at its start), only
 * that group is tried: an assignment or fleet membership change applies to
 * the next session, never to a running one.
 */
export async function resolveStationTariff(
  q: TariffQuery,
  sql: postgres.Sql,
): Promise<StationTariff | null> {
  const resolved = await resolveWithPricing(q, sql);
  return resolved == null ? null : toStationTariff(resolved.pricing, resolved.tariff);
}

/**
 * resolveStationTariff with every active tariff of the group it resolved in
 * (the portal pricing page tells the driver whether the price can change
 * during the session).
 */
export async function resolveStationPricing(
  q: TariffQuery,
  sql: postgres.Sql,
): Promise<{ tariff: StationTariff; groupTariffs: GroupTariff[] } | null> {
  const resolved = await resolveWithPricing(q, sql);
  if (resolved == null) return null;
  return {
    tariff: toStationTariff(resolved.pricing, resolved.tariff),
    groupTariffs: resolved.pricing.tariffs,
  };
}

/** resolveStationTariff with the group it resolved in. */
async function resolveWithPricing(
  q: TariffQuery,
  sql: postgres.Sql,
): Promise<{ pricing: StationPricing; tariff: GroupTariff } | null> {
  let chain: StationPricing[];
  if (q.pricingGroupId != null) {
    const pricing = await loadGroupPricingAtStation(q.pricingGroupId, q.stationUuid, sql);
    chain = pricing != null ? [pricing] : [];
  } else {
    chain = await loadStationPricingChain(q, sql);
  }
  if (!chain.some((p) => p.tariffs.length > 0)) return null;
  const holidays = await getPricingHolidays(sql);
  return pickFromChain(
    chain,
    { at: q.at ?? new Date(), sessionEnergyKwh: q.sessionEnergyKwh ?? 0 },
    holidays,
  );
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
 *
 * With split billing on, a session moves to the tariff that applies as time
 * and energy go on, within the pricing group it started in, so charging is
 * free only when every active tariff of that group is free (owner decision
 * 2026-10-09: the start decides from whether any reachable tariff is paid).
 * The holding fee is billed at the first segment's rate only, so the other
 * tariffs are checked without it.
 */
export async function isStationChargingFree(
  q: TariffQuery & { reserved: boolean; freeVend: boolean },
  sql: postgres.Sql,
): Promise<boolean> {
  if (q.freeVend) return true;
  const resolved = await resolveWithPricing(q, sql);
  if (!isTariffFree(resolved?.tariff ?? null, { reserved: q.reserved })) return false;
  if (resolved == null || !(await isSplitBillingEnabled())) return true;
  return !hasPaidTariff(resolved.pricing.tariffs);
}

/** True when any of the tariffs has a price above zero (holding fee aside). */
export function hasPaidTariff(tariffs: TariffPriceSnapshot[]): boolean {
  return tariffs.some((t) => !isTariffFree(t));
}

/**
 * True when split billing is on and the pricing group the session started in
 * (charging_sessions.pricing_group_id) has an active tariff with a price
 * above zero: the session can move to a paid tariff while it charges. The
 * payment gate treats such a session as paid at its start (B3).
 */
export async function sessionGroupHasPaidTariff(
  sql: postgres.Sql,
  sessionId: string,
): Promise<boolean> {
  if (!(await isSplitBillingEnabled())) return false;
  const rows = await sql<
    Array<{
      id: string;
      price_per_kwh: string | null;
      price_per_minute: string | null;
      price_per_session: string | null;
      idle_fee_price_per_minute: string | null;
      reservation_fee_per_minute: string | null;
      tax_rate: string | null;
    }>
  >`
    SELECT t.id, t.price_per_kwh, t.price_per_minute, t.price_per_session,
           t.idle_fee_price_per_minute, t.reservation_fee_per_minute, t.tax_rate
    FROM charging_sessions cs
    JOIN tariffs t ON t.pricing_group_id = cs.pricing_group_id AND t.is_active = true
    WHERE cs.id = ${sessionId}
  `;
  return hasPaidTariff(
    rows.map((r) => ({
      id: r.id,
      pricePerKwh: r.price_per_kwh,
      pricePerMinute: r.price_per_minute,
      pricePerSession: r.price_per_session,
      idleFeePricePerMinute: r.idle_fee_price_per_minute,
      reservationFeePerMinute: r.reservation_fee_per_minute,
      taxRate: r.tax_rate,
    })),
  );
}

/**
 * Pricing groups that break the default rule: active tariffs but no active
 * default tariff without restrictions (groups written before the API required
 * one, and that migration 0340 could not give a default). The resolver passes
 * such a group to the next one whenever none of its tariffs matches. The API
 * logs them at startup so the operator adds a default.
 */
export async function listPricingGroupsWithoutDefault(
  sql: postgres.Sql,
): Promise<Array<{ id: string; name: string }>> {
  return sql<Array<{ id: string; name: string }>>`
    SELECT pg.id, pg.name
    FROM pricing_groups pg
    WHERE EXISTS (
        SELECT 1 FROM tariffs t WHERE t.pricing_group_id = pg.id AND t.is_active = true
      )
      AND NOT EXISTS (
        SELECT 1 FROM tariffs d
        WHERE d.pricing_group_id = pg.id AND d.is_active = true
          AND d.is_default = true AND d.priority = 0
      )
    ORDER BY pg.name, pg.id
  `;
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
