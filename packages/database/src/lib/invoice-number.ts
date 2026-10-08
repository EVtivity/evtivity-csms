// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { createLogger, isValidTimezone } from '@evtivity/lib';
import type { db } from '../config.js';
import type { InvoiceKind } from '../schema/invoices.js';
import { getSystemTimezone } from './system-settings.js';

const logger = createLogger('invoice-number');

/** Number prefix per document kind: INV for invoices, CN for credit notes. */
const NUMBER_PREFIX: Record<InvoiceKind, string> = { invoice: 'INV', credit_note: 'CN' };

/**
 * The INV-YYYYMM- (or CN-YYYYMM-) prefix of a document issued at issuedAt: the
 * year and month in the system timezone, so an invoice issued late on the last
 * day of a month carries that month. An invalid timezone falls back to UTC.
 */
export function invoiceNumberPrefix(
  issuedAt: Date,
  timeZone: string,
  kind: InvoiceKind = 'invoice',
): string {
  let zone = timeZone;
  if (!isValidTimezone(zone)) {
    logger.warn({ timeZone }, 'Invalid system timezone, numbering the invoice in UTC');
    zone = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(issuedAt);
  const year = parts.find((p) => p.type === 'year')?.value ?? String(issuedAt.getUTCFullYear());
  const month =
    parts.find((p) => p.type === 'month')?.value ??
    String(issuedAt.getUTCMonth() + 1).padStart(2, '0');
  return `${NUMBER_PREFIX[kind]}-${year}${month}-`;
}

/** What runs the number allocation: the invoice transaction. */
export type InvoiceNumberExecutor = Pick<typeof db, 'execute'>;

/**
 * Allocates the next number of a document kind inside the caller's
 * transaction. Format INV-YYYYMM-NNNN or CN-YYYYMM-NNNN, the month of issuedAt
 * in the system timezone. The counter row of invoice_number_counters is
 * incremented in the transaction: it stays locked until the commit, so
 * concurrent invoices are numbered one after the other, and a rollback gives
 * the number back. The numbers have no gaps (GoBD), which a sequence cannot
 * guarantee: nextval is never rolled back.
 *
 * The sequence part (NNNN) is global per kind and does not reset monthly.
 *
 * invoice_number_seq is no longer read. v0.1.41 pods still number through it
 * during the rolling upgrade to v0.1.42, under the same counter row lock and
 * always above the counter, so the two never draw the same number. v0.1.43
 * drops it.
 */
export async function allocateInvoiceNumber(
  tx: InvoiceNumberExecutor,
  kind: InvoiceKind,
  issuedAt: Date,
): Promise<string> {
  const prefix = invoiceNumberPrefix(issuedAt, await getSystemTimezone(), kind);
  const [row] = await tx.execute(
    sql`UPDATE invoice_number_counters SET value = value + 1
        WHERE name = ${kind} RETURNING value`,
  );
  if (row == null) throw new Error(`Invoice number counter '${kind}' is missing`);
  const value = Number((row as { value: string | number }).value);
  return `${prefix}${String(value).padStart(4, '0')}`;
}
