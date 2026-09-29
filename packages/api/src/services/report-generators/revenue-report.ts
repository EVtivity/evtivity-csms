// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, and, eq, count } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  sites,
  chargingStations,
  paymentRecords,
  getSystemTimezone,
  getCompanyCurrency,
} from '@evtivity/database';
import { buildCsv } from './csv-builder.js';
import { buildXlsx } from './xlsx-builder.js';
import { PdfReportBuilder } from './pdf-builder.js';
import { formatCurrencyAmount } from '@evtivity/lib';
import { inCompanyCurrency } from '../../lib/company-currency.js';
import type { ReportGeneratorResult } from '../report.service.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Filters {
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  siteId?: string | undefined;
}

function parseFilters(raw: Record<string, unknown>): Filters {
  const dateFromRaw = typeof raw['dateFrom'] === 'string' ? raw['dateFrom'] : undefined;
  const dateToRaw = typeof raw['dateTo'] === 'string' ? raw['dateTo'] : undefined;
  return {
    dateFrom: dateFromRaw != null && ISO_DATE.test(dateFromRaw) ? dateFromRaw : undefined,
    dateTo: dateToRaw != null && ISO_DATE.test(dateToRaw) ? dateToRaw : undefined,
    siteId: typeof raw['siteId'] === 'string' ? raw['siteId'] : undefined,
  };
}

function buildDateConditions(filters: Filters, tz: string) {
  const conditions = [];
  // Compare startedAt projected into the system timezone so YYYY-MM-DD
  // filters mean "the operator's local day" instead of UTC midnight.
  if (filters.dateFrom != null) {
    conditions.push(
      sql`(${chargingSessions.startedAt} AT TIME ZONE ${tz})::date >= ${filters.dateFrom}::date`,
    );
  }
  if (filters.dateTo != null) {
    conditions.push(
      sql`(${chargingSessions.startedAt} AT TIME ZONE ${tz})::date <= ${filters.dateTo}::date`,
    );
  }
  return conditions;
}

interface RevenueByDay {
  date: string;
  revenueCents: number;
  electricityCostCents: number;
  sessionCount: number;
}

interface RevenueBySite {
  siteName: string;
  revenueCents: number;
  electricityCostCents: number;
  sessionCount: number;
  energyKwh: number;
}

interface PaymentBreakdown {
  status: string;
  count: number;
  totalCents: number;
}

