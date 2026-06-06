// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  text,
  integer,
  serial,
  varchar,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { createId } from '../lib/id.js';
import { sites, chargingStations } from './assets.js';

export const maintenanceEventTypeEnum = pgEnum('maintenance_event_type', ['immediate', 'one_off']);

export const maintenanceEventStatusEnum = pgEnum('maintenance_event_status', [
  'scheduled',
  'active',
  'completed',
  'cancelled',
]);

export const maintenanceSessionPolicyEnum = pgEnum('maintenance_session_policy', [
  'ignore',
  'stop_graceful',
]);

export const maintenanceEvents = pgTable(
  'maintenance_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('maintenanceEvent')),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    eventType: maintenanceEventTypeEnum('event_type').notNull(),
    status: maintenanceEventStatusEnum('status').notNull().default('scheduled'),
    plannedStartAt: timestamp('planned_start_at', { withTimezone: true }).notNull(),
    plannedEndAt: timestamp('planned_end_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    // null/empty array = all stations under the site at activation time.
    affectedStationIds: text('affected_station_ids').array(),
    activeSessionPolicy: maintenanceSessionPolicyEnum('active_session_policy')
      .notNull()
      .default('ignore'),
    customMessage: text('custom_message'),
    reason: text('reason'),
    reservationsCancelledCount: integer('reservations_cancelled_count').notNull().default(0),
    sessionsStoppedCount: integer('sessions_stopped_count').notNull().default(0),
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_maintenance_events_site_status').on(table.siteId, table.status),
    index('idx_maintenance_events_planned_start_at').on(table.plannedStartAt),
    index('idx_maintenance_events_planned_end_at').on(table.plannedEndAt),
  ],
);

// One row per station per fan-out phase, written by the maintenance fan-out
// runners after each phase completes. Gives operators a per-station drill-down
// (which OCPP command, what the station answered, status before/after) so a
// partially-commanded fleet is visible in the UI instead of requiring DB log
// archaeology. Varchar columns instead of enums so new phases or command
// outcomes do not need a migration.
export const maintenanceEventStations = pgTable(
  'maintenance_event_stations',
  {
    id: serial('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => maintenanceEvents.id, { onDelete: 'cascade' }),
    // Nulled when the station row is hard-deleted; the snapshot keeps identity.
    stationId: text('station_id').references(() => chargingStations.id, { onDelete: 'set null' }),
    stationIdSnapshot: text('station_id_snapshot').notNull(),
    stationOcppId: varchar('station_ocpp_id', { length: 255 }).notNull(),
    phase: varchar('phase', { length: 20 }).notNull(),
    command: varchar('command', { length: 80 }).notNull(),
    commandStatus: varchar('command_status', { length: 20 }).notNull(),
    error: text('error'),
    statusBefore: varchar('status_before', { length: 50 }),
    statusAfter: varchar('status_after', { length: 50 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_maintenance_event_stations_event_id').on(table.eventId),
    index('idx_maintenance_event_stations_created_at').on(table.createdAt),
  ],
);

// Re-export the audit log artefacts from the unified audit schema for callers
// that import them from this module.
export { maintenanceEventAuditLog, maintenanceEventAuditActionEnum } from './audit.js';
