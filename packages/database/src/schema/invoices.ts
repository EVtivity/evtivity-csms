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
} from 'drizzle-orm/pg-core';
import { createId } from '../lib/id.js';
import { drivers } from './drivers.js';
import { chargingSessions } from './charging.js';

export const invoiceStatusEnum = pgEnum('invoice_status', ['draft', 'issued', 'paid', 'void']);

export const invoices = pgTable(
  'invoices',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('invoice')),
    invoiceNumber: varchar('invoice_number', { length: 50 }).notNull().unique(),
    driverId: text('driver_id').references(() => drivers.id, { onDelete: 'set null' }),
    status: invoiceStatusEnum('status').notNull().default('draft'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_invoices_driver_id').on(table.driverId),
    index('idx_invoices_status').on(table.status),
    index('idx_invoices_invoice_number').on(table.invoiceNumber),
  ],
);

export const invoiceLineItems = pgTable(
  'invoice_line_items',
  {
    id: serial('id').primaryKey(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => chargingSessions.id, { onDelete: 'cascade' }),
    description: varchar('description', { length: 500 }).notNull(),
    quantity: numeric('quantity').notNull().default('1'),
    unitPriceCents: integer('unit_price_cents').notNull(),
    totalCents: integer('total_cents').notNull(),
    taxCents: integer('tax_cents').notNull().default(0),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_invoice_line_items_invoice_id').on(table.invoiceId),
    index('idx_invoice_line_items_session_id').on(table.sessionId),
  ],
);
