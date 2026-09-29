// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { db, sites, getCompanyCurrency } from '@evtivity/database';
import type { Logger } from 'pino';

export async function dashboardSnapshotHandler(log: Logger): Promise<void> {
  const allSites = await db.select({ id: sites.id, timezone: sites.timezone }).from(sites);

  if (allSites.length === 0) {
    log.info('No sites found, skipping dashboard snapshot');
    return;
  }

  // ocpp_server_health is a singleton row that aggregates ping metrics
  // globally; every site's snapshot records the same numbers. Read it
  // once up front instead of N times inside the per-site fan-out.
  const pingRows = await db.execute(sql`
    SELECT
      COALESCE(avg_ping_latency_ms, 0) AS avg_ping_latency_ms,
      COALESCE(ping_success_rate, 100) AS ping_success_rate
    FROM ocpp_server_health
    WHERE id = 'singleton'
  `);
  const pingData = pingRows[0] as
    | { avg_ping_latency_ms: string; ping_success_rate: string }
    | undefined;
  const avgPingLatencyMs = Math.round(Number(pingData?.avg_ping_latency_ms ?? 0) * 100) / 100;
  const pingSuccessRate = Number(pingData?.ping_success_rate ?? 100);
  const companyCurrency = await getCompanyCurrency();

  const CONCURRENCY = 5;
  for (let i = 0; i < allSites.length; i += CONCURRENCY) {
    const batch = allSites.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((site) =>
        snapshotSite(
          site.id,
          site.timezone,
          log,
          avgPingLatencyMs,
          pingSuccessRate,
          companyCurrency,
        ),
      ),
    );
    results.forEach((result, idx) => {
      if (result.status === 'rejected') {
        const failed = batch[idx];
        log.error({ siteId: failed?.id, error: result.reason }, 'Failed to snapshot site');
      }
    });
  }

  log.info({ siteCount: allSites.length }, 'Dashboard snapshot complete');
}

