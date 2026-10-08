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
import type { EmailAttachment, ServiceLogger } from '@evtivity/lib';
import {
  createFleetInvoice,
  dateIn,
  findPeriodInvoice,
  fleetInvoicePeriod,
  previousPeriod,
} from './fleet-invoice.service.js';
import {
  fleetInvoiceVariables,
  sendFleetInvoiceEmail,
  type FleetInvoiceSendResult,
} from './fleet-invoice-notice.js';
import { getInvoice } from './invoice.service.js';
import { generateInvoicePdf } from './invoice-pdf.service.js';

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
        WHERE i.fleet_id = u.fleet_id AND i.period_start = u.period_start AND i.kind = 'invoice')
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
  | { status: 'invoiced'; invoiceId: string; email: FleetInvoiceSendResult['status'] }
  | { status: 'exists'; invoiceId: string; email: FleetInvoiceSendResult['status'] }
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
 * invoice if it never was (`sendFleetInvoiceEmail` mode `once`). Nothing to
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

  const sent = await sendFleetInvoiceEmail(invoiceId, 'once', deps);
  if (sent.status === 'no_contacts') {
    log.warn({ fleetId, invoiceId }, 'Fleet has no billing contact; the invoice was not emailed');
  }
  return created
    ? { status: 'invoiced', invoiceId, email: sent.status }
    : { status: 'exists', invoiceId, email: sent.status };
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
  period: string;
  invoiceNumber: string | null;
  errorMessage: string;
}

/**
 * The variables of one fleet.InvoiceRunFailed digest (pure). The templates
 * hold the wording in each language; the lists carry data only: fleet name,
 * invoice number and the error of each fleet, joined with "; ".
 */
export function fleetInvoiceRunFailureVariables(
  period: string,
  rows: FleetInvoiceRunFailureRow[],
): Record<string, string | number> {
  const issued = rows.filter((row) => row.invoiceNumber != null);
  const notInvoiced = rows.filter((row) => row.invoiceNumber == null);
  return {
    period,
    fleetCount: rows.length,
    fleetNames: rows.map((row) => row.fleetName).join(', '),
    issuedNotEmailedCount: issued.length,
    issuedNotEmailed: issued
      .map((row) => `${row.fleetName} (${row.invoiceNumber ?? ''}): ${row.errorMessage}`)
      .join('; '),
    notInvoicedCount: notInvoiced.length,
    notInvoiced: notInvoiced.map((row) => `${row.fleetName}: ${row.errorMessage}`).join('; '),
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

/** Claims the failures not reported yet; each row is returned to one caller only. */
async function claimUnreportedFailures(): Promise<FleetInvoiceRunFailureRow[]> {
  const rows = await client<
    Array<{
      fleet_id: string;
      name: string | null;
      period: string;
      invoice_number: string | null;
      error_message: string;
    }>
  >`
    WITH claimed AS (
      UPDATE fleet_invoice_run_failures SET reported_at = now()
      WHERE reported_at IS NULL
      RETURNING fleet_id, period_start, invoice_number, error_message
    )
    SELECT c.fleet_id, f.name, to_char(c.period_start, 'YYYY-MM') AS period,
           c.invoice_number, c.error_message
    FROM claimed c LEFT JOIN fleets f ON f.id = c.fleet_id
    ORDER BY c.period_start, f.name, c.fleet_id
  `;
  return rows.map((row) => ({
    fleetId: row.fleet_id,
    fleetName: row.name ?? row.fleet_id,
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
      SELECT count(*)::int AS n FROM fleet_invoice_run_failures WHERE reported_at IS NULL`;
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
 */
export async function sendFleetInvoiceOverdueNotice(
  invoiceId: string,
  deps: FleetInvoiceRunDeps,
  now: Date = new Date(),
): Promise<FleetOverdueNoticeResult> {
  const detail = await getInvoice(invoiceId);
  if (detail == null) return 'not_found';
  const { invoice } = detail;
  if (
    invoice.fleetId == null ||
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
  for (const email of contacts.emails) {
    await dispatchSystemNotification(
      client,
      FLEET_INVOICE_OVERDUE_EVENT,
      { email, language, timezone },
      variables,
      deps.templatesDirs,
      [attachment],
    );
  }
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
    WHERE i.kind = 'invoice' AND i.status = 'issued'
      AND i.due_at < ${now} AND i.overdue_notice_sent_at IS NULL
      AND cardinality(f.billing_contact_emails) > 0
    ORDER BY i.due_at, i.id
    LIMIT ${FLEET_INVOICE_OVERDUE_BATCH}
  `;
  const summary: FleetOverdueRunSummary = { sent: 0, noContacts: 0, failed: 0 };
  for (const row of rows) {
    try {
      const result = await sendFleetInvoiceOverdueNotice(row.id, deps, now);
      if (result === 'sent') summary.sent += 1;
      if (result === 'no_contacts') summary.noContacts += 1;
    } catch (err) {
      summary.failed += 1;
      log.warn({ err, invoiceId: row.id }, 'Fleet invoice overdue notice failed; continuing');
    }
  }
  return summary;
}
