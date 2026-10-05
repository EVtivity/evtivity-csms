// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, and, gte, lte, eq, count } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  sites,
  getSystemTimezone,
} from '@evtivity/database';
import { buildCsv } from './csv-builder.js';
import { buildXlsx } from './xlsx-builder.js';
import { PdfReportBuilder } from './pdf-builder.js';
import type { UiLanguage } from '@evtivity/lib/languages';
import type { ReportGeneratorResult } from '../report.service.js';
import { csvRows, dateCell, fixedCell, pdfRows } from './report-cells.js';
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

function buildDateConditions(filters: Filters) {
  const conditions = [];
  if (filters.dateFrom) {
    conditions.push(gte(chargingSessions.startedAt, new Date(filters.dateFrom)));
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    to.setHours(23, 59, 59, 999);
    conditions.push(lte(chargingSessions.startedAt, to));
  }
  return conditions;
}

interface EnergyByDay {
  date: string;
  energyKwh: number;
  sessionCount: number;
}

interface EnergyByStation {
  stationName: string;
  siteName: string;
  energyKwh: number;
  sessionCount: number;
}

interface EnergyBySite {
  siteName: string;
  energyKwh: number;
  sessionCount: number;
  avgKwhPerSession: number;
}

async function queryEnergyByDay(filters: Filters, tz: string): Promise<EnergyByDay[]> {
  const conditions = buildDateConditions(filters);
  // Without joining stations + filtering siteId, the per-day breakdown
  // aggregates energy across ALL sites even when the report is scoped
  // to one — a cross-site data leak in the report output. Mirror the
  // siteId filter from queryEnergyByStation below.
  const baseQuery = db
    .select({
      date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
      energyKwh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric / 1000), 0)`,
      sessionCount: count(),
    })
    .from(chargingSessions);

  if (filters.siteId) {
    conditions.push(eq(chargingStations.siteId, filters.siteId));
    return baseQuery
      .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(sql`1`)
      .orderBy(sql`1`);
  }

  return baseQuery
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(sql`1`)
    .orderBy(sql`1`);
}

async function queryEnergyByStation(filters: Filters, noSite: string): Promise<EnergyByStation[]> {
  const conditions = buildDateConditions(filters);
  if (filters.siteId) {
    conditions.push(eq(chargingStations.siteId, filters.siteId));
  }

  const rows = await db
    .select({
      stationName: sql<string>`coalesce(${chargingStations.stationId}, ${chargingStations.id}::text)`,
      siteName: sql<string>`coalesce(${sites.name}, ${noSite})`,
      energyKwh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric / 1000), 0)`,
      sessionCount: count(),
    })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .leftJoin(sites, eq(chargingStations.siteId, sites.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(chargingStations.id, chargingStations.stationId, sites.name)
    .orderBy(sql`3 desc`);

  return rows;
}

async function queryEnergyBySite(filters: Filters, noSite: string): Promise<EnergyBySite[]> {
  const conditions = buildDateConditions(filters);
  if (filters.siteId) {
    conditions.push(eq(sites.id, filters.siteId));
  }

  const rows = await db
    .select({
      siteName: sql<string>`coalesce(${sites.name}, ${noSite})`,
      energyKwh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric / 1000), 0)`,
      sessionCount: count(),
      avgKwhPerSession: sql<number>`coalesce(avg(${chargingSessions.energyDeliveredWh}::numeric / 1000), 0)`,
    })
    .from(chargingSessions)
    .leftJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .leftJoin(sites, eq(chargingStations.siteId, sites.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(sites.id, sites.name)
    .orderBy(sql`2 desc`);

  return rows;
}

export async function generateEnergyReport(
  rawFilters: Record<string, unknown>,
  format: string,
  language: UiLanguage = 'en',
): Promise<ReportGeneratorResult> {
  const filters = parseFilters(rawFilters);
  const rl = reportLocale(language, format);
  const { common, columns } = rl.labels;
  const l = rl.labels.energy;
  const tz = await getSystemTimezone();

  const [byDay, byStation, bySite] = await Promise.all([
    queryEnergyByDay(filters, tz),
    queryEnergyByStation(filters, common.noSite),
    queryEnergyBySite(filters, common.noSite),
  ]);

  const totalKwh = bySite.reduce((sum, r) => sum + parseFloat(String(r.energyKwh)), 0);
  const totalSessions = bySite.reduce((sum, r) => sum + parseFloat(String(r.sessionCount)), 0);
  const kwh = (value: unknown) => fixedCell(parseFloat(String(value)), 2);

  const dayHeaders = [columns.date, columns.energyKwh, columns.sessions];
  const dayRows: unknown[][] = byDay.map((r) => [
    dateCell(r.date),
    kwh(r.energyKwh),
    r.sessionCount,
  ]);
  const stationHeaders = [columns.station, columns.site, columns.energyKwh, columns.sessions];
  const stationRows: unknown[][] = byStation.map((r) => [
    r.stationName,
    r.siteName,
    kwh(r.energyKwh),
    r.sessionCount,
  ]);
  const siteHeaders = [
    columns.site,
    columns.energyKwh,
    columns.sessions,
    l.columns.avgKwhPerSession,
  ];
  const siteRows: unknown[][] = bySite.map((r) => [
    r.siteName,
    kwh(r.energyKwh),
    r.sessionCount,
    kwh(r.avgKwhPerSession),
  ]);

  if (format === 'csv') {
    const rows: unknown[][] = [
      ...dayRows,
      [],
      stationHeaders,
      ...stationRows,
      [],
      siteHeaders,
      ...siteRows,
    ];
    const csv = buildCsv(dayHeaders, csvRows(rows));
    return { data: Buffer.from(csv, 'utf-8'), fileName: `energy-report-${String(Date.now())}.csv` };
  } else if (format === 'xlsx') {
    const data = await buildXlsx([
      { name: l.sheets.byDay, headers: dayHeaders, rows: dayRows },
      { name: l.sheets.byStation, headers: stationHeaders, rows: stationRows },
      { name: l.sheets.bySite, headers: siteHeaders, rows: siteRows },
    ]);
    return { data, fileName: `energy-report-${String(Date.now())}.xlsx` };
  }

  // PDF
  const pdf = new PdfReportBuilder(rl.language);
  pdf.addTitle(l.title);
  pdf.addSubtitle(rl.period(filters.dateFrom, filters.dateTo, common.allTime));
  pdf.addSummaryRow(
    rl.summary(l.summary.totalEnergy),
    rl.fill(common.kwh, { value: rl.number(totalKwh, 2) }),
  );
  pdf.addSummaryRow(rl.summary(l.summary.totalSessions), rl.number(totalSessions));

  pdf.addTable(dayHeaders, pdfRows(dayRows, rl));
  pdf.addTable(stationHeaders, pdfRows(stationRows, rl));
  pdf.addTable(siteHeaders, pdfRows(siteRows, rl));

  const data = await pdf.build();
  return { data, fileName: `energy-report-${String(Date.now())}.pdf` };
}
