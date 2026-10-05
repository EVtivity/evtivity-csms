// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, sql } from 'drizzle-orm';
import { db, reports, users, getSystemTimezone } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import { isUiLanguage, type UiLanguage } from '@evtivity/lib/languages';
import { generateNeviReport } from './report-generators/nevi-report.js';
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

export interface ReportGeneratorResult {
  data: Buffer;
  fileName: string;
}

/**
 * Builds a report file. `language` sets its labels and PDF formatting
 * (report-generators/report-locale.ts). NEVI ignores it: the EV-ChART template
 * has fixed English field names.
 */
export type ReportGenerator = (
  filters: Record<string, unknown>,
  format: string,
  language: UiLanguage,
) => Promise<ReportGeneratorResult>;

/** Report types a generator exists for. */
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

// Every process that queues a report generates it in-process (the API for
// operator requests, the worker for schedules), so the generators are part of
// this module rather than registered at startup.
const generators: Record<ReportType, ReportGenerator> = {
  nevi: generateNeviReport,
  revenue: generateRevenueReport,
  energy: generateEnergyReport,
  sessions: generateSessionsReport,
  utilization: generateUtilizationReport,
  stationHealth: generateStationHealthReport,
  sustainability: generateSustainabilityReport,
  driverActivity: generateDriverActivityReport,
};

function isReportType(value: string): value is ReportType {
  return (REPORT_TYPES as readonly string[]).includes(value);
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
  if (!isReportType(reportType)) {
    throw new Error(`No generator registered for report type: ${reportType}`);
  }
  return generators[reportType](filters, format, language);
}

export async function queueReport(params: {
  name: string;
  reportType: string;
  format: string;
  filters: Record<string, unknown>;
  userId: string;
}): Promise<string> {
  const [row] = await db
    .insert(reports)
    .values({
      name: params.name,
      reportType: params.reportType,
      format: params.format,
      filters: params.filters,
      generatedById: params.userId,
    })
    .returning({ id: reports.id });

  const reportId = row?.id;
  if (reportId == null) return '';

  setImmediate(() => {
    void generateReport(reportId);
  });

  return reportId;
}

export async function generateReport(reportId: string): Promise<void> {
  await db.update(reports).set({ status: 'generating' }).where(eq(reports.id, reportId));

  const [report] = await db
    .select({
      reportType: reports.reportType,
      format: reports.format,
      filters: reports.filters,
      generatedById: reports.generatedById,
    })
    .from(reports)
    .where(eq(reports.id, reportId));

  if (report == null) return;

  const generator = isReportType(report.reportType) ? generators[report.reportType] : undefined;
  if (generator == null) {
    await db
      .update(reports)
      .set({
        status: 'failed',
        error: `No generator registered for report type: ${report.reportType}`,
        completedAt: sql`now()`,
      })
      .where(eq(reports.id, reportId));
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
      .where(eq(reports.id, reportId));
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
      .where(eq(reports.id, reportId));
  }
}
