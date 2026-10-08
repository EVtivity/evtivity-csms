// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, and, eq, count, inArray, type SQL } from 'drizzle-orm';
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
import type { UiLanguage } from '@evtivity/lib/languages';
import { inCompanyCurrency } from '../company-currency.js';
import {
  queryRevenue,
  revenueItem,
  EMPTY_REVENUE,
  paymentsKeptCentsSql,
} from '../session-revenue.js';
import { MoneyCell, moneyCell, csvRows, dateCell, pdfRows } from './report-cells.js';
import { reportLocale } from './report-locale.js';
import type { ReportGeneratorResult } from '../report-registry.js';

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
  netRevenueCents: number;
  taxCents: number;
  electricityCostCents: number;
  billedOnAccountCents: number;
  sessionCount: number;
}

interface RevenueBySite {
  siteName: string;
  revenueCents: number;
  netRevenueCents: number;
  taxCents: number;
  electricityCostCents: number;
  billedOnAccountCents: number;
  sessionCount: number;
  energyKwh: number;
}

interface PaymentBreakdown {
  status: string;
  count: number;
  totalCents: number;
}

/** Revenue items (session-revenue.ts) in the report's date range and site. */
function revenueConditions(filters: Filters, tz: string): SQL[] {
  const where: SQL[] = [];
  if (filters.dateFrom != null) {
    where.push(
      sql`(${revenueItem.occurredAt} AT TIME ZONE ${tz})::date >= ${filters.dateFrom}::date`,
    );
  }
  if (filters.dateTo != null) {
    where.push(
      sql`(${revenueItem.occurredAt} AT TIME ZONE ${tz})::date <= ${filters.dateTo}::date`,
    );
  }
  if (filters.siteId != null) where.push(sql`${revenueItem.siteId} = ${filters.siteId}`);
  return where;
}

