// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Network health (background AI worker `network_summary`): deterministic
 * per-site metrics for the last 24 hours against the daily average of the 7
 * days before, and the candidate actions the worker may propose. The model
 * only writes the narrative over these numbers; it never computes them.
 *
 * Conformance test stations and their rows never count.
 */

import {
  client,
  operatorStationSql,
  siteInsightsSuppressedSql,
  stationInsightsSuppressedSql,
  toDate,
} from '@evtivity/database';
import type { RawTimestamp } from '@evtivity/database';

/** A station faulted for longer than this is a soft reset candidate. */
export const FAULTED_RESET_HOURS = 6;

export interface PeriodCounts {
  sessions: number;
  failedSessions: number;
  /** Refused authorizations (a CSMS database error is not a refusal). */
  refusedAuthorizations: number;
  /** `event_alerts` rows: written only for critical station events (severity 0-1 or an alert rule). */
  criticalAlerts: number;
}

export interface SiteHealthMetrics {
  siteId: string;
  siteName: string;
  stations: number;
  online: number;
  offline: number;
  faulted: number;
  /** Last 24 hours. */
  last24h: PeriodCounts;
  /** Daily average over the 7 days before the last 24 hours, rounded to one decimal. */
  priorDailyAverage: PeriodCounts;
}

export interface FaultedStation {
  stationId: string;
  ocppStationId: string;
  ocppProtocol: string | null;
  siteId: string;
  faultedSince: Date;
}

/** Whether a site had anything to summarize: a station, a session, a refusal or an alert. */
export function hasActivity(m: SiteHealthMetrics): boolean {
  return (
    m.stations > 0 &&
    (m.last24h.sessions > 0 ||
      m.offline > 0 ||
      m.faulted > 0 ||
      m.last24h.refusedAuthorizations > 0 ||
      m.last24h.criticalAlerts > 0)
  );
}

interface MetricsRow {
  site_id: string;
  site_name: string;
  stations: number;
  online: number;
  offline: number;
  faulted: number;
  sessions_24h: number;
  failed_24h: number;
  refused_24h: number;
  alerts_24h: number;
  sessions_prior: number;
  failed_prior: number;
  refused_prior: number;
  alerts_prior: number;
}

const avg = (total: number): number => Math.round((total / 7) * 10) / 10;

