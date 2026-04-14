// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * @deprecated Job handlers have been migrated to packages/worker/src/handlers/.
 * startCronRunner is no longer called from the API entry point.
 * This file is kept for reference only.
 */
import { eq, and, lte, ne, sql, isNull } from 'drizzle-orm';
import crypto from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  db,
  client,
  cronjobs,
  reportSchedules,
  reports,
  paymentReconciliationRuns,
  chargingSessions,
  chargingStations,
  sessionTariffSegments,
  guestSessions,
  isSplitBillingEnabled,
  isPushDisplayEnabled,
} from '@evtivity/database';
import type { FastifyBaseLogger } from 'fastify';
import { CronExpressionParser } from 'cron-parser';
import { queueReport } from './report.service.js';
import { reconcilePayments } from './payment-reconciliation.service.js';
import { resolveTariff } from './tariff.service.js';
import { getStripeConfig, cancelPaymentIntent } from './stripe.service.js';
import { pushPricingDisplayToAllStations } from './pricing-display.service.js';
import { getPubSub } from '../lib/pubsub.js';
import { getNotificationSettings, sendEmail, renderTemplate, wrapEmailHtml } from '@evtivity/lib';
import type { EmailAttachment } from '@evtivity/lib';

const currentDir = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = process.env['API_TEMPLATES_DIR'] ?? resolve(currentDir, '..', 'templates');

type JobHandler = (log: FastifyBaseLogger) => Promise<void>;

const jobHandlers = new Map<string, JobHandler>();

jobHandlers.set('report-scheduler', async (log: FastifyBaseLogger) => {
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
        .set({
          lastRunAt: now,
          nextRunAt,
          updatedAt: sql`now()`,
        })
        .where(eq(reportSchedules.id, schedule.id));

      const recipientEmails = schedule.recipientEmails as string[] | null;
      if (recipientEmails != null && recipientEmails.length > 0) {
        // Wait for the report to finish generating (poll up to 5 minutes)
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
          const companyRows = await client`
            SELECT value FROM settings WHERE key = 'company.name'
          `;
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
});

jobHandlers.set('tariff-boundary-check', async (log: FastifyBaseLogger) => {
  const [splitBilling, pushDisplay] = await Promise.all([
    isSplitBillingEnabled(),
    isPushDisplayEnabled(),
  ]);

  if (!splitBilling && !pushDisplay) return;

  if (splitBilling) {
    const now = new Date();

    const activeSessions = await db
      .select({
        sessionId: chargingSessions.id,
        stationUuid: chargingSessions.stationId,
        driverId: chargingSessions.driverId,
        tariffId: chargingSessions.tariffId,
        energyDeliveredWh: chargingSessions.energyDeliveredWh,
        idleMinutes: chargingSessions.idleMinutes,
        currentCostCents: chargingSessions.currentCostCents,
        stationOcppId: chargingStations.stationId,
        ocppProtocol: chargingStations.ocppProtocol,
      })
      .from(chargingSessions)
      .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
      .where(eq(chargingSessions.status, 'active'));

    const pubsub = getPubSub();

    for (const session of activeSessions) {
      try {
        const currentTariff = await resolveTariff(session.stationUuid, session.driverId);
        if (currentTariff == null || currentTariff.id === session.tariffId) continue;

        const energyWh = session.energyDeliveredWh != null ? Number(session.energyDeliveredWh) : 0;
        const idleMins = Number(session.idleMinutes);

        // Close open segment
        await db
          .update(sessionTariffSegments)
          .set({
            endedAt: now,
            energyWhEnd: String(energyWh),
            durationMinutes: sql`EXTRACT(EPOCH FROM (NOW() - started_at)) / 60`,
            idleMinutes: String(idleMins),
          })
          .where(
            and(
              eq(sessionTariffSegments.sessionId, session.sessionId),
              isNull(sessionTariffSegments.endedAt),
            ),
          );

        // Open new segment
        await db.insert(sessionTariffSegments).values({
          sessionId: session.sessionId,
          tariffId: currentTariff.id,
          startedAt: now,
          energyWhStart: String(energyWh),
        });

        // Update session tariff snapshot
        await db
          .update(chargingSessions)
          .set({
            tariffId: currentTariff.id,
            tariffPricePerKwh: currentTariff.pricePerKwh,
            tariffPricePerMinute: currentTariff.pricePerMinute,
            tariffPricePerSession: currentTariff.pricePerSession,
            tariffIdleFeePricePerMinute: currentTariff.idleFeePricePerMinute,
            tariffTaxRate: currentTariff.taxRate,
            updatedAt: sql`now()`,
          })
          .where(eq(chargingSessions.id, session.sessionId));

        log.info(
          {
            sessionId: session.sessionId,
            oldTariffId: session.tariffId,
            newTariffId: currentTariff.id,
          },
          'Tariff boundary: split session at new tariff',
        );

        // Notify OCPP 2.1 stations of cost update (fire-and-forget)
        if (session.ocppProtocol != null && session.ocppProtocol.startsWith('ocpp2')) {
          const commandId = crypto.randomUUID();
          await pubsub.publish(
            'ocpp_commands',
            JSON.stringify({
              commandId,
              stationId: session.stationOcppId,
              action: 'CostUpdated',
              payload: {
                totalCost: (session.currentCostCents ?? 0) / 100,
                transactionId: session.sessionId,
              },
              version: session.ocppProtocol,
            }),
          );
        }
      } catch (err: unknown) {
        log.error(
          { sessionId: session.sessionId, error: err },
          'Tariff boundary check failed for session',
        );
      }
    }
  }

  if (pushDisplay) {
    await pushPricingDisplayToAllStations(log);
  }
});

jobHandlers.set('payment-reconciliation', async (log: FastifyBaseLogger) => {
  const result = await reconcilePayments(log);

  // Store the run result
  await db.insert(paymentReconciliationRuns).values({
    checkedCount: result.checked,
    matchedCount: result.matched,
    discrepancyCount: result.discrepancies.length,
    errorCount: result.errors.length,
    discrepancies: result.discrepancies,
    errors: result.errors.length > 0 ? result.errors : null,
  });

  if (result.discrepancies.length > 0) {
    log.warn(
      { discrepancies: result.discrepancies.length, checked: result.checked },
      'Payment reconciliation found discrepancies',
    );
  } else {
    log.info(
      { checked: result.checked, matched: result.matched },
      'Payment reconciliation completed',
    );
  }
});

jobHandlers.set('guest-session-cleanup', async (log: FastifyBaseLogger) => {
  const expired = await db
    .select()
    .from(guestSessions)
    .where(
      and(
        sql`${guestSessions.status} IN ('pending_payment', 'payment_authorized')`,
        lte(guestSessions.expiresAt, new Date()),
      ),
    );

  for (const gs of expired) {
    try {
      if (gs.stripePaymentIntentId != null) {
        const config = await getStripeConfig(null);
        if (config != null) {
          await cancelPaymentIntent(config, gs.stripePaymentIntentId);
        }
      }
      await db
        .update(guestSessions)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(guestSessions.id, gs.id));
    } catch (err: unknown) {
      log.error({ guestSessionId: gs.id, error: err }, 'Failed to expire guest session');
    }
  }

  if (expired.length > 0) {
    log.info({ count: expired.length }, 'Expired guest sessions cleaned up');
  }
});