async function queryRevenueByDay(
  filters: Filters,
  tz: string,
  currency: string,
): Promise<RevenueByDay[]> {
  const billed = inCompanyCurrency(chargingSessions.currency, currency);
  const day = sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`;
  const conditions = [...buildDateConditions(filters, tz), billed];

  const costsQuery = db
    .select({
      date: day,
      electricityCostCents: sql<number>`coalesce(sum(${chargingSessions.electricityCostCents}), 0)::float8`,
    })
    .from(chargingSessions);
  if (filters.siteId != null) {
    conditions.push(eq(chargingStations.siteId, filters.siteId));
    costsQuery.innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id));
  }

  const [costs, revenue] = await Promise.all([
    costsQuery.where(and(...conditions)).groupBy(sql`1`),
    queryRevenue({
      companyCurrency: currency,
      key: sql`date_trunc('day', ${revenueItem.occurredAt} AT TIME ZONE ${tz})::date`,
      where: revenueConditions(filters, tz),
    }),
  ]);
  const costByDay = new Map(costs.map((c) => [c.date, c.electricityCostCents]));
  const days = new Set<string>([
    ...costByDay.keys(),
    ...[...revenue.keys()].filter((k): k is string => k != null),
  ]);
  return [...days].sort().map((date) => {
    const r = revenue.get(date) ?? EMPTY_REVENUE;
    return {
      date,
      revenueCents: r.grossCents,
      netRevenueCents: r.netCents,
      taxCents: r.taxCents,
      electricityCostCents: costByDay.get(date) ?? 0,
      billedOnAccountCents: r.billedOnAccountCents,
      sessionCount: r.sessionCount,
    };
  });
}

async function queryRevenueBySite(
  filters: Filters,
  tz: string,
  currency: string,
  noSite: string,
): Promise<RevenueBySite[]> {
  const billed = inCompanyCurrency(chargingSessions.currency, currency);
  const conditions = [...buildDateConditions(filters, tz), billed];
  if (filters.siteId != null) {
    conditions.push(eq(sites.id, filters.siteId));
  }

  const [rows, revenue] = await Promise.all([
    db
      .select({
        siteId: sites.id,
        siteName: sql<string>`coalesce(${sites.name}, ${noSite})`,
        electricityCostCents: sql<number>`coalesce(sum(${chargingSessions.electricityCostCents}), 0)::float8`,
        energyKwh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric / 1000), 0)::float8`,
      })
      .from(chargingSessions)
      .leftJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
      .leftJoin(sites, eq(chargingStations.siteId, sites.id))
      .where(and(...conditions))
      .groupBy(sites.id, sites.name),
    queryRevenue({
      companyCurrency: currency,
      key: revenueItem.siteId,
      where: revenueConditions(filters, tz),
    }),
  ]);

  const bySite = new Map<string | null, RevenueBySite>();
  for (const row of rows) {
    bySite.set(row.siteId, {
      siteName: row.siteName,
      revenueCents: 0,
      netRevenueCents: 0,
      taxCents: 0,
      electricityCostCents: row.electricityCostCents,
      billedOnAccountCents: 0,
      sessionCount: 0,
      energyKwh: row.energyKwh,
    });
  }
  // Sites with revenue but no billed session in the range (reservation fees only).
  const missing = [...revenue.keys()].filter((id): id is string => id != null && !bySite.has(id));
  if (missing.length > 0) {
    const names = await db
      .select({ id: sites.id, name: sites.name })
      .from(sites)
      .where(inArray(sites.id, missing));
    for (const site of names) {
      bySite.set(site.id, {
        siteName: site.name,
        revenueCents: 0,
        netRevenueCents: 0,
        taxCents: 0,
        electricityCostCents: 0,
        billedOnAccountCents: 0,
        sessionCount: 0,
        energyKwh: 0,
      });
    }
  }
  for (const [siteId, r] of revenue) {
    const site =
      bySite.get(siteId) ??
      ({
        siteName: noSite,
        revenueCents: 0,
        netRevenueCents: 0,
        taxCents: 0,
        electricityCostCents: 0,
        billedOnAccountCents: 0,
        sessionCount: 0,
        energyKwh: 0,
      } satisfies RevenueBySite);
    site.revenueCents = r.grossCents;
    site.netRevenueCents = r.netCents;
    site.taxCents = r.taxCents;
    site.billedOnAccountCents = r.billedOnAccountCents;
    site.sessionCount = r.sessionCount;
    bySite.set(siteId, site);
  }
  // Biggest sites first.
  return [...bySite.values()].sort((a, b) => b.revenueCents - a.revenueCents);
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
      totalCents: sql<number>`${paymentsKeptCentsSql(currency)}::float8`,
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
  language: UiLanguage = 'en',
): Promise<ReportGeneratorResult> {
  const filters = parseFilters(rawFilters);
  const rl = reportLocale(language, format);
  const { common, columns } = rl.labels;
  const l = rl.labels.revenue;
  const [tz, currency] = await Promise.all([getSystemTimezone(), getCompanyCurrency()]);
  const money = (cents: number): MoneyCell => moneyCell(cents, currency);

  const [byDay, bySite, payments] = await Promise.all([
    queryRevenueByDay(filters, tz, currency),
    queryRevenueBySite(filters, tz, currency, common.noSite),
    queryPaymentBreakdown(filters, tz, currency),
  ]);

  const totalSessions = bySite.reduce((sum, r) => sum + r.sessionCount, 0);
  const totalRevenueCents = bySite.reduce((sum, r) => sum + r.revenueCents, 0);
  const totalNetRevenueCents = bySite.reduce((sum, r) => sum + r.netRevenueCents, 0);
  const totalTaxCents = bySite.reduce((sum, r) => sum + r.taxCents, 0);
  const totalElectricityCents = bySite.reduce((sum, r) => sum + r.electricityCostCents, 0);
  const totalBilledOnAccountCents = bySite.reduce((sum, r) => sum + r.billedOnAccountCents, 0);

  // Revenue is billed sessions and reservation fees minus refunds
  // (session-revenue.ts); unpaid account sessions are a column of their own
  // (billed on account), not revenue. Profit is revenue excluding tax minus electricity
  // cost: the tax collected is owed to the tax authority, not earned.
  const moneyColumns = [
    rl.moneyHeader(l.columns.revenue, currency, common.inclTax),
    rl.moneyHeader(l.columns.tax, currency),
    rl.moneyHeader(l.columns.revenue, currency, common.exclTax),
    rl.moneyHeader(l.columns.electricityCost, currency),
    rl.moneyHeader(l.columns.profit, currency),
    rl.moneyHeader(l.columns.billedOnAccount, currency, common.inclTax),
  ];
  const moneyCells = (r: {
    revenueCents: number;
    taxCents: number;
    netRevenueCents: number;
    electricityCostCents: number;
    billedOnAccountCents: number;
  }): MoneyCell[] => [
    money(r.revenueCents),
    money(r.taxCents),
    money(r.netRevenueCents),
    money(r.electricityCostCents),
    money(r.netRevenueCents - r.electricityCostCents),
    money(r.billedOnAccountCents),
  ];
  const dayHeaders = [columns.date, ...moneyColumns, columns.sessions];
  const dayRows = byDay.map((r) => [dateCell(r.date), ...moneyCells(r), r.sessionCount]);
  const siteHeaders = [columns.site, ...moneyColumns, columns.sessions, columns.energyKwh];
  const siteRows = bySite.map((r) => [
    r.siteName,
    ...moneyCells(r),
    r.sessionCount,
    Math.round(r.energyKwh * 10) / 10,
  ]);
  const paymentHeaders = [
    l.columns.paymentStatus,
    columns.count,
    rl.moneyHeader(columns.total, currency),
  ];
  const paymentRows = payments.map((r) => [r.status, r.count, money(r.totalCents)]);

  if (format === 'csv') {
    const rows: unknown[][] = [...dayRows, [], siteHeaders, ...siteRows, [], paymentHeaders];
    rows.push(...paymentRows);

    const csv = buildCsv(dayHeaders, csvRows(rows));
    return {
      data: Buffer.from(csv, 'utf-8'),
      fileName: `revenue-report-${String(Date.now())}.csv`,
    };
  } else if (format === 'xlsx') {
    const data = await buildXlsx([
      { name: l.sheets.byDay, headers: dayHeaders, rows: dayRows },
      { name: l.sheets.bySite, headers: siteHeaders, rows: siteRows },
      { name: l.sheets.payments, headers: paymentHeaders, rows: paymentRows },
    ]);
    return { data, fileName: `revenue-report-${String(Date.now())}.xlsx` };
  }

  // PDF
  const fmt = (cents: number): string => rl.money(cents, currency);
  const pdf = new PdfReportBuilder(rl.language);
  pdf.addTitle(l.title);
  pdf.addSubtitle(rl.period(filters.dateFrom, filters.dateTo, common.allTime));
  pdf.addSummaryRow(rl.summary(l.summary.totalRevenueInclTax), fmt(totalRevenueCents));
  pdf.addSummaryRow(rl.summary(l.summary.totalTax), fmt(totalTaxCents));
  pdf.addSummaryRow(rl.summary(l.summary.totalRevenueExclTax), fmt(totalNetRevenueCents));
  pdf.addSummaryRow(rl.summary(l.summary.totalElectricityCost), fmt(totalElectricityCents));
  pdf.addSummaryRow(
    rl.summary(l.summary.totalProfit),
    fmt(totalNetRevenueCents - totalElectricityCents),
  );
  pdf.addSummaryRow(rl.summary(l.summary.totalBilledOnAccount), fmt(totalBilledOnAccountCents));
  pdf.addSummaryRow(rl.summary(l.summary.totalSessions), rl.number(totalSessions));

  pdf.addTable(dayHeaders, pdfRows(dayRows, rl));
  pdf.addTable(siteHeaders, pdfRows(siteRows, rl));
  pdf.addTable(paymentHeaders, pdfRows(paymentRows, rl));

  const data = await pdf.build();
  return { data, fileName: `revenue-report-${String(Date.now())}.pdf` };
}
