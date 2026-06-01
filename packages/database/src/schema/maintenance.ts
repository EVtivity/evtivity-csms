// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { pgTable, pgEnum, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { createId } from '../lib/id.js';
import { sites } from './assets.js';

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

// Re-export the audit log artefacts from the unified audit schema for callers
// that import them from this module.
export { maintenanceEventAuditLog, maintenanceEventAuditActionEnum } from './audit.js';
