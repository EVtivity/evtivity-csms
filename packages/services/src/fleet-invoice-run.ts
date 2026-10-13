// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  client,
  db,
  invoiceAuditLog,
  loadFleetBillingContacts,
  getSystemTimezone,
  writeAudit,
} from '@evtivity/database';
import { AppError, dispatchSystemNotification, isValidTimezone } from '@evtivity/lib';
import type { EmailAttachment, NotificationDelivery, ServiceLogger } from '@evtivity/lib';
import {
  createFleetInvoice,
  createMemberInvoice,
  dateIn,
  findMemberPeriodInvoice,
  findPeriodInvoice,
  fleetInvoicePeriod,
  previousPeriod,
} from './fleet-invoice.service.js';
import {
  MEMBER_OVERDUE_EVENT,
  dispatchMemberInvoiceNotice,
  fleetInvoiceVariables,
  memberInvoiceRecipient,
  sendAccountInvoiceEmail,
  type AccountInvoiceSendResult,
} from './fleet-invoice-notice.js';
import { MEMBER_INVOICE_JOB_NAME } from './account-invoice-jobs.js';
import { getInvoice } from './invoice.service.js';
import { generateInvoicePdf } from './invoice-pdf.service.js';
import { systemInvoiceAuditActor, writeInvoiceSentAudit } from './invoice-audit.js';
import type { InvoiceAuditActor } from './invoice-audit.js';

/** Operators hear which fleets the scheduled run could not invoice for a month (system event, one digest per month). */
export const FLEET_INVOICE_RUN_FAILED_EVENT = 'fleet.InvoiceRunFailed';

/** The fleet billing contacts hear that an issued fleet invoice is past due. */
export const FLEET_INVOICE_OVERDUE_EVENT = 'invoice.FleetOverdue';

/** Operators with this permission issue invoices and get the run failure notice. */
export const FLEET_INVOICE_RUN_PERMISSION = 'payments:write';

/** The audit label of invoices the scheduled run issued. */
export const FLEET_INVOICE_RUN_ACTOR = 'fleet-invoice-run';

/** At most this many overdue invoices are handled per run; the rest wait for the next. */
export const FLEET_INVOICE_OVERDUE_BATCH = 500;

const MAX_ERROR_LENGTH = 300;

export interface FleetInvoiceRunDeps {
  /** Notification template directories of the calling process. */
  templatesDirs: string[];
}

/**
 * The month the scheduled run bills at `now`: the month before the current
 * one in the system timezone, from the run day (1 to 28) on, else null. A run
 * day reached means the previous month has ended everywhere in the timezone.
 */
export function scheduledRunPeriod(now: Date, timeZone: string, runDay: number): string | null {
  const day = Number(dateIn(now, timeZone).slice(8, 10));
  if (!Number.isInteger(day) || day < runDay) return null;
  return previousPeriod(now, timeZone);
}

/**
 * The BullMQ job id of one fleet's scheduled invoice for a period (P7).
 * BullMQ refuses `:` in custom ids, so the parts are joined with dots.
 */
export function fleetInvoiceJobId(fleetId: string, period: string): string {
  return `fleet-invoice.${fleetId}.${period}`;
}

/** One fleet and the month the scheduled run invoices for it. */
export interface FleetPeriodToInvoice {
  fleetId: string;
  period: string;
}

/**
 * The fleets the scheduled run invoices, each with its oldest month to bill,
 * up to `latestPeriod` (the month before the current one). Per fleet with
 * `auto_invoice`: the oldest month (system timezone) in which an account
 * session ended that the fleet invoice would bill (completed, no invoice, no
 * payment record, a cost above zero in the company
 * currency), that has no fleet invoice in any status and no recorded run
 * failure. So a month the run missed (the worker was down for the whole run
 * window) is billed first, on its own invoice, and the next month on a later
 * run. A month with a credited invoice or a recorded failure is left to the
 * operator. Account billing turned off does not leave a fleet out: its
 * unbilled sessions are still invoiced.
 */
