// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  serial,
  varchar,
  text,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { chargingStations } from './assets.js';
import { drivers } from './drivers.js';
import { users } from './identity.js';

export const messageDirectionEnum = pgEnum('message_direction', ['inbound', 'outbound']);

export const ocppMessageLogs = pgTable(
  'ocpp_message_logs',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    direction: messageDirectionEnum('direction').notNull(),
    messageType: integer('message_type').notNull(),
    messageId: varchar('message_id', { length: 36 }).notNull(),
    action: varchar('action', { length: 100 }),
    payload: jsonb('payload'),
    errorCode: varchar('error_code', { length: 50 }),
    errorDescription: text('error_description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ocpp_message_logs_station_id').on(table.stationId),
    index('idx_ocpp_message_logs_action').on(table.action),
    index('idx_ocpp_message_logs_created_at').on(table.createdAt),
    index('idx_ocpp_message_logs_message_id').on(table.messageId),
  ],
);

export const connectionLogs = pgTable(
  'connection_logs',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    event: varchar('event', { length: 50 }).notNull(),
    remoteAddress: varchar('remote_address', { length: 45 }),
    protocol: varchar('protocol', { length: 50 }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_connection_logs_station_id').on(table.stationId),
    index('idx_connection_logs_created_at').on(table.createdAt),
  ],
);

export const ocppServerHealth = pgTable('ocpp_server_health', {
  id: text('id').primaryKey().default('singleton'),
  connectedStations: integer('connected_stations').notNull().default(0),
  avgPingLatencyMs: doublePrecision('avg_ping_latency_ms').notNull().default(0),
  maxPingLatencyMs: doublePrecision('max_ping_latency_ms').notNull().default(0),
  pingSuccessRate: doublePrecision('ping_success_rate').notNull().default(100),
  totalPingsSent: integer('total_pings_sent').notNull().default(0),
  totalPongsReceived: integer('total_pongs_received').notNull().default(0),
  serverStartedAt: timestamp('server_started_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accessLogs = pgTable(
  'access_logs',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').references(() => users.id),
    driverId: text('driver_id').references(() => drivers.id),
    action: varchar('action', { length: 100 }).notNull(),
    category: varchar('category', { length: 20 }).notNull(),
    authType: varchar('auth_type', { length: 20 }).default('anonymous'),
    apiKeyName: varchar('api_key_name', { length: 255 }),
    method: varchar('method', { length: 10 }),
    path: varchar('path', { length: 500 }),
    statusCode: integer('status_code'),
    durationMs: integer('duration_ms'),
    remoteAddress: varchar('remote_address', { length: 45 }),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_access_logs_user_id').on(table.userId),
    index('idx_access_logs_driver_id').on(table.driverId),
    index('idx_access_logs_category').on(table.category),
    index('idx_access_logs_created_at').on(table.createdAt),
    index('idx_access_logs_action').on(table.action),
  ],
);

export const workerJobStatusEnum = pgEnum('worker_job_status', ['started', 'completed', 'failed']);

export const workerJobLogs = pgTable(
  'worker_job_logs',
  {
    id: serial('id').primaryKey(),
    jobName: varchar('job_name', { length: 255 }).notNull(),
    queue: varchar('queue', { length: 100 }).notNull(),
    status: workerJobStatusEnum('status').notNull(),
    durationMs: integer('duration_ms'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_worker_job_logs_job_name').on(table.jobName),
    index('idx_worker_job_logs_queue').on(table.queue),
    index('idx_worker_job_logs_started_at').on(table.startedAt),
  ],
);

export const portStatusLog = pgTable(
  'port_status_log',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    evseId: integer('evse_id').notNull(),
    connectorId: integer('connector_id'),
    previousStatus: varchar('previous_status', { length: 20 }),
    newStatus: varchar('new_status', { length: 20 }).notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_port_status_log_station_id').on(table.stationId),
    index('idx_port_status_log_timestamp').on(table.timestamp),
    index('idx_port_status_log_station_evse').on(table.stationId, table.evseId),
  ],
);
