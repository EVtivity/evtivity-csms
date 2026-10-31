// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The day replay of a site layout (GET /v1/sites/:id/layout/replay): what each
// operator station of the site did during one calendar day in the site's
// timezone. Read only, bounded: at most REPLAY_MAX_STATIONS stations and
// REPLAY_MAX_CHANGES changes per list (the rest is cut off, newest last).
//
// Sources:
// - online state: connection_logs events 'connected' and 'disconnected' (the
//   two events the OCPP server writes when a station connects and its socket
//   closes; every other event, such as auth_failed, is ignored);
// - connector status: port_status_log (the last row before the day, then the
//   rows within it);
// - sessions: charging_sessions of the station at this site (sessions keep
//   their site) overlapping the day, without driver data;
// - power: meter_values Power.Active.Import without a phase, averaged per
//   5-minute bucket, converted to kW like the load management live draw
//   (unit W or none divided by 1000, any other unit taken as kW) and summed
//   over the EVSEs, a reading without an EVSE counting only when the station
//   sent no EVSE reading in that bucket.
//
// Site scope: a station's connection, status and power rows count only from
// the time it stands at this site (`stationReplaySince`), so after a move a
// user of the new site never sees the station's data from the old one.
// Sessions are taken by their own site (`charging_sessions.site_id`).

import { sql } from 'drizzle-orm';
import { db, operatorStationSql } from '@evtivity/database';
import { zonedMidnight } from '@evtivity/lib/timezone';

/** Stations a replay covers, at most (oldest first). */
export const REPLAY_MAX_STATIONS = 200;
/** Entries of one list (online changes, a connector's changes, sessions, power buckets), at most. */
export const REPLAY_MAX_CHANGES = 2000;
/** How far back a replay day may be, in days. */
export const REPLAY_MAX_DAYS_BACK = 90;
/** Power bucket length in minutes. */
export const REPLAY_BUCKET_MINUTES = 5;

export interface ReplayDay {
  from: Date;
  to: Date;
}

export type ReplayDayProblem = 'invalid' | 'future' | 'too_old';

/** The calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function zonedDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/**
 * The bounds of a calendar day in a timezone: `from` its midnight, `to` the
 * next day's midnight (exclusive; 23 or 25 hours on a DST change). Refuses a
 * day after today in that timezone and one more than REPLAY_MAX_DAYS_BACK days
 * before it.
 */
export function replayDayBounds(
  date: string,
  timeZone: string,
  now: Date = new Date(),
): ReplayDay | ReplayDayProblem {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match == null) return 'invalid';
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return 'invalid';
  }
  const today = dayNumber(zonedDate(now, timeZone));
  const asked = dayNumber(date);
  if (asked > today) return 'future';
  if (asked < today - REPLAY_MAX_DAYS_BACK) return 'too_old';
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    from: zonedMidnight(year, month, day, timeZone),
    to: zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone),
  };
}

/** kW of a Power.Active.Import value, as the load management live draw reads it. */
export function powerToKw(value: number, unit: string | null): number {
  return unit == null || unit === 'W' ? value / 1000 : value;
}

export interface PowerBucketRow {
  bucket: Date;
  /** The EVSE row id, null for a station-level reading. */
  evseId: string | null;
  /** Average kW of the bucket's readings. */
  kw: number;
}

/**
 * One kW value per bucket, in time order: the sum over the EVSEs that reported
 * in it, else the station-level reading. Rounded to watts.
 */
export function stationPowerSeries(
  rows: readonly PowerBucketRow[],
): Array<{ at: string; kw: number }> {
  const byBucket = new Map<number, { evse: number; hasEvse: boolean; station: number | null }>();
  for (const row of rows) {
    const key = row.bucket.getTime();
    const entry = byBucket.get(key) ?? { evse: 0, hasEvse: false, station: null };
    if (row.evseId == null) entry.station = row.kw;
    else {
      entry.evse += row.kw;
      entry.hasEvse = true;
    }
    byBucket.set(key, entry);
  }
  return [...byBucket.entries()]
    .sort(([a], [b]) => a - b)
    .slice(0, REPLAY_MAX_CHANGES)
    .map(([key, e]) => ({
      at: new Date(key).toISOString(),
      kw: Math.round((e.hasEvse ? e.evse : (e.station ?? 0)) * 1000) / 1000,
    }));
}