export async function loadFleetsToInvoice(
  latestPeriod: string,
  timeZone: string,
  currency: string,
): Promise<FleetPeriodToInvoice[]> {
  const { endsAt } = fleetInvoicePeriod(latestPeriod, timeZone);
  const zone = isValidTimezone(timeZone) ? timeZone : 'UTC';
  const rows = await client<Array<{ fleet_id: string; period: string }>>`
    WITH unbilled AS (
      SELECT cs.billing_fleet_id AS fleet_id,
             date_trunc('month', cs.ended_at AT TIME ZONE ${zone})::date AS period_start
      FROM charging_sessions cs
      JOIN fleets f ON f.id = cs.billing_fleet_id AND f.auto_invoice
      WHERE cs.billing_mode = 'account'
        AND NOT cs.member_billed
        AND cs.status = 'completed'
        AND cs.invoice_id IS NULL
        AND cs.ended_at < ${endsAt.toISOString()}::timestamptz
        AND cs.final_cost_cents > 0
        AND upper(cs.currency) = ${currency.toUpperCase()}
        AND NOT EXISTS (SELECT 1 FROM payment_records pr WHERE pr.session_id = cs.id)
    )
    SELECT u.fleet_id, to_char(min(u.period_start), 'YYYY-MM') AS period
    FROM unbilled u
    WHERE NOT EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.fleet_id = u.fleet_id AND i.period_start = u.period_start AND i.kind = 'invoice'
          AND NOT i.member_billed)
      AND NOT EXISTS (
        SELECT 1 FROM fleet_invoice_run_failures r
        WHERE r.fleet_id = u.fleet_id AND r.period_start = u.period_start)
    GROUP BY u.fleet_id
    ORDER BY u.fleet_id
  `;
  return rows.map((row) => ({ fleetId: row.fleet_id, period: row.period }));
}

/** What the scheduled invoice of one fleet did. */
export type ScheduledFleetInvoiceResult =
  | { status: 'invoiced'; invoiceId: string; email: AccountInvoiceSendResult['status'] }
  | { status: 'exists'; invoiceId: string; email: AccountInvoiceSendResult['status'] }
  | { status: 'nothing_to_bill' }
  | { status: 'fleet_not_found' };

function appErrorCode(err: unknown): string | null {
  return err instanceof AppError ? err.code : null;
}

/**
 * Issues and emails the invoice of one fleet for a period, through the same
 * service as the on-demand route (createFleetInvoice, P2 and P3), audited as
 * `invoice_generated` by the system actor `fleet-invoice-run`.
 *
 * Idempotent (P7): a period that already has a live invoice (a retry, or an
 * operator who generated it meanwhile) answers `exists` and only emails the
 * invoice if it never was (`sendAccountInvoiceEmail` mode `once`). Nothing to
 * bill and an unknown fleet are results, not failures. Any other error
 * throws, so the job retries; an email failure throws too, and the retry
 * sends it through `exists`. Only sessions ended in the month are billed
 * (`periodOnly`): every month gets its own invoice.
 */
export async function runScheduledFleetInvoice(
  fleetId: string,
  period: string,
  deps: FleetInvoiceRunDeps,
  log: ServiceLogger,
  now: Date = new Date(),
): Promise<ScheduledFleetInvoiceResult> {
  let invoiceId: string;
  let created = false;
  try {
    const result = await createFleetInvoice(fleetId, period, now, { periodOnly: true });
    invoiceId = result.invoice.id;
    created = true;
    const sessionIds = [
      ...new Set(result.lineItems.map((item) => item.sessionId).filter((id) => id != null)),
    ];
    await writeAudit(
      { table: invoiceAuditLog, idColumn: 'invoice_id' },
      {
        entityId: invoiceId,
        entityIdSnapshot: invoiceId,
        action: 'invoice_generated',
        actor: 'system',
        actorLabel: FLEET_INVOICE_RUN_ACTOR,
        before: null,
        after: { ...result.invoice, sessionIds, excludedCount: result.excludedCount },
        notes: period,
      },
      db,
      log,
    );
  } catch (err) {
    const code = appErrorCode(err);
    if (code === 'FLEET_INVOICE_NOTHING_TO_BILL') return { status: 'nothing_to_bill' };
    if (code === 'FLEET_NOT_FOUND') return { status: 'fleet_not_found' };
    if (code !== 'FLEET_INVOICE_PERIOD_EXISTS') throw err;
    const timeZone = await getSystemTimezone();
    const live = await findPeriodInvoice(
      db,
      fleetId,
      fleetInvoicePeriod(period, timeZone).periodStart,
    );
    // Credited between the refusal and this read: the operator bills it again.
    if (live == null) return { status: 'nothing_to_bill' };
    invoiceId = live.id;
  }

  const sent = await sendAccountInvoiceEmail(invoiceId, 'once', deps, {
    actor: systemInvoiceAuditActor(FLEET_INVOICE_RUN_ACTOR),
    log,
  });
  if (sent.status === 'no_contacts') {
    log.warn({ fleetId, invoiceId }, 'Fleet has no billing contact; the invoice was not emailed');
  }
  return created
    ? { status: 'invoiced', invoiceId, email: sent.status }
    : { status: 'exists', invoiceId, email: sent.status };
}

/** The audit label of member invoices that "Invoice All Members" issued. */
export const MEMBER_INVOICE_BATCH_ACTOR = 'member-invoice-batch';

