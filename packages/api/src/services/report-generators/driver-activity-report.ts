// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, and, gte, lte, eq, count, type SQL } from 'drizzle-orm';
import { db, chargingSessions, drivers, getCompanyCurrency } from '@evtivity/database';
import { buildCsv } from './csv-builder.js';
import { buildXlsx } from './xlsx-builder.js';
import { PdfReportBuilder } from './pdf-builder.js';
import { queryRevenue, revenueItem } from '../../lib/session-revenue.js';
import {
  csvMoneyRows,
  moneyCell,
  moneyHeader,
  pdfMoneyRows,
  type MoneyCell,
} from './report-money.js';
import type { ReportGeneratorResult } from '../report.service.js';

interface Filters {
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
}

function parseFilters(raw: Record<string, unknown>): Filters {
  return {
    dateFrom: typeof raw['dateFrom'] === 'string' ? raw['dateFrom'] : undefined,
    dateTo: typeof raw['dateTo'] === 'string' ? raw['dateTo'] : undefined,
  };
}

function dateBounds(filters: Filters): { from: Date | null; to: Date | null } {
  const from = filters.dateFrom ? new Date(filters.dateFrom) : null;
  let to: Date | null = null;
  if (filters.dateTo) {
    to = new Date(filters.dateTo);
    to.setHours(23, 59, 59, 999);
  }
  return { from, to };
}

function buildDateConditions(filters: Filters) {
  const { from, to } = dateBounds(filters);
  const conditions = [];
  if (from != null) conditions.push(gte(chargingSessions.startedAt, from));
  if (to != null) conditions.push(lte(chargingSessions.startedAt, to));
  return conditions;
}

interface DriverActivity {
  driverName: string;
  driverEmail: string;
  sessionCount: number;
  totalKwh: number;
  totalSpendCents: number;
  avgDurationMinutes: number;
  firstSession: string | null;
  lastSession: string | null;
}

async function queryDriverActivity(filters: Filters, currency: string): Promise<DriverActivity[]> {
  const conditions = [
    ...buildDateConditions(filters),
    sql`${chargingSessions.driverId} IS NOT NULL`,
  ];

  const rows = await db
    .select({
      driverId: drivers.id,
      driverFirstName: sql<string>`coalesce(${drivers.firstName}, '')`,
      driverLastName: sql<string>`coalesce(${drivers.lastName}, '')`,
      driverEmail: sql<string>`coalesce(${drivers.email}, '')`,
      sessionCount: count(),
      totalKwh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric / 1000), 0)`,
      avgDurationMinutes: sql<number>`coalesce(avg(extract(epoch from (coalesce(${chargingSessions.endedAt}, now()) - ${chargingSessions.startedAt})) / 60), 0)`,
      firstSession: sql<string>`min(${chargingSessions.startedAt})::text`,
      lastSession: sql<string>`max(${chargingSessions.startedAt})::text`,
    })
    .from(chargingSessions)
    .innerJoin(drivers, eq(chargingSessions.driverId, drivers.id))
    .where(and(...conditions))
    .groupBy(drivers.id, drivers.firstName, drivers.lastName, drivers.email)
    .orderBy(sql`5 desc`)
    .limit(500);

  // Spend is the drivers' revenue (session-revenue.ts): ended sessions and
  // reservation fees billed in the company currency, minus refunds.
  const { from, to } = dateBounds(filters);
  const where: SQL[] = [
    sql`${revenueItem.driverId} IN (${sql.join(
      rows.length > 0 ? rows.map((r) => sql`${r.driverId}`) : [sql`NULL`],
      sql`, `,
    )})`,
  ];
  if (from != null)
    where.push(sql`${revenueItem.occurredAt} >= ${from.toISOString()}::timestamptz`);
  if (to != null) where.push(sql`${revenueItem.occurredAt} <= ${to.toISOString()}::timestamptz`);
  const spend = await queryRevenue({ companyCurrency: currency, key: revenueItem.driverId, where });

  return rows.map((r) => ({
    driverName: [r.driverFirstName, r.driverLastName].filter(Boolean).join(' '),
    driverEmail: r.driverEmail,
    sessionCount: r.sessionCount,
    totalKwh: Math.round(r.totalKwh * 100) / 100,
    totalSpendCents: spend.get(r.driverId)?.grossCents ?? 0,
    avgDurationMinutes: Math.round(r.avgDurationMinutes * 10) / 10,
    firstSession: r.firstSession,
    lastSession: r.lastSession,
  }));
}

export async function generateDriverActivityReport(
  rawFilters: Record<string, unknown>,
  format: string,
): Promise<ReportGeneratorResult> {
  const filters = parseFilters(rawFilters);
  const currency = await getCompanyCurrency();
  const driverActivity = await queryDriverActivity(filters, currency);

  const dateLabel = [filters.dateFrom, filters.dateTo].filter(Boolean).join(' to ') || 'All time';
  const totalDrivers = driverActivity.length;
  const totalSessions = driverActivity.reduce((s, r) => s + r.sessionCount, 0);
  const totalKwh = driverActivity.reduce((s, r) => s + r.totalKwh, 0);

  const spendHeader = moneyHeader('Total Spend', currency, 'incl. tax');
  const headers = [
    'Driver',
    'Email',
    'Sessions',
    'Total kWh',
    spendHeader,
    'Avg Duration (min)',
    'First Session',
    'Last Session',
  ];
  const rows: unknown[][] = driverActivity.map((d) => [
    d.driverName,
    d.driverEmail,
    d.sessionCount,
    Math.round(d.totalKwh * 100) / 100,
    moneyCell(d.totalSpendCents, currency),
    d.avgDurationMinutes,
    d.firstSession,
    d.lastSession,
  ]);

  if (format === 'csv') {
    const csv = buildCsv(headers, csvMoneyRows(rows));
    return {
      data: Buffer.from(csv, 'utf-8'),
      fileName: `driver-activity-${String(Date.now())}.csv`,
    };
  } else if (format === 'xlsx') {
    const data = await buildXlsx([{ name: 'Driver Activity', headers, rows }]);
    return { data, fileName: `driver-activity-${String(Date.now())}.xlsx` };
  }

  const pdf = new PdfReportBuilder();
  pdf.addTitle('Driver Activity Report');
  pdf.addSubtitle(`Period: ${dateLabel}`);
  pdf.addSummaryRow('Active Drivers:', String(totalDrivers));
  pdf.addSummaryRow('Total Sessions:', String(totalSessions));
  pdf.addSummaryRow('Total Energy:', `${totalKwh.toFixed(2)} kWh`);

  const spend = (d: DriverActivity): MoneyCell => moneyCell(d.totalSpendCents, currency);
  pdf.addTable(
    ['Driver', 'Email', 'Sessions', 'kWh', 'Spend (incl. tax)', 'Avg Duration'],
    pdfMoneyRows(
      driverActivity
        .slice(0, 200)
        .map((d) => [
          d.driverName,
          d.driverEmail,
          d.sessionCount,
          parseFloat(String(d.totalKwh)).toFixed(1),
          spend(d),
          `${String(d.avgDurationMinutes)}m`,
        ]),
    ),
  );

  const data = await pdf.build();
  return { data, fileName: `driver-activity-${String(Date.now())}.pdf` };
}
