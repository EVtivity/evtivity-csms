// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, lt, sql } from 'drizzle-orm';
import { db, reports, users, getSystemTimezone } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import { isUiLanguage, type UiLanguage } from '@evtivity/lib/languages';
import { ReportGeneratorRegistry, REPORT_FORMATS } from './report-registry.js';
import type { ReportFormat, ReportGeneratorResult } from './report-registry.js';
import { generateNeviReport, neviFiltersError } from './report-generators/nevi-report.js';
import { generateRevenueReport } from './report-generators/revenue-report.js';
import { generateEnergyReport } from './report-generators/energy-report.js';
import { generateSessionsReport } from './report-generators/sessions-report.js';
import { generateUtilizationReport } from './report-generators/utilization-report.js';
import { generateStationHealthReport } from './report-generators/station-health-report.js';
import { generateSustainabilityReport } from './report-generators/sustainability-report.js';
import { generateDriverActivityReport } from './report-generators/driver-activity-report.js';

const log = createLogger('reports');

/**
 * Compute the next-run-at timestamp for a report schedule, anchored at 6 AM in
 * the system timezone. Delegated to Postgres so date arithmetic (DST, end-of-
 * month clamp) is correct regardless of the API/worker host's timezone — JS
 * `Date#setHours` runs in the host's local tz, and `setMonth + setDate` walks
 * off the end of short months (Jan 31 + 1 month → Mar 3 in JS, vs Feb 28 in
 * Postgres).
 */
export async function computeNextRunAtInTz(
  frequency: string,
  dayOfWeek: number | null,
  dayOfMonth: number | null,
): Promise<Date> {
  const tz = await getSystemTimezone();
  const dow = dayOfWeek ?? 1;
  const dom = dayOfMonth ?? 1;
  const rows = await db.execute(sql`
    SELECT (
      CASE ${frequency}::text
        WHEN 'daily' THEN
          (date_trunc('day', (now() AT TIME ZONE ${tz}) + interval '1 day') + interval '6 hours')
            AT TIME ZONE ${tz}
        WHEN 'weekly' THEN (
          -- Postgres dow: 0=Sun..6=Sat, matching JS getDay()
          date_trunc('day', now() AT TIME ZONE ${tz})
            + interval '1 day' * (
                ((${dow}::int - extract(dow from now() AT TIME ZONE ${tz})::int + 7) % 7 + 6) % 7 + 1
              )
            + interval '6 hours'
        ) AT TIME ZONE ${tz}
        WHEN 'monthly' THEN (
          -- Last day of NEXT month (date_trunc('month', +2mo) - 1 day) gives
          -- the max-clamp for dom; then add (dom-1) days to land on the
          -- requested day of the next month.
          date_trunc('month', (now() AT TIME ZONE ${tz}) + interval '1 month')
            + interval '1 day' * (
                LEAST(
                  ${dom}::int,
                  extract(day from
                    date_trunc('month', (now() AT TIME ZONE ${tz}) + interval '2 month')
                      - interval '1 day'
                  )::int
                ) - 1
              )
            + interval '6 hours'
        ) AT TIME ZONE ${tz}
        ELSE
          (date_trunc('day', (now() AT TIME ZONE ${tz}) + interval '1 day') + interval '6 hours')
            AT TIME ZONE ${tz}
      END
    ) AS next_run_at
  `);
  // db.execute returns timestamptz columns as strings rather than Date
  // objects (unlike the type-aware db.select path). Drizzle's INSERT path
  // calls .toISOString() on the value, so we have to coerce to Date here.
  const row = (rows as unknown as Array<{ next_run_at: Date | string }>)[0];
  if (row == null) {
    throw new Error('Failed to compute next_run_at');
  }
  return row.next_run_at instanceof Date ? row.next_run_at : new Date(row.next_run_at);
}