/**
 * The BullMQ job id of one member invoice (P7): `member-invoice.<fleet>.<driver>.<yyyy-mm>`
 * for the scheduled run, plus `.<batchId>` for one "Invoice All Members"
 * request, so a repeated add of the same batch adds nothing while a new
 * batch can try again. BullMQ refuses `:` in custom ids.
 */
export function memberInvoiceJobId(
  fleetId: string,
  driverId: string,
  period: string,
  batchId?: string,
): string {
  const base = `member-invoice.${fleetId}.${driverId}.${period}`;
  return batchId == null ? base : `${base}.${batchId}`;
}

/** One member invoice job: a driver of a fleet and the month to bill. */
export interface MemberInvoiceJob {
  fleetId: string;
  driverId: string;
  period: string;
  /** Set for "Invoice All Members": the request's id; absent for the scheduled run. */
  batchId?: string | undefined;
  /** Set for "Invoice All Members": who asked, audited with label member-invoice-batch. */
  actor?: InvoiceAuditActor | undefined;
}

/** What adds member invoice jobs: a BullMQ Queue (structural, so this package needs no bullmq). */
export interface MemberInvoiceJobQueue {
  addBulk(
    jobs: Array<{ name: string; data: MemberInvoiceJob; opts: { jobId: string } }>,
  ): Promise<unknown>;
}

/** One "Invoice All Members" request: the drivers it covers and who asked. */
export interface MemberInvoiceBatch {
  fleetId: string;
  period: string;
  batchId: string;
  actor: InvoiceAuditActor;
  driverIds: readonly string[];
}

/**
 * Adds one `member-invoices` job per driver of an "Invoice All Members"
 * request in one atomic addBulk, job id per fleet, driver, month and batch
 * (memberInvoiceJobId, P7): a retried add of the same batch adds nothing.
 * The jobs wait in Redis until a worker runs, so a worker that is down loses
 * nothing. Nothing is written to the database before (P4): a failed add
 * throws, so the operator sees it and nothing is issued.
 */
export async function enqueueMemberInvoiceBatch(
  queue: MemberInvoiceJobQueue,
  batch: MemberInvoiceBatch,
): Promise<void> {
  if (batch.driverIds.length === 0) return;
  await queue.addBulk(
    batch.driverIds.map((driverId) => ({
      name: MEMBER_INVOICE_JOB_NAME,
      data: {
        fleetId: batch.fleetId,
        driverId,
        period: batch.period,
        batchId: batch.batchId,
        actor: batch.actor,
      },
      opts: { jobId: memberInvoiceJobId(batch.fleetId, driverId, batch.period, batch.batchId) },
    })),
  );
}

/** One driver of a fleet and the month the scheduled run issues their member invoice for. */
export interface MemberPeriodToInvoice {
  fleetId: string;
  driverId: string;
  period: string;
}

/**
 * The member invoices the scheduled run issues, like loadFleetsToInvoice for
 * the drivers of fleets with `auto_invoice` that invoice their members: per
 * fleet and driver with member-billed sessions the member invoice would bill
 * (account, completed, unbilled, no payment record, a cost above zero in the
 * company currency), the oldest month up to `latestPeriod` with no member
 * invoice of that driver in any status and no recorded run failure. Credited
 * months are left to the operator, as for fleets.
 */
export async function loadMembersToInvoice(
  latestPeriod: string,
  timeZone: string,
  currency: string,
): Promise<MemberPeriodToInvoice[]> {
  const { endsAt } = fleetInvoicePeriod(latestPeriod, timeZone);
  const zone = isValidTimezone(timeZone) ? timeZone : 'UTC';
  const rows = await client<Array<{ fleet_id: string; driver_id: string; period: string }>>`
    WITH unbilled AS (
      SELECT cs.billing_fleet_id AS fleet_id, cs.driver_id,
             date_trunc('month', cs.ended_at AT TIME ZONE ${zone})::date AS period_start
      FROM charging_sessions cs
      JOIN fleets f ON f.id = cs.billing_fleet_id AND f.auto_invoice
      WHERE cs.billing_mode = 'account'
        AND cs.member_billed
        AND cs.driver_id IS NOT NULL
        AND cs.status = 'completed'
        AND cs.invoice_id IS NULL
        AND cs.ended_at < ${endsAt.toISOString()}::timestamptz
        AND cs.final_cost_cents > 0
        AND upper(cs.currency) = ${currency.toUpperCase()}
        AND NOT EXISTS (SELECT 1 FROM payment_records pr WHERE pr.session_id = cs.id)
    )
    SELECT u.fleet_id, u.driver_id, to_char(min(u.period_start), 'YYYY-MM') AS period
    FROM unbilled u
    WHERE NOT EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.fleet_id = u.fleet_id AND i.driver_id = u.driver_id
          AND i.period_start = u.period_start AND i.kind = 'invoice' AND i.member_billed)
      AND NOT EXISTS (
        SELECT 1 FROM fleet_member_invoice_run_failures r
        WHERE r.fleet_id = u.fleet_id AND r.driver_id = u.driver_id
          AND r.period_start = u.period_start)
    GROUP BY u.fleet_id, u.driver_id
    ORDER BY u.fleet_id, u.driver_id
  `;
  return rows.map((row) => ({
    fleetId: row.fleet_id,
    driverId: row.driver_id,
    period: row.period,
  }));
}

