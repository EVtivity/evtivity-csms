// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, and, gte, lte, eq, count } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  sites,
  drivers,
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
  stationId?: string | undefined;
  status?: string | undefined;
}

function parseFilters(raw: Record<string, unknown>): Filters {
  return {
    dateFrom: typeof raw['dateFrom'] === 'string' ? raw['dateFrom'] : undefined,
    dateTo: typeof raw['dateTo'] === 'string' ? raw['dateTo'] : undefined,
    siteId: typeof raw['siteId'] === 'string' ? raw['siteId'] : undefined,
    stationId: typeof raw['stationId'] === 'string' ? raw['stationId'] : undefined,
    status: typeof raw['status'] === 'string' ? raw['status'] : undefined,
  };
}

async function getTimezone(): Promise<string> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'system.timezone'));
  return typeof row?.value === 'string' ? row.value : 'America/New_York';
}

function buildConditions(filters: Filters) {
  const conditions = [];
  if (filters.dateFrom) {
    conditions.push(gte(chargingSessions.startedAt, new Date(filters.dateFrom)));
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    to.setHours(23, 59, 59, 999);
    conditions.push(lte(chargingSessions.startedAt, to));
  }
  if (filters.stationId) {
    conditions.push(eq(chargingSessions.stationId, filters.stationId));
  }
  if (filters.status) {
    conditions.push(sql`${chargingSessions.status} = ${filters.status}`);
  }
  return conditions;
}

interface SessionRow {
  sessionId: string;
  transactionId: string;
  stationName: string;
  siteName: string;
  driverName: string;
  driverEmail: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMinutes: number;
  energyKwh: number;
  costCents: number;
  stoppedReason: string;
  paymentSource: string;
}

interface FailedSessionSummary {
  reason: string;
  count: number;
}

