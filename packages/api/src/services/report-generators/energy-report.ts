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

  const rows = await db
    .select({
      date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
      energyKwh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric / 1000), 0)`,
      sessionCount: count(),
    })
    .from(chargingSessions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  return rows;
}

async function queryEnergyByStation(filters: Filters): Promise<EnergyByStation[]> {
  const conditions = buildDateConditions(filters);
  if (filters.siteId) {
    conditions.push(eq(chargingStations.siteId, filters.siteId));
  }

  const rows = await db
    .select({
      stationName: sql<string>`coalesce(${chargingStations.stationId}, ${chargingStations.id}::text)`,
      siteName: sql<string>`coalesce(${sites.name}, 'No Site')`,
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

async function queryEnergyBySite(filters: Filters): Promise<EnergyBySite[]> {
  const conditions = buildDateConditions(filters);
  if (filters.siteId) {
    conditions.push(eq(sites.id, filters.siteId));
  }

  const rows = await db
    .select({
      siteName: sql<string>`coalesce(${sites.name}, 'No Site')`,
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
): Promise<ReportGeneratorResult> {
  const filters = parseFilters(rawFilters);
  const tz = await getTimezone();

  const [byDay, byStation, bySite] = await Promise.all([
    queryEnergyByDay(filters, tz),
    queryEnergyByStation(filters),
    queryEnergyBySite(filters),
  ]);

  const totalKwh = bySite.reduce((sum, r) => sum + parseFloat(String(r.energyKwh)), 0);
  const totalSessions = bySite.reduce((sum, r) => sum + parseFloat(String(r.sessionCount)), 0);
  const dateLabel = [filters.dateFrom, filters.dateTo].filter(Boolean).join(' to ') || 'All time';

  if (format === 'csv') {
    const headers = ['Date', 'Energy (kWh)', 'Sessions'];
    const rows: unknown[][] = byDay.map((r) => [
      r.date,
      parseFloat(String(r.energyKwh)).toFixed(2),
      r.sessionCount,
    ]);
    rows.push([]);
    rows.push(['Station', 'Site', 'Energy (kWh)', 'Sessions']);
    for (const r of byStation) {
      rows.push([
        r.stationName,
        r.siteName,
        parseFloat(String(r.energyKwh)).toFixed(2),
        r.sessionCount,
      ]);
    }
    rows.push([]);
    rows.push(['Site', 'Energy (kWh)', 'Sessions', 'Avg kWh/Session']);
    for (const r of bySite) {
      rows.push([
        r.siteName,
        parseFloat(String(r.energyKwh)).toFixed(2),
        r.sessionCount,
        parseFloat(String(r.avgKwhPerSession)).toFixed(2),
      ]);
    }

    const csv = buildCsv(headers, rows);
    return { data: Buffer.from(csv, 'utf-8'), fileName: `energy-report-${String(Date.now())}.csv` };
  } else if (format === 'xlsx') {
    const data = await buildXlsx([
      {
        name: 'By Day',
        headers: ['Date', 'Energy (kWh)', 'Sessions'],
        rows: byDay.map((r) => [
          r.date,
          parseFloat(String(r.energyKwh)).toFixed(2),
          r.sessionCount,
        ]),
      },
      {
        name: 'By Station',
        headers: ['Station', 'Site', 'Energy (kWh)', 'Sessions'],
        rows: byStation.map((r) => [
          r.stationName,
          r.siteName,
          parseFloat(String(r.energyKwh)).toFixed(2),
          r.sessionCount,
        ]),
      },
      {
        name: 'By Site',
        headers: ['Site', 'Energy (kWh)', 'Sessions', 'Avg kWh/Session'],
        rows: bySite.map((r) => [
          r.siteName,
          parseFloat(String(r.energyKwh)).toFixed(2),
          r.sessionCount,
          parseFloat(String(r.avgKwhPerSession)).toFixed(2),
        ]),
      },
    ]);
    return { data, fileName: `energy-report-${String(Date.now())}.xlsx` };
  }

  // PDF
  const pdf = new PdfReportBuilder();
  pdf.addTitle('Energy Report');
  pdf.addSubtitle(`Period: ${dateLabel}`);
  pdf.addSummaryRow('Total Energy:', `${totalKwh.toFixed(2)} kWh`);
  pdf.addSummaryRow('Total Sessions:', String(totalSessions));

  pdf.addTable(
    ['Date', 'Energy (kWh)', 'Sessions'],
    byDay.map((r) => [r.date, parseFloat(String(r.energyKwh)).toFixed(2), r.sessionCount]),
  );

  pdf.addTable(
    ['Station', 'Site', 'Energy (kWh)', 'Sessions'],
    byStation.map((r) => [
      r.stationName,
      r.siteName,
      parseFloat(String(r.energyKwh)).toFixed(2),
      r.sessionCount,
    ]),
  );

  pdf.addTable(
    ['Site', 'Energy (kWh)', 'Sessions', 'Avg kWh/Session'],
    bySite.map((r) => [
      r.siteName,
      parseFloat(String(r.energyKwh)).toFixed(2),
      r.sessionCount,
      parseFloat(String(r.avgKwhPerSession)).toFixed(2),
    ]),
  );

  const data = await pdf.build();
  return { data, fileName: `energy-report-${String(Date.now())}.pdf` };
}
