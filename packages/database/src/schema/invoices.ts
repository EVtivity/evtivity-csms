// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  text,
  serial,
  varchar,
  integer,
  numeric,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  bigint,
  date,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createId } from '../lib/id.js';
import { drivers, fleets } from './drivers.js';
import { chargingSessions } from './charging.js';
import { paymentRecords } from './payments.js';

// 'credited': an issued or paid invoice a credit note credited in full. Its
// content never changes after issue (GoBD); only the status moves.
export const invoiceStatusEnum = pgEnum('invoice_status', [
  'draft',
  'issued',
  'paid',
  'void',
  'credited',
]);

/** An invoice, or a credit note that credits one (negative amounts). */
export const INVOICE_KINDS = ['invoice', 'credit_note'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export const invoices = pgTable(
  'invoices',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('invoice')),
    invoiceNumber: varchar('invoice_number', { length: 50 }).notNull().unique(),
    driverId: text('driver_id').references(() => drivers.id, { onDelete: 'set null' }),
    // A fleet invoice (charge on account) bills a fleet for one calendar month
    // (system timezone); a credit note of it carries the same fleet and period.
    // Null on driver invoices. See features/fleet-billing.md (fleet invoice).
    fleetId: text('fleet_id').references(() => fleets.id, { onDelete: 'restrict' }),
    // First and last day of the billed month.
    periodStart: date('period_start'),
    periodEnd: date('period_end'),
    // The fleet billing profile's bill-to block at issue (FleetBillTo), never updated.
    billTo: jsonb('bill_to'),
    // Language of the fleet invoice PDF and email at issue (INVOICE_LANGUAGES).
    language: varchar('language', { length: 10 }),
    // When the invoice email last went to the fleet billing contacts; the
    // marker that sends it once per issue (a resend sets it again).
    sentAt: timestamp('sent_at', { withTimezone: true }),
    // When invoice.FleetOverdue went to the fleet billing contacts (an issued
    // fleet invoice past its due date). The claim that sends it once (S9 run).
    overdueNoticeSentAt: timestamp('overdue_notice_sent_at', { withTimezone: true }),
    status: invoiceStatusEnum('status').notNull().default('draft'),
    kind: varchar('kind', { length: 16, enum: INVOICE_KINDS }).notNull().default('invoice'),
    // The invoice a credit note credits (kind 'credit_note' only). One credit note per invoice.
    creditedInvoiceId: text('credited_invoice_id').references((): AnyPgColumn => invoices.id, {
      onDelete: 'restrict',
    }),
    // The operator's reason for a credit note, printed on it.
    creditReason: varchar('credit_reason', { length: 500 }),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    currency: varchar('currency', { length: 3 }).notNull(),
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    // When the invoice was paid in full: at creation when every amount on it was
    // already collected, or when an operator marked it paid. Null on older invoices.
    paidAt: timestamp('paid_at', { withTimezone: true }),
    // The operator's note of a payment received outside EVtivity (bank transfer reference).
    paymentReference: varchar('payment_reference', { length: 200 }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_invoices_driver_id').on(table.driverId),
    index('idx_invoices_status').on(table.status),
    index('idx_invoices_invoice_number').on(table.invoiceNumber),
    index('idx_invoices_fleet_id').on(table.fleetId),
    // One live invoice per fleet and period; a void or credited one frees it.
    uniqueIndex('uq_invoices_fleet_period')
      .on(table.fleetId, table.periodStart)
      .where(sql`fleet_id IS NOT NULL AND kind = 'invoice' AND status NOT IN ('void', 'credited')`),
    uniqueIndex('uq_invoices_credited_invoice_id')
      .on(table.creditedInvoiceId)
      .where(sql`credited_invoice_id IS NOT NULL`),
    check('invoices_kind_check', sql`${table.kind} IN ('invoice', 'credit_note')`),
    check(
      'invoices_fleet_period_check',
      sql`${table.fleetId} IS NULL OR (${table.periodStart} IS NOT NULL AND ${table.periodEnd} IS NOT NULL AND ${table.periodEnd} >= ${table.periodStart})`,
    ),
    check(
      'invoices_credit_note_reference_check',
      sql`(${table.kind} = 'credit_note') = (${table.creditedInvoiceId} IS NOT NULL)`,
    ),
  ],
);

/**
 * The last number issued per document kind ('invoice', 'credit_note'). The
 * invoice transaction increments its row, so a rolled-back invoice gives its
 * number back and the numbers have no gaps (GoBD). A sequence never rolls back.
 */
export const invoiceNumberCounters = pgTable('invoice_number_counters', {
  name: varchar('name', { length: 32 }).primaryKey(),
  value: bigint('value', { mode: 'number' }).notNull(),
});

export const invoiceLineItems = pgTable(
  'invoice_line_items',
  {
    id: serial('id').primaryKey(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => chargingSessions.id, { onDelete: 'cascade' }),
    // A reservation fee charge (cancellation or no-show) invoiced on this line.
    paymentRecordId: integer('payment_record_id').references(() => paymentRecords.id, {
      onDelete: 'cascade',
    }),
    description: varchar('description', { length: 500 }).notNull(),
    quantity: numeric('quantity').notNull().default('1'),
    unitPriceCents: integer('unit_price_cents').notNull(),
    totalCents: integer('total_cents').notNull(),
    taxCents: integer('tax_cents').notNull().default(0),
    /** Tax rate of this line as a fraction (0.19 is 19%). totalCents is net of it. */
    taxRate: numeric('tax_rate').notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_invoice_line_items_invoice_id').on(table.invoiceId),
    index('idx_invoice_line_items_session_id').on(table.sessionId),
    index('idx_invoice_line_items_payment_record_id').on(table.paymentRecordId),
  ],
);
