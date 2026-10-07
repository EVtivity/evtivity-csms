// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, and, eq, count } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  sites,
  drivers,
  paymentRecords,
  getSystemTimezone,
} from '@evtivity/database';
import { sessionCurrencySql } from '../company-currency.js';
import { buildCsv } from './csv-builder.js';
import { buildXlsx } from './xlsx-builder.js';
import { PdfReportBuilder } from './pdf-builder.js';
import { splitGrossByTaxRate, vatPercentFromFraction } from '@evtivity/lib';
import { storedCostBreakdown } from '@evtivity/lib';
import type { UiLanguage } from '@evtivity/lib/languages';
import { csvRows, moneyCell, pdfRows } from './report-cells.js';
import { reportLocale } from './report-locale.js';
import type { ReportGeneratorResult } from '../report-registry.js';

interface Filters {
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  siteId?: string | undefined;
  stationId?: string | undefined;
  status?: string | undefined;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseFilters(raw: Record<string, unknown>): Filters {
  const dateFromRaw = typeof raw['dateFrom'] === 'string' ? raw['dateFrom'] : undefined;
  const dateToRaw = typeof raw['dateTo'] === 'string' ? raw['dateTo'] : undefined;
  return {
    // Drop malformed dates so the generator doesn't bind Invalid Date into SQL
    // (which silently returns zero rows on Postgres). A 400 from the route is
    // the right surface for explicit input errors; scheduled re-runs that
    // somehow inherit a bad string just degrade to no-filter instead of empty.
    dateFrom: dateFromRaw != null && ISO_DATE.test(dateFromRaw) ? dateFromRaw : undefined,
    dateTo: dateToRaw != null && ISO_DATE.test(dateToRaw) ? dateToRaw : undefined,
    siteId: typeof raw['siteId'] === 'string' ? raw['siteId'] : undefined,
    stationId: typeof raw['stationId'] === 'string' ? raw['stationId'] : undefined,
    status: typeof raw['status'] === 'string' ? raw['status'] : undefined,
  };
}

function buildConditions(filters: Filters, tz: string) {
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
  if (filters.stationId != null) {
    conditions.push(eq(chargingSessions.stationId, filters.stationId));
  }
  if (filters.status != null) {
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
  /** Final cost, or the running cost while the session is active; tax included. */
  costCents: number;
  /** True when costCents is the final cost. */
  costIsFinal: boolean;
  /** Net amount and tax in costCents, split at the session's tariff tax rate. */
  netCents: number;
  taxCents: number;
  /** Tax rate as a percentage (19), 0 without one. */
  taxRatePercent: number;
  refundedCents: number;
  currency: string;
  stoppedReason: string;
  paymentSource: string;
}

interface FailedSessionSummary {
  reason: string;
  count: number;
}

const SESSION_LIMIT = 10000;

interface SessionLogResult {
  rows: SessionRow[];
  truncated: boolean;
}

async function querySessionLog(filters: Filters, tz: string): Promise<SessionLogResult> {
  const conditions = buildConditions(filters, tz);

  if (filters.siteId != null) {
    conditions.push(eq(chargingStations.siteId, filters.siteId));
  }

  // Pull the most-recent paymentRecord per session in a correlated subquery so
  // the main join is 1:1. A direct leftJoin duplicates sessions whenever the
  // session has both a pre-auth and a capture (the normal Stripe flow), or any
  // refund.
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
      costCents:
        sql<number>`coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents}, 0)`.mapWith(
          Number,
        ),
      costIsFinal: sql<boolean>`${chargingSessions.finalCostCents} IS NOT NULL`,
      tariffTaxRate: chargingSessions.tariffTaxRate,
      costBreakdown: chargingSessions.costBreakdown,
      refundedCents: sql<number>`coalesce((
        SELECT pr.refunded_amount_cents
        FROM ${paymentRecords} pr
        WHERE pr.session_id = ${chargingSessions.id}
        ORDER BY pr.created_at DESC
        LIMIT 1
      ), 0)`.mapWith(Number),
      currency: sessionCurrencySql(),
      stoppedReason: sql<string>`coalesce(${chargingSessions.stoppedReason}, '')`,
      paymentSource: sql<string>`coalesce((
        SELECT pr.payment_source
        FROM ${paymentRecords} pr
        WHERE pr.session_id = ${chargingSessions.id}
        ORDER BY pr.created_at DESC
        LIMIT 1
      ), '')`,
    })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .leftJoin(sites, eq(chargingStations.siteId, sites.id))
    .leftJoin(drivers, eq(chargingSessions.driverId, drivers.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${chargingSessions.startedAt} desc`)
    // LIMIT+1 lets us flag truncation without a second count(*) on what may be
    // a multi-million-row sessions table.
    .limit(SESSION_LIMIT + 1);

  const truncated = rows.length > SESSION_LIMIT;
  const trimmed = truncated ? rows.slice(0, SESSION_LIMIT) : rows;

  const mapped = trimmed.map((r) => {
    // The net amount and tax stored with the cost by the cost assembly (exact
    // per tax rate). A cost without a stored split (written outside the
    // assembly) is split at the session's tariff rate.
    const taxRate = Number(r.tariffTaxRate ?? 0);
    const split =
      storedCostBreakdown({ costCents: r.costCents, costBreakdown: r.costBreakdown }) ??
      splitGrossByTaxRate(r.costCents, taxRate);
    return {
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
      costIsFinal: r.costIsFinal,
      netCents: split.netCents,
      taxCents: split.taxCents,
      taxRatePercent: vatPercentFromFraction(taxRate),
      refundedCents: r.refundedCents,
      currency: r.currency,
      stoppedReason: r.stoppedReason,
      paymentSource: r.paymentSource,
    };
  });

  return { rows: mapped, truncated };
}

async function queryFailedSessions(
  filters: Filters,
  tz: string,
  unknown: string,
): Promise<FailedSessionSummary[]> {
  const conditions = buildConditions(filters, tz);
  conditions.push(sql`${chargingSessions.status} in ('faulted', 'invalid')`);

  // The failed-session breakdown has to honour the same siteId filter the
  // main session log applies; otherwise picking siteA filters the rows but
  // leaves the summary cross-site.
  if (filters.siteId != null) {
    const rows = await db
      .select({
        reason: sql<string>`coalesce(${chargingSessions.stoppedReason}, ${unknown})`,
        count: count(),
      })
      .from(chargingSessions)
      .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
      .where(and(...conditions, eq(chargingStations.siteId, filters.siteId)))
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`);
    return rows;
  }

