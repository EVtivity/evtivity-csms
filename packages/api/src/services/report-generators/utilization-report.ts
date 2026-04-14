// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, and, gte, lte, eq, count } from 'drizzle-orm';
import { db, chargingSessions, chargingStations, sites, settings } from '@evtivity/database';
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

async function getTimezone(): Promise<string> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'system.timezone'));
  return typeof row?.value === 'string' ? row.value : 'America/New_York';
}

function getDateRange(filters: Filters): { since: Date; until: Date; totalHours: number } {
  const until = filters.dateTo
    ? (() => {
        const d = new Date(filters.dateTo);
        d.setHours(23, 59, 59, 999);
        return d;
      })()
    : new Date();
  const since = filters.dateFrom
    ? new Date(filters.dateFrom)
    : new Date(until.getTime() - 30 * 86400000);
  const totalHours = Math.max((until.getTime() - since.getTime()) / 3600000, 1);
  return { since, until, totalHours };
}

interface SiteUtilization {
  siteName: string;
  stationCount: number;
  sessionHours: number;
  utilization: number;
}

interface StationUtilization {
  stationName: string;
  siteName: string;
  sessionHours: number;
  sessionCount: number;
  utilization: number;
}

interface PeakHour {
  hour: number;
  dayOfWeek: number;
  count: number;
}

async function querySiteUtilization(
  filters: Filters,
  totalHours: number,
): Promise<SiteUtilization[]> {
  const conditions = [];
  if (filters.dateFrom) {
    conditions.push(gte(chargingSessions.startedAt, new Date(filters.dateFrom)));
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    to.setHours(23, 59, 59, 999);
    conditions.push(lte(chargingSessions.startedAt, to));
  }
  if (filters.siteId) {
    conditions.push(eq(sites.id, filters.siteId));
  }

  const sessionJoinConditions = [eq(chargingSessions.stationId, chargingStations.id)];
  if (filters.dateFrom) {
    sessionJoinConditions.push(gte(chargingSessions.startedAt, new Date(filters.dateFrom)));
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    to.setHours(23, 59, 59, 999);
    sessionJoinConditions.push(lte(chargingSessions.startedAt, to));
  }

  const rows = await db
    .select({
      siteName: sql<string>`coalesce(${sites.name}, 'No Site')`,
      stationCount: sql<number>`count(distinct ${chargingStations.id})`,
      sessionHours: sql<number>`coalesce(sum(extract(epoch from (coalesce(${chargingSessions.endedAt}, now()) - ${chargingSessions.startedAt})) / 3600), 0)`,
    })
    .from(sites)
    .leftJoin(chargingStations, eq(chargingStations.siteId, sites.id))
    .leftJoin(chargingSessions, and(...sessionJoinConditions))
    .where(filters.siteId ? eq(sites.id, filters.siteId) : undefined)
    .groupBy(sites.id, sites.name)
    .orderBy(sql`3 desc`);

  return rows.map((r) => ({
    siteName: r.siteName,
    stationCount: r.stationCount,
    sessionHours: Math.round(r.sessionHours * 10) / 10,
    utilization:
      r.stationCount > 0
        ? Math.round((r.sessionHours / (r.stationCount * totalHours)) * 1000) / 10
        : 0,
  }));
}

async function queryStationUtilization(
  filters: Filters,
  totalHours: number,
): Promise<StationUtilization[]> {
  const conditions = [];
  if (filters.dateFrom) {
    conditions.push(gte(chargingSessions.startedAt, new Date(filters.dateFrom)));
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    to.setHours(23, 59, 59, 999);
    conditions.push(lte(chargingSessions.startedAt, to));
  }
  if (filters.siteId) {
    conditions.push(eq(chargingStations.siteId, filters.siteId));
  }

  const sessionJoinConditions = [eq(chargingSessions.stationId, chargingStations.id)];
  if (filters.dateFrom) {
    sessionJoinConditions.push(gte(chargingSessions.startedAt, new Date(filters.dateFrom)));
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    to.setHours(23, 59, 59, 999);
    sessionJoinConditions.push(lte(chargingSessions.startedAt, to));
  }

  const rows = await db
    .select({
      stationName: sql<string>`coalesce(${chargingStations.stationId}, ${chargingStations.id}::text)`,
      siteName: sql<string>`coalesce(${sites.name}, 'No Site')`,
      sessionHours: sql<number>`coalesce(sum(extract(epoch from (coalesce(${chargingSessions.endedAt}, now()) - ${chargingSessions.startedAt})) / 3600), 0)`,
      sessionCount: count(),
    })
    .from(chargingStations)
    .leftJoin(sites, eq(chargingStations.siteId, sites.id))
    .leftJoin(chargingSessions, and(...sessionJoinConditions))
    .where(filters.siteId ? eq(chargingStations.siteId, filters.siteId) : undefined)
    .groupBy(chargingStations.id, chargingStations.stationId, sites.name)
    .orderBy(sql`3 desc`);

  return rows.map((r) => ({
    stationName: r.stationName,
    siteName: r.siteName,
    sessionHours: Math.round(r.sessionHours * 10) / 10,
    sessionCount: r.sessionCount,
    utilization: Math.min(Math.round((r.sessionHours / totalHours) * 1000) / 10, 100),
  }));
}

