// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, eq } from 'drizzle-orm';
import { db, settings } from '@evtivity/database';
import { buildCsv } from './csv-builder.js';
import { buildXlsx } from './xlsx-builder.js';
import { PdfReportBuilder } from './pdf-builder.js';
import type { ReportGeneratorResult } from '../report.service.js';

interface Filters {
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  siteId?: string | undefined;
}

function parseFilters(raw: Record<string, unknown>): Filters {
  return {
    dateFrom: typeof raw['dateFrom'] === 'string' ? raw['dateFrom'] : undefined,
    dateTo: typeof raw['dateTo'] === 'string' ? raw['dateTo'] : undefined,
    siteId: typeof raw['siteId'] === 'string' ? raw['siteId'] : undefined,
  };
}

function getDateRange(filters: Filters): { since: Date; sinceIso: string } {
  const since = filters.dateFrom
    ? new Date(filters.dateFrom)
    : new Date(Date.now() - 30 * 86400000);
  return { since, sinceIso: since.toISOString() };
}

interface StationUptime {
  stationName: string;
  siteName: string;
  portCount: number;
  uptimePercent: number;
  downtimeMinutes: number;
}

interface FaultFrequency {
  stationName: string;
  faultCount: number;
}

interface DowntimeIncident {
  stationName: string;
  evseId: number;
  status: string;
  startedAt: string;
  durationMinutes: number;
}

async function queryStationUptime(filters: Filters): Promise<StationUptime[]> {
  const { since, sinceIso } = getDateRange(filters);
  const periodMinutes = Math.floor((Date.now() - since.getTime()) / 60000);
  const periodMinutesStr = String(periodMinutes);

  const siteCondition = filters.siteId ? sql`AND cs.site_id = ${filters.siteId}` : sql``;

  const rows = await db.execute(sql`
    WITH all_ports AS (
      SELECT DISTINCT e.station_id, e.evse_id
      FROM evses e
      INNER JOIN charging_stations cs ON cs.id = e.station_id
      WHERE 1=1 ${siteCondition}
    ),
    pre_period_status AS (
      SELECT DISTINCT ON (psl.station_id, psl.evse_id)
        psl.station_id,
        psl.evse_id,
        psl.new_status,
        ${sinceIso}::timestamptz AS timestamp
      FROM port_status_log psl
      INNER JOIN all_ports ap ON ap.station_id = psl.station_id AND ap.evse_id = psl.evse_id
      WHERE psl.timestamp < ${sinceIso}::timestamptz
      ORDER BY psl.station_id, psl.evse_id, psl.timestamp DESC
    ),
    seeded_log AS (
      SELECT station_id, evse_id, new_status, timestamp FROM pre_period_status
      UNION ALL
      SELECT psl.station_id, psl.evse_id, psl.new_status, psl.timestamp
      FROM port_status_log psl
      INNER JOIN all_ports ap ON ap.station_id = psl.station_id AND ap.evse_id = psl.evse_id
      WHERE psl.timestamp >= ${sinceIso}::timestamptz
    ),
    port_transitions AS (
      SELECT
        station_id,
        evse_id,
        new_status,
        timestamp,
        LEAD(timestamp) OVER (PARTITION BY station_id, evse_id ORDER BY timestamp) AS next_timestamp
      FROM seeded_log
    ),
    outage_minutes AS (
      SELECT
        station_id,
        evse_id,
        SUM(EXTRACT(EPOCH FROM (COALESCE(next_timestamp, now()) - timestamp)) / 60) AS down_minutes
      FROM port_transitions
      WHERE new_status IN ('faulted', 'unavailable')
      GROUP BY station_id, evse_id
    ),
    station_data AS (
      SELECT
        ap.station_id,
        COUNT(DISTINCT ap.evse_id) AS port_count,
        AVG(
          CASE WHEN ${sql.raw(periodMinutesStr)} > 0
            THEN GREATEST(0, ((${sql.raw(periodMinutesStr)} - COALESCE(om.down_minutes, 0)) / ${sql.raw(periodMinutesStr)}) * 100)
            ELSE 100
          END
        ) AS uptime_pct,
        SUM(COALESCE(om.down_minutes, 0)) AS total_down_minutes
      FROM all_ports ap
      LEFT JOIN outage_minutes om ON om.station_id = ap.station_id AND om.evse_id = ap.evse_id
      GROUP BY ap.station_id
    )
    SELECT
      cs.station_id AS station_name,
      COALESCE(s.name, '') AS site_name,
      sd.port_count,
      sd.uptime_pct,
      sd.total_down_minutes
    FROM station_data sd
    INNER JOIN charging_stations cs ON cs.id = sd.station_id
    LEFT JOIN sites s ON s.id = cs.site_id
    ORDER BY sd.uptime_pct ASC
  `);

  return (
    rows as unknown as Array<{
      station_name: string;
      site_name: string;
      port_count: string;
      uptime_pct: string;
      total_down_minutes: string;
    }>
  ).map((r) => ({
    stationName: r.station_name,
    siteName: r.site_name,
    portCount: Number(r.port_count),
    uptimePercent: Math.round(Number(r.uptime_pct) * 100) / 100,
    downtimeMinutes: Math.round(Number(r.total_down_minutes)),
  }));
}

