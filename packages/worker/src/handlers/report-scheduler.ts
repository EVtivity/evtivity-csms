// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, inArray, lte, sql } from 'drizzle-orm';
import { db, client, reportSchedules, reports, users } from '@evtivity/database';
import type { Logger } from 'pino';
import {
  queueReport,
  computeNextRunAtInTz,
  operatorReportLanguage,
  renderReport,
  sweepStaleReports,
} from '@evtivity/services/report.service';
import { getNotificationSettings, sendEmail, renderTemplate, wrapEmailHtml } from '@evtivity/lib';
import type { EmailAttachment, RenderedTemplate } from '@evtivity/lib';
import { isUiLanguage } from '@evtivity/lib/languages';
import { API_TEMPLATES_DIR } from '@evtivity/services/template-dirs';
import { enqueueReport } from '../report-worker.js';

export async function reportSchedulerHandler(log: Logger): Promise<void> {
  await sweepReports(log);

  const now = new Date();
  const dueSchedules = await db
    .select()
    .from(reportSchedules)
    .where(and(eq(reportSchedules.isEnabled, true), lte(reportSchedules.nextRunAt, now)));

  // Process schedules concurrently so a single stuck waitForReport (5-min
  // timeout) doesn't block the others. Promise.allSettled keeps one failure
  // from aborting the whole tick.
  await Promise.allSettled(dueSchedules.map((schedule) => runOneSchedule(schedule, now, log)));
}

async function runOneSchedule(
  schedule: typeof reportSchedules.$inferSelect,
  now: Date,
  log: Logger,
): Promise<void> {
  try {
    const filters = schedule.filters != null ? (schedule.filters as Record<string, unknown>) : {};
    const reportId = await queueReport(
      {
        name: schedule.name,
        reportType: schedule.reportType,
        format: schedule.format,
        filters,
        userId: schedule.createdById,
      },
      enqueueReport,
    );

    log.info(
      { scheduleId: schedule.id, reportId, reportType: schedule.reportType },
      'Scheduled report queued',
    );

    const nextRunAt = await computeNextRunAtInTz(
      schedule.frequency,
      schedule.dayOfWeek,
      schedule.dayOfMonth,
    );

    await db
      .update(reportSchedules)
      .set({ lastRunAt: now, nextRunAt, updatedAt: sql`now()` })
      .where(eq(reportSchedules.id, schedule.id));

    const recipientEmails = schedule.recipientEmails as string[] | null;
    if (recipientEmails == null || recipientEmails.length === 0) return;

    const completedReport = await waitForReport(reportId, log);
    const notificationSettings = await getNotificationSettings(client);
    if (notificationSettings.smtp == null) return;

    const attachmentsFor = await reportAttachments(schedule, completedReport, filters, log);
    const companyRows = await client`SELECT value FROM settings WHERE key = 'company.name'`;
    const companyName = (companyRows[0]?.value as string | undefined) ?? 'EVtivity CSMS';
    const templateVars = {
      companyName,
      reportName: schedule.name,
      generatedAt: new Date().toISOString(),
    };
    // Each recipient gets the email in their operator account language, like
    // other operator notifications. An address without a user account gets en.
    const languageByEmail = await recipientLanguages(recipientEmails);
    const renderedByLanguage = new Map<string, RenderedTemplate>();
    for (const recipientEmail of recipientEmails) {
      const language = languageByEmail.get(recipientEmail.toLowerCase()) ?? 'en';
      let rendered = renderedByLanguage.get(language);
      if (rendered == null) {
        rendered = await renderTemplate(
          'email',
          'report.Scheduled',
          language,
          templateVars,
          client,
          undefined,
          API_TEMPLATES_DIR,
        );
        renderedByLanguage.set(language, rendered);
      }
      const wrappedHtml =
        rendered.html != null
          ? wrapEmailHtml(
              rendered.html,
              companyName,
              notificationSettings.emailWrapperTemplate,
              templateVars,
            )
          : undefined;
      const ok = await sendEmail(
        notificationSettings.smtp,
        recipientEmail,
        rendered.subject,
        rendered.body,
        wrappedHtml,
        await attachmentsFor(language),
      );
      const storedBody = wrappedHtml ?? rendered.body;
      await client`
        INSERT INTO notifications (channel, recipient, subject, body, status, event_type, sent_at, metadata)
        VALUES ('email', ${recipientEmail}, ${rendered.subject}, ${storedBody}, ${ok ? 'sent' : 'failed'}, 'report.Scheduled', NOW(), ${client.json({ scheduleId: schedule.id })})
      `;
    }
  } catch (err: unknown) {
    log.error({ scheduleId: schedule.id, error: err }, 'Failed to run scheduled report');
  }
}