/** What one member invoice job did. */
export type MemberInvoiceJobResult =
  | { status: 'invoiced'; invoiceId: string; email: AccountInvoiceSendResult['status'] }
  | { status: 'exists'; invoiceId: string; email: AccountInvoiceSendResult['status'] }
  | { status: 'nothing_to_bill' }
  | { status: 'fleet_not_found' }
  | { status: 'driver_not_found' };

/**
 * Issues and emails the member invoice of one driver for a period, through
 * the same service as the on-demand route (createMemberInvoice, P2 and P3),
 * audited as `invoice_generated`: by the system actor `fleet-invoice-run` for
 * the scheduled run (only sessions ended in the month, `periodOnly`), by the
 * requester with label `member-invoice-batch` for "Invoice All Members" (no
 * lower bound, like the on-demand route).
 *
 * Idempotent (P7): a live member invoice of the period answers `exists` and
 * only emails it if it never was (`once`). Nothing to bill, an unknown fleet
 * and an unknown driver are results. A driver without an email gets no email
 * (`no_email`, logged): the operator adds one and uses Send. Any other error
 * throws, so the job retries.
 */
export async function runMemberInvoiceJob(
  job: MemberInvoiceJob,
  deps: FleetInvoiceRunDeps,
  log: ServiceLogger,
  now: Date = new Date(),
): Promise<MemberInvoiceJobResult> {
  const { fleetId, driverId, period } = job;
  const actor: InvoiceAuditActor =
    job.actor != null
      ? { ...job.actor, actorLabel: MEMBER_INVOICE_BATCH_ACTOR }
      : systemInvoiceAuditActor(FLEET_INVOICE_RUN_ACTOR);
  let invoiceId: string;
  let created = false;
  try {
    const result = await createMemberInvoice(fleetId, driverId, period, now, {
      periodOnly: job.batchId == null,
    });
    invoiceId = result.invoice.id;
    created = true;
    const sessionIds = [
      ...new Set(result.lineItems.map((item) => item.sessionId).filter((id) => id != null)),
    ];
    await writeAudit(
      { table: invoiceAuditLog, idColumn: 'invoice_id' },
      {
        entityId: invoiceId,
        entityIdSnapshot: invoiceId,
        action: 'invoice_generated',
        ...actor,
        before: null,
        after: { ...result.invoice, sessionIds, excludedCount: result.excludedCount },
        notes: period,
      },
      db,
      log,
    );
  } catch (err) {
    const code = appErrorCode(err);
    if (code === 'FLEET_INVOICE_NOTHING_TO_BILL') return { status: 'nothing_to_bill' };
    if (code === 'FLEET_NOT_FOUND') return { status: 'fleet_not_found' };
    if (code === 'DRIVER_NOT_FOUND') return { status: 'driver_not_found' };
    if (code !== 'FLEET_INVOICE_PERIOD_EXISTS') throw err;
    const timeZone = await getSystemTimezone();
    const live = await findMemberPeriodInvoice(
      db,
      fleetId,
      driverId,
      fleetInvoicePeriod(period, timeZone).periodStart,
    );
    // Credited between the refusal and this read: the operator bills it again.
    if (live == null) return { status: 'nothing_to_bill' };
    invoiceId = live.id;
  }

  const sent = await sendAccountInvoiceEmail(invoiceId, 'once', deps, { actor, log });
  if (sent.status === 'no_email' || sent.status === 'no_driver') {
    log.warn(
      { fleetId, driverId, invoiceId, reason: sent.status },
      'Member invoice not emailed: the driver has no email',
    );
  }
  return created
    ? { status: 'invoiced', invoiceId, email: sent.status }
    : { status: 'exists', invoiceId, email: sent.status };
}

/**
 * Records that the member invoice of a driver and month failed for good, for
 * the next failure digest (fleet_member_invoice_run_failures, the member
 * counterpart of recordFleetInvoiceRunFailure). Fail-open (P9). The scheduled
 * run skips a recorded month.
 */
