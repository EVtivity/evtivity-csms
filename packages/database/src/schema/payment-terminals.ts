// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { createId } from '../lib/id.js';
import { chargingStations, evses, sites } from './assets.js';
import { chargingSessions } from './charging.js';
import { guestSessions } from './drivers.js';
import { users } from './identity.js';
import { paymentRecords } from './payments.js';

/** The terminal states of a terminal transaction (P5: no update leaves them, except a refund of a capture). */
export const TERMINAL_TXN_STATE_VALUES = [
  'requested',
  'presenting',
  'authorized',
  'declined',
  'expired',
  'capture_requested',
  'captured',
  'void_requested',
  'voided',
  'refund_pending',
  'partially_refunded',
  'refunded',
  'failed',
] as const;

/**
 * A card payment terminal (v0.1.49, `features/payment-terminals.md`). The
 * registry row: the provider and its device id, the pairing to a site, a
 * station and optionally one EVSE (null EVSE: station-wide), the operator
 * status and the last known device status. Vendor, model and serial number
 * are the OCPP PaymentCtrlr identity of the physical terminal. Site, station
 * and EVSE are SET NULL on delete: a terminal outlives the record it was
 * mounted at, and a cascade would delete its SIM attachment history. Only
 * `@evtivity/database/lib/payment-terminals.ts` writes it.
 */
export const paymentTerminals = pgTable(
  'payment_terminals',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('paymentTerminal')),
    siteId: text('site_id').references(() => sites.id, { onDelete: 'set null' }),
    stationId: text('station_id').references(() => chargingStations.id, { onDelete: 'set null' }),
    evseId: text('evse_id').references(() => evses.id, { onDelete: 'set null' }),
    label: varchar('label', { length: 100 }),
    vendor: varchar('vendor', { length: 255 }),
    model: varchar('model', { length: 255 }),
    serialNumber: varchar('serial_number', { length: 255 }),
    provider: varchar('provider', { length: 32 }).notNull(),
    integrationMode: varchar('integration_mode', { length: 16 }).notNull(),
    providerDeviceId: varchar('provider_device_id', { length: 128 }),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    online: boolean('online'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    statusFetchedAt: timestamp('status_fetched_at', { withTimezone: true }),
    /** When the terminal was first seen offline in the current offline period (the 15-minute alert). */
    offlineSince: timestamp('offline_since', { withTimezone: true }),
    /** When the operators were alerted about the current offline period (once per period). */
    offlineAlertedAt: timestamp('offline_alerted_at', { withTimezone: true }),
    firmwareVersion: varchar('firmware_version', { length: 64 }),
    ocppTerminalId: varchar('ocpp_terminal_id', { length: 255 }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_payment_terminals_site_id').on(table.siteId),
    index('idx_payment_terminals_station_id').on(table.stationId),
    uniqueIndex('uq_payment_terminals_provider_device')
      .on(table.provider, table.providerDeviceId)
      .where(sql`${table.providerDeviceId} IS NOT NULL`),
    uniqueIndex('uq_payment_terminals_active_evse')
      .on(table.evseId)
      .where(sql`${table.evseId} IS NOT NULL AND ${table.status} = 'active'`),
    check(
      'payment_terminals_integration_mode_check',
      sql`${table.integrationMode} IN ('cloud', 'hardware')`,
    ),
    check('payment_terminals_status_check', sql`${table.status} IN ('active', 'inactive')`),
    check(
      'payment_terminals_evse_needs_station_check',
      sql`${table.evseId} IS NULL OR ${table.stationId} IS NOT NULL`,
    ),
  ],
);

/**
 * One card payment at a terminal (v0.1.49). Only `@evtivity/payments`
 * `terminal-payments.ts` writes it. Site, station and EVSE are stamped at the
 * start (site isolation reads this row's site, never the terminal's current
 * one). The terminal is RESTRICT: history never cascades away.
 */
