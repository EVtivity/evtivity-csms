// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  db,
  invoices,
  invoiceLineItems,
  chargingSessions,
  allocateInvoiceNumber,
} from '@evtivity/database';
import { AppError } from '@evtivity/lib';
import { creditNoteError } from './invoice.service.js';
import type { InvoiceWithLineItems } from './invoice.service.js';

type Invoice = typeof invoices.$inferSelect;

/** Statuses of an invoice a credit note can credit. */
const CREDITABLE_STATUSES = ['issued', 'paid'] as const;

/** Negates an amount without producing -0. */
function negate(cents: number): number {
  return 0 - cents;
}

export interface CreditResult {
  /** The credited invoice before the credit. */
  before: Invoice;
  /** The credited invoice after the credit (status 'credited', content unchanged). */
  original: Invoice;
  /** The credit note and its lines. */
  creditNote: InvoiceWithLineItems;
  /** Sessions the credit released, so the next invoice bills them again. */
  releasedSessionIds: string[];
}

function notCreditableError(status: Invoice['status']): AppError {
  if (status === 'credited') {
    return new AppError(
      'This invoice is already credited by a credit note',
      409,
      'INVOICE_ALREADY_CREDITED',
    );
  }
  return new AppError(
    `Only an issued or paid invoice can be credited; this invoice is ${status}`,
    409,
    'INVOICE_NOT_ISSUED',
  );
}

/**
 * Credits an issued or paid invoice in full with a credit note (GoBD: an
 * issued invoice is never changed or deleted; a credit note that references it
 * corrects it). In one transaction:
 *
 * - locks the invoice (FOR UPDATE), so two credits of one invoice run one
 *   after the other and the second is refused;
 * - inserts the credit note: kind 'credit_note', credited_invoice_id, its own
 *   gap-free number (CN-YYYYMM-NNNN), every line of the invoice with negated
 *   amounts, and the reason;
 * - moves the invoice to 'credited' (its lines and amounts stay as issued);
 * - releases the invoice's sessions (invoice_id back to null), so the next
 *   invoice bills them again, corrected. Reservation fee charges stay claimed
 *   by the credited invoice and are not billed again (plan, Corrections).
 *
 * The credit note is issued with no due date. When the credited invoice was
 * paid, the refund of that money is made outside EVtivity.
 *
 * Throws INVOICE_IS_CREDIT_NOTE (409) for a credit note,
 * INVOICE_ALREADY_CREDITED (409) for a credited invoice, and
 * INVOICE_NOT_ISSUED (409) for a draft or void one. The unique index on
 * credited_invoice_id refuses a second credit note at the database too. Null
 * when the invoice does not exist.
 */
export async function creditInvoice(
  invoiceId: string,
  reason: string,
): Promise<CreditResult | null> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .for('update');
    if (before == null) return null;
    if (before.kind === 'credit_note') throw creditNoteError();
    if (!(CREDITABLE_STATUSES as readonly string[]).includes(before.status)) {
      throw notCreditableError(before.status);
    }

    const lines = await tx
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId))
      .orderBy(asc(invoiceLineItems.id));

    const now = new Date();
    const invoiceNumber = await allocateInvoiceNumber(tx, 'credit_note', now);
    const [creditNote] = await tx
      .insert(invoices)
      .values({
        invoiceNumber,
        kind: 'credit_note',
        creditedInvoiceId: before.id,
        creditReason: reason,
        driverId: before.driverId,
        // A credit note of a fleet invoice bills the same fleet and period, with
        // the bill-to block and language of the invoice it credits.
        fleetId: before.fleetId,
        periodStart: before.periodStart,
        periodEnd: before.periodEnd,
        billTo: before.billTo,
        language: before.language,
        status: 'issued',
        issuedAt: now,
        dueAt: null,
        paidAt: null,
        currency: before.currency,
        subtotalCents: negate(before.subtotalCents),
        taxCents: negate(before.taxCents),
        totalCents: negate(before.totalCents),
      })
      .returning();
    if (creditNote == null) throw new Error('Failed to create credit note');

    const lineItems =
      lines.length > 0
        ? await tx
            .insert(invoiceLineItems)
            .values(
              lines.map((line) => ({
                invoiceId: creditNote.id,
                sessionId: line.sessionId,
                paymentRecordId: line.paymentRecordId,
                description: line.description,
                quantity: line.quantity,
                unitPriceCents: negate(line.unitPriceCents),
                totalCents: negate(line.totalCents),
                taxCents: negate(line.taxCents),
                taxRate: line.taxRate,
                metadata: line.metadata,
              })),
            )
            .returning()
        : [];

    const [original] = await tx
      .update(invoices)
      .set({ status: 'credited', updatedAt: now })
      .where(and(eq(invoices.id, invoiceId), inArray(invoices.status, [...CREDITABLE_STATUSES])))
      .returning();
    // The row is locked, so its status cannot have changed since the select.
    if (original == null) throw new Error('Invoice changed while it was being credited');

    const released = await tx
      .update(chargingSessions)
      .set({ invoiceId: null })
      .where(eq(chargingSessions.invoiceId, invoiceId))
      .returning({ id: chargingSessions.id });

    return {
      before,
      original,
      creditNote: { invoice: creditNote, lineItems },
      releasedSessionIds: released.map((session) => session.id),
    };
  });
}