export async function recordMemberInvoiceRunFailure(
  fleetId: string,
  driverId: string,
  period: string,
  error: string,
  log: ServiceLogger,
): Promise<FleetInvoiceRunFailureOutcome | null> {
  try {
    const timeZone = await getSystemTimezone();
    const { periodStart } = fleetInvoicePeriod(period, timeZone);
    const live = await findMemberPeriodInvoice(db, fleetId, driverId, periodStart);
    await client`
      INSERT INTO fleet_member_invoice_run_failures
        (fleet_id, driver_id, period_start, invoice_number, error_message)
      VALUES (${fleetId}, ${driverId}, ${periodStart}::date, ${live?.invoiceNumber ?? null},
              ${error.slice(0, MAX_ERROR_LENGTH)})
      ON CONFLICT (fleet_id, driver_id, period_start) DO UPDATE SET
        invoice_number = EXCLUDED.invoice_number,
        error_message = EXCLUDED.error_message,
        failed_at = now(),
        reported_at = NULL`;
    return live == null ? 'not_invoiced' : 'issued_not_emailed';
  } catch (err) {
    log.error({ err, fleetId, driverId, period }, 'Could not record the failed member invoice');
    return null;
  }
}

interface OperatorRecipient {
  email: string;
  phone?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
  language?: string | undefined;
  timezone?: string | undefined;
  userId?: string | undefined;
}

/** Active operators with FLEET_INVOICE_RUN_PERMISSION (invoices are not site-scoped). */
async function loadInvoiceOperators(): Promise<OperatorRecipient[]> {
  const rows = await client<
    Array<{
      id: string;
      email: string;
      phone: string | null;
      first_name: string | null;
      last_name: string | null;
      language: string | null;
      timezone: string | null;
    }>
  >`
    SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.language, u.timezone
    FROM users u
    WHERE u.is_active
      AND EXISTS (SELECT 1 FROM user_permissions p
        WHERE p.user_id = u.id AND p.permission = ${FLEET_INVOICE_RUN_PERMISSION})
    ORDER BY u.id
  `;
  return rows.map((u) => ({
    email: u.email,
    phone: u.phone ?? undefined,
    firstName: u.first_name ?? undefined,
    lastName: u.last_name ?? undefined,
    language: u.language ?? undefined,
    timezone: u.timezone ?? undefined,
    userId: u.id,
  }));
}

/**
 * What a failed scheduled invoice left: the invoice of the month was issued
 * but not emailed (the operator uses Send on it), or nothing was invoiced
 * (the operator generates the invoice by hand).
 */
export type FleetInvoiceRunFailureOutcome = 'issued_not_emailed' | 'not_invoiced';

/**
 * Records that the scheduled invoice of a fleet and month failed for good
 * (attempts used up, or the job stalled past BullMQ's limit), for the next
 * failure digest. The live invoice of the month at this moment decides the
 * outcome. A month failing again (after a Redis loss the cron adds the job
 * again) is reported again. Fail-open (P9): a failure is logged at error and
 * null is returned. The scheduled run skips a recorded month.
 */
export async function recordFleetInvoiceRunFailure(
  fleetId: string,
  period: string,
  error: string,
  log: ServiceLogger,
): Promise<FleetInvoiceRunFailureOutcome | null> {
  try {
    const timeZone = await getSystemTimezone();
    const { periodStart } = fleetInvoicePeriod(period, timeZone);
    const live = await findPeriodInvoice(db, fleetId, periodStart);
    await client`
      INSERT INTO fleet_invoice_run_failures (fleet_id, period_start, invoice_number, error_message)
      VALUES (${fleetId}, ${periodStart}::date, ${live?.invoiceNumber ?? null},
              ${error.slice(0, MAX_ERROR_LENGTH)})
      ON CONFLICT (fleet_id, period_start) DO UPDATE SET
        invoice_number = EXCLUDED.invoice_number,
        error_message = EXCLUDED.error_message,
        failed_at = now(),
        reported_at = NULL`;
    return live == null ? 'not_invoiced' : 'issued_not_emailed';
  } catch (err) {
    log.error({ err, fleetId, period }, 'Could not record the failed fleet invoice run');
    return null;
  }
}

/** One recorded failure the digest reports. */
export interface FleetInvoiceRunFailureRow {
  fleetId: string;
  fleetName: string;
  /** Set on a member invoice failure: the driver the invoice was for. */
  driverName?: string | null | undefined;
  period: string;
  invoiceNumber: string | null;
  errorMessage: string;
}

/** The fleet, and for a member invoice the driver, an entry of the digest names. */
function failureLabel(row: FleetInvoiceRunFailureRow): string {
  return row.driverName == null ? row.fleetName : `${row.fleetName}, ${row.driverName}`;
}

/**
 * The variables of one fleet.InvoiceRunFailed digest (pure). The templates
 * hold the wording in each language; the lists carry data only: fleet name
 * (and the driver of a member invoice), invoice number and the error of each
 * entry, joined with "; ". `fleetNames` lists each fleet once.
 */