async function queryFaultFrequency(filters: Filters): Promise<FaultFrequency[]> {
  const { sinceIso } = getDateRange(filters);

  const siteCondition = filters.siteId ? sql`AND cs.site_id = ${filters.siteId}` : sql``;

  const rows = await db.execute(sql`
    SELECT
      cs.station_id AS station_name,
      COUNT(*) AS fault_count
    FROM port_status_log psl
    INNER JOIN charging_stations cs ON cs.id = psl.station_id
    WHERE psl.new_status = 'faulted'
      AND psl.timestamp >= ${sinceIso}::timestamptz
      ${siteCondition}
    GROUP BY cs.station_id
    ORDER BY fault_count DESC
    LIMIT 50
  `);

  return (rows as unknown as Array<{ station_name: string; fault_count: string }>).map((r) => ({
    stationName: r.station_name,
    faultCount: Number(r.fault_count),
  }));
}

async function queryDowntimeIncidents(filters: Filters): Promise<DowntimeIncident[]> {
  const { sinceIso } = getDateRange(filters);

  const siteCondition = filters.siteId ? sql`AND cs.site_id = ${filters.siteId}` : sql``;

  const [tzRow] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'system.timezone'));
  const tz = typeof tzRow?.value === 'string' ? tzRow.value : 'America/New_York';

  const rows = await db.execute(sql`
    SELECT
      cs.station_id AS station_name,
      psl.evse_id,
      psl.new_status AS status,
      (psl.timestamp AT TIME ZONE ${tz})::text AS started_at,
      EXTRACT(EPOCH FROM (COALESCE(
        LEAD(psl.timestamp) OVER (PARTITION BY psl.station_id, psl.evse_id ORDER BY psl.timestamp),
        now()
      ) - psl.timestamp)) / 60 AS duration_minutes
    FROM port_status_log psl
    INNER JOIN charging_stations cs ON cs.id = psl.station_id
    WHERE psl.new_status IN ('faulted', 'unavailable')
      AND psl.timestamp >= ${sinceIso}::timestamptz
      ${siteCondition}
    ORDER BY psl.timestamp DESC
    LIMIT 500
  `);

  return (
    rows as unknown as Array<{
      station_name: string;
      evse_id: number;
      status: string;
      started_at: string;
      duration_minutes: string;
    }>
  ).map((r) => ({
    stationName: r.station_name,
    evseId: r.evse_id,
    status: r.status,
    startedAt: r.started_at,
    durationMinutes: Math.round(Number(r.duration_minutes)),
  }));
}

