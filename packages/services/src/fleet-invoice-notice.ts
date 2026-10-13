// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client, getSystemTimezone, loadFleetBillingContacts } from '@evtivity/database';
import {
  dispatchDriverNotification,
  dispatchSystemNotification,
  notificationMoney,
} from '@evtivity/lib';
import type { EmailAttachment, NotificationDelivery } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { getInvoice } from './invoice.service.js';
import type { InvoiceDetail } from './invoice.service.js';
import {
  formatPeriod,
  generateInvoicePdf,
  resolveInvoicePdfLanguage,
} from './invoice-pdf.service.js';
import { INVOICE_LABELS } from './invoice-labels.js';
import { writeInvoiceSentAudit } from './invoice-audit.js';
import type { InvoiceAuditActor, InvoiceAuditLogger } from './invoice-audit.js';

export const FLEET_INVOICE_EVENT = 'invoice.FleetInvoice';
export const FLEET_CREDIT_NOTE_EVENT = 'invoice.FleetCreditNote';
/** Driver events of a member invoice (`invoices.member_billed`): always on, email and push. */
export const MEMBER_INVOICE_EVENT = 'invoice.MemberInvoice';
export const MEMBER_CREDIT_NOTE_EVENT = 'invoice.MemberCreditNote';
export const MEMBER_OVERDUE_EVENT = 'invoice.MemberOverdue';
export type MemberInvoiceEvent =
  | typeof MEMBER_INVOICE_EVENT
  | typeof MEMBER_CREDIT_NOTE_EVENT
  | typeof MEMBER_OVERDUE_EVENT;

/**
 * How a send treats an invoice that was emailed before: `once` sends only
 * when it never was (the issue of an invoice or credit note, P7), `resend`
 * always sends (the operator's Send action).
 */
export type AccountInvoiceSendMode = 'once' | 'resend';

/**
 * What a send did. `no_contacts`: a fleet invoice whose fleet has no billing
 * contact. `no_driver`: a member invoice whose driver row is gone.
 * `no_email`: a member invoice whose driver has no email address. None of
 * them marks the invoice sent.
 */
export type AccountInvoiceSendResult =
  | { status: 'sent'; recipients: number }
  | {
      status: 'already_sent' | 'no_contacts' | 'no_driver' | 'no_email' | 'not_fleet' | 'not_found';
    };

export interface AccountInvoiceSendDeps {
  /** Notification template directories of the calling process. */
  templatesDirs: string[];
}

/** Who the `invoice_sent` audit row names, and where a failed write is logged. */
export interface AccountInvoiceSendAudit {
  actor: InvoiceAuditActor;
  log?: InvoiceAuditLogger | undefined;
}

/**
 * The template variables of a fleet or member invoice, credit note or overdue
 * notice. `invoiceId` lets the app open the invoice from a member push.
 */
export function fleetInvoiceVariables(detail: InvoiceDetail): Record<string, unknown> {
  const { invoice, fleet, creditedInvoice, lineItems } = detail;
  const language = resolveInvoicePdfLanguage(invoice.language);
  const periodLabel = formatPeriod(invoice.periodStart, INVOICE_LABELS[language].locale) ?? '';
  const amountCents = Math.abs(invoice.totalCents);
  const common = {
    invoiceId: invoice.id,
    fleetName: fleet?.name ?? '',
    periodLabel,
    issuedAt: invoice.issuedAt?.toISOString() ?? '',
    // Formatted in the recipient's language by the dispatcher.
    total: notificationMoney(amountCents, invoice.currency),
    totalCents: amountCents,
    currency: invoice.currency,
  };
  if (invoice.kind === 'credit_note') {
    return {
      ...common,
      creditNoteNumber: invoice.invoiceNumber,
      invoiceNumber: creditedInvoice?.invoiceNumber ?? '',
      creditReason: invoice.creditReason ?? '',
      wasPaid: creditedInvoice?.paidAt != null,
    };
  }
  const sessions = new Set(lineItems.map((item) => item.sessionId).filter((id) => id != null));
  return {
    ...common,
    invoiceNumber: invoice.invoiceNumber,
    dueAt: invoice.dueAt?.toISOString() ?? '',
    sessionCount: sessions.size,
  };
}

/** Marks the invoice sent; for `once` only when it never was. True when this call may send. */
async function markSent(invoiceId: string, mode: AccountInvoiceSendMode): Promise<boolean> {
  const rows =
    mode === 'once'
      ? await client`
          UPDATE invoices SET sent_at = now() WHERE id = ${invoiceId} AND sent_at IS NULL
          RETURNING id`
      : await client`UPDATE invoices SET sent_at = now() WHERE id = ${invoiceId} RETURNING id`;
  return rows.length > 0;
}

/** The PDF of an invoice or credit note as an email attachment. */
function pdfAttachment(invoiceNumber: string, pdf: Buffer): EmailAttachment {
  return { filename: `${invoiceNumber}.pdf`, content: pdf, contentType: 'application/pdf' };
}

/**
 * The driver a member invoice goes to: the invoice's driver when the row
 * still exists and has an email address (owner decision: the driver only,
 * never the fleet contacts).
 */
