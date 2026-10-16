// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { invoices } from '@evtivity/database';
import type { InvoicePaymentSettings } from '@evtivity/database';
import { buildEpcQrPayload, formatCurrencyAmount, formatIban } from '@evtivity/lib';
import type { InvoiceLabels } from './invoice-labels.js';

type Invoice = typeof invoices.$inferSelect;

/** The fields of an invoice the payment block reads. */
export type InvoicePaymentBlockInvoice = Pick<
  Invoice,
  | 'invoiceNumber'
  | 'kind'
  | 'status'
  | 'fleetId'
  | 'currency'
  | 'totalCents'
  | 'issuedAt'
  | 'dueAt'
  | 'paidAt'
  | 'paymentReference'
>;

/**
 * The "Payment information" block below the totals of an invoice PDF:
 * - `transfer`: an issued invoice with an amount to pay. The sentence names
 *   the amount, the due date and the invoice number as the reference; the rows
 *   hold the bank details; `qrPayload` is the EPC QR code (EUR only, when on).
 * - `paid`: a paid invoice. No transfer request, so nobody pays twice.
 * - `creditNote`: a credit note. Nothing to pay, no QR code.
 */
export interface InvoicePaymentBlock {
  kind: 'transfer' | 'paid' | 'creditNote';
  text: string;
  /** Label and value rows printed under the text. */
  rows: Array<[string, string]>;
  /** The EPC QR code payload, or null when none is printed. */
  qrPayload: string | null;
}

export interface InvoicePaymentBlockInput {
  invoice: InvoicePaymentBlockInvoice;
  labels: InvoiceLabels;
  payment: InvoicePaymentSettings;
  /** The seller name, the account holder when none is set. */
  sellerName: string;
  /** Formats a date in the invoice language. */
  formatDate: (value: Date | null) => string;
}

/**
 * Whether a driver invoice was paid when it was issued: every session on it
 * was collected through the payment provider (a card payment), so paidAt is
 * the issue time and no reference was recorded. An operator's mark-paid
 * (a payment received outside EVtivity) sets its own date and reference.
 */
function paidByCardAtIssue(invoice: InvoicePaymentBlockInvoice): boolean {
  return (
    invoice.fleetId == null &&
    invoice.totalCents > 0 &&
    invoice.paymentReference == null &&
    invoice.paidAt != null &&
    invoice.issuedAt != null &&
    invoice.paidAt.getTime() === invoice.issuedAt.getTime()
  );
}

/**
 * The payment block of an invoice PDF, or null when none is printed: no IBAN
 * is set, or the invoice is a draft, void, credited, or has nothing to pay.
 */
export function invoicePaymentBlock(input: InvoicePaymentBlockInput): InvoicePaymentBlock | null {
  const { invoice, labels, payment } = input;
  if (payment.iban == null) return null;

  if (invoice.kind === 'credit_note') {
    return { kind: 'creditNote', text: labels.paymentCreditNote, rows: [], qrPayload: null };
  }

  if (invoice.status === 'paid') {
    const date = input.formatDate(invoice.paidAt ?? invoice.issuedAt);
    const template = paidByCardAtIssue(invoice) ? labels.paymentPaidByCard : labels.paymentPaid;
    const rows: Array<[string, string]> =
      invoice.paymentReference != null && invoice.paymentReference.trim() !== ''
        ? [[labels.paymentReference, invoice.paymentReference.trim()]]
        : [];
    return { kind: 'paid', text: template.replace('{date}', date), rows, qrPayload: null };
  }

  if (invoice.status !== 'issued' || invoice.totalCents <= 0) return null;

  const amount = formatCurrencyAmount(invoice.totalCents, invoice.currency, labels.locale);
  const text =
    invoice.dueAt != null
      ? labels.paymentTransfer
          .replace('{amount}', amount)
          .replace('{date}', input.formatDate(invoice.dueAt))
          .replace('{reference}', invoice.invoiceNumber)
      : labels.paymentTransferNoDue
          .replace('{amount}', amount)
          .replace('{reference}', invoice.invoiceNumber);
  const holder = payment.accountHolder ?? input.sellerName;
  const rows: Array<[string, string]> = [
    [labels.paymentAccountHolder, holder],
    [labels.paymentIban, formatIban(payment.iban)],
  ];
  if (payment.bic != null) rows.push([labels.paymentBic, payment.bic]);
  if (payment.bankName != null) rows.push([labels.paymentBank, payment.bankName]);
  rows.push([labels.paymentReference, invoice.invoiceNumber]);

  const qrPayload = payment.epcQrEnabled
    ? buildEpcQrPayload({
        name: holder,
        iban: payment.iban,
        bic: payment.bic,
        amountCents: invoice.totalCents,
        currency: invoice.currency,
        remittance: invoice.invoiceNumber,
      })
    : null;
  return { kind: 'transfer', text, rows, qrPayload };
}
