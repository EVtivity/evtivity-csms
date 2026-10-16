// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db, reportScheduleAuditLog, writeAudit } from '@evtivity/database';
import type { AuditActor } from '@evtivity/database';
import type { ReportSiteScope } from './report-scope.js';

// Generated and downloaded reports are filed with the report schedule audit
// (the Reports page History): under the schedule that produced the report, or
// under no schedule for a report generated on demand. The snapshot names the
// report (`report:<id>`) and the report id is in `notes`, as for a deleted
// report. The row never holds the report contents.
const REPORT_AUDIT = { table: reportScheduleAuditLog, idColumn: 'report_schedule_id' } as const;

export interface ReportAuditActor {
  actor: AuditActor;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
  actorLabel?: string | null;
}

interface AuditLogger {
  warn: (obj: unknown, msg?: string) => void;
}

/** Records a queued report (`report_generated`). Fail-open: an insert error is logged. */
export async function writeReportGeneratedAudit(
  report: {
    reportId: string;
    name: string;
    reportType: string;
    format: string;
    filters: Record<string, unknown>;
    siteScope: ReportSiteScope;
    scheduleId: number | null;
  },
  actor: ReportAuditActor,
  logger?: AuditLogger,
): Promise<void> {
  if (report.reportId === '') return;
  await writeAudit(
    REPORT_AUDIT,
    {
      entityId: report.scheduleId == null ? null : String(report.scheduleId),
      entityIdSnapshot: `report:${report.reportId}`,
      action: 'report_generated',
      ...actor,
      after: {
        reportId: report.reportId,
        name: report.name,
        reportType: report.reportType,
        format: report.format,
        filters: report.filters,
        siteScope: report.siteScope == null ? null : [...report.siteScope],
        scheduleId: report.scheduleId,
      },
      notes: report.reportId,
    },
    db,
    logger,
  );
}

/** Records a report file download (`report_downloaded`). Fail-open: an insert error is logged. */
export async function writeReportDownloadedAudit(
  report: { reportId: string; name: string; reportType: string; format: string; fileName: string },
  actor: ReportAuditActor,
  logger?: AuditLogger,
): Promise<void> {
  await writeAudit(
    REPORT_AUDIT,
    {
      entityId: null,
      entityIdSnapshot: `report:${report.reportId}`,
      action: 'report_downloaded',
      ...actor,
      after: report,
      notes: report.reportId,
    },
    db,
    logger,
  );
}
