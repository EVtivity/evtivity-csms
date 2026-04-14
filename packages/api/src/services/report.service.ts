// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, sql } from 'drizzle-orm';
import { db, reports } from '@evtivity/database';
import type { FastifyBaseLogger } from 'fastify';

export interface ReportGeneratorResult {
  data: Buffer;
  fileName: string;
}

export type ReportGenerator = (
  filters: Record<string, unknown>,
  format: string,
) => Promise<ReportGeneratorResult>;

const generatorRegistry = new Map<string, ReportGenerator>();

export function registerGenerator(reportType: string, generator: ReportGenerator): void {
  generatorRegistry.set(reportType, generator);
}

let _log: FastifyBaseLogger | null = null;

export function setReportLogger(log: FastifyBaseLogger): void {
  _log = log;
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
    })
    .from(reports)
    .where(eq(reports.id, reportId));

  if (report == null) return;

  const generator = generatorRegistry.get(report.reportType);
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
    const result = await generator(filters, report.format);

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
    _log?.error({ reportId, error: err }, 'Report generation failed');
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
