// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { getCompanyCurrency, getFleetInvoiceRunDay, getSystemTimezone } from '@evtivity/database';
import type { Logger } from '@evtivity/lib';
import {
  loadFleetsToInvoice,
  scheduledRunPeriod,
  sendFleetInvoiceOverdueNotices,
  sendFleetInvoiceRunFailureDigests,
  type FleetPeriodToInvoice,
} from '@evtivity/services/fleet-invoice-run';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { enqueueFleetInvoice } from '../fleet-invoice-worker.js';

export interface FleetInvoiceRunDeps {
  now: () => Date;
  timeZone: () => Promise<string>;
  runDay: () => Promise<number>;
  currency: () => Promise<string>;
  loadFleets: (
    latestPeriod: string,
    timeZone: string,
    currency: string,
  ) => Promise<FleetPeriodToInvoice[]>;
  enqueue: (data: FleetPeriodToInvoice) => Promise<void>;
  sendFailureDigests: (log: Logger) => Promise<{ periods: number; fleets: number }>;
  sendOverdue: (
    log: Logger,
    now: Date,
  ) => Promise<{ sent: number; noContacts: number; failed: number }>;
}

const defaultDeps: FleetInvoiceRunDeps = {
  now: () => new Date(),
  timeZone: getSystemTimezone,
  runDay: getFleetInvoiceRunDay,
  currency: getCompanyCurrency,
  loadFleets: loadFleetsToInvoice,
  enqueue: enqueueFleetInvoice,
  sendFailureDigests: (log) =>
    sendFleetInvoiceRunFailureDigests({ templatesDirs: ALL_TEMPLATES_DIRS }, log),
  sendOverdue: (log, now) =>
    sendFleetInvoiceOverdueNotices({ templatesDirs: ALL_TEMPLATES_DIRS }, log, now),
};

/** What one cron run did. */
export interface FleetInvoiceRunSummary {
  /** The latest month the run bills (the month before the current one), null before the run day. */
  period: string | null;
  enqueued: number;
  enqueueFailed: number;
  failureDigest: { periods: number; fleets: number } | null;
  overdue: { sent: number; noContacts: number; failed: number } | null;
}

/**
 * Cron `fleet-invoice-run` (hourly). Three independent steps, each fail-open
 * (P9) so one failing does not stop the others:
 *
 * 1. From the run day (setting fleet.invoiceRunDay, system timezone) to the
 *    end of the month, enqueues one `fleet-invoice` job per fleet with
 *    auto_invoice for its oldest month up to the previous one that still has
 *    sessions to bill and no invoice (a month a missed run left is billed
 *    first, the next one on a later run). The job id per fleet and month (P7)
 *    and the period key make every rerun add nothing; each fleet's job fails
 *    and retries on its own.
 * 2. Sends one fleet.InvoiceRunFailed digest per month for the fleets whose
 *    job failed for good since the last digest.
 * 3. Sends invoice.FleetOverdue for issued fleet invoices past their due
 *    date, once per invoice.
 */
export async function runFleetInvoiceCron(
  log: Logger,
  deps: FleetInvoiceRunDeps = defaultDeps,
): Promise<FleetInvoiceRunSummary> {
  const now = deps.now();
  const summary: FleetInvoiceRunSummary = {
    period: null,
    enqueued: 0,
    enqueueFailed: 0,
    failureDigest: null,
    overdue: null,
  };

  try {
    const timeZone = await deps.timeZone();
    const period = scheduledRunPeriod(now, timeZone, await deps.runDay());
    summary.period = period;
    if (period != null) {
      const toInvoice = await deps.loadFleets(period, timeZone, await deps.currency());
      for (const item of toInvoice) {
        try {
          await deps.enqueue(item);
          summary.enqueued += 1;
        } catch (err) {
          summary.enqueueFailed += 1;
          log.warn({ err, ...item }, 'Could not enqueue the fleet invoice; continuing');
        }
      }
    }
  } catch (err) {
    log.warn({ err }, 'Fleet invoice run could not list the fleets; next run retries');
  }

  try {
    summary.failureDigest = await deps.sendFailureDigests(log);
  } catch (err) {
    log.warn({ err }, 'Fleet invoice run failure digest failed; next run retries');
  }

  try {
    summary.overdue = await deps.sendOverdue(log, now);
  } catch (err) {
    log.warn({ err }, 'Fleet invoice overdue notices failed; next run retries');
  }

  return summary;
}

export async function fleetInvoiceRunHandler(log: Logger): Promise<void> {
  const summary = await runFleetInvoiceCron(log);
  const overdue = summary.overdue;
  const digest = summary.failureDigest;
  // Jobs that already exist are re-added every hour of the month (a no-op), so
  // the summary is info only when something was sent or failed.
  if (
    summary.enqueueFailed > 0 ||
    (digest != null && digest.fleets > 0) ||
    (overdue != null && overdue.sent + overdue.failed > 0)
  ) {
    log.info(summary, 'Fleet invoice run');
  } else {
    log.debug(summary, 'Fleet invoice run');
  }
}
