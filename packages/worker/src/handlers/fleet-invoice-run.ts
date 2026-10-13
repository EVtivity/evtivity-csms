// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { getCompanyCurrency, getFleetInvoiceRunDay, getSystemTimezone } from '@evtivity/database';
import type { Logger } from '@evtivity/lib';
import {
  loadFleetsToInvoice,
  loadMembersToInvoice,
  scheduledRunPeriod,
  sendFleetInvoiceOverdueNotices,
  sendFleetInvoiceRunFailureDigests,
  sendMemberInvoiceOverdueNotices,
  type FleetPeriodToInvoice,
  type MemberPeriodToInvoice,
} from '@evtivity/services/fleet-invoice-run';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { enqueueFleetInvoice } from '../fleet-invoice-worker.js';
import { enqueueMemberInvoice } from '../member-invoice-worker.js';

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
  loadMembers: (
    latestPeriod: string,
    timeZone: string,
    currency: string,
  ) => Promise<MemberPeriodToInvoice[]>;
  enqueueMember: (data: MemberPeriodToInvoice) => Promise<void>;
  sendFailureDigests: (log: Logger) => Promise<{ periods: number; fleets: number }>;
  sendOverdue: (
    log: Logger,
    now: Date,
  ) => Promise<{ sent: number; noContacts: number; failed: number }>;
  sendMemberOverdue: (log: Logger, now: Date) => Promise<{ sent: number; failed: number }>;
}

const defaultDeps: FleetInvoiceRunDeps = {
  now: () => new Date(),
  timeZone: getSystemTimezone,
  runDay: getFleetInvoiceRunDay,
  currency: getCompanyCurrency,
  loadFleets: loadFleetsToInvoice,
  enqueue: enqueueFleetInvoice,
  loadMembers: loadMembersToInvoice,
  enqueueMember: enqueueMemberInvoice,
  sendFailureDigests: (log) =>
    sendFleetInvoiceRunFailureDigests({ templatesDirs: ALL_TEMPLATES_DIRS }, log),
  sendOverdue: (log, now) =>
    sendFleetInvoiceOverdueNotices({ templatesDirs: ALL_TEMPLATES_DIRS }, log, now),
  sendMemberOverdue: (log, now) =>
    sendMemberInvoiceOverdueNotices({ templatesDirs: ALL_TEMPLATES_DIRS }, log, now),
};

/** What one cron run did. */
export interface FleetInvoiceRunSummary {
  /** The latest month the run bills (the month before the current one), null before the run day. */
  period: string | null;
  enqueued: number;
  enqueueFailed: number;
  /** Member invoice jobs (fleets that invoice each driver). */
  memberEnqueued: number;
  memberEnqueueFailed: number;
  failureDigest: { periods: number; fleets: number } | null;
  overdue: { sent: number; noContacts: number; failed: number } | null;
  memberOverdue: { sent: number; failed: number } | null;
}

/** Enqueues each item; one failure is logged and the others go on. */
async function enqueueEach<T extends FleetPeriodToInvoice | MemberPeriodToInvoice>(
  items: T[],
  enqueue: (item: T) => Promise<void>,
  log: Logger,
  what: string,
): Promise<{ enqueued: number; failed: number }> {
  const counts = { enqueued: 0, failed: 0 };
  for (const item of items) {
    try {
      await enqueue(item);
      counts.enqueued += 1;
    } catch (err) {
      counts.failed += 1;
      const fields: Record<string, unknown> = { ...item };
      log.warn({ err, ...fields }, `Could not enqueue the ${what}; continuing`);
    }
  }
  return counts;
}

/**
 * Cron `fleet-invoice-run` (hourly). Independent steps, each fail-open (P9)
 * so one failing does not stop the others:
 *
 * 1. From the run day (setting fleet.invoiceRunDay, system timezone) to the
 *    end of the month, enqueues one `fleet-invoice` job per fleet with
 *    auto_invoice for its oldest month up to the previous one that still has
 *    sessions to bill and no invoice (a month a missed run left is billed
 *    first, the next one on a later run), and one `member-invoice` job per
 *    driver with member-billed sessions of such a fleet, the same way. The
 *    job ids per fleet (and driver) and month (P7) and the period keys make
 *    every rerun add nothing; each job fails and retries on its own.
 * 2. Sends one fleet.InvoiceRunFailed digest per month for the fleet and
 *    member invoices whose job failed for good since the last digest.
 * 3. Sends invoice.FleetOverdue for issued fleet invoices and
 *    invoice.MemberOverdue for issued member invoices past their due date,
 *    once per invoice.
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
    memberEnqueued: 0,
    memberEnqueueFailed: 0,
    failureDigest: null,
    overdue: null,
    memberOverdue: null,
  };

  let timeZone: string | null = null;
  try {
    timeZone = await deps.timeZone();
    summary.period = scheduledRunPeriod(now, timeZone, await deps.runDay());
  } catch (err) {
    log.warn({ err }, 'Fleet invoice run could not read its settings; next run retries');
  }

  const period = summary.period;
  if (period != null && timeZone != null) {
    try {
      const toInvoice = await deps.loadFleets(period, timeZone, await deps.currency());
      const counts = await enqueueEach(toInvoice, deps.enqueue, log, 'fleet invoice');
      summary.enqueued = counts.enqueued;
      summary.enqueueFailed = counts.failed;
    } catch (err) {
      log.warn({ err }, 'Fleet invoice run could not list the fleets; next run retries');
    }
    try {
      const members = await deps.loadMembers(period, timeZone, await deps.currency());
      const counts = await enqueueEach(members, deps.enqueueMember, log, 'member invoice');
      summary.memberEnqueued = counts.enqueued;
      summary.memberEnqueueFailed = counts.failed;
    } catch (err) {
      log.warn({ err }, 'Fleet invoice run could not list the member invoices; next run retries');
    }
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

  try {
    summary.memberOverdue = await deps.sendMemberOverdue(log, now);
  } catch (err) {
    log.warn({ err }, 'Member invoice overdue notices failed; next run retries');
  }

  return summary;
}

export async function fleetInvoiceRunHandler(log: Logger): Promise<void> {
  const summary = await runFleetInvoiceCron(log);
  const { overdue, memberOverdue } = summary;
  const digest = summary.failureDigest;
  // Jobs that already exist are re-added every hour of the month (a no-op), so
  // the summary is info only when something was sent or failed.
  if (
    summary.enqueueFailed + summary.memberEnqueueFailed > 0 ||
    (digest != null && digest.fleets > 0) ||
    (overdue != null && overdue.sent + overdue.failed > 0) ||
    (memberOverdue != null && memberOverdue.sent + memberOverdue.failed > 0)
  ) {
    log.info(summary, 'Fleet invoice run');
  } else {
    log.debug(summary, 'Fleet invoice run');
  }
}