// Stored language of the operator users among the recipients, keyed by
// lowercased email.
async function recipientLanguages(emails: string[]): Promise<Map<string, string>> {
  const lowered = [...new Set(emails.map((e) => e.toLowerCase()))];
  const rows = await db
    .select({ email: users.email, language: users.language })
    .from(users)
    .where(inArray(sql`lower(${users.email})`, lowered));
  return new Map(rows.map((r) => [r.email.toLowerCase(), r.language]));
}

const CONTENT_TYPES: Record<string, string> = {
  csv: 'text/csv',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * The report attachment in each recipient language, built once per language.
 * The stored report (in the schedule creator's language) is reused for that
 * language; other languages are generated in memory. A file that fails to
 * generate is logged and the email goes without it, as when the stored report
 * fails. No attachment at all when the stored report did not complete.
 */
async function reportAttachments(
  schedule: typeof reportSchedules.$inferSelect,
  storedReport: { fileData: Buffer; fileName: string } | null,
  filters: Record<string, unknown>,
  log: Logger,
): Promise<(language: string) => Promise<EmailAttachment[] | undefined>> {
  if (storedReport == null) return () => Promise.resolve(undefined);
  const contentType = CONTENT_TYPES[schedule.format] ?? 'application/octet-stream';
  const storedLanguage = await operatorReportLanguage(schedule.createdById);
  const byLanguage = new Map<string, EmailAttachment[] | undefined>([
    [
      storedLanguage,
      [{ filename: storedReport.fileName, content: storedReport.fileData, contentType }],
    ],
  ]);
  return async (language) => {
    const key = isUiLanguage(language) ? language : 'en';
    if (byLanguage.has(key)) return byLanguage.get(key);
    let attachments: EmailAttachment[] | undefined;
    try {
      const file = await renderReport(schedule.reportType, filters, schedule.format, key);
      attachments = [{ filename: file.fileName, content: file.data, contentType }];
    } catch (err: unknown) {
      log.warn(
        { scheduleId: schedule.id, language: key, err },
        'Scheduled report attachment failed in this language, sending without it',
      );
    }
    byLanguage.set(key, attachments);
    return attachments;
  };
}

async function waitForReport(
  reportId: string,
  log: Logger,
): Promise<{ fileData: Buffer; fileName: string } | null> {
  const maxAttempts = 60;
  const intervalMs = 5000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const [report] = await db
      .select({ status: reports.status, fileData: reports.fileData, fileName: reports.fileName })
      .from(reports)
      .where(eq(reports.id, reportId));

    if (report == null) return null;
    if (report.status === 'completed') {
      if (report.fileData != null && report.fileName != null) {
        return { fileData: report.fileData, fileName: report.fileName };
      }
      return null;
    }
    if (report.status === 'failed') {
      log.warn({ reportId }, 'Scheduled report generation failed, skipping email attachment');
      return null;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  log.warn({ reportId }, 'Scheduled report did not complete within timeout');
  return null;
}

/**
 * Queues again the reports whose queue message was lost and fails the ones a
 * stopped worker left generating. Fail-open: a sweep error never stops the
 * scheduled reports.
 */
async function sweepReports(log: Logger): Promise<void> {
  try {
    const { pending, timedOut } = await sweepStaleReports();
    for (const reportId of pending) {
      await enqueueReport(reportId);
    }
    if (pending.length > 0 || timedOut > 0) {
      log.info({ requeued: pending.length, timedOut }, 'Stale reports swept');
    }
  } catch (err: unknown) {
    log.warn({ err }, 'Report sweep failed');
  }
}