async function snapshotSite(
  siteId: string,
  timezone: string,
  log: Logger,
  avgPingLatencyMs: number,
  pingSuccessRate: number,
  companyCurrency: string,
): Promise<void> {
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

  // Day boundaries used by every block below; compute once.
  const dayStartIso = new Date(dayStartUtc).toISOString();
  const dayEndIso = new Date(dayEndUtc).toISOString();
  const periodMinutes = Math.floor(
    (new Date(dayEndIso).getTime() - new Date(dayStartIso).getTime()) / 60000,
  );
  const periodMinutesStr = String(periodMinutes);

  // The read blocks (station counts, uptime, sessions+energy, session money,
  // revenue) are all independent of each other. The only cross-block dependency is
  // the upsert at the end. Fire them in parallel to collapse 4 sequential
  // RTTs into one. Ping data is fetched once at the run level (singleton
  // row) and passed in, so it is not part of this fan-out.
  const [stationRows, uptimeRows, sessionRows, sessionMoneyRows, revenueRows] = await Promise.all([
    // 1. Station counts
    db.execute(sql`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE is_online = true) AS online
      FROM charging_stations
      WHERE site_id = ${siteId}
    `),

    // 2. Uptime CTE (midnight to midnight in site timezone)
    db.execute(sql`
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
  `),

    // 3. Sessions, energy
    db.execute(sql`
      SELECT
        COUNT(*) AS total_sessions,
        COUNT(*) FILTER (WHERE cs2.started_at >= ${dayStartIso}::timestamptz AND cs2.started_at < ${dayEndIso}::timestamptz) AS day_sessions,
        COALESCE(SUM(cs2.energy_delivered_wh), 0) AS total_energy_wh,
        COALESCE(SUM(cs2.energy_delivered_wh) FILTER (WHERE cs2.started_at >= ${dayStartIso}::timestamptz AND cs2.started_at < ${dayEndIso}::timestamptz), 0) AS day_energy_wh,
        COUNT(*) FILTER (WHERE cs2.status = 'active') AS active_sessions
      FROM charging_sessions cs2
      INNER JOIN charging_stations cs ON cs.id = cs2.station_id
      WHERE cs.site_id = ${siteId}
    `),

    // 4. Sessions and electricity cost per session currency (the tariff
    // currency, else the company currency)
    db.execute(sql`
      SELECT
        upper(COALESCE(cs2.currency, ${companyCurrency})) AS currency,
        COUNT(*) AS total_sessions,
        COALESCE(SUM(cs2.electricity_cost_cents), 0) AS total_electricity_cost_cents,
        COALESCE(SUM(cs2.electricity_cost_cents) FILTER (WHERE cs2.started_at >= ${dayStartIso}::timestamptz AND cs2.started_at < ${dayEndIso}::timestamptz), 0) AS day_electricity_cost_cents
      FROM charging_sessions cs2
      INNER JOIN charging_stations cs ON cs.id = cs2.station_id
      WHERE cs.site_id = ${siteId}
      GROUP BY 1
    `),

    // 5. Revenue per payment currency
    db.execute(sql`
      SELECT
        upper(pr.currency) AS currency,
        COALESCE(SUM(pr.captured_amount_cents), 0) AS total_revenue_cents,
        COALESCE(SUM(pr.captured_amount_cents) FILTER (WHERE pr.created_at >= ${dayStartIso}::timestamptz AND pr.created_at < ${dayEndIso}::timestamptz), 0) AS day_revenue_cents,
        COUNT(*) AS total_transactions,
        COUNT(*) FILTER (WHERE pr.created_at >= ${dayStartIso}::timestamptz AND pr.created_at < ${dayEndIso}::timestamptz) AS day_transactions
      FROM payment_records pr
      INNER JOIN charging_sessions cs2 ON cs2.id = pr.session_id
      INNER JOIN charging_stations cs ON cs.id = cs2.station_id
      WHERE cs.site_id = ${siteId}
        AND pr.status IN ('captured', 'partially_refunded')
      GROUP BY 1
    `),
  ]);

  const stationData = stationRows[0] as { total: string; online: string };
  const totalStations = Number(stationData.total);
  const onlineStations = Number(stationData.online);
  const onlinePercent = totalStations > 0 ? (onlineStations / totalStations) * 100 : 0;

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

  const sessData = sessionRows[0] as {
    total_sessions: string;
    day_sessions: string;
    total_energy_wh: string;
    day_energy_wh: string;
    active_sessions: string;
  };
  const totalSessionsNum = Number(sessData.total_sessions);

  const money = mergeCurrencyRows(
    sessionMoneyRows as unknown as SessionMoneyRow[],
    revenueRows as unknown as RevenueRow[],
  );
  let totalTransactions = 0;
  let dayTransactions = 0;
  for (const row of revenueRows as unknown as RevenueRow[]) {
    totalTransactions += Number(row.total_transactions);
    dayTransactions += Number(row.day_transactions);
  }

  // 6. Upsert the snapshot and replace its per-currency rows in one
  // transaction, so a re-run for the same date never leaves a mix.
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO dashboard_snapshots (
        site_id, snapshot_date, total_stations, online_stations, online_percent,
        uptime_percent, active_sessions, total_energy_wh, day_energy_wh,
        total_sessions, day_sessions, connected_stations,
        total_transactions, day_transactions, total_ports, stations_below_threshold,
        avg_ping_latency_ms, ping_success_rate,
        created_at
      ) VALUES (
        ${siteId}, ${snapshotDate}::date, ${totalStations}, ${onlineStations}, ${onlinePercent},
        ${uptimePercent}, ${Number(sessData.active_sessions)}, ${Number(sessData.total_energy_wh)}, ${Number(sessData.day_energy_wh)},
        ${totalSessionsNum}, ${Number(sessData.day_sessions)}, ${onlineStations},
        ${totalTransactions}, ${dayTransactions}, ${totalPorts}, ${stationsBelowThreshold},
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
        total_transactions = EXCLUDED.total_transactions,
        day_transactions = EXCLUDED.day_transactions,
        total_ports = EXCLUDED.total_ports,
        stations_below_threshold = EXCLUDED.stations_below_threshold,
        avg_ping_latency_ms = EXCLUDED.avg_ping_latency_ms,
        ping_success_rate = EXCLUDED.ping_success_rate,
        created_at = now()
    `);

    await tx.execute(sql`
      DELETE FROM dashboard_snapshot_revenue
      WHERE site_id = ${siteId} AND snapshot_date = ${snapshotDate}::date
    `);

    if (money.length > 0) {
      const values = money.map(
        (m) => sql`(
          ${siteId}, ${snapshotDate}::date, ${m.currency}, ${m.totalRevenueCents}, ${m.dayRevenueCents},
          ${m.totalSessions}, ${m.totalElectricityCostCents}, ${m.dayElectricityCostCents}, now()
        )`,
      );
      await tx.execute(sql`
        INSERT INTO dashboard_snapshot_revenue (
          site_id, snapshot_date, currency, total_revenue_cents, day_revenue_cents,
          total_sessions, total_electricity_cost_cents, day_electricity_cost_cents, created_at
        ) VALUES ${sql.join(values, sql`, `)}
      `);
    }
  });

  log.info({ siteId, snapshotDate }, 'Site snapshot saved');
}

interface SessionMoneyRow {
  currency: string;
  total_sessions: string | number;
  total_electricity_cost_cents: string | number;
  day_electricity_cost_cents: string | number;
}

interface RevenueRow {
  currency: string;
  total_revenue_cents: string | number;
  day_revenue_cents: string | number;
  total_transactions: string | number;
  day_transactions: string | number;
}

export interface SnapshotMoney {
  currency: string;
  totalRevenueCents: number;
  dayRevenueCents: number;
  totalSessions: number;
  totalElectricityCostCents: number;
  dayElectricityCostCents: number;
}

/**
 * Joins session money (by session currency) and payment revenue (by payment
 * currency) into one entry per currency. Currencies with no sessions, no
 * revenue, and no cost are left out.
 */
export function mergeCurrencyRows(
  sessionRows: SessionMoneyRow[],
  revenueRows: RevenueRow[],
): SnapshotMoney[] {
  const byCurrency = new Map<string, SnapshotMoney>();
  const entry = (currency: string): SnapshotMoney => {
    let m = byCurrency.get(currency);
    if (m == null) {
      m = {
        currency,
        totalRevenueCents: 0,
        dayRevenueCents: 0,
        totalSessions: 0,
        totalElectricityCostCents: 0,
        dayElectricityCostCents: 0,
      };
      byCurrency.set(currency, m);
    }
    return m;
  };
  for (const row of sessionRows) {
    const m = entry(row.currency);
    m.totalSessions += Number(row.total_sessions);
    m.totalElectricityCostCents += Number(row.total_electricity_cost_cents);
    m.dayElectricityCostCents += Number(row.day_electricity_cost_cents);
  }
  for (const row of revenueRows) {
    const m = entry(row.currency);
    m.totalRevenueCents += Number(row.total_revenue_cents);
    m.dayRevenueCents += Number(row.day_revenue_cents);
  }
  return [...byCurrency.values()].filter(
    (m) =>
      m.totalSessions > 0 ||
      m.totalRevenueCents !== 0 ||
      m.dayRevenueCents !== 0 ||
      m.totalElectricityCostCents !== 0 ||
      m.dayElectricityCostCents !== 0,
  );
}
