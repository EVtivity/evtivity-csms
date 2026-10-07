// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, and, gte, lte, eq, count } from 'drizzle-orm';
import { db, chargingSessions, chargingStations, sites, settings } from '@evtivity/database';
import { buildCsv } from './csv-builder.js';
import { buildXlsx } from './xlsx-builder.js';
import { PdfReportBuilder } from './pdf-builder.js';
import type { UiLanguage } from '@evtivity/lib/languages';
import type { ReportGeneratorResult } from '../report-registry.js';
import { csvRows, pdfRows, percentCell } from './report-cells.js';
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
  noSite: string,
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
      siteName: sql<string>`coalesce(${sites.name}, ${noSite})`,
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
  noSite: string,
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
      siteName: sql<string>`coalesce(${sites.name}, ${noSite})`,
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

export async function generateUtilizationReport(
  rawFilters: Record<string, unknown>,
  format: string,
  language: UiLanguage = 'en',
): Promise<ReportGeneratorResult> {
  const filters = parseFilters(rawFilters);
  const rl = reportLocale(language, format);
  const { common, columns } = rl.labels;
  const l = rl.labels.utilization;
  const tz = await getTimezone();
  const { totalHours } = getDateRange(filters);

  const [bySite, byStation, peakUsage] = await Promise.all([
    querySiteUtilization(filters, totalHours, common.noSite),
    queryStationUtilization(filters, totalHours, common.noSite),
    queryPeakUsage(filters, tz),
  ]);

  const siteHeaders = [
    columns.site,
    columns.stations,
    l.columns.sessionHours,
    l.columns.utilizationPercent,
  ];
  const siteRows: unknown[][] = bySite.map((r) => [
    r.siteName,
    r.stationCount,
    r.sessionHours,
    percentCell(r.utilization),
  ]);
  const stationHeaders = [
    columns.station,
    columns.site,
    l.columns.sessionHours,
    columns.sessions,
    l.columns.utilizationPercent,
  ];
  const stationRow = (r: StationUtilization): unknown[] => [
    r.stationName,
    r.siteName,
    r.sessionHours,
    r.sessionCount,
    percentCell(r.utilization),
  ];
  const peakHeaders = [l.columns.day, l.columns.hour, l.columns.sessionCount];
  const peakRows: unknown[][] = peakUsage
    .slice(0, 20)
    .map((r) => [rl.weekday(r.dayOfWeek), `${String(r.hour).padStart(2, '0')}:00`, r.count]);

  if (format === 'csv') {
    const rows: unknown[][] = [
      ...siteRows,
      [],
      stationHeaders,
      ...byStation.map(stationRow),
      [],
      [l.sheets.peakHours],
      peakHeaders,
      ...peakRows,
    ];
    const csv = buildCsv(siteHeaders, csvRows(rows));
    return {
      data: Buffer.from(csv, 'utf-8'),
      fileName: `utilization-report-${String(Date.now())}.csv`,
    };
  } else if (format === 'xlsx') {
    const data = await buildXlsx([
      { name: l.sheets.bySite, headers: siteHeaders, rows: siteRows },
      { name: l.sheets.byStation, headers: stationHeaders, rows: byStation.map(stationRow) },
      { name: l.sheets.peakHours, headers: peakHeaders, rows: peakRows },
    ]);
    return { data, fileName: `utilization-report-${String(Date.now())}.xlsx` };
  }

  // PDF
  const pdf = new PdfReportBuilder(rl.language);
  pdf.addTitle(l.title);
  pdf.addSubtitle(rl.period(filters.dateFrom, filters.dateTo, common.last30Days));

  const avgUtil =
    bySite.length > 0
      ? Math.round((bySite.reduce((s, r) => s + r.utilization, 0) / bySite.length) * 10) / 10
      : 0;
  pdf.addSummaryRow(rl.summary(l.summary.averageUtilization), rl.percent(avgUtil));
  pdf.addSummaryRow(rl.summary(l.summary.totalStations), rl.number(byStation.length));

  pdf.addTable(siteHeaders, pdfRows(siteRows, rl));

  pdf.addTable(
    [columns.station, columns.site, l.columns.hours, columns.sessions, l.columns.utilizationShort],
    pdfRows(byStation.slice(0, 100).map(stationRow), rl),
  );

  pdf.addTable([l.columns.day, l.columns.hour, columns.sessions], pdfRows(peakRows, rl));

  const data = await pdf.build();
  return { data, fileName: `utilization-report-${String(Date.now())}.pdf` };
}
