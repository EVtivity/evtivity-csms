// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, and, gte, lt, eq, count, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  sites,
  getSystemTimezone,
  inOperatorStation,
  isOperatorStation,
  operatorStationSql,
} from '@evtivity/database';
import { buildCsv } from './csv-builder.js';
import { buildXlsx } from './xlsx-builder.js';
import { PdfReportBuilder } from './pdf-builder.js';
import { loadPdfBranding } from '../pdf-branding.js';
import type { UiLanguage } from '@evtivity/lib/languages';
import type { ReportGeneratorResult } from '../report-registry.js';
import { stationSiteInScope, type ReportSiteScope } from '../report-scope.js';
import { csvRows, pdfRows, percentCell } from './report-cells.js';
import { reportLocale } from './report-locale.js';
import { reportDay, reportDayBounds, reportFileName } from './report-dates.js';

interface Filters {
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  siteId?: string | undefined;
  /** The report's site scope (report-scope.ts). */
  scope: ReportSiteScope;
  /** The company time zone the report days start and end in. */
  timeZone: string;
}

function parseFilters(
  raw: Record<string, unknown>,
  scope: ReportSiteScope,
  timeZone: string,
): Filters {
  return {
    dateFrom: reportDay(raw['dateFrom']),
    dateTo: reportDay(raw['dateTo']),
    siteId: typeof raw['siteId'] === 'string' ? raw['siteId'] : undefined,
    scope,
    timeZone,
  };
}

type UtilizationPeriod = ReturnType<typeof getDateRange>;

/** Sessions that overlap the period, so a session crossing an edge counts its part inside. */
function overlapsPeriod(period: UtilizationPeriod): SQL[] {
  return [
    lt(chargingSessions.startedAt, period.until),
    sql`coalesce(${chargingSessions.endedAt}, now()) > ${period.since.toISOString()}::timestamptz`,
  ];
}

/** Hours of each session inside the period, summed. */
function sessionHoursInPeriod(period: UtilizationPeriod): SQL<number> {
  const since = period.since.toISOString();
  const until = period.until.toISOString();
  return sql<number>`coalesce(sum(greatest(0, extract(epoch from (least(coalesce(${chargingSessions.endedAt}, now()), ${until}::timestamptz) - greatest(${chargingSessions.startedAt}, ${since}::timestamptz))))) / 3600, 0)`;
}

/** Conditions on a site id column: the site filter and the report's site scope. */
function siteConditions(filters: Filters, siteIdColumn: AnyColumn): SQL | undefined {
  const conditions: SQL[] = [];
  if (filters.siteId) conditions.push(eq(siteIdColumn, filters.siteId));
  const inScope = stationSiteInScope(siteIdColumn, filters.scope);
  if (inScope != null) conditions.push(inScope);
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * The hours the utilization is measured over. The period never ends after
 * now, so the hours still to come of a to-date period do not lower it.
 */
export function getDateRange(
  dateFrom: string | undefined,
  dateTo: string | undefined,
  timeZone: string,
  now: Date = new Date(),
): { since: Date; until: Date; totalHours: number } {
  const bounds = reportDayBounds(dateFrom, dateTo, timeZone);
  const until = bounds.until != null && bounds.until.getTime() < now.getTime() ? bounds.until : now;
  const since = bounds.from ?? new Date(until.getTime() - 30 * 86400000);
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
  period: UtilizationPeriod,
  noSite: string,
): Promise<SiteUtilization[]> {
  const { totalHours } = period;
  // Session hours of the sessions that happened at the site (site_id, kept
  // when a station moves) over the stations the site has now. Conformance
  // test stations and their sessions are left out.
  const sessionJoinConditions = [
    eq(chargingSessions.siteId, sites.id),
    inOperatorStation(chargingSessions.stationId),
    ...overlapsPeriod(period),
  ];

  const rows = await db
    .select({
      siteName: sql<string>`coalesce(${sites.name}, ${noSite})`,
      stationCount: sql<number>`(select count(*)::int from ${chargingStations} st where st.site_id = ${sites.id} and ${sql.raw(operatorStationSql('st'))})`,
      sessionHours: sessionHoursInPeriod(period),
    })
    .from(sites)
    .leftJoin(chargingSessions, and(...sessionJoinConditions))
    .where(siteConditions(filters, sites.id))
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
  period: UtilizationPeriod,
  noSite: string,
): Promise<StationUtilization[]> {
  const { totalHours } = period;
  const sessionJoinConditions = [
    eq(chargingSessions.stationId, chargingStations.id),
    ...overlapsPeriod(period),
  ];

  const rows = await db
    .select({
      stationName: sql<string>`coalesce(${chargingStations.stationId}, ${chargingStations.id}::text)`,
      siteName: sql<string>`coalesce(${sites.name}, ${noSite})`,
      sessionHours: sessionHoursInPeriod(period),
      // count(column): a station without sessions has one joined row of nulls.
      sessionCount: count(chargingSessions.id),
    })
    .from(chargingStations)
    .leftJoin(sites, eq(chargingStations.siteId, sites.id))
    .leftJoin(chargingSessions, and(...sessionJoinConditions))
    .where(and(isOperatorStation(), siteConditions(filters, chargingStations.siteId)))
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

async function queryPeakUsage(
  filters: Filters,
  period: UtilizationPeriod,
  tz: string,
): Promise<PeakHour[]> {
  // Sessions of conformance test stations are never reported; peaks count the
  // sessions that started in the period.
  const conditions: SQL[] = [
    inOperatorStation(chargingSessions.stationId),
    gte(chargingSessions.startedAt, period.since),
    lt(chargingSessions.startedAt, period.until),
  ];
  // Peak usage honours the site filter and the site scope like the other
  // sheets, by the site each session happened at.
  const atSites = siteConditions(filters, chargingSessions.siteId);
  if (atSites != null) conditions.push(atSites);

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
  language: UiLanguage,
  siteIds: ReportSiteScope,
): Promise<ReportGeneratorResult> {
  const tz = await getSystemTimezone();
  const filters = parseFilters(rawFilters, siteIds, tz);
  const rl = reportLocale(language, format);
  const { common, columns } = rl.labels;
  const l = rl.labels.utilization;
  const period = getDateRange(filters.dateFrom, filters.dateTo, tz);

  const [bySite, byStation, peakUsage] = await Promise.all([
    querySiteUtilization(filters, period, common.noSite),
    queryStationUtilization(filters, period, common.noSite),
    queryPeakUsage(filters, period, tz),
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
      fileName: reportFileName('utilization-report', filters.dateFrom, filters.dateTo, 'csv'),
    };
  } else if (format === 'xlsx') {
    const data = await buildXlsx([
      { name: l.sheets.bySite, headers: siteHeaders, rows: siteRows },
      { name: l.sheets.byStation, headers: stationHeaders, rows: byStation.map(stationRow) },
      { name: l.sheets.peakHours, headers: peakHeaders, rows: peakRows },
    ]);
    return {
      data,
      fileName: reportFileName('utilization-report', filters.dateFrom, filters.dateTo, 'xlsx'),
    };
  }

  // PDF
  const pdf = new PdfReportBuilder(rl.language, await loadPdfBranding());
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
  return {
    data,
    fileName: reportFileName('utilization-report', filters.dateFrom, filters.dateTo, 'pdf'),
  };
}
