// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { pgTable, pgEnum, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { createId } from '../lib/id.js';
import { chargingStations, evses, connectors } from './assets.js';
import { drivers } from './drivers.js';
import { fleetReservations } from './fleet-reservations.js';

export const reservationStatusEnum = pgEnum('reservation_status', [
  'scheduled',
  'active',
  'in_use',
  'used',
  'cancelled',
  'expired',
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
    status: reservationStatusEnum('status').notNull().default('active'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    fleetReservationId: text('fleet_reservation_id').references(() => fleetReservations.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_reservations_station_id').on(table.stationId),
    index('idx_reservations_status').on(table.status),
  ],
);