/** Metrics of every site, or of one site. `now` bounds both windows. */
export async function siteHealthMetrics(input: {
  now: Date;
  siteId?: string;
}): Promise<SiteHealthMetrics[]> {
  const siteFilter = input.siteId === undefined ? client`true` : client`s.id = ${input.siteId}`;
  const now = input.now;
  const rows = await client<MetricsRow[]>`
    WITH bounds AS (
      SELECT ${now}::timestamptz AS now_at,
        ${now}::timestamptz - interval '24 hours' AS day_start,
        ${now}::timestamptz - interval '8 days' AS prior_start
    )
    SELECT s.id AS site_id, s.name AS site_name,
      (SELECT count(*)::int FROM charging_stations cs WHERE cs.site_id = s.id AND ${client.unsafe(operatorStationSql('cs'))}) AS stations,
      (SELECT count(*)::int FROM charging_stations cs WHERE cs.site_id = s.id AND ${client.unsafe(operatorStationSql('cs'))} AND cs.is_online) AS online,
      (SELECT count(*)::int FROM charging_stations cs WHERE cs.site_id = s.id AND ${client.unsafe(operatorStationSql('cs'))} AND NOT cs.is_online) AS offline,
      (SELECT count(*)::int FROM charging_stations cs WHERE cs.site_id = s.id AND ${client.unsafe(operatorStationSql('cs'))} AND cs.availability = 'faulted') AS faulted,
      (SELECT count(*)::int FROM charging_sessions x JOIN charging_stations cs ON cs.id = x.station_id
        WHERE cs.site_id = s.id AND ${client.unsafe(operatorStationSql('cs'))} AND x.started_at >= b.day_start AND x.started_at < b.now_at) AS sessions_24h,
      (SELECT count(*)::int FROM charging_sessions x JOIN charging_stations cs ON cs.id = x.station_id
        WHERE cs.site_id = s.id AND ${client.unsafe(operatorStationSql('cs'))} AND x.status IN ('failed', 'faulted')
          AND x.started_at >= b.day_start AND x.started_at < b.now_at) AS failed_24h,
      (SELECT count(*)::int FROM authorize_attempts a JOIN charging_stations cs ON cs.station_id = a.station_id
        WHERE cs.site_id = s.id AND ${client.unsafe(operatorStationSql('cs'))} AND a.outcome NOT IN ('accepted', 'db_error')
          AND a.created_at >= b.day_start AND a.created_at < b.now_at) AS refused_24h,
      (SELECT count(*)::int FROM event_alerts e JOIN charging_stations cs ON cs.id = e.station_id
        WHERE cs.site_id = s.id AND ${client.unsafe(operatorStationSql('cs'))} AND e.created_at >= b.day_start AND e.created_at < b.now_at) AS alerts_24h,
      (SELECT count(*)::int FROM charging_sessions x JOIN charging_stations cs ON cs.id = x.station_id
        WHERE cs.site_id = s.id AND ${client.unsafe(operatorStationSql('cs'))} AND x.started_at >= b.prior_start AND x.started_at < b.day_start) AS sessions_prior,
      (SELECT count(*)::int FROM charging_sessions x JOIN charging_stations cs ON cs.id = x.station_id
        WHERE cs.site_id = s.id AND ${client.unsafe(operatorStationSql('cs'))} AND x.status IN ('failed', 'faulted')
          AND x.started_at >= b.prior_start AND x.started_at < b.day_start) AS failed_prior,
      (SELECT count(*)::int FROM authorize_attempts a JOIN charging_stations cs ON cs.station_id = a.station_id
        WHERE cs.site_id = s.id AND ${client.unsafe(operatorStationSql('cs'))} AND a.outcome NOT IN ('accepted', 'db_error')
          AND a.created_at >= b.prior_start AND a.created_at < b.day_start) AS refused_prior,
      (SELECT count(*)::int FROM event_alerts e JOIN charging_stations cs ON cs.id = e.station_id
        WHERE cs.site_id = s.id AND ${client.unsafe(operatorStationSql('cs'))} AND e.created_at >= b.prior_start AND e.created_at < b.day_start) AS alerts_prior
    FROM sites s CROSS JOIN bounds b
    WHERE ${siteFilter}
      -- A suppressed site gets no summary and stays out of the company one.
      AND NOT ${client.unsafe(siteInsightsSuppressedSql('s'))}
    ORDER BY s.name, s.id
  `;
  return rows.map((r) => ({
    siteId: r.site_id,
    siteName: r.site_name,
    stations: r.stations,
    online: r.online,
    offline: r.offline,
    faulted: r.faulted,
    last24h: {
      sessions: r.sessions_24h,
      failedSessions: r.failed_24h,
      refusedAuthorizations: r.refused_24h,
      criticalAlerts: r.alerts_24h,
    },
    priorDailyAverage: {
      sessions: avg(r.sessions_prior),
      failedSessions: avg(r.failed_prior),
      refusedAuthorizations: avg(r.refused_prior),
      criticalAlerts: avg(r.alerts_prior),
    },
  }));
}

interface FaultedRow {
  id: string;
  station_id: string;
  ocpp_protocol: string | null;
  site_id: string;
  faulted_since: RawTimestamp;
}

/**
 * Stations of a site that are online and faulted for longer than
 * `FAULTED_RESET_HOURS`: the time of the last port transition to faulted (or
 * the station's own report) with no later transition out of it.
 */
export async function longFaultedStations(input: {
  siteId: string;
  now: Date;
}): Promise<FaultedStation[]> {
  const rows = await client<FaultedRow[]>`
    SELECT cs.id, cs.station_id, cs.ocpp_protocol, cs.site_id,
      COALESCE(
        (SELECT max(p.timestamp) FROM port_status_log p
          WHERE p.station_id = cs.id AND p.new_status = 'faulted'),
        cs.updated_at
      ) AS faulted_since
    FROM charging_stations cs
    WHERE cs.site_id = ${input.siteId} AND cs.is_online AND cs.availability = 'faulted'
      AND ${client.unsafe(operatorStationSql('cs'))}
      AND NOT ${client.unsafe(stationInsightsSuppressedSql('cs'))}
      AND NOT EXISTS (
        SELECT 1 FROM port_status_log p
        WHERE p.station_id = cs.id AND p.new_status <> 'faulted'
          AND p.timestamp > ${input.now}::timestamptz - make_interval(hours => ${FAULTED_RESET_HOURS})
      )
    ORDER BY cs.station_id
  `;
  const cutoff = input.now.getTime() - FAULTED_RESET_HOURS * 3_600_000;
  return rows
    .map((r) => ({
      stationId: r.id,
      ocppStationId: r.station_id,
      ocppProtocol: r.ocpp_protocol,
      siteId: r.site_id,
      faultedSince: toDate(r.faulted_since as Date | string),
    }))
    .filter((s) => s.faultedSince.getTime() <= cutoff);
}