async function queryRevenueByDay(
  filters: Filters,
  tz: string,
  currency: string,
): Promise<RevenueByDay[]> {
  const billed = inCompanyCurrency(chargingSessions.currency, currency);
  const conditions = [
    ...buildDateConditions(filters, tz),
    sql`coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents}) is not null`,
  ];

  const baseQuery = db
    .select({
      date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
      revenueCents: sql<number>`coalesce(sum(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})) filter (where ${billed}), 0)::float8`,
      electricityCostCents: sql<number>`coalesce(sum(${chargingSessions.electricityCostCents}) filter (where ${billed}), 0)::float8`,
      sessionCount: count(),
    })
    .from(chargingSessions);

  if (filters.siteId != null) {
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

async function queryRevenueBySite(
  filters: Filters,
  tz: string,
  currency: string,
): Promise<RevenueBySite[]> {
  const billed = inCompanyCurrency(chargingSessions.currency, currency);
  const conditions = [
    ...buildDateConditions(filters, tz),
    sql`coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents}) is not null`,
  ];

  if (filters.siteId != null) {
    conditions.push(eq(sites.id, filters.siteId));
  }

  const rows = await db
    .select({
      siteName: sql<string>`coalesce(${sites.name}, 'No Site')`,
      revenueCents: sql<number>`coalesce(sum(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})) filter (where ${billed}), 0)::float8`,
      electricityCostCents: sql<number>`coalesce(sum(${chargingSessions.electricityCostCents}) filter (where ${billed}), 0)::float8`,
      sessionCount: count(),
      energyKwh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric / 1000), 0)::float8`,
    })
    .from(chargingSessions)
    .leftJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .leftJoin(sites, eq(chargingStations.siteId, sites.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(sites.id, sites.name)
    // Order by revenue (position 2 in the SELECT list) desc so the biggest
    // sites surface first; positional reference avoids re-stating the
    // SUM aggregate.
    .orderBy(sql`2 desc`);

  return rows;
}

async function queryPaymentBreakdown(
  filters: Filters,
  tz: string,
  currency: string,
): Promise<PaymentBreakdown[]> {
  // Payment breakdown must honour the same date + site filters as the rest
  // of the report. Without joining to chargingSessions, the prior version
  // returned cross-time/cross-site totals even when the report was scoped.
  const conditions = buildDateConditions(filters, tz);
  if (filters.siteId != null) {
    conditions.push(eq(chargingStations.siteId, filters.siteId));
  }

  return db
    .select({
      status: paymentRecords.status,
      count: count(),
      totalCents: sql<number>`coalesce(sum(${paymentRecords.capturedAmountCents}) filter (where ${inCompanyCurrency(paymentRecords.currency, currency)}), 0)::float8`,
    })
    .from(paymentRecords)
    .innerJoin(chargingSessions, eq(paymentRecords.sessionId, chargingSessions.id))
    .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(paymentRecords.status);
}

export async function generateRevenueReport(
  rawFilters: Record<string, unknown>,
  format: string,
): Promise<ReportGeneratorResult> {
  const filters = parseFilters(rawFilters);
  const [tz, currency] = await Promise.all([getSystemTimezone(), getCompanyCurrency()]);
  const money = (cents: number): string => formatCurrencyAmount(cents, currency);

  const [byDay, bySite, payments] = await Promise.all([
    queryRevenueByDay(filters, tz, currency),
    queryRevenueBySite(filters, tz, currency),
    queryPaymentBreakdown(filters, tz, currency),
  ]);

  const totalSessions = bySite.reduce((sum, r) => sum + r.sessionCount, 0);
  const totalRevenueCents = bySite.reduce((sum, r) => sum + r.revenueCents, 0);
  const totalElectricityCents = bySite.reduce((sum, r) => sum + r.electricityCostCents, 0);

  const dateLabel = [filters.dateFrom, filters.dateTo].filter(Boolean).join(' to ') || 'All time';

  const dayHeaders = ['Date', 'Revenue', 'Electricity Cost', 'Profit', 'Sessions'];
  const dayRows = byDay.map((r) => [
    r.date,
    money(r.revenueCents),
    money(r.electricityCostCents),
    money(r.revenueCents - r.electricityCostCents),
    r.sessionCount,
  ]);
  const siteHeaders = ['Site', 'Revenue', 'Electricity Cost', 'Profit', 'Sessions', 'Energy (kWh)'];
  const siteRows = bySite.map((r) => [
    r.siteName,
    money(r.revenueCents),
    money(r.electricityCostCents),
    money(r.revenueCents - r.electricityCostCents),
    r.sessionCount,
    r.energyKwh.toFixed(1),
  ]);
  const paymentHeaders = ['Payment Status', 'Count', 'Total'];
  const paymentRows = payments.map((r) => [r.status, r.count, money(r.totalCents)]);

  if (format === 'csv') {
    const rows: unknown[][] = [...dayRows, [], siteHeaders, ...siteRows, [], paymentHeaders];
    rows.push(...paymentRows);

    const csv = buildCsv(dayHeaders, rows);
    return {
      data: Buffer.from(csv, 'utf-8'),
      fileName: `revenue-report-${String(Date.now())}.csv`,
    };
  } else if (format === 'xlsx') {
    const data = await buildXlsx([
      { name: 'By Day', headers: dayHeaders, rows: dayRows },
      { name: 'By Site', headers: siteHeaders, rows: siteRows },
      { name: 'Payments', headers: paymentHeaders, rows: paymentRows },
    ]);
    return { data, fileName: `revenue-report-${String(Date.now())}.xlsx` };
  }

  // PDF
  const pdf = new PdfReportBuilder();
  pdf.addTitle('Revenue Report');
  pdf.addSubtitle(`Period: ${dateLabel}`);
  pdf.addSummaryRow('Total Revenue:', money(totalRevenueCents));
  pdf.addSummaryRow('Total Electricity Cost:', money(totalElectricityCents));
  pdf.addSummaryRow('Total Profit:', money(totalRevenueCents - totalElectricityCents));
  pdf.addSummaryRow('Total Sessions:', String(totalSessions));

  pdf.addTable(dayHeaders, dayRows);
  pdf.addTable(siteHeaders, siteRows);
  pdf.addTable(paymentHeaders, paymentRows);

  const data = await pdf.build();
  return { data, fileName: `revenue-report-${String(Date.now())}.pdf` };
}
