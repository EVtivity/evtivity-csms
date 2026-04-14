// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { createId } from '../lib/id.js';
import { fleets } from './drivers.js';
import { users } from './identity.js';

export const fleetReservations = pgTable(
  'fleet_reservations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('fleetReservation')),
    fleetId: text('fleet_id')
      .notNull()
      .references(() => fleets.id),
    name: text('name'),
    status: text('status').notNull().default('active'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    chargingProfileData: jsonb('charging_profile_data'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_fleet_reservations_fleet_id').on(table.fleetId),
    index('idx_fleet_reservations_status').on(table.status),
  ],
);
