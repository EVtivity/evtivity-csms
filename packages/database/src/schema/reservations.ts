// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  text,
  integer,
  numeric,
  timestamp,
  varchar,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { createId } from '../lib/id.js';
import { chargingStations, evses, connectors } from './assets.js';
import { drivers, driverTokens } from './drivers.js';
import { fleetReservations } from './fleet-reservations.js';

export const reservationStatusEnum = pgEnum('reservation_status', [
  'scheduled',
  'active',
  'in_use',
  'used',
  'cancelled',
  'expired',
]);

// Who triggered the cancellation. Drives whether a cancellation fee may
// apply: driver -> always per settings, operator -> opt-in per request,
// system -> never.
export const reservationCancelledByEnum = pgEnum('reservation_cancelled_by', [
  'driver',
  'operator',
  'system',
]);

// Why the reservation was cancelled. Stable enum so the UI and notification
// templates can render the right localized string. Free-form notes from the
// operator land in `cancelNote` instead.
export const reservationCancelReasonEnum = pgEnum('reservation_cancel_reason', [
  'driver_initiated',
  'operator_manual',
  'expired_no_show',
  'station_rejected_occupied',
  'station_rejected_other',
  'station_offline_at_activation',
  'evse_in_use_at_activation',
  'station_faulted_at_activation',
  'system_cleanup',
  // v0.1.45 (migration 0450): the station never answered ReserveNow (G4), and
  // the station went offline or faulted while it held the EVSE (G16, E12).
  'station_no_response',
  'station_unavailable_during_hold',
]);

/**
 * The no-show fee of a reservation (migration 0451): none, due (the expiry
 * recorded a fee to charge; the cron settles it), charged, failed (declined or
 * could not run), waived (another driver used the reserved EVSE, E13).
 */
export const RESERVATION_NO_SHOW_FEE_STATES = [
  'none',
  'due',
  'charged',
  'failed',
  'waived',
] as const;
export type ReservationNoShowFeeState = (typeof RESERVATION_NO_SHOW_FEE_STATES)[number];

export const reservations = pgTable(
  'reservations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('reservation')),
    reservationId: integer('reservation_id').notNull(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    evseId: text('evse_id').references(() => evses.id),
    connectorId: text('connector_id').references(() => connectors.id),
    driverId: text('driver_id').references(() => drivers.id),
    tokenId: text('token_id').references(() => driverTokens.id, { onDelete: 'set null' }),
    status: reservationStatusEnum('status').notNull().default('active'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    fleetReservationId: text('fleet_reservation_id').references(() => fleetReservations.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    cancelledBy: reservationCancelledByEnum('cancelled_by'),
    cancelReason: reservationCancelReasonEnum('cancel_reason'),
    cancelNote: text('cancel_note'),
    cancellationFeeCents: integer('cancellation_fee_cents').notNull().default(0),
    // Fee terms snapshotted at creation (migration 0341): the tax basis the
    // fee amounts are entered in, the tax rate and holding fee per minute of
    // the tariff the driver resolved at the station, and the cancellation fee
    // setting. feeTaxBasis null: created before 0341, charged on the terms
    // current at the charge (resolveReservationFeeTerms).
    feeTaxBasis: varchar('fee_tax_basis', { length: 5 }),
    feeTaxRate: numeric('fee_tax_rate'),
    feePerMinute: numeric('fee_per_minute'),
    feeCancellationCents: integer('fee_cancellation_cents'),
    // When the station accepted ReserveNow (migration 0451). A no-show fee is
    // charged only for a hold the station accepted (G5).
    stationAckAt: timestamp('station_ack_at', { withTimezone: true }),
    noShowFeeState: varchar('no_show_fee_state', { length: 10 })
      .$type<ReservationNoShowFeeState>()
      .notNull()
      .default('none'),
  },
  (table) => [
    index('idx_reservations_station_id').on(table.stationId),
    index('idx_reservations_status').on(table.status),
    index('idx_reservations_driver_id').on(table.driverId),
    index('idx_reservations_token_id').on(table.tokenId),
    index('idx_reservations_expires_at').on(table.expiresAt),
    // The OCPP reservation id is unique on a station while live (0453, E15).
    uniqueIndex('uq_reservations_station_ocpp_live')
      .on(table.stationId, table.reservationId)
      .where(sql`${table.status} IN ('scheduled', 'active', 'in_use')`),
    index('idx_reservations_scheduled_starts_at')
      .on(table.startsAt)
      .where(sql`${table.status} = 'scheduled'`),
    index('idx_reservations_no_show_fee_due')
      .on(table.updatedAt)
      .where(sql`${table.noShowFeeState} = 'due'`),
    check(
      'reservations_no_show_fee_state_check',
      sql`${table.noShowFeeState} IN ('none', 'due', 'charged', 'failed', 'waived')`,
    ),
  ],
);

// reservationAuditLog moved to schema/audit.ts as part of the unified
// per-entity audit scheme (migration 0035). Re-exported here for backward
// compatibility with importers that still reach into schema/reservations.
export { reservationAuditLog, reservationAuditActionEnum } from './audit.js';