export function fleetInvoiceRunFailureVariables(
  period: string,
  rows: FleetInvoiceRunFailureRow[],
): Record<string, string | number> {
  const issued = rows.filter((row) => row.invoiceNumber != null);
  const notInvoiced = rows.filter((row) => row.invoiceNumber == null);
  const fleetNames = [...new Set(rows.map((row) => row.fleetName))];
  return {
    period,
    fleetCount: fleetNames.length,
    fleetNames: fleetNames.join(', '),
    memberCount: rows.filter((row) => row.driverName != null).length,
    issuedNotEmailedCount: issued.length,
    issuedNotEmailed: issued
      .map((row) => `${failureLabel(row)} (${row.invoiceNumber ?? ''}): ${row.errorMessage}`)
      .join('; '),
    notInvoicedCount: notInvoiced.length,
    notInvoiced: notInvoiced.map((row) => `${failureLabel(row)}: ${row.errorMessage}`).join('; '),
  };
}

/** Groups failure rows by month, months and fleets in the order given. */
export function groupFailuresByPeriod(
  rows: FleetInvoiceRunFailureRow[],
): Map<string, FleetInvoiceRunFailureRow[]> {
  const byPeriod = new Map<string, FleetInvoiceRunFailureRow[]>();
  for (const row of rows) {
    const list = byPeriod.get(row.period) ?? [];
    list.push(row);
    byPeriod.set(row.period, list);
  }
  return byPeriod;
}

/**
 * Claims the failures not reported yet, fleet invoices and member invoices in
 * one statement; each row is returned to one caller only. Within a month the
 * fleet invoice entries come first, then the member entries by driver name.
 */