export interface OnlineEvent {
  at: Date;
  online: boolean;
}

/**
 * The online state at the start of the day and its changes during it: the
 * last event before the day sets the start (none: the opposite of the first
 * change of the day, else `fallbackOnline`, the station's current state);
 * repeated events of the same state are dropped.
 */
export function onlineTimeline(
  before: OnlineEvent | null,
  during: readonly OnlineEvent[],
  fallbackOnline: boolean,
): { initialOnline: boolean; onlineChanges: Array<{ at: string; online: boolean }> } {
  const sorted = [...during].sort((a, b) => a.at.getTime() - b.at.getTime());
  const initialOnline = before?.online ?? (sorted[0] != null ? !sorted[0].online : fallbackOnline);
  const onlineChanges: Array<{ at: string; online: boolean }> = [];
  let state = initialOnline;
  for (const e of sorted) {
    if (e.online === state) continue;
    state = e.online;
    onlineChanges.push({ at: e.at.toISOString(), online: e.online });
    if (onlineChanges.length >= REPLAY_MAX_CHANGES) break;
  }
  return { initialOnline, onlineChanges };
}

export interface StationSiteHistory {
  /** When the station's layout row was placed at this site (the layout writer recreates it at every move). */
  placedAt: Date | null;
  /** The newest audited site change of the station (`before.siteId` differs from `after.siteId`). */
  lastMove: { at: Date; siteId: string | null } | null;
  /** The end (or now, while active) of the newest session the station ran at another site. */
  foreignSessionUntil: Date | null;
}

/**
 * From when a station's rows belong to the site: the latest of its layout
 * placement at the site, its newest audited move to the site and the end of
 * its newest session at another site. `closed` (no rows) when its newest
 * audited move went to another site, so where it stood since cannot be told;
 * null (no bound) when nothing shows it ever stood elsewhere.
 */
export function stationReplaySince(
  history: StationSiteHistory,
  siteId: string,
): Date | null | 'closed' {
  if (history.lastMove != null && history.lastMove.siteId !== siteId) return 'closed';
  const bounds = [history.placedAt, history.lastMove?.at ?? null, history.foreignSessionUntil]
    .filter((d): d is Date => d != null)
    .map((d) => d.getTime());
  return bounds.length === 0 ? null : new Date(Math.max(...bounds));
}

/** Whether the station stood at the site from the day start on, so its current state may stand in for a missing event. */
function currentStateApplies(since: Date | null | 'closed' | undefined, from: Date): boolean {
  return since === null || (since instanceof Date && since.getTime() <= from.getTime());
}

export interface ReplayConnector {
  evseId: number;
  connectorId: number | null;
  initialStatus: string | null;
  changes: Array<{ at: string; status: string }>;
}

