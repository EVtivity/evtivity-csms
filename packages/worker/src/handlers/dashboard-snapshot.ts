// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { db, sites } from '@evtivity/database';
import type { Logger } from 'pino';

export async function dashboardSnapshotHandler(log: Logger): Promise<void> {
  const allSites = await db.select({ id: sites.id, timezone: sites.timezone }).from(sites);

  if (allSites.length === 0) {
    log.info('No sites found, skipping dashboard snapshot');
    return;
  }

  for (const site of allSites) {
    try {
      await snapshotSite(site.id, site.timezone, log);
    } catch (err) {
      log.error({ siteId: site.id, error: err }, 'Failed to snapshot site');
    }
  }

  log.info({ siteCount: allSites.length }, 'Dashboard snapshot complete');
}

async function snapshotSite(siteId: string, timezone: string, log: Logger): Promise<void> {
  // "Yesterday" in the site's timezone
  const yesterdayResult = await db.execute(
    sql`SELECT (now() AT TIME ZONE ${timezone} - interval '1 day')::date AS yesterday`,
  );
  const snapshotDate = (yesterdayResult[0] as { yesterday: string }).yesterday;

  // Day boundaries in UTC for filtering
  const dayBoundaries = await db.execute(sql`
    SELECT
      (${snapshotDate}::date AT TIME ZONE ${timezone}) AS day_start,
      ((${snapshotDate}::date + interval '1 day') AT TIME ZONE ${timezone}) AS day_end
  `);
  const { day_start: dayStartUtc, day_end: dayEndUtc } = dayBoundaries[0] as {
    day_start: string;
    day_end: string;
  };

  // 1. Station counts
  const stationRows = await db.execute(sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE is_online = true) AS online
    FROM charging_stations
    WHERE site_id = ${siteId}
  `);
  const stationData = stationRows[0] as { total: string; online: string };
  const totalStations = Number(stationData.total);
  const onlineStations = Number(stationData.online);
  const onlinePercent = totalStations > 0 ? (onlineStations / totalStations) * 100 : 0;

  // 2. Uptime (midnight to midnight in site timezone)
  const dayStartIso = new Date(dayStartUtc).toISOString();
  const dayEndIso = new Date(dayEndUtc).toISOString();
  const periodMinutes = Math.floor(
    (new Date(dayEndIso).getTime() - new Date(dayStartIso).getTime()) / 60000,
  );
  const periodMinutesStr = String(periodMinutes);

  const uptimeRows = await db.execute(sql`
    WITH all_ports AS (
      SELECT DISTINCT e.station_id, e.evse_id
      FROM evses e
      INNER JOIN charging_stations cs ON cs.id = e.station_id
      WHERE cs.site_id = ${siteId}
    ),
    pre_period_status AS (
      SELECT DISTINCT ON (psl.station_id, psl.evse_id)
        psl.station_id,
        psl.evse_id,
        psl.new_status,
        ${dayStartIso}::timestamptz AS timestamp
      FROM port_status_log psl
      INNER JOIN all_ports ap ON ap.station_id = psl.station_id AND ap.evse_id = psl.evse_id
      WHERE psl.timestamp < ${dayStartIso}::timestamptz
      ORDER BY psl.station_id, psl.evse_id, psl.timestamp DESC
    ),
    seeded_log AS (
      SELECT station_id, evse_id, new_status, timestamp FROM pre_period_status
      UNION ALL
      SELECT psl.station_id, psl.evse_id, psl.new_status, psl.timestamp
      FROM port_status_log psl
      INNER JOIN all_ports ap ON ap.station_id = psl.station_id AND ap.evse_id = psl.evse_id
      WHERE psl.timestamp >= ${dayStartIso}::timestamptz
        AND psl.timestamp < ${dayEndIso}::timestamptz
    ),
    port_transitions AS (
      SELECT
        station_id, evse_id, new_status, timestamp,
        LEAD(timestamp) OVER (PARTITION BY station_id, evse_id ORDER BY timestamp) AS next_timestamp
      FROM seeded_log
    ),
    outage_minutes AS (
      SELECT
        station_id, evse_id,
        SUM(EXTRACT(EPOCH FROM (
          LEAST(COALESCE(next_timestamp, ${dayEndIso}::timestamptz), ${dayEndIso}::timestamptz)
          - timestamp
        )) / 60) AS down_minutes
      FROM port_transitions
      WHERE new_status IN ('faulted', 'unavailable')
      GROUP BY station_id, evse_id
    ),
    port_uptime AS (
      SELECT
        ap.station_id, ap.evse_id,
        CASE WHEN ${sql.raw(periodMinutesStr)} > 0
          THEN GREATEST(0, ((${sql.raw(periodMinutesStr)} - COALESCE(om.down_minutes, 0)) / ${sql.raw(periodMinutesStr)}) * 100)
          ELSE 100
        END AS uptime_pct
      FROM all_ports ap
      LEFT JOIN outage_minutes om ON om.station_id = ap.station_id AND om.evse_id = ap.evse_id
    ),
    station_uptime AS (
      SELECT station_id, AVG(uptime_pct) AS station_uptime_pct
      FROM port_uptime
      GROUP BY station_id
    )
    SELECT
      COALESCE(AVG(station_uptime_pct), 100) AS uptime_percent,
      (SELECT COUNT(*) FROM all_ports) AS total_ports,
      COUNT(*) FILTER (WHERE station_uptime_pct < 97) AS stations_below_threshold
    FROM station_uptime
  `);
  const uptimeData = uptimeRows[0] as
    | {
        uptime_percent: string;
        total_ports: string;
        stations_below_threshold: string;
      }
    | undefined;
  const uptimePercent = Math.round(Number(uptimeData?.uptime_percent ?? 100) * 100) / 100;
  const totalPorts = Number(uptimeData?.total_ports ?? 0);
  const stationsBelowThreshold = Number(uptimeData?.stations_below_threshold ?? 0);

  // 3. Sessions, energy, revenue
  const sessionRows = await db.execute(sql`
    SELECT
      COUNT(*) AS total_sessions,
      COUNT(*) FILTER (WHERE cs2.started_at >= ${dayStartIso}::timestamptz AND cs2.started_at < ${dayEndIso}::timestamptz) AS day_sessions,
      COALESCE(SUM(cs2.energy_delivered_wh), 0) AS total_energy_wh,
      COALESCE(SUM(cs2.energy_delivered_wh) FILTER (WHERE cs2.started_at >= ${dayStartIso}::timestamptz AND cs2.started_at < ${dayEndIso}::timestamptz), 0) AS day_energy_wh,
      COUNT(*) FILTER (WHERE cs2.status = 'active') AS active_sessions
    FROM charging_sessions cs2
    INNER JOIN charging_stations cs ON cs.id = cs2.station_id
    WHERE cs.site_id = ${siteId}
  `);
  const sessData = sessionRows[0] as {
    total_sessions: string;
    day_sessions: string;
    total_energy_wh: string;
    day_energy_wh: string;
    active_sessions: string;
  };

  const revenueRows = await db.execute(sql`
    SELECT
      COALESCE(SUM(pr.captured_amount_cents), 0) AS total_revenue_cents,
      COALESCE(SUM(pr.captured_amount_cents) FILTER (WHERE pr.created_at >= ${dayStartIso}::timestamptz AND pr.created_at < ${dayEndIso}::timestamptz), 0) AS day_revenue_cents,
      COUNT(*) AS total_transactions,
      COUNT(*) FILTER (WHERE pr.created_at >= ${dayStartIso}::timestamptz AND pr.created_at < ${dayEndIso}::timestamptz) AS day_transactions
    FROM payment_records pr
    INNER JOIN charging_sessions cs2 ON cs2.id = pr.session_id
    INNER JOIN charging_stations cs ON cs.id = cs2.station_id
    WHERE cs.site_id = ${siteId}
      AND pr.status IN ('captured', 'partially_refunded')
  `);
  const revData = revenueRows[0] as {
    total_revenue_cents: string;
    day_revenue_cents: string;
    total_transactions: string;
    day_transactions: string;
  };

  const totalSessionsNum = Number(sessData.total_sessions);
  const totalRevCents = Number(revData.total_revenue_cents);
  const avgRevPerSession = totalSessionsNum > 0 ? Math.round(totalRevCents / totalSessionsNum) : 0;

  // 4. Ping health
  const pingRows = await db.execute(sql`
    SELECT
      COALESCE(AVG(oh.avg_ping_latency_ms), 0) AS avg_ping_latency_ms,
      CASE WHEN COALESCE(SUM(oh.total_pings_sent), 0) > 0
        THEN ROUND(SUM(oh.total_pongs_received)::numeric / SUM(oh.total_pings_sent) * 100, 1)
        ELSE 100
      END AS ping_success_rate
    FROM ocpp_health oh
    INNER JOIN charging_stations cs ON cs.ocpp_identity = oh.station_id
    WHERE cs.site_id = ${siteId}
  `);
  const pingData = pingRows[0] as {
    avg_ping_latency_ms: string;
    ping_success_rate: string;
  };
  const avgPingLatencyMs = Math.round(Number(pingData.avg_ping_latency_ms) * 100) / 100;
  const pingSuccessRate = Number(pingData.ping_success_rate);

  // 5. Upsert
  await db.execute(sql`
    INSERT INTO dashboard_snapshots (
      site_id, snapshot_date, total_stations, online_stations, online_percent,
      uptime_percent, active_sessions, total_energy_wh, day_energy_wh,
      total_sessions, day_sessions, connected_stations,
      total_revenue_cents, day_revenue_cents, avg_revenue_cents_per_session,
      total_transactions, day_transactions, total_ports, stations_below_threshold,
      avg_ping_latency_ms, ping_success_rate,
      created_at
    ) VALUES (
      ${siteId}, ${snapshotDate}::date, ${totalStations}, ${onlineStations}, ${onlinePercent},
      ${uptimePercent}, ${Number(sessData.active_sessions)}, ${Number(sessData.total_energy_wh)}, ${Number(sessData.day_energy_wh)},
      ${totalSessionsNum}, ${Number(sessData.day_sessions)}, ${onlineStations},
      ${totalRevCents}, ${Number(revData.day_revenue_cents)}, ${avgRevPerSession},
      ${Number(revData.total_transactions)}, ${Number(revData.day_transactions)}, ${totalPorts}, ${stationsBelowThreshold},
      ${avgPingLatencyMs}, ${pingSuccessRate},
      now()
    )
    ON CONFLICT (site_id, snapshot_date) DO UPDATE SET
      total_stations = EXCLUDED.total_stations,
      online_stations = EXCLUDED.online_stations,
      online_percent = EXCLUDED.online_percent,
      uptime_percent = EXCLUDED.uptime_percent,
      active_sessions = EXCLUDED.active_sessions,
      total_energy_wh = EXCLUDED.total_energy_wh,
      day_energy_wh = EXCLUDED.day_energy_wh,
      total_sessions = EXCLUDED.total_sessions,
      day_sessions = EXCLUDED.day_sessions,
      connected_stations = EXCLUDED.connected_stations,
      total_revenue_cents = EXCLUDED.total_revenue_cents,
      day_revenue_cents = EXCLUDED.day_revenue_cents,
      avg_revenue_cents_per_session = EXCLUDED.avg_revenue_cents_per_session,
      total_transactions = EXCLUDED.total_transactions,
      day_transactions = EXCLUDED.day_transactions,
      total_ports = EXCLUDED.total_ports,
      stations_below_threshold = EXCLUDED.stations_below_threshold,
      avg_ping_latency_ms = EXCLUDED.avg_ping_latency_ms,
      ping_success_rate = EXCLUDED.ping_success_rate,
      created_at = now()
  `);

  log.info({ siteId, snapshotDate }, 'Site snapshot saved');
}