export function memberInvoiceRecipient(
  detail: InvoiceDetail,
): { driverId: string } | { status: 'no_driver' | 'no_email' } {
  const { driver } = detail;
  if (driver == null) return { status: 'no_driver' };
  if (driver.email == null || driver.email === '') return { status: 'no_email' };
  return { driverId: driver.id };
}

/**
 * Sends one member invoice notice (invoice.MemberInvoice,
 * invoice.MemberCreditNote or invoice.MemberOverdue) to the driver through
 * dispatchDriverNotification (P2), with the PDF attached to the email and no
 * SMS: the SMS template is the push text. The events are required, so the
 * operator switch and the driver's preferences do not apply. Fail-open: the
 * dispatcher never throws and returns what a provider accepted.
 */
export async function dispatchMemberInvoiceNotice(
  detail: InvoiceDetail,
  eventType: MemberInvoiceEvent,
  driverId: string,
  pdf: Buffer,
  deps: AccountInvoiceSendDeps,
): Promise<NotificationDelivery[]> {
  const { delivered } = await dispatchDriverNotification(
    client,
    eventType,
    driverId,
    fleetInvoiceVariables(detail),
    deps.templatesDirs,
    getPubSub(),
    { attachments: [pdfAttachment(detail.invoice.invoiceNumber, pdf)], sms: false },
  );
  return delivered;
}

/** Emails a member invoice or its credit note to the driver (sendAccountInvoiceEmail). */
async function sendMemberInvoiceEmail(
  detail: InvoiceDetail,
  mode: AccountInvoiceSendMode,
  deps: AccountInvoiceSendDeps,
  audit: AccountInvoiceSendAudit,
): Promise<AccountInvoiceSendResult> {
  const { invoice } = detail;
  const recipient = memberInvoiceRecipient(detail);
  if ('status' in recipient) return recipient;

  const pdf = await generateInvoicePdf(detail);
  if (!(await markSent(invoice.id, mode))) return { status: 'already_sent' };

  const eventType =
    invoice.kind === 'credit_note' ? MEMBER_CREDIT_NOTE_EVENT : MEMBER_INVOICE_EVENT;
  const delivered = await dispatchMemberInvoiceNotice(
    detail,
    eventType,
    recipient.driverId,
    pdf,
    deps,
  );
  await writeInvoiceSentAudit(
    {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      eventType,
      delivered,
      resend: invoice.sentAt != null,
      actor: audit.actor,
    },
    audit.log,
  );
  return { status: 'sent', recipients: 1 };
}

/**
 * Emails an account invoice or its credit note with the PDF attached, routed
 * by `invoices.member_billed`:
 *
 * - Fleet invoice: invoice.FleetInvoice or invoice.FleetCreditNote to each
 *   billing contact of the fleet through dispatchSystemNotification (P2), in
 *   the language stored on the invoice and the system timezone. A fleet
 *   without billing contacts sends nothing (`no_contacts`).
 * - Member invoice: invoice.MemberInvoice or invoice.MemberCreditNote to the
 *   driver only, through dispatchDriverNotification (email and push, no SMS),
 *   in the driver's language. A driver that is gone (`no_driver`) or has no
 *   email (`no_email`) sends nothing.
 *
 * `invoices.sent_at` is the marker: mode `once` claims it only while it is
 * null, so an issue is emailed once (P7); `resend` sends again and sets it.
 * The PDF is rendered before the claim, so a render failure leaves the
 * invoice unsent. The dispatchers are fail-open per recipient (each attempt
 * is in the notification history). A send that at least one provider
 * accepted is audited as `invoice_sent` by `audit.actor` (a resend when the
 * invoice was emailed before).
 */
export async function sendAccountInvoiceEmail(
  invoiceId: string,
  mode: AccountInvoiceSendMode,
  deps: AccountInvoiceSendDeps,
  audit: AccountInvoiceSendAudit,
): Promise<AccountInvoiceSendResult> {
  const detail = await getInvoice(invoiceId);
  if (detail == null) return { status: 'not_found' };
  const { invoice } = detail;
  if (invoice.fleetId == null) return { status: 'not_fleet' };
  if (invoice.memberBilled) return sendMemberInvoiceEmail(detail, mode, deps, audit);

  const contacts = await loadFleetBillingContacts(client, invoice.fleetId);
  if (contacts.emails.length === 0) return { status: 'no_contacts' };

  const pdf = await generateInvoicePdf(detail);
  if (!(await markSent(invoice.id, mode))) return { status: 'already_sent' };

  const attachment = pdfAttachment(invoice.invoiceNumber, pdf);
  const eventType = invoice.kind === 'credit_note' ? FLEET_CREDIT_NOTE_EVENT : FLEET_INVOICE_EVENT;
  const variables = fleetInvoiceVariables(detail);
  const language = invoice.language ?? contacts.language ?? 'en';
  const timezone = await getSystemTimezone();
  const delivered: NotificationDelivery[] = [];
  for (const email of contacts.emails) {
    const result = await dispatchSystemNotification(
      client,
      eventType,
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
      eventType,
      delivered,
      resend: invoice.sentAt != null,
      actor: audit.actor,
    },
    audit.log,
  );
  return { status: 'sent', recipients: contacts.emails.length };
}
