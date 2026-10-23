// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { index, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { createId } from '../lib/id.js';
import { chargingStations, sites } from './assets.js';

/**
 * A payment terminal (placeholder, v0.1.48): the second target a SIM can be
 * attached to (`sim_attachments.payment_terminal_id`). Nothing writes it yet;
 * the terminal management follow-up adds routes and a writer. Vendor, model and
 * serial number are the OCPP PaymentCtrlr identity of the physical terminal.
 * Site and station are SET NULL on delete: a terminal outlives the record it
 * was mounted at, and a cascade would delete its SIM attachment history.
 */
export const paymentTerminals = pgTable(
  'payment_terminals',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('paymentTerminal')),
    siteId: text('site_id').references(() => sites.id, { onDelete: 'set null' }),
    stationId: text('station_id').references(() => chargingStations.id, { onDelete: 'set null' }),
    label: varchar('label', { length: 100 }),
    vendor: varchar('vendor', { length: 255 }),
    model: varchar('model', { length: 255 }),
    serialNumber: varchar('serial_number', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_payment_terminals_site_id').on(table.siteId),
    index('idx_payment_terminals_station_id').on(table.stationId),
  ],
);