async function claimUnreportedFailures(): Promise<FleetInvoiceRunFailureRow[]> {
  const rows = await client<
    Array<{
      fleet_id: string;
      name: string | null;
      driver_id: string | null;
      first_name: string | null;
      last_name: string | null;
      period: string;
      invoice_number: string | null;
      error_message: string;
    }>
  >`
    WITH claimed_fleets AS (
      UPDATE fleet_invoice_run_failures SET reported_at = now()
      WHERE reported_at IS NULL
      RETURNING fleet_id, NULL::text AS driver_id, period_start, invoice_number, error_message
    ), claimed_members AS (
      UPDATE fleet_member_invoice_run_failures SET reported_at = now()
      WHERE reported_at IS NULL
      RETURNING fleet_id, driver_id, period_start, invoice_number, error_message
    ), claimed AS (
      SELECT * FROM claimed_fleets UNION ALL SELECT * FROM claimed_members
    )
    SELECT c.fleet_id, f.name, c.driver_id, d.first_name, d.last_name,
           to_char(c.period_start, 'YYYY-MM') AS period, c.invoice_number, c.error_message
    FROM claimed c
    LEFT JOIN fleets f ON f.id = c.fleet_id
    LEFT JOIN drivers d ON d.id = c.driver_id
    ORDER BY c.period_start, f.name, c.fleet_id, c.driver_id IS NOT NULL,
             d.last_name, d.first_name, c.driver_id
  `;
  return rows.map((row) => ({
    fleetId: row.fleet_id,
    fleetName: row.name ?? row.fleet_id,
    driverName:
      row.driver_id == null
        ? null
        : `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || row.driver_id,
    period: row.period,
    invoiceNumber: row.invoice_number,
    errorMessage: row.error_message,
  }));
}

/** Counts of one digest pass. */
export interface FleetInvoiceRunDigestSummary {
  periods: number;
  fleets: number;
}

/**
 * Sends one fleet.InvoiceRunFailed per month to the operators who issue
 * invoices (`payments:write`), listing every fleet of that month whose
 * scheduled invoice failed for good and was not reported yet. The rows are
 * claimed (`reported_at`) before the send, so replicas running the cron
 * together never send a fleet twice; a fleet that fails later gets a later
 * digest that lists only it. Without an operator nothing is claimed. A send
 * that fails is not repeated. Fail-open (P9): a failure is logged at warn.
 */
export async function sendFleetInvoiceRunFailureDigests(
  deps: FleetInvoiceRunDeps,
  log: ServiceLogger,
): Promise<FleetInvoiceRunDigestSummary> {
  const summary: FleetInvoiceRunDigestSummary = { periods: 0, fleets: 0 };
  try {
    const pending = await client<Array<{ n: number }>>`
      SELECT ((SELECT count(*) FROM fleet_invoice_run_failures WHERE reported_at IS NULL)
            + (SELECT count(*) FROM fleet_member_invoice_run_failures WHERE reported_at IS NULL)
             )::int AS n`;
    if ((pending[0]?.n ?? 0) === 0) return summary;
    const operators = await loadInvoiceOperators();
    if (operators.length === 0) {
      log.warn('No operator to notify of the failed fleet invoice run');
      return summary;
    }
    const rows = await claimUnreportedFailures();
    for (const [period, fleets] of groupFailuresByPeriod(rows)) {
      const variables = fleetInvoiceRunFailureVariables(period, fleets);
      for (const operator of operators) {
        await dispatchSystemNotification(
          client,
          FLEET_INVOICE_RUN_FAILED_EVENT,
          operator,
          variables,
          deps.templatesDirs,
        );
      }
      summary.periods += 1;
      summary.fleets += fleets.length;
    }
  } catch (err) {
    log.warn({ err }, 'Fleet invoice run failure digest failed; continuing');
  }
  return summary;
}

/** What an overdue notice for one invoice did. */
export type FleetOverdueNoticeResult =
  | 'sent'
  | 'already_sent'
  | 'no_contacts'
  | 'not_overdue'
  | 'not_found';

/** Claims the overdue notice of an issued invoice; true when this call may send. */
async function claimOverdueNotice(invoiceId: string): Promise<boolean> {
  const rows = await client`
    UPDATE invoices SET overdue_notice_sent_at = now()
    WHERE id = ${invoiceId} AND overdue_notice_sent_at IS NULL AND status = 'issued'
    RETURNING id`;
  return rows.length > 0;
}

/**
 * Emails invoice.FleetOverdue for one issued fleet invoice past its due date
 * to the fleet's billing contacts, with the PDF attached, in the language
 * stored on the invoice. Sent once per invoice (P7): the claim
 * `invoices.overdue_notice_sent_at` is taken before the send, so a send that
 * fails is not repeated (the dispatcher logs each attempt). A fleet without
 * billing contacts is not claimed, so the notice goes out once one is added.
 * A notice that at least one provider accepted is audited as `invoice_sent`
 * (event invoice.FleetOverdue) by the system actor `fleet-invoice-run`.
 */
export async function sendFleetInvoiceOverdueNotice(
  invoiceId: string,
  deps: FleetInvoiceRunDeps,
  now: Date = new Date(),
  log?: ServiceLogger,
): Promise<FleetOverdueNoticeResult> {
  const detail = await getInvoice(invoiceId);
  if (detail == null) return 'not_found';
  const { invoice } = detail;
  // A member invoice goes to its driver, never to the fleet's contacts.
  if (
    invoice.fleetId == null ||
    invoice.memberBilled ||
    invoice.kind !== 'invoice' ||
    invoice.status !== 'issued' ||
    invoice.dueAt == null ||
    invoice.dueAt.getTime() >= now.getTime()
  ) {
    return 'not_overdue';
  }

  const contacts = await loadFleetBillingContacts(client, invoice.fleetId);
  if (contacts.emails.length === 0) return 'no_contacts';

  const pdf = await generateInvoicePdf(detail);
  if (!(await claimOverdueNotice(invoice.id))) return 'already_sent';

  const attachment: EmailAttachment = {
    filename: `${invoice.invoiceNumber}.pdf`,
    content: pdf,
    contentType: 'application/pdf',
  };
  const variables = fleetInvoiceVariables(detail);
  const language = invoice.language ?? contacts.language ?? 'en';
  const timezone = await getSystemTimezone();
  const delivered: NotificationDelivery[] = [];
  for (const email of contacts.emails) {
    const result = await dispatchSystemNotification(
      client,
      FLEET_INVOICE_OVERDUE_EVENT,
      { email, language, timezone },
      variables,
      deps.templatesDirs,
      [attachment],
    );
    delivered.push(...result.delivered);
  }
  await writeInvoiceSentAudit(
    {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      eventType: FLEET_INVOICE_OVERDUE_EVENT,
      delivered,
      resend: false,
      actor: systemInvoiceAuditActor(FLEET_INVOICE_RUN_ACTOR),
    },
    log,
  );
  return 'sent';
}

/** What an overdue notice for one member invoice did. */
export type MemberOverdueNoticeResult =
  | 'sent'
  | 'already_sent'
  | 'no_driver'
  | 'no_email'
  | 'not_overdue'
  | 'not_found';

/**
 * Sends invoice.MemberOverdue for one issued member invoice past its due date
 * to its driver only, with the PDF attached (email and push, no SMS;
 * dispatchMemberInvoiceNotice), in the driver's language. Sent once per
 * invoice (P7): the claim `invoices.overdue_notice_sent_at` is taken before
 * the send. A driver that is gone or has no email is not claimed, so the
 * reminder goes out once an email is added. A notice that a provider accepted
 * is audited as `invoice_sent` (event invoice.MemberOverdue) by the system
 * actor `fleet-invoice-run`.
 */
export async function sendMemberInvoiceOverdueNotice(
  invoiceId: string,
  deps: FleetInvoiceRunDeps,
  now: Date = new Date(),
  log?: ServiceLogger,
): Promise<MemberOverdueNoticeResult> {
  const detail = await getInvoice(invoiceId);
  if (detail == null) return 'not_found';
  const { invoice } = detail;
  if (
    !invoice.memberBilled ||
    invoice.kind !== 'invoice' ||
    invoice.status !== 'issued' ||
    invoice.dueAt == null ||
    invoice.dueAt.getTime() >= now.getTime()
  ) {
    return 'not_overdue';
  }

  const recipient = memberInvoiceRecipient(detail);
  if ('status' in recipient) return recipient.status;

  const pdf = await generateInvoicePdf(detail);
  if (!(await claimOverdueNotice(invoice.id))) return 'already_sent';

  const delivered = await dispatchMemberInvoiceNotice(
    detail,
    MEMBER_OVERDUE_EVENT,
    recipient.driverId,
    pdf,
    deps,
  );
  await writeInvoiceSentAudit(
    {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      eventType: MEMBER_OVERDUE_EVENT,
      delivered,
      resend: false,
      actor: systemInvoiceAuditActor(FLEET_INVOICE_RUN_ACTOR),
    },
    log,
  );
  return 'sent';
}

/** Counts of one overdue pass. */
export interface FleetOverdueRunSummary {
  sent: number;
  noContacts: number;
  failed: number;
}

/**
 * Sends invoice.FleetOverdue for every issued fleet invoice past its due date
 * whose notice was not sent yet, oldest due first, at most
 * FLEET_INVOICE_OVERDUE_BATCH per pass. Each invoice is fail-open (P9): a
 * failure is logged at warn and the next one goes on.
 */
export async function sendFleetInvoiceOverdueNotices(
  deps: FleetInvoiceRunDeps,
  log: ServiceLogger,
  now: Date = new Date(),
): Promise<FleetOverdueRunSummary> {
  // Fleets without a billing contact are left out here, so they never hold up the batch.
  const rows = await client<Array<{ id: string }>>`
    SELECT i.id FROM invoices i
    JOIN fleets f ON f.id = i.fleet_id
    WHERE i.kind = 'invoice' AND i.status = 'issued' AND NOT i.member_billed
      AND i.due_at < ${now} AND i.overdue_notice_sent_at IS NULL
      AND cardinality(f.billing_contact_emails) > 0
    ORDER BY i.due_at, i.id
    LIMIT ${FLEET_INVOICE_OVERDUE_BATCH}
  `;
  const summary: FleetOverdueRunSummary = { sent: 0, noContacts: 0, failed: 0 };
  for (const row of rows) {
    try {
      const result = await sendFleetInvoiceOverdueNotice(row.id, deps, now, log);
      if (result === 'sent') summary.sent += 1;
      if (result === 'no_contacts') summary.noContacts += 1;
    } catch (err) {
      summary.failed += 1;
      log.warn({ err, invoiceId: row.id }, 'Fleet invoice overdue notice failed; continuing');
    }
  }
  return summary;
}

/** Counts of one member overdue pass. */
export interface MemberOverdueRunSummary {
  sent: number;
  failed: number;
}

/**
 * Sends invoice.MemberOverdue for every issued member invoice past its due
 * date whose reminder was not sent yet and whose driver has an email, oldest
 * due first, at most FLEET_INVOICE_OVERDUE_BATCH per pass. A driver without
 * an email is left out (not claimed), so the reminder goes once an email is
 * added. Each invoice is fail-open (P9).
 */
export async function sendMemberInvoiceOverdueNotices(
  deps: FleetInvoiceRunDeps,
  log: ServiceLogger,
  now: Date = new Date(),
): Promise<MemberOverdueRunSummary> {
  const rows = await client<Array<{ id: string }>>`
    SELECT i.id FROM invoices i
    JOIN drivers d ON d.id = i.driver_id
    WHERE i.member_billed AND i.kind = 'invoice' AND i.status = 'issued'
      AND i.due_at < ${now} AND i.overdue_notice_sent_at IS NULL
      AND coalesce(d.email, '') <> ''
    ORDER BY i.due_at, i.id
    LIMIT ${FLEET_INVOICE_OVERDUE_BATCH}
  `;
  const summary: MemberOverdueRunSummary = { sent: 0, failed: 0 };
  for (const row of rows) {
    try {
      const result = await sendMemberInvoiceOverdueNotice(row.id, deps, now, log);
      if (result === 'sent') summary.sent += 1;
    } catch (err) {
      summary.failed += 1;
      log.warn({ err, invoiceId: row.id }, 'Member invoice overdue notice failed; continuing');
    }
  }
  return summary;
}
