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
  boolean,
  timestamp,
  jsonb,
  index,
  unique,
  customType,
} from 'drizzle-orm/pg-core';
import { createId } from '../lib/id.js';
import { chargingStations } from './assets.js';
import { users } from './identity.js';

const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const reportStatusEnum = pgEnum('report_status', [
  'pending',
  'generating',
  'completed',
  'failed',
]);

export const reportFrequencyEnum = pgEnum('report_frequency', ['daily', 'weekly', 'monthly']);

export const excludedDowntimeReasonEnum = pgEnum('excluded_downtime_reason', [
  'utility_outage',
  'vandalism',
  'natural_disaster',
  'scheduled_maintenance',
  'vehicle_caused',
]);

export const reports = pgTable(
  'reports',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('report')),
    name: varchar('name', { length: 255 }).notNull(),
    reportType: varchar('report_type', { length: 50 }).notNull(),
    status: reportStatusEnum('status').notNull().default('pending'),
    format: varchar('format', { length: 10 }).notNull(),
    filters: jsonb('filters'),
    fileData: bytea('file_data'),
    fileName: varchar('file_name', { length: 255 }),
    fileSize: integer('file_size'),
    generatedById: text('generated_by_id').references(() => users.id),
    error: varchar('error', { length: 1000 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_reports_generated_by_id').on(table.generatedById),
    index('idx_reports_report_type').on(table.reportType),
    index('idx_reports_created_at').on(table.createdAt),
    index('idx_reports_status').on(table.status),
  ],
);

export const reportSchedules = pgTable(
  'report_schedules',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    reportType: varchar('report_type', { length: 50 }).notNull(),
    format: varchar('format', { length: 10 }).notNull(),
    frequency: reportFrequencyEnum('frequency').notNull(),
    dayOfWeek: integer('day_of_week'),
    dayOfMonth: integer('day_of_month'),
    filters: jsonb('filters'),
    recipientEmails: jsonb('recipient_emails'),
    isEnabled: boolean('is_enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    createdById: text('created_by_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_report_schedules_next_run').on(table.nextRunAt, table.isEnabled),
    index('idx_report_schedules_created_by').on(table.createdById),
  ],
);

export const neviExcludedDowntime = pgTable(
  'nevi_excluded_downtime',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    evseId: integer('evse_id').notNull(),
    reason: excludedDowntimeReasonEnum('reason').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    notes: varchar('notes', { length: 1000 }),
    createdById: text('created_by_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_nevi_excluded_downtime_station').on(table.stationId),
    index('idx_nevi_excluded_downtime_started_at').on(table.startedAt),
  ],
);

export const neviStationData = pgTable(
  'nevi_station_data',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    operatorName: varchar('operator_name', { length: 255 }),
    operatorAddress: varchar('operator_address', { length: 500 }),
    operatorPhone: varchar('operator_phone', { length: 50 }),
    operatorEmail: varchar('operator_email', { length: 255 }),
    installationCost: numeric('installation_cost'),
    gridConnectionCost: numeric('grid_connection_cost'),
    maintenanceCostAnnual: numeric('maintenance_cost_annual'),
    maintenanceCostYear: integer('maintenance_cost_year'),
    derCapacityKw: numeric('der_capacity_kw'),
    derCapacityKwh: numeric('der_capacity_kwh'),
    derType: varchar('der_type', { length: 100 }),
    programParticipation: jsonb('program_participation'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('uq_nevi_station_data_station').on(table.stationId)],
);
