// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client, getSystemTimezone, loadFleetBillingContacts } from '@evtivity/database';
import { dispatchSystemNotification, notificationMoney } from '@evtivity/lib';
import type { EmailAttachment } from '@evtivity/lib';
import { getInvoice } from './invoice.service.js';
import type { InvoiceDetail } from './invoice.service.js';
import {
  formatPeriod,
  generateInvoicePdf,
  resolveInvoicePdfLanguage,
} from './invoice-pdf.service.js';
import { INVOICE_LABELS } from './invoice-labels.js';

export const FLEET_INVOICE_EVENT = 'invoice.FleetInvoice';
export const FLEET_CREDIT_NOTE_EVENT = 'invoice.FleetCreditNote';

/**
 * How a send treats an invoice that was emailed before: `once` sends only
 * when it never was (the issue of an invoice or credit note, P7), `resend`
 * always sends (the operator's Send action).
 */
export type FleetInvoiceSendMode = 'once' | 'resend';

/** What a send did. */
export type FleetInvoiceSendResult =
  | { status: 'sent'; recipients: number }
  | { status: 'already_sent' | 'no_contacts' | 'not_fleet' | 'not_found' };

export interface FleetInvoiceSendDeps {
  /** Notification template directories of the calling process. */
  templatesDirs: string[];
}

/** The template variables of a fleet invoice or credit note email. */
export function fleetInvoiceVariables(detail: InvoiceDetail): Record<string, unknown> {
  const { invoice, fleet, creditedInvoice, lineItems } = detail;
  const language = resolveInvoicePdfLanguage(invoice.language);
  const periodLabel = formatPeriod(invoice.periodStart, INVOICE_LABELS[language].locale) ?? '';
  const amountCents = Math.abs(invoice.totalCents);
  const common = {
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
async function markSent(invoiceId: string, mode: FleetInvoiceSendMode): Promise<boolean> {
  const rows =
    mode === 'once'
      ? await client`
          UPDATE invoices SET sent_at = now() WHERE id = ${invoiceId} AND sent_at IS NULL
          RETURNING id`
      : await client`UPDATE invoices SET sent_at = now() WHERE id = ${invoiceId} RETURNING id`;
  return rows.length > 0;
}

/**
 * Emails a fleet invoice (invoice.FleetInvoice) or the credit note of one
 * (invoice.FleetCreditNote) to the fleet's billing contacts, with the PDF
 * attached, through dispatchSystemNotification (P2), in the language stored on
 * the invoice and the system timezone. `invoices.sent_at` is the marker: mode
 * `once` claims it only while it is null, so an issue is emailed once (P7);
 * `resend` sends again and sets it. The PDF is rendered before the claim, so
 * a render failure leaves the invoice unsent. The dispatcher is fail-open per
 * recipient (each attempt is in the notification history). A fleet without
 * billing contacts sends nothing (`no_contacts`).
 */
export async function sendFleetInvoiceEmail(
  invoiceId: string,
  mode: FleetInvoiceSendMode,
  deps: FleetInvoiceSendDeps,
): Promise<FleetInvoiceSendResult> {
  const detail = await getInvoice(invoiceId);
  if (detail == null) return { status: 'not_found' };
  const { invoice } = detail;
  if (invoice.fleetId == null) return { status: 'not_fleet' };

  const contacts = await loadFleetBillingContacts(client, invoice.fleetId);
  if (contacts.emails.length === 0) return { status: 'no_contacts' };

  const pdf = await generateInvoicePdf(detail);
  if (!(await markSent(invoice.id, mode))) return { status: 'already_sent' };

  const attachment: EmailAttachment = {
    filename: `${invoice.invoiceNumber}.pdf`,
    content: pdf,
    contentType: 'application/pdf',
  };
  const eventType = invoice.kind === 'credit_note' ? FLEET_CREDIT_NOTE_EVENT : FLEET_INVOICE_EVENT;
  const variables = fleetInvoiceVariables(detail);
  const language = invoice.language ?? contacts.language ?? 'en';
  const timezone = await getSystemTimezone();
  for (const email of contacts.emails) {
    await dispatchSystemNotification(
      client,
      eventType,
      { email, language, timezone },
      variables,
      deps.templatesDirs,
      [attachment],
    );
  }
  return { status: 'sent', recipients: contacts.emails.length };
}