async function queryPeakUsage(filters: Filters, tz: string): Promise<PeakHour[]> {
  const conditions = [];
  if (filters.dateFrom) {
    conditions.push(gte(chargingSessions.startedAt, new Date(filters.dateFrom)));
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    to.setHours(23, 59, 59, 999);
    conditions.push(lte(chargingSessions.startedAt, to));
  }

  const rows = await db
    .select({
      hour: sql<number>`extract(hour from ${chargingSessions.startedAt} AT TIME ZONE ${tz})::int`,
      dayOfWeek: sql<number>`extract(isodow from ${chargingSessions.startedAt} AT TIME ZONE ${tz})::int`,
      count: count(),
    })
    .from(chargingSessions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(sql`1`, sql`2`)
    .orderBy(sql`3 desc`);

  return rows;
}

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export async function generateUtilizationReport(
  rawFilters: Record<string, unknown>,
  format: string,
): Promise<ReportGeneratorResult> {
  const filters = parseFilters(rawFilters);
  const tz = await getTimezone();
  const { totalHours } = getDateRange(filters);

  const [bySite, byStation, peakUsage] = await Promise.all([
    querySiteUtilization(filters, totalHours),
    queryStationUtilization(filters, totalHours),
    queryPeakUsage(filters, tz),
  ]);

  const dateLabel =
    [filters.dateFrom, filters.dateTo].filter(Boolean).join(' to ') || 'Last 30 days';

  if (format === 'csv') {
    const headers = ['Site', 'Stations', 'Session Hours', 'Utilization (%)'];
    const rows: unknown[][] = bySite.map((r) => [
      r.siteName,
      r.stationCount,
      r.sessionHours,
      r.utilization,
    ]);
    rows.push([]);
    rows.push(['Station', 'Site', 'Session Hours', 'Sessions', 'Utilization (%)']);
    for (const r of byStation) {
      rows.push([r.stationName, r.siteName, r.sessionHours, r.sessionCount, r.utilization]);
    }
    rows.push([]);
    rows.push(['Peak Hours']);
    rows.push(['Day', 'Hour', 'Session Count']);
    for (const r of peakUsage.slice(0, 20)) {
      rows.push([DAY_NAMES[r.dayOfWeek] ?? '', `${String(r.hour).padStart(2, '0')}:00`, r.count]);
    }

    const csv = buildCsv(headers, rows);
    return {
      data: Buffer.from(csv, 'utf-8'),
      fileName: `utilization-report-${String(Date.now())}.csv`,
    };
  } else if (format === 'xlsx') {
    const data = await buildXlsx([
      {
        name: 'By Site',
        headers: ['Site', 'Stations', 'Session Hours', 'Utilization (%)'],
        rows: bySite.map((r) => [r.siteName, r.stationCount, r.sessionHours, r.utilization]),
      },
      {
        name: 'By Station',
        headers: ['Station', 'Site', 'Session Hours', 'Sessions', 'Utilization (%)'],
        rows: byStation.map((r) => [
          r.stationName,
          r.siteName,
          r.sessionHours,
          r.sessionCount,
          r.utilization,
        ]),
      },
      {
        name: 'Peak Hours',
        headers: ['Day', 'Hour', 'Session Count'],
        rows: peakUsage
          .slice(0, 20)
          .map((r) => [
            DAY_NAMES[r.dayOfWeek] ?? '',
            `${String(r.hour).padStart(2, '0')}:00`,
            r.count,
          ]),
      },
    ]);
    return { data, fileName: `utilization-report-${String(Date.now())}.xlsx` };
  }

  // PDF
  const pdf = new PdfReportBuilder();
  pdf.addTitle('Utilization Report');
  pdf.addSubtitle(`Period: ${dateLabel}`);

  const avgUtil =
    bySite.length > 0
      ? Math.round((bySite.reduce((s, r) => s + r.utilization, 0) / bySite.length) * 10) / 10
      : 0;
  pdf.addSummaryRow('Average Utilization:', `${String(avgUtil)}%`);
  pdf.addSummaryRow('Total Stations:', String(byStation.length));

  pdf.addTable(
    ['Site', 'Stations', 'Session Hours', 'Utilization (%)'],
    bySite.map((r) => [r.siteName, r.stationCount, r.sessionHours, `${String(r.utilization)}%`]),
  );

  pdf.addTable(
    ['Station', 'Site', 'Hours', 'Sessions', 'Util (%)'],
    byStation
      .slice(0, 100)
      .map((r) => [
        r.stationName,
        r.siteName,
        r.sessionHours,
        r.sessionCount,
        `${String(r.utilization)}%`,
      ]),
  );

  pdf.addTable(
    ['Day', 'Hour', 'Sessions'],
    peakUsage
      .slice(0, 20)
      .map((r) => [DAY_NAMES[r.dayOfWeek] ?? '', `${String(r.hour).padStart(2, '0')}:00`, r.count]),
  );

  const data = await pdf.build();
  return { data, fileName: `utilization-report-${String(Date.now())}.pdf` };
}
