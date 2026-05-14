// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { pgTable, pgEnum, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
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
  'system_cleanup',
]);

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
  },
  (table) => [
    index('idx_reservations_station_id').on(table.stationId),
    index('idx_reservations_status').on(table.status),
    index('idx_reservations_driver_id').on(table.driverId),
    index('idx_reservations_token_id').on(table.tokenId),
  ],
);

// reservationAuditLog moved to schema/audit.ts as part of the unified
// per-entity audit scheme (migration 0035). Re-exported here for backward
// compatibility with importers that still reach into schema/reservations.
export { reservationAuditLog, reservationAuditActionEnum } from './audit.js';