export async function generateStationHealthReport(
  rawFilters: Record<string, unknown>,
  format: string,
): Promise<ReportGeneratorResult> {
  const filters = parseFilters(rawFilters);

  const [uptime, faults, incidents] = await Promise.all([
    queryStationUptime(filters),
    queryFaultFrequency(filters),
    queryDowntimeIncidents(filters),
  ]);

  const dateLabel =
    [filters.dateFrom, filters.dateTo].filter(Boolean).join(' to ') || 'Last 30 days';
  const avgUptime =
    uptime.length > 0
      ? Math.round((uptime.reduce((s, r) => s + r.uptimePercent, 0) / uptime.length) * 100) / 100
      : 100;

  if (format === 'csv') {
    const headers = ['Station', 'Site', 'Ports', 'Uptime (%)', 'Downtime (min)'];
    const rows: unknown[][] = uptime.map((r) => [
      r.stationName,
      r.siteName,
      r.portCount,
      r.uptimePercent,
      r.downtimeMinutes,
    ]);
    rows.push([]);
    rows.push(['Fault Frequency']);
    rows.push(['Station', 'Fault Count']);
    for (const f of faults) {
      rows.push([f.stationName, f.faultCount]);
    }
    rows.push([]);
    rows.push(['Downtime Incidents']);
    rows.push(['Station', 'EVSE', 'Status', 'Started', 'Duration (min)']);
    for (const i of incidents) {
      rows.push([i.stationName, i.evseId, i.status, i.startedAt, i.durationMinutes]);
    }

    const csv = buildCsv(headers, rows);
    return {
      data: Buffer.from(csv, 'utf-8'),
      fileName: `station-health-${String(Date.now())}.csv`,
    };
  } else if (format === 'xlsx') {
    const tables: Array<{ name: string; headers: string[]; rows: unknown[][] }> = [
      {
        name: 'Uptime',
        headers: ['Station', 'Site', 'Ports', 'Uptime (%)', 'Downtime (min)'],
        rows: uptime.map((r) => [
          r.stationName,
          r.siteName,
          r.portCount,
          r.uptimePercent,
          r.downtimeMinutes,
        ]),
      },
    ];

    if (faults.length > 0) {
      tables.push({
        name: 'Fault Frequency',
        headers: ['Station', 'Fault Count'],
        rows: faults.map((f) => [f.stationName, f.faultCount]),
      });
    }

    tables.push({
      name: 'Downtime Incidents',
      headers: ['Station', 'EVSE', 'Status', 'Started', 'Duration (min)'],
      rows: incidents.map((i) => [
        i.stationName,
        i.evseId,
        i.status,
        i.startedAt,
        i.durationMinutes,
      ]),
    });

    const data = await buildXlsx(tables);
    return { data, fileName: `station-health-${String(Date.now())}.xlsx` };
  }

  const pdf = new PdfReportBuilder();
  pdf.addTitle('Station Health Report');
  pdf.addSubtitle(`Period: ${dateLabel}`);
  pdf.addSummaryRow('Average Uptime:', `${String(avgUptime)}%`);
  pdf.addSummaryRow('Stations Reported:', String(uptime.length));

  pdf.addTable(
    ['Station', 'Site', 'Ports', 'Uptime (%)', 'Downtime (min)'],
    uptime.map((r) => [
      r.stationName,
      r.siteName,
      r.portCount,
      `${String(r.uptimePercent)}%`,
      r.downtimeMinutes,
    ]),
  );

  if (faults.length > 0) {
    pdf.addTable(
      ['Station', 'Fault Count'],
      faults.map((f) => [f.stationName, f.faultCount]),
    );
  }

  pdf.addTable(
    ['Station', 'EVSE', 'Status', 'Started', 'Duration (min)'],
    incidents
      .slice(0, 200)
      .map((i) => [i.stationName, i.evseId, i.status, i.startedAt, i.durationMinutes]),
  );

  const data = await pdf.build();
  return { data, fileName: `station-health-${String(Date.now())}.pdf` };
}