export interface ReplayStation {
  id: string;
  initialOnline: boolean;
  onlineChanges: Array<{ at: string; online: boolean }>;
  connectors: ReplayConnector[];
  sessions: Array<{ startedAt: string; endedAt: string | null; energyWh: number }>;
  power: Array<{ at: string; kw: number }>;
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function connectorKey(evseId: number, connectorId: number | null): string {
  return `${String(evseId)}:${connectorId == null ? '-' : String(connectorId)}`;
}

/** The replay of the operator stations of a site for one day. */
export async function readSiteLayoutReplay(
  siteId: string,
  day: ReplayDay,
): Promise<ReplayStation[]> {
  const fromIso = day.from.toISOString();
  const toIso = day.to.toISOString();
  const stationRows = (await db.execute(sql`
    SELECT cs.id, cs.is_online
    FROM charging_stations cs
    WHERE cs.site_id = ${siteId} AND ${sql.raw(operatorStationSql('cs'))}
    ORDER BY cs.created_at, cs.id
    LIMIT ${REPLAY_MAX_STATIONS}
  `)) as unknown as Array<{ id: string; is_online: boolean }>;
  if (stationRows.length === 0) return [];
  const ids = stationRows.map((s) => s.id);
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

  // From when each station's rows belong to this site (fail closed: 'infinity').
  const historyRows = (await db.execute(sql`
    SELECT s.id,
      (SELECT p.created_at FROM station_layout_positions p
        WHERE p.station_id = s.id AND p.site_id = ${siteId}) AS placed_at,
      mv.created_at AS move_at, mv.site_id AS move_site_id,
      (SELECT max(coalesce(c.ended_at, now())) FROM charging_sessions c
        WHERE c.station_id = s.id AND c.site_id IS NOT NULL AND c.site_id <> ${siteId})
        AS foreign_until
    FROM charging_stations s
    LEFT JOIN LATERAL (
      SELECT a.created_at, a.after->>'siteId' AS site_id FROM station_audit_log a
      WHERE a.station_id = s.id AND a.before ? 'siteId' AND a.after ? 'siteId'
        AND (a.before->>'siteId') IS DISTINCT FROM (a.after->>'siteId')
      ORDER BY a.created_at DESC, a.id DESC LIMIT 1
    ) mv ON true
    WHERE s.id IN (${idList})
  `)) as unknown as Array<{
    id: string;
    placed_at: unknown;
    move_at: unknown;
    move_site_id: string | null;
    foreign_until: unknown;
  }>;
  const sinceByStation = new Map<string, Date | null | 'closed'>();
  for (const h of historyRows) {
    sinceByStation.set(
      h.id,
      stationReplaySince(
        {
          placedAt: h.placed_at == null ? null : toDate(h.placed_at),
          lastMove: h.move_at == null ? null : { at: toDate(h.move_at), siteId: h.move_site_id },
          foreignSessionUntil: h.foreign_until == null ? null : toDate(h.foreign_until),
        },
        siteId,
      ),
    );
  }
  const windowRows = sql.join(
    ids.map((id) => {
      const since = sinceByStation.has(id) ? (sinceByStation.get(id) ?? null) : 'closed';
      const value =
        since === 'closed' ? 'infinity' : since == null ? '-infinity' : since.toISOString();
      return sql`(${id}, ${value}::timestamptz)`;
    }),
    sql`, `,
  );
  const windows = sql`(VALUES ${windowRows}) AS w(station_id, since)`;

  const [beforeOnline, duringOnline, portDuring, portBefore, sessionRows, powerRows] =
    await Promise.all([
      db.execute(sql`
        SELECT w.station_id, last.event, last.created_at
        FROM ${windows}
        CROSS JOIN LATERAL (
          SELECT cl.event, cl.created_at FROM connection_logs cl
          WHERE cl.station_id = w.station_id AND cl.created_at < ${fromIso}::timestamptz
            AND cl.created_at >= w.since AND cl.event IN ('connected', 'disconnected')
          ORDER BY cl.created_at DESC LIMIT 1
        ) last
      `),
      db.execute(sql`
        SELECT cl.station_id, cl.event, cl.created_at
        FROM connection_logs cl JOIN ${windows} ON w.station_id = cl.station_id
        WHERE cl.created_at >= ${fromIso}::timestamptz AND cl.created_at < ${toIso}::timestamptz
          AND cl.created_at >= w.since AND cl.event IN ('connected', 'disconnected')
        ORDER BY cl.station_id, cl.created_at, cl.id
      `),
      db.execute(sql`
        SELECT p.station_id, p.evse_id, p.connector_id, p.new_status, p.timestamp
        FROM port_status_log p JOIN ${windows} ON w.station_id = p.station_id
        WHERE p.timestamp >= ${fromIso}::timestamptz AND p.timestamp < ${toIso}::timestamptz
          AND p.timestamp >= w.since
        ORDER BY p.station_id, p.timestamp, p.id
      `),
      // The last row before the day of every connector the station has now.
      db.execute(sql`
        SELECT e.station_id, e.evse_id, c.connector_id, last.new_status
        FROM evses e
        JOIN connectors c ON c.evse_id = e.id
        JOIN ${windows} ON w.station_id = e.station_id
        CROSS JOIN LATERAL (
          SELECT p.new_status FROM port_status_log p
          WHERE p.station_id = e.station_id AND p.evse_id = e.evse_id
            AND (p.connector_id = c.connector_id OR p.connector_id IS NULL)
            AND p.timestamp < ${fromIso}::timestamptz AND p.timestamp >= w.since
          ORDER BY p.timestamp DESC LIMIT 1
        ) last
      `),
      db.execute(sql`
        SELECT station_id, coalesce(started_at, created_at) AS started_at, ended_at,
          coalesce(energy_delivered_wh, 0)::float AS energy_wh
        FROM charging_sessions
        WHERE site_id = ${siteId} AND station_id IN (${idList})
          AND coalesce(started_at, created_at) < ${toIso}::timestamptz
          AND (ended_at IS NULL OR ended_at >= ${fromIso}::timestamptz)
        ORDER BY station_id, coalesce(started_at, created_at)
      `),
      db.execute(sql`
        SELECT mv.station_id, mv.evse_id,
          date_bin(${`${String(REPLAY_BUCKET_MINUTES)} minutes`}::interval, mv.timestamp, ${fromIso}::timestamptz) AS bucket,
          avg(CASE WHEN mv.unit IS NULL OR mv.unit = 'W' THEN mv.value::float / 1000 ELSE mv.value::float END) AS kw
        FROM meter_values mv JOIN ${windows} ON w.station_id = mv.station_id
        WHERE mv.measurand = 'Power.Active.Import' AND mv.phase IS NULL
          AND mv.timestamp >= ${fromIso}::timestamptz AND mv.timestamp < ${toIso}::timestamptz
          AND mv.timestamp >= w.since
        GROUP BY mv.station_id, mv.evse_id, bucket
      `),
    ]);

  const group = <T extends { station_id: string }>(rows: unknown): Map<string, T[]> => {
    const out = new Map<string, T[]>();
    for (const row of rows as T[]) {
      const list = out.get(row.station_id) ?? [];
      list.push(row);
      out.set(row.station_id, list);
    }
    return out;
  };
  type EventRow = { station_id: string; event: string; created_at: unknown };
  type PortRow = {
    station_id: string;
    evse_id: number;
    connector_id: number | null;
    new_status: string;
    timestamp?: unknown;
  };
  const beforeOnlineBy = group<EventRow>(beforeOnline);
  const duringOnlineBy = group<EventRow>(duringOnline);
  const portDuringBy = group<PortRow>(portDuring);
  const portBeforeBy = group<PortRow>(portBefore);
  const sessionsBy = group<{
    station_id: string;
    started_at: unknown;
    ended_at: unknown;
    energy_wh: unknown;
  }>(sessionRows);
  const powerBy = group<{
    station_id: string;
    evse_id: string | null;
    bucket: unknown;
    kw: unknown;
  }>(powerRows);
  const asEvent = (r: EventRow): OnlineEvent => ({
    at: toDate(r.created_at),
    online: r.event === 'connected',
  });

  return stationRows.map((station) => {
    const before = beforeOnlineBy.get(station.id)?.[0];
    const online = onlineTimeline(
      before != null ? asEvent(before) : null,
      (duringOnlineBy.get(station.id) ?? []).map(asEvent),
      // The current state only when the station has stood here all along.
      currentStateApplies(sinceByStation.get(station.id), day.from) ? station.is_online : false,
    );

    const connectors = new Map<string, ReplayConnector>();
    for (const row of portBeforeBy.get(station.id) ?? []) {
      connectors.set(connectorKey(row.evse_id, row.connector_id), {
        evseId: row.evse_id,
        connectorId: row.connector_id,
        initialStatus: row.new_status,
        changes: [],
      });
    }
    for (const row of portDuringBy.get(station.id) ?? []) {
      const key = connectorKey(row.evse_id, row.connector_id);
      const entry = connectors.get(key) ?? {
        evseId: row.evse_id,
        connectorId: row.connector_id,
        initialStatus: null,
        changes: [],
      };
      if (entry.changes.length < REPLAY_MAX_CHANGES) {
        entry.changes.push({ at: toDate(row.timestamp).toISOString(), status: row.new_status });
      }
      connectors.set(key, entry);
    }

    return {
      id: station.id,
      initialOnline: online.initialOnline,
      onlineChanges: online.onlineChanges,
      connectors: [...connectors.values()].sort(
        (a, b) => a.evseId - b.evseId || (a.connectorId ?? 0) - (b.connectorId ?? 0),
      ),
      sessions: (sessionsBy.get(station.id) ?? []).slice(0, REPLAY_MAX_CHANGES).map((s) => ({
        startedAt: toDate(s.started_at).toISOString(),
        endedAt: s.ended_at == null ? null : toDate(s.ended_at).toISOString(),
        energyWh: Number(s.energy_wh),
      })),
      power: stationPowerSeries(
        (powerBy.get(station.id) ?? []).map((r) => ({
          bucket: toDate(r.bucket),
          evseId: r.evse_id,
          kw: Number(r.kw),
        })),
      ),
    };
  });
}
