// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, eq } from 'drizzle-orm';
import { db, settings } from '@evtivity/database';
import { buildCsv } from './csv-builder.js';
import { buildXlsx } from './xlsx-builder.js';
import { PdfReportBuilder } from './pdf-builder.js';
import type { UiLanguage } from '@evtivity/lib/languages';
import type { ReportGeneratorResult } from '../report-registry.js';
import { csvRows, dateCell, pdfRows, percentCell } from './report-cells.js';
import { reportLocale } from './report-locale.js';

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
  language: UiLanguage = 'en',
): Promise<ReportGeneratorResult> {
  const filters = parseFilters(rawFilters);
  const rl = reportLocale(language, format);
  const { common, columns } = rl.labels;
  const l = rl.labels.stationHealth;

  const [uptime, faults, incidents] = await Promise.all([
    queryStationUptime(filters),
    queryFaultFrequency(filters),
    queryDowntimeIncidents(filters),
  ]);

  const avgUptime =
    uptime.length > 0
      ? Math.round((uptime.reduce((s, r) => s + r.uptimePercent, 0) / uptime.length) * 100) / 100
      : 100;

  const uptimeHeaders = [
    columns.station,
    columns.site,
    l.columns.ports,
    l.columns.uptimePercent,
    l.columns.downtimeMin,
  ];
  const uptimeRows: unknown[][] = uptime.map((r) => [
    r.stationName,
    r.siteName,
    r.portCount,
    percentCell(r.uptimePercent),
    r.downtimeMinutes,
  ]);
  const faultHeaders = [columns.station, l.columns.faultCount];
  const faultRows: unknown[][] = faults.map((f) => [f.stationName, f.faultCount]);
  const incidentHeaders = [
    columns.station,
    l.columns.evse,
    columns.status,
    columns.started,
    columns.durationMin,
  ];
  const incidentRow = (i: DowntimeIncident): unknown[] => [
    i.stationName,
    i.evseId,
    i.status,
    dateCell(i.startedAt),
    i.durationMinutes,
  ];

  if (format === 'csv') {
    const rows: unknown[][] = [
      ...uptimeRows,
      [],
      [l.sheets.faultFrequency],
      faultHeaders,
      ...faultRows,
      [],
      [l.sheets.downtimeIncidents],
      incidentHeaders,
      ...incidents.map(incidentRow),
    ];
    const csv = buildCsv(uptimeHeaders, csvRows(rows));
    return {
      data: Buffer.from(csv, 'utf-8'),
      fileName: `station-health-${String(Date.now())}.csv`,
    };
  } else if (format === 'xlsx') {
    const tables: Array<{ name: string; headers: string[]; rows: unknown[][] }> = [
      { name: l.sheets.uptime, headers: uptimeHeaders, rows: uptimeRows },
    ];

    if (faults.length > 0) {
      tables.push({ name: l.sheets.faultFrequency, headers: faultHeaders, rows: faultRows });
    }

    tables.push({
      name: l.sheets.downtimeIncidents,
      headers: incidentHeaders,
      rows: incidents.map(incidentRow),
    });

    const data = await buildXlsx(tables);
    return { data, fileName: `station-health-${String(Date.now())}.xlsx` };
  }

  const pdf = new PdfReportBuilder(rl.language);
  pdf.addTitle(l.title);
  pdf.addSubtitle(rl.period(filters.dateFrom, filters.dateTo, common.last30Days));
  pdf.addSummaryRow(rl.summary(l.summary.averageUptime), rl.percent(avgUptime));
  pdf.addSummaryRow(rl.summary(l.summary.stationsReported), rl.number(uptime.length));

  pdf.addTable(uptimeHeaders, pdfRows(uptimeRows, rl));

  if (faults.length > 0) {
    pdf.addTable(faultHeaders, pdfRows(faultRows, rl));
  }

  pdf.addTable(incidentHeaders, pdfRows(incidents.slice(0, 200).map(incidentRow), rl));

  const data = await pdf.build();
  return { data, fileName: `station-health-${String(Date.now())}.pdf` };
}
