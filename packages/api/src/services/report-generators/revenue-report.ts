// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, and, gte, lte, eq, count } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  sites,
  chargingStations,
  paymentRecords,
  settings,
} from '@evtivity/database';
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

interface RevenueByDay {
  date: string;
  revenueCents: number;
  sessionCount: number;
}

interface RevenueBySite {
  siteName: string;
  revenueCents: number;
  sessionCount: number;
  energyKwh: number;
}

interface PaymentBreakdown {
  status: string;
  count: number;
  totalCents: number;
}

async function queryRevenueByDay(filters: Filters, tz: string): Promise<RevenueByDay[]> {
  const conditions = [
    ...buildDateConditions(filters),
    sql`coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents}) is not null`,
  ];

  const rows = await db
    .select({
      date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
      revenueCents: sql<number>`coalesce(sum(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})), 0)`,
      sessionCount: count(),
    })
    .from(chargingSessions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  return rows;
}

async function queryRevenueBySite(filters: Filters): Promise<RevenueBySite[]> {
  const conditions = [
    ...buildDateConditions(filters),
    sql`coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents}) is not null`,
  ];

  if (filters.siteId) {
    conditions.push(eq(sites.id, filters.siteId));
  }

  const rows = await db
    .select({
      siteName: sql<string>`coalesce(${sites.name}, 'No Site')`,
      revenueCents: sql<number>`coalesce(sum(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})), 0)`,
      sessionCount: count(),
      energyKwh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric / 1000), 0)`,
    })
    .from(chargingSessions)
    .leftJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .leftJoin(sites, eq(chargingStations.siteId, sites.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(sites.id, sites.name)
    .orderBy(sql`2 desc`);

  return rows;
}

async function queryPaymentBreakdown(): Promise<PaymentBreakdown[]> {
  const rows = await db
    .select({
      status: paymentRecords.status,
      count: count(),
      totalCents: sql<number>`coalesce(sum(${paymentRecords.capturedAmountCents}), 0)`,
    })
    .from(paymentRecords)
    .groupBy(paymentRecords.status);

  return rows;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function generateRevenueReport(
  rawFilters: Record<string, unknown>,
  format: string,
): Promise<ReportGeneratorResult> {
  const filters = parseFilters(rawFilters);
  const tz = await getTimezone();

  const [byDay, bySite, payments] = await Promise.all([
    queryRevenueByDay(filters, tz),
    queryRevenueBySite(filters),
    queryPaymentBreakdown(),
  ]);

  const totalRevenueCents = bySite.reduce((sum, r) => sum + parseFloat(String(r.revenueCents)), 0);
  const totalSessions = bySite.reduce((sum, r) => sum + parseFloat(String(r.sessionCount)), 0);

  const dateLabel = [filters.dateFrom, filters.dateTo].filter(Boolean).join(' to ') || 'All time';

  if (format === 'csv') {
    const headers = ['Date', 'Revenue ($)', 'Sessions'];
    const rows = byDay.map((r) => [r.date, formatCents(r.revenueCents), r.sessionCount]);
    rows.push([]);
    rows.push(['Site', 'Revenue ($)', 'Sessions', 'Energy (kWh)']);
    for (const r of bySite) {
      rows.push([
        r.siteName,
        formatCents(r.revenueCents),
        r.sessionCount,
        parseFloat(String(r.energyKwh)).toFixed(1),
      ]);
    }
    rows.push([]);
    rows.push(['Payment Status', 'Count', 'Total ($)']);
    for (const r of payments) {
      rows.push([r.status, r.count, formatCents(r.totalCents)]);
    }

    const csv = buildCsv(headers, rows);
    return {
      data: Buffer.from(csv, 'utf-8'),
      fileName: `revenue-report-${String(Date.now())}.csv`,
    };
  } else if (format === 'xlsx') {
    const data = await buildXlsx([
      {
        name: 'By Day',
        headers: ['Date', 'Revenue ($)', 'Sessions'],
        rows: byDay.map((r) => [r.date, formatCents(r.revenueCents), r.sessionCount]),
      },
      {
        name: 'By Site',
        headers: ['Site', 'Revenue ($)', 'Sessions', 'Energy (kWh)'],
        rows: bySite.map((r) => [
          r.siteName,
          formatCents(r.revenueCents),
          r.sessionCount,
          parseFloat(String(r.energyKwh)).toFixed(1),
        ]),
      },
      {
        name: 'Payments',
        headers: ['Payment Status', 'Count', 'Total ($)'],
        rows: payments.map((r) => [r.status, r.count, formatCents(r.totalCents)]),
      },
    ]);
    return { data, fileName: `revenue-report-${String(Date.now())}.xlsx` };
  }

  // PDF
  const pdf = new PdfReportBuilder();
  pdf.addTitle('Revenue Report');
  pdf.addSubtitle(`Period: ${dateLabel}`);
  pdf.addSummaryRow('Total Revenue:', formatCents(totalRevenueCents));
  pdf.addSummaryRow('Total Sessions:', String(totalSessions));

  pdf.addTable(
    ['Date', 'Revenue', 'Sessions'],
    byDay.map((r) => [r.date, formatCents(r.revenueCents), r.sessionCount]),
  );

  pdf.addTable(
    ['Site', 'Revenue', 'Sessions', 'Energy (kWh)'],
    bySite.map((r) => [
      r.siteName,
      formatCents(r.revenueCents),
      r.sessionCount,
      parseFloat(String(r.energyKwh)).toFixed(1),
    ]),
  );

  pdf.addTable(
    ['Payment Status', 'Count', 'Total'],
    payments.map((r) => [r.status, r.count, formatCents(r.totalCents)]),
  );

  const data = await pdf.build();
  return { data, fileName: `revenue-report-${String(Date.now())}.pdf` };
}