export const paymentTerminalTransactions = pgTable(
  'payment_terminal_transactions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('paymentTerminalTransaction')),
    paymentTerminalId: text('payment_terminal_id')
      .notNull()
      .references(() => paymentTerminals.id, { onDelete: 'restrict' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    providerTxnRef: varchar('provider_txn_ref', { length: 200 }),
    siteId: text('site_id').references(() => sites.id, { onDelete: 'set null' }),
    stationId: text('station_id').references(() => chargingStations.id, { onDelete: 'set null' }),
    /** The OCPP EVSE id the start went to; 0 for a station-wide start the station decides. */
    evseNumber: integer('evse_number'),
    guestSessionId: integer('guest_session_id').references(() => guestSessions.id, {
      onDelete: 'set null',
    }),
    sessionId: text('session_id').references(() => chargingSessions.id, { onDelete: 'set null' }),
    paymentRecordId: integer('payment_record_id').references(() => paymentRecords.id, {
      onDelete: 'set null',
    }),
    state: varchar('state', { length: 20 }).notNull().default('requested'),
    currency: varchar('currency', { length: 3 }).notNull(),
    requestedCents: integer('requested_cents').notNull(),
    authorizedCents: integer('authorized_cents'),
    capturedCents: integer('captured_cents'),
    refundedCents: integer('refunded_cents').notNull().default(0),
    cardLast4: varchar('card_last4', { length: 4 }),
    cardBin: varchar('card_bin', { length: 6 }),
    cardBrand: varchar('card_brand', { length: 30 }),
    declineCode: varchar('decline_code', { length: 200 }),
    failureReason: varchar('failure_reason', { length: 500 }),
    receiptUrl: varchar('receipt_url', { length: 500 }),
    receiptEmail: varchar('receipt_email', { length: 255 }),
    pendingOperationRef: varchar('pending_operation_ref', { length: 200 }),
    pendingOperationAt: timestamp('pending_operation_at', { withTimezone: true }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_payment_terminal_txn_provider_ref')
      .on(table.provider, table.providerTxnRef)
      .where(sql`${table.providerTxnRef} IS NOT NULL`),
    uniqueIndex('uq_payment_terminal_txn_guest_session')
      .on(table.guestSessionId)
      .where(sql`${table.guestSessionId} IS NOT NULL`),
    index('idx_payment_terminal_txn_terminal').on(table.paymentTerminalId, table.requestedAt),
    index('idx_payment_terminal_txn_session').on(table.sessionId),
    index('idx_payment_terminal_txn_site').on(table.siteId),
    index('idx_payment_terminal_txn_open')
      .on(table.state, table.updatedAt)
      .where(
        sql`${table.state} IN ('requested', 'presenting', 'authorized', 'capture_requested', 'void_requested', 'refund_pending')`,
      ),
    check(
      'payment_terminal_txn_state_check',
      sql`${table.state} IN ('requested', 'presenting', 'authorized', 'declined', 'expired', 'capture_requested', 'captured', 'void_requested', 'voided', 'refund_pending', 'partially_refunded', 'refunded', 'failed')`,
    ),
    check(
      'payment_terminal_txn_amounts_check',
      sql`${table.requestedCents} BETWEEN 1 AND 1000000
        AND (${table.authorizedCents} IS NULL OR ${table.authorizedCents} BETWEEN 1 AND ${table.requestedCents})
        AND (${table.capturedCents} IS NULL OR (${table.authorizedCents} IS NOT NULL AND ${table.capturedCents} BETWEEN 0 AND ${table.authorizedCents}))
        AND ${table.refundedCents} BETWEEN 0 AND COALESCE(${table.capturedCents}, 0)`,
    ),
    check(
      'payment_terminal_txn_card_check',
      sql`(${table.cardLast4} IS NULL OR ${table.cardLast4} ~ '^[0-9]{4}$')
        AND (${table.cardBin} IS NULL OR ${table.cardBin} ~ '^[0-9]{6}$')`,
    ),
  ],
);