async function querySessionLog(filters: Filters, tz: string): Promise<SessionRow[]> {
  const conditions = buildConditions(filters);

  if (filters.siteId) {
    conditions.push(eq(chargingStations.siteId, filters.siteId));
  }

  const rows = await db
    .select({
      sessionId: chargingSessions.id,
      transactionId: chargingSessions.transactionId,
      stationName: sql<string>`coalesce(${chargingStations.stationId}, ${chargingStations.id}::text)`,
      siteName: sql<string>`coalesce(${sites.name}, '')`,
      driverFirstName: sql<string>`coalesce(${drivers.firstName}, '')`,
      driverLastName: sql<string>`coalesce(${drivers.lastName}, '')`,
      driverEmail: sql<string>`coalesce(${drivers.email}, '')`,
      status: chargingSessions.status,
      startedAt: sql<string>`${chargingSessions.startedAt} AT TIME ZONE ${tz}`,
      endedAt: sql<string>`${chargingSessions.endedAt} AT TIME ZONE ${tz}`,
      durationMinutes: sql<number>`coalesce(extract(epoch from (${chargingSessions.endedAt} - ${chargingSessions.startedAt})) / 60, 0)`,
      energyKwh: sql<number>`coalesce(${chargingSessions.energyDeliveredWh}::numeric / 1000, 0)`,
      costCents: sql<number>`coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents}, 0)`,
      stoppedReason: sql<string>`coalesce(${chargingSessions.stoppedReason}, '')`,
      paymentSource: sql<string>`coalesce(${paymentRecords.paymentSource}, '')`,
    })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .leftJoin(sites, eq(chargingStations.siteId, sites.id))
    .leftJoin(drivers, eq(chargingSessions.driverId, drivers.id))
    .leftJoin(paymentRecords, eq(paymentRecords.sessionId, chargingSessions.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${chargingSessions.startedAt} desc`)
    .limit(10000);

  return rows.map((r) => ({
    sessionId: r.sessionId,
    transactionId: r.transactionId,
    stationName: r.stationName,
    siteName: r.siteName,
    driverName: [r.driverFirstName, r.driverLastName].filter(Boolean).join(' '),
    driverEmail: r.driverEmail,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationMinutes: Math.round(r.durationMinutes * 10) / 10,
    energyKwh: Math.round(r.energyKwh * 100) / 100,
    costCents: r.costCents,
    stoppedReason: r.stoppedReason,
    paymentSource: r.paymentSource,
  }));
}

async function queryFailedSessions(filters: Filters): Promise<FailedSessionSummary[]> {
  const conditions = buildConditions(filters);
  conditions.push(sql`${chargingSessions.status} in ('faulted', 'invalid')`);

  const rows = await db
    .select({
      reason: sql<string>`coalesce(${chargingSessions.stoppedReason}, 'Unknown')`,
      count: count(),
    })
    .from(chargingSessions)
    .where(and(...conditions))
    .groupBy(sql`1`)
    .orderBy(sql`2 desc`);

  return rows;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function generateSessionsReport(
  rawFilters: Record<string, unknown>,
  format: string,
): Promise<ReportGeneratorResult> {
  const filters = parseFilters(rawFilters);
  const tz = await getTimezone();

  const [sessions, failedSummary] = await Promise.all([
    querySessionLog(filters, tz),
    queryFailedSessions(filters),
  ]);

  const dateLabel = [filters.dateFrom, filters.dateTo].filter(Boolean).join(' to ') || 'All time';

  if (format === 'csv') {
    const headers = [
      'Transaction ID',
      'Station',
      'Site',
      'Driver',
      'Email',
      'Status',
      'Started',
      'Ended',
      'Duration (min)',
      'Energy (kWh)',
      'Cost ($)',
      'Stopped Reason',
      'Payment Source',
    ];
    const rows: unknown[][] = sessions.map((s) => [
      s.transactionId,
      s.stationName,
      s.siteName,
      s.driverName,
      s.driverEmail,
      s.status,
      s.startedAt,
      s.endedAt,
      s.durationMinutes,
      s.energyKwh,
      formatCents(s.costCents),
      s.stoppedReason,
      s.paymentSource,
    ]);

    if (failedSummary.length > 0) {
      rows.push([]);
      rows.push(['Failed Session Analysis']);
      rows.push(['Reason', 'Count']);
      for (const f of failedSummary) {
        rows.push([f.reason, f.count]);
      }
    }

    const csv = buildCsv(headers, rows);
    return {
      data: Buffer.from(csv, 'utf-8'),
      fileName: `sessions-report-${String(Date.now())}.csv`,
    };
  } else if (format === 'xlsx') {
    const tables: Array<{ name: string; headers: string[]; rows: unknown[][] }> = [
      {
        name: 'Sessions',
        headers: [
          'Transaction ID',
          'Station',
          'Site',
          'Driver',
          'Email',
          'Status',
          'Started',
          'Ended',
          'Duration (min)',
          'Energy (kWh)',
          'Cost ($)',
          'Stopped Reason',
          'Payment Source',
        ],
        rows: sessions.map((s) => [
          s.transactionId,
          s.stationName,
          s.siteName,
          s.driverName,
          s.driverEmail,
          s.status,
          s.startedAt,
          s.endedAt,
          s.durationMinutes,
          s.energyKwh,
          formatCents(s.costCents),
          s.stoppedReason,
          s.paymentSource,
        ]),
      },
    ];

    if (failedSummary.length > 0) {
      tables.push({
        name: 'Failed Sessions',
        headers: ['Reason', 'Count'],
        rows: failedSummary.map((f) => [f.reason, f.count]),
      });
    }

    const data = await buildXlsx(tables);
    return { data, fileName: `sessions-report-${String(Date.now())}.xlsx` };
  }

  // PDF
  const pdf = new PdfReportBuilder();
  pdf.addTitle('Sessions Report');
  pdf.addSubtitle(`Period: ${dateLabel}`);
  pdf.addSummaryRow('Total Sessions:', String(sessions.length));

  pdf.addTable(
    ['Txn ID', 'Station', 'Site', 'Driver', 'Status', 'Duration', 'kWh', 'Cost'],
    sessions
      .slice(0, 500)
      .map((s) => [
        s.transactionId.slice(0, 8),
        s.stationName,
        s.siteName,
        s.driverName,
        s.status,
        `${String(s.durationMinutes)}m`,
        parseFloat(String(s.energyKwh)).toFixed(1),
        formatCents(s.costCents),
      ]),
  );

  if (failedSummary.length > 0) {
    pdf.addTable(
      ['Failed Reason', 'Count'],
      failedSummary.map((f) => [f.reason, f.count]),
    );
  }

  const data = await pdf.build();
  return { data, fileName: `sessions-report-${String(Date.now())}.pdf` };
}