/** Built-in report types. The API validates requests against this list. */
export const REPORT_TYPES = [
  'nevi',
  'revenue',
  'energy',
  'sessions',
  'utilization',
  'stationHealth',
  'sustainability',
  'driverActivity',
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

// The worker generates every report (`reports` queue); the API only stores and
// announces it. Schedules render ad hoc files with renderReport, so the built-in
// generators are registered here, once per process, rather than at startup.
export const reportGenerators = new ReportGeneratorRegistry();

// Registration order is the order the CSMS lists the types in.
for (const [type, generate] of [
  ['revenue', generateRevenueReport],
  ['utilization', generateUtilizationReport],
  ['energy', generateEnergyReport],
  ['stationHealth', generateStationHealthReport],
  ['sessions', generateSessionsReport],
  ['sustainability', generateSustainabilityReport],
  ['driverActivity', generateDriverActivityReport],
] as const) {
  reportGenerators.register({ type, generate, formats: REPORT_FORMATS, generateFromUi: true });
}
reportGenerators.register({
  type: 'nevi',
  generate: generateNeviReport,
  // The EV-ChART template is an XLSX workbook. Its quarter and year come from
  // the NEVI Compliance tab, so the Generate and Schedules tabs do not offer it.
  formats: ['xlsx'],
  generateFromUi: false,
  validateFilters: neviFiltersError,
});

export interface ReportTypeInfo {
  type: string;
  formats: readonly ReportFormat[];
  generateFromUi: boolean;
}

/** The registered report types, for the CSMS report pages. */
export function listReportTypes(): ReportTypeInfo[] {
  return reportGenerators.list().map(({ type, formats, generateFromUi }) => ({
    type,
    formats,
    generateFromUi,
  }));
}

/** Why the filters cannot produce this report type, or null when they can. */
export function reportFiltersError(
  reportType: string,
  filters: Record<string, unknown>,
): string | null {
  return reportGenerators.get(reportType)?.validateFilters?.(filters) ?? null;
}

/**
 * The language of an operator's report files: the user's stored UI language,
 * English for an unknown user or an unsupported value.
 */
export async function operatorReportLanguage(userId: string | null): Promise<UiLanguage> {
  if (userId == null || userId === '') return 'en';
  const [user] = await db
    .select({ language: users.language })
    .from(users)
    .where(eq(users.id, userId));
  return isUiLanguage(user?.language) ? user.language : 'en';
}

/**
 * Builds a report file without storing it. The scheduled report email uses it
 * for recipients whose language differs from the stored report's. Throws for
 * an unknown report type or a generator error.
 */
export async function renderReport(
  reportType: string,
  filters: Record<string, unknown>,
  format: string,
  language: UiLanguage,
): Promise<ReportGeneratorResult> {
  const descriptor = reportGenerators.get(reportType);
  if (descriptor == null) {
    throw new Error(`No generator registered for report type: ${reportType}`);
  }
  return descriptor.generate(filters, format, language);
}

/**
 * Pub/sub channel the API announces a new report on; the worker turns each
 * message into a `reports` job. Payload: `{ reportId }`.
 */
export const REPORT_GENERATE_CHANNEL = 'report_generate';

/** A report still pending this long after it was created is queued again. */
export const REPORT_PENDING_RETRY_MS = 2 * 60_000;

/** A report still generating this long after it was created is marked failed. */
export const REPORT_GENERATING_TIMEOUT_MS = 30 * 60_000;

export const REPORT_TIMED_OUT_ERROR = 'Report generation timed out';

/** BullMQ job id of a report: one job per report, however often it is announced. */
export function reportJobId(reportId: string): string {
  return `report-${reportId}`;
}

/**
 * The format a report's file is written in: the asked format when the generator writes it,
 * else its first format (NEVI is always xlsx), so the row and the download match the file.
 */
export function reportFileFormat(reportType: string, format: string): string {
  const formats: readonly string[] | undefined = reportGenerators.get(reportType)?.formats;
  if (formats == null || formats.includes(format)) return format;
  return formats[0] ?? format;
}

/**
 * Stores a pending report and hands it to `dispatch`, which queues the
 * generation in the worker. A dispatch that fails is logged and the report
 * stays pending; the worker's report sweep queues it again.
 */
export async function queueReport(
  params: {
    name: string;
    reportType: string;
    format: string;
    filters: Record<string, unknown>;
    userId: string | null;
  },
  dispatch: (reportId: string) => Promise<void>,
): Promise<string> {
  const [row] = await db
    .insert(reports)
    .values({
      name: params.name,
      reportType: params.reportType,
      format: reportFileFormat(params.reportType, params.format),
      filters: params.filters,
      generatedById: params.userId,
    })
    .returning({ id: reports.id });

  const reportId = row?.id;
  if (reportId == null) return '';

  try {
    await dispatch(reportId);
  } catch (err: unknown) {
    log.warn({ reportId, err }, 'Failed to queue report generation; the report sweep retries it');
  }

  return reportId;
}

/**
 * Generates a pending report. Only the caller that moves it from pending to
 * generating runs the generator, so a job delivered twice does the work once.
 * The final status is written only while the report is still generating, so a
 * report the sweep timed out stays failed.
 */
export async function generateReport(reportId: string): Promise<void> {
  const [report] = await db
    .update(reports)
    .set({ status: 'generating' })
    .where(and(eq(reports.id, reportId), eq(reports.status, 'pending')))
    .returning({
      reportType: reports.reportType,
      format: reports.format,
      filters: reports.filters,
      generatedById: reports.generatedById,
    });

  if (report == null) {
    log.debug({ reportId }, 'Report is not pending; skipping generation');
    return;
  }

  const stillGenerating = and(eq(reports.id, reportId), eq(reports.status, 'generating'));

  const generator = reportGenerators.get(report.reportType)?.generate;
  if (generator == null) {
    await db
      .update(reports)
      .set({
        status: 'failed',
        error: `No generator registered for report type: ${report.reportType}`,
        completedAt: sql`now()`,
      })
      .where(stillGenerating);
    return;
  }

  try {
    const filters = report.filters != null ? (report.filters as Record<string, unknown>) : {};
    // On-demand reports are in the requesting operator's language; a scheduled
    // report's stored file is in the schedule creator's language.
    const language = await operatorReportLanguage(report.generatedById);
    const result = await generator(filters, report.format, language);

    await db
      .update(reports)
      .set({
        status: 'completed',
        fileData: result.data,
        fileName: result.fileName,
        fileSize: result.data.length,
        completedAt: sql`now()`,
      })
      .where(stillGenerating);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    log.error({ reportId, error: err }, 'Report generation failed');
    await db
      .update(reports)
      .set({
        status: 'failed',
        error: errorMsg.slice(0, 1000),
        completedAt: sql`now()`,
      })
      .where(stillGenerating);
  }
}

/**
 * Report sweep, run by the worker: returns the ids of reports still pending
 * after `REPORT_PENDING_RETRY_MS` (their queue message was lost) so they are
 * queued again, and marks failed the reports still generating after
 * `REPORT_GENERATING_TIMEOUT_MS` (the worker running them stopped).
 */
export async function sweepStaleReports(): Promise<{ pending: string[]; timedOut: number }> {
  const pendingBefore = new Date(Date.now() - REPORT_PENDING_RETRY_MS);
  const generatingBefore = new Date(Date.now() - REPORT_GENERATING_TIMEOUT_MS);

  const pendingRows = await db
    .select({ id: reports.id })
    .from(reports)
    .where(and(eq(reports.status, 'pending'), lt(reports.createdAt, pendingBefore)));

  const timedOutRows = await db
    .update(reports)
    .set({ status: 'failed', error: REPORT_TIMED_OUT_ERROR, completedAt: sql`now()` })
    .where(and(eq(reports.status, 'generating'), lt(reports.createdAt, generatingBefore)))
    .returning({ id: reports.id });

  return { pending: pendingRows.map((row) => row.id), timedOut: timedOutRows.length };
}
