// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, lte, sql } from 'drizzle-orm';
import { db, client, reportSchedules, reports } from '@evtivity/database';
import type { Logger } from 'pino';
import { queueReport } from '@evtivity/api/src/services/report.service.js';
import { getNotificationSettings, sendEmail, renderTemplate, wrapEmailHtml } from '@evtivity/lib';
import type { EmailAttachment } from '@evtivity/lib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR =
  process.env['API_TEMPLATES_DIR'] ??
  resolve(currentDir, '..', '..', '..', 'api', 'src', 'templates');

export async function reportSchedulerHandler(log: Logger): Promise<void> {
  const now = new Date();
  const dueSchedules = await db
    .select()
    .from(reportSchedules)
    .where(and(eq(reportSchedules.isEnabled, true), lte(reportSchedules.nextRunAt, now)));

  for (const schedule of dueSchedules) {
    try {
      const filters = schedule.filters != null ? (schedule.filters as Record<string, unknown>) : {};
      const reportId = await queueReport({
        name: schedule.name,
        reportType: schedule.reportType,
        format: schedule.format,
        filters,
        userId: schedule.createdById ?? '',
      });

      log.info(
        { scheduleId: schedule.id, reportId, reportType: schedule.reportType },
        'Scheduled report queued',
      );

      const nextRunAt = computeNextRunAt(
        schedule.frequency,
        schedule.dayOfWeek,
        schedule.dayOfMonth,
      );

      await db
        .update(reportSchedules)
        .set({ lastRunAt: now, nextRunAt, updatedAt: sql`now()` })
        .where(eq(reportSchedules.id, schedule.id));

      const recipientEmails = schedule.recipientEmails as string[] | null;
      if (recipientEmails != null && recipientEmails.length > 0) {
        const completedReport = await waitForReport(reportId, log);
        const notificationSettings = await getNotificationSettings(client);
        if (notificationSettings.smtp != null) {
          const attachments: EmailAttachment[] = [];
          if (completedReport != null) {
            const contentTypes: Record<string, string> = {
              csv: 'text/csv',
              pdf: 'application/pdf',
              xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            };
            attachments.push({
              filename: completedReport.fileName,
              content: completedReport.fileData,
              contentType: contentTypes[schedule.format] ?? 'application/octet-stream',
            });
          }
          const companyRows = await client`SELECT value FROM settings WHERE key = 'company.name'`;
          const companyName = (companyRows[0]?.value as string | undefined) ?? 'EVtivity CSMS';
          const templateVars = {
            companyName,
            reportName: schedule.name,
            generatedAt: new Date().toISOString(),
          };
          const rendered = await renderTemplate(
            'email',
            'report.Scheduled',
            'en',
            templateVars,
            client,
            undefined,
            TEMPLATES_DIR,
          );
          const wrappedHtml =
            rendered.html != null
              ? wrapEmailHtml(
                  rendered.html,
                  companyName,
                  notificationSettings.emailWrapperTemplate,
                  templateVars,
                )
              : undefined;
          for (const recipientEmail of recipientEmails) {
            const ok = await sendEmail(
              notificationSettings.smtp,
              recipientEmail,
              rendered.subject,
              rendered.body,
              wrappedHtml,
              attachments.length > 0 ? attachments : undefined,
            );
            const storedBody = wrappedHtml ?? rendered.body;
            await client`
              INSERT INTO notifications (channel, recipient, subject, body, status, event_type, sent_at, metadata)
              VALUES ('email', ${recipientEmail}, ${rendered.subject}, ${storedBody}, ${ok ? 'sent' : 'failed'}, 'report.Scheduled', NOW(), ${JSON.stringify({ scheduleId: schedule.id })})
            `;
          }
        }
      }
    } catch (err: unknown) {
      log.error({ scheduleId: schedule.id, error: err }, 'Failed to run scheduled report');
    }
  }
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

function computeNextRunAt(
  frequency: string,
  dayOfWeek: number | null,
  dayOfMonth: number | null,
): Date {
  const now = new Date();
  if (frequency === 'daily') {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(6, 0, 0, 0);
    return next;
  }
  if (frequency === 'weekly') {
    const dow = dayOfWeek ?? 1;
    const next = new Date(now);
    const currentDow = next.getDay();
    const daysUntil = (dow - currentDow + 7) % 7 || 7;
    next.setDate(next.getDate() + daysUntil);
    next.setHours(6, 0, 0, 0);
    return next;
  }
  if (frequency === 'monthly') {
    const dom = dayOfMonth ?? 1;
    const next = new Date(now);
    next.setMonth(next.getMonth() + 1);
    const daysInMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(dom, daysInMonth));
    next.setHours(6, 0, 0, 0);
    return next;
  }
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(6, 0, 0, 0);
  return next;
}