  const rows = await db
    .select({
      reason: sql<string>`coalesce(${chargingSessions.stoppedReason}, ${unknown})`,
      count: count(),
    })
    .from(chargingSessions)
    .where(and(...conditions))
    .groupBy(sql`1`)
    .orderBy(sql`2 desc`);

  return rows;
}

export async function generateSessionsReport(
  rawFilters: Record<string, unknown>,
  format: string,
  language: UiLanguage = 'en',
): Promise<ReportGeneratorResult> {
  const filters = parseFilters(rawFilters);
  const rl = reportLocale(language, format);
  const { common, columns } = rl.labels;
  const l = rl.labels.sessions;
  const tz = await getSystemTimezone();

  const [logResult, failedSummary] = await Promise.all([
    querySessionLog(filters, tz),
    queryFailedSessions(filters, tz, common.unknown),
  ]);
  const sessions = logResult.rows;
  const truncationNote = logResult.truncated
    ? rl.fill(l.truncated, { limit: rl.number(SESSION_LIMIT) })
    : null;
  const costInclTax = `${l.columns.cost} (${common.inclTax})`;

  // Money columns are numbers in each session's currency (Currency column).
  const sessionHeaders = [
    l.columns.transactionId,
    columns.station,
    columns.site,
    columns.driver,
    columns.email,
    columns.status,
    columns.started,
    columns.ended,
    columns.durationMin,
    columns.energyKwh,
    costInclTax,
    l.columns.costFinal,
    l.columns.net,
    l.columns.tax,
    l.columns.taxRatePercent,
    l.columns.refunded,
    l.columns.currency,
    l.columns.stoppedReason,
    l.columns.paymentSource,
  ];
  const sessionRows: unknown[][] = sessions.map((s) => [
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
    moneyCell(s.costCents, s.currency),
    s.costIsFinal ? common.yes : common.no,
    moneyCell(s.netCents, s.currency),
    moneyCell(s.taxCents, s.currency),
    s.taxRatePercent,
    moneyCell(s.refundedCents, s.currency),
    s.currency,
    s.stoppedReason,
    s.paymentSource,
  ]);
  const failedHeaders = [l.columns.reason, columns.count];
  const failedRows: unknown[][] = failedSummary.map((f) => [f.reason, f.count]);

  if (format === 'csv') {
    const headers = sessionHeaders;
    const rows: unknown[][] = csvRows(sessionRows);

    if (failedSummary.length > 0) {
      rows.push([]);
      rows.push([l.failedAnalysis]);
      rows.push(failedHeaders);
      rows.push(...failedRows);
    }
    if (truncationNote != null) {
      rows.push([]);
      rows.push([truncationNote]);
    }

    const csv = buildCsv(headers, rows);
    return {
      data: Buffer.from(csv, 'utf-8'),
      fileName: `sessions-report-${String(Date.now())}.csv`,
    };
  } else if (format === 'xlsx') {
    const tables: Array<{ name: string; headers: string[]; rows: unknown[][] }> = [
      {
        name: l.sheets.sessions,
        headers: sessionHeaders,
        rows: sessionRows,
      },
    ];

    if (failedSummary.length > 0) {
      tables.push({
        name: l.sheets.failedSessions,
        headers: failedHeaders,
        rows: failedRows,
      });
    }
    if (truncationNote != null) {
      tables.push({
        name: l.sheets.note,
        headers: [l.columns.resultTruncated],
        rows: [[truncationNote]],
      });
    }

    const data = await buildXlsx(tables);
    return { data, fileName: `sessions-report-${String(Date.now())}.xlsx` };
  }

  // PDF
  const pdf = new PdfReportBuilder(rl.language);
  pdf.addTitle(l.title);
  pdf.addSubtitle(rl.period(filters.dateFrom, filters.dateTo, common.allTime));
  pdf.addSummaryRow(rl.summary(l.summary.totalSessions), rl.number(sessions.length));
  if (truncationNote != null) {
    pdf.addSubtitle(truncationNote);
  }

  pdf.addTable(
    [
      l.columns.transactionIdShort,
      columns.station,
      columns.site,
      columns.driver,
      columns.status,
      columns.duration,
      columns.kwh,
      costInclTax,
    ],
    pdfRows(
      sessions
        .slice(0, 500)
        .map((s) => [
          s.transactionId.slice(0, 8),
          s.stationName,
          s.siteName,
          s.driverName,
          s.status,
          rl.fill(common.minutes, { value: rl.number(s.durationMinutes) }),
          rl.number(s.energyKwh, 1),
          moneyCell(s.costCents, s.currency),
        ]),
      rl,
    ),
  );

  if (failedSummary.length > 0) {
    pdf.addTable([l.columns.failedReason, columns.count], pdfRows(failedRows, rl));
  }

  const data = await pdf.build();
  return { data, fileName: `sessions-report-${String(Date.now())}.pdf` };
}