jobHandlers.set('charging-profile-reconciliation', async (log: FastifyBaseLogger) => {
  const { chargingProfiles } = await import('@evtivity/database');

  // Get stations that have both csms_set and station_reported profiles
  const stationsWithProfiles = await db
    .selectDistinct({ stationId: chargingProfiles.stationId })
    .from(chargingProfiles)
    .where(eq(chargingProfiles.source, 'csms_set'));

  let mismatchCount = 0;

  for (const row of stationsWithProfiles) {
    // Get latest CSMS-set profiles grouped by evseId
    const csmsProfiles = await db
      .select({
        evseId: chargingProfiles.evseId,
        profileData: chargingProfiles.profileData,
      })
      .from(chargingProfiles)
      .where(
        and(eq(chargingProfiles.stationId, row.stationId), eq(chargingProfiles.source, 'csms_set')),
      )
      .orderBy(sql`${chargingProfiles.sentAt} DESC NULLS LAST`);

    // Get latest station-reported profiles grouped by evseId
    const stationProfiles = await db
      .select({
        evseId: chargingProfiles.evseId,
        profileData: chargingProfiles.profileData,
      })
      .from(chargingProfiles)
      .where(
        and(
          eq(chargingProfiles.stationId, row.stationId),
          eq(chargingProfiles.source, 'station_reported'),
        ),
      )
      .orderBy(sql`${chargingProfiles.reportedAt} DESC NULLS LAST`);

    // Build maps of latest profile per evseId
    const csmsMap = new Map<number | null, unknown>();
    for (const p of csmsProfiles) {
      if (!csmsMap.has(p.evseId)) csmsMap.set(p.evseId, p.profileData);
    }

    const stationMap = new Map<number | null, unknown>();
    for (const p of stationProfiles) {
      if (!stationMap.has(p.evseId)) stationMap.set(p.evseId, p.profileData);
    }

    // Compare
    for (const [evseId, csmsData] of csmsMap) {
      const stationData = stationMap.get(evseId);
      if (stationData == null || JSON.stringify(csmsData) !== JSON.stringify(stationData)) {
        mismatchCount++;
        try {
          const pubsub = getPubSub();
          await pubsub.publish(
            'csms_events',
            JSON.stringify({
              eventType: 'station.profileMismatch',
              stationId: row.stationId,
              sessionId: null,
              siteId: null,
            }),
          );
        } catch {
          // Best-effort SSE notification
        }
      }
    }
  }

  if (mismatchCount > 0) {
    log.info({ mismatchCount }, 'Charging profile mismatches detected');
  }
});

