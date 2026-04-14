// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, and, gte, lte, eq, count } from 'drizzle-orm';
import { db, chargingSessions, drivers } from '@evtivity/database';
import { buildCsv } from './csv-builder.js';
import { buildXlsx } from './xlsx-builder.js';
import { PdfReportBuilder } from './pdf-builder.js';
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

async function queryDriverActivity(filters: Filters): Promise<DriverActivity[]> {
  const conditions = [
    ...buildDateConditions(filters),
    sql`${chargingSessions.driverId} IS NOT NULL`,
  ];

  const rows = await db
    .select({
      driverFirstName: sql<string>`coalesce(${drivers.firstName}, '')`,
      driverLastName: sql<string>`coalesce(${drivers.lastName}, '')`,
      driverEmail: sql<string>`coalesce(${drivers.email}, '')`,
      sessionCount: count(),
      totalKwh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric / 1000), 0)`,
      totalSpendCents: sql<number>`coalesce(sum(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})), 0)`,
      avgDurationMinutes: sql<number>`coalesce(avg(extract(epoch from (coalesce(${chargingSessions.endedAt}, now()) - ${chargingSessions.startedAt})) / 60), 0)`,
      firstSession: sql<string>`min(${chargingSessions.startedAt})::text`,
      lastSession: sql<string>`max(${chargingSessions.startedAt})::text`,
    })
    .from(chargingSessions)
    .innerJoin(drivers, eq(chargingSessions.driverId, drivers.id))
    .where(and(...conditions))
    .groupBy(drivers.id, drivers.firstName, drivers.lastName, drivers.email)
    .orderBy(sql`4 desc`)
    .limit(500);

  return rows.map((r) => ({
    driverName: [r.driverFirstName, r.driverLastName].filter(Boolean).join(' '),
    driverEmail: r.driverEmail,
    sessionCount: r.sessionCount,
    totalKwh: Math.round(r.totalKwh * 100) / 100,
    totalSpendCents: r.totalSpendCents,
    avgDurationMinutes: Math.round(r.avgDurationMinutes * 10) / 10,
    firstSession: r.firstSession,
    lastSession: r.lastSession,
  }));
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function generateDriverActivityReport(
  rawFilters: Record<string, unknown>,
  format: string,
): Promise<ReportGeneratorResult> {
  const filters = parseFilters(rawFilters);
  const driverActivity = await queryDriverActivity(filters);

  const dateLabel = [filters.dateFrom, filters.dateTo].filter(Boolean).join(' to ') || 'All time';
  const totalDrivers = driverActivity.length;
  const totalSessions = driverActivity.reduce((s, r) => s + r.sessionCount, 0);
  const totalKwh = driverActivity.reduce((s, r) => s + r.totalKwh, 0);

  if (format === 'csv') {
    const headers = [
      'Driver',
      'Email',
      'Sessions',
      'Total kWh',
      'Total Spend ($)',
      'Avg Duration (min)',
      'First Session',
      'Last Session',
    ];
    const rows: unknown[][] = driverActivity.map((d) => [
      d.driverName,
      d.driverEmail,
      d.sessionCount,
      parseFloat(String(d.totalKwh)).toFixed(2),
      formatCents(d.totalSpendCents),
      d.avgDurationMinutes,
      d.firstSession,
      d.lastSession,
    ]);

    const csv = buildCsv(headers, rows);
    return {
      data: Buffer.from(csv, 'utf-8'),
      fileName: `driver-activity-${String(Date.now())}.csv`,
    };
  } else if (format === 'xlsx') {
    const data = await buildXlsx([
      {
        name: 'Driver Activity',
        headers: [
          'Driver',
          'Email',
          'Sessions',
          'Total kWh',
          'Total Spend ($)',
          'Avg Duration (min)',
          'First Session',
          'Last Session',
        ],
        rows: driverActivity.map((d) => [
          d.driverName,
          d.driverEmail,
          d.sessionCount,
          parseFloat(String(d.totalKwh)).toFixed(2),
          formatCents(d.totalSpendCents),
          d.avgDurationMinutes,
          d.firstSession,
          d.lastSession,
        ]),
      },
    ]);
    return { data, fileName: `driver-activity-${String(Date.now())}.xlsx` };
  }

  const pdf = new PdfReportBuilder();
  pdf.addTitle('Driver Activity Report');
  pdf.addSubtitle(`Period: ${dateLabel}`);
  pdf.addSummaryRow('Active Drivers:', String(totalDrivers));
  pdf.addSummaryRow('Total Sessions:', String(totalSessions));
  pdf.addSummaryRow('Total Energy:', `${totalKwh.toFixed(2)} kWh`);

  pdf.addTable(
    ['Driver', 'Email', 'Sessions', 'kWh', 'Spend', 'Avg Duration'],
    driverActivity
      .slice(0, 200)
      .map((d) => [
        d.driverName,
        d.driverEmail,
        d.sessionCount,
        parseFloat(String(d.totalKwh)).toFixed(1),
        formatCents(d.totalSpendCents),
        `${String(d.avgDurationMinutes)}m`,
      ]),
  );

  const data = await pdf.build();
  return { data, fileName: `driver-activity-${String(Date.now())}.pdf` };
}