jobHandlers.set('config-drift-detection', async (log: FastifyBaseLogger) => {
  const { configTemplates, stationConfigurations } = await import('@evtivity/database');

  // Get all templates with variables
  const templates = await db.select().from(configTemplates);

  let driftCount = 0;

  for (const template of templates) {
    const variables = template.variables as Array<{
      component: string;
      variable: string;
      value: string;
    }>;
    if (variables.length === 0) continue;

    // Resolve target stations from filter
    const filter = template.targetFilter as Record<string, string> | null;
    const conditions = [eq(chargingStations.isOnline, true)];
    if (filter?.siteId) conditions.push(eq(chargingStations.siteId, filter.siteId));
    if (filter?.vendorId) conditions.push(eq(chargingStations.vendorId, filter.vendorId));
    if (filter?.model) conditions.push(eq(chargingStations.model, filter.model));

    const targetStations = await db
      .select({ id: chargingStations.id })
      .from(chargingStations)
      .where(and(...conditions));

    for (const station of targetStations) {
      const actualVars = await db
        .select()
        .from(stationConfigurations)
        .where(eq(stationConfigurations.stationId, station.id));

      for (const expected of variables) {
        const actual = actualVars.find(
          (v) => v.component === expected.component && v.variable === expected.variable,
        );
        if (actual == null || actual.value !== expected.value) {
          driftCount++;
          try {
            const pubsub = getPubSub();
            await pubsub.publish(
              'csms_events',
              JSON.stringify({
                eventType: 'config.driftDetected',
                stationId: station.id,
                sessionId: null,
                siteId: null,
              }),
            );
          } catch {
            // Best-effort SSE notification
          }
          break; // One drift per station is enough to flag
        }
      }
    }
  }

  if (driftCount > 0) {
    log.info({ driftCount }, 'Configuration drift detected');
  }
});

async function waitForReport(
  reportId: string,
  log: FastifyBaseLogger,
): Promise<{ fileData: Buffer; fileName: string } | null> {
  const maxAttempts = 60; // 5 minutes at 5s intervals
  const intervalMs = 5000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const [report] = await db
      .select({
        status: reports.status,
        fileData: reports.fileData,
        fileName: reports.fileName,
      })
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

    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
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
    const dow = dayOfWeek ?? 1; // default Monday
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
    next.setDate(Math.min(dom, daysInMonth(next.getFullYear(), next.getMonth())));
    next.setHours(6, 0, 0, 0);
    return next;
  }

  // Fallback: next day
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(6, 0, 0, 0);
  return next;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

const CRON_RUNNER_INTERVAL_MS = 60_000;

async function runCronTick(log: FastifyBaseLogger): Promise<void> {
  const now = new Date();

  const dueJobs = await db
    .select()
    .from(cronjobs)
    .where(and(lte(cronjobs.nextRunAt, now), ne(cronjobs.status, 'running')));

  for (const job of dueJobs) {
    const handler = jobHandlers.get(job.name);
    if (handler == null) {
      log.warn({ jobName: job.name }, 'No handler registered for cronjob');
      continue;
    }

    const startTime = Date.now();

    try {
      await db
        .update(cronjobs)
        .set({ status: 'running', updatedAt: sql`now()` })
        .where(eq(cronjobs.id, job.id));

      await handler(log);

      const durationMs = Date.now() - startTime;
      const nextRunAt = computeNextRunFromSchedule(job.schedule);

      await db
        .update(cronjobs)
        .set({
          status: 'completed',
          lastRunAt: now,
          durationMs,
          result: { success: true },
          error: null,
          nextRunAt,
          updatedAt: sql`now()`,
        })
        .where(eq(cronjobs.id, job.id));
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      const nextRunAt = computeNextRunFromSchedule(job.schedule);

      await db
        .update(cronjobs)
        .set({
          status: 'failed',
          lastRunAt: now,
          durationMs,
          error: errorMsg.slice(0, 1000),
          nextRunAt,
          updatedAt: sql`now()`,
        })
        .where(eq(cronjobs.id, job.id));

      log.error({ jobName: job.name, error: err }, 'Cronjob failed');
    }
  }
}

function computeNextRunFromSchedule(schedule: string): Date {
  try {
    const interval = CronExpressionParser.parse(schedule);
    return interval.next().toDate();
  } catch {
    // Fallback: 5 minutes from now
    return new Date(Date.now() + 5 * 60_000);
  }
}

export function startCronRunner(log: FastifyBaseLogger): () => void {
  log.info('Cron runner started (interval: 60s)');

  const timer = setInterval(() => {
    void runCronTick(log).catch((err: unknown) => {
      log.error({ err }, 'Cron tick failed');
    });
  }, CRON_RUNNER_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    log.info('Cron runner stopped');
  };
}
