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
} from 'drizzle-orm/pg-core';
import { createId } from '../lib/id.js';
import { tariffs } from './pricing.js';
import { chargingStations, evses, connectors } from './assets.js';
import { drivers } from './drivers.js';
import { reservations } from './reservations.js';

export const sessionStatusEnum = pgEnum('session_status', [
  'active',
  'completed',
  'invalid',
  'faulted',
  'failed',
]);

export const transactionEventTypeEnum = pgEnum('transaction_event_type', [
  'started',
  'updated',
  'ended',
]);

export const chargingSessions = pgTable(
  'charging_sessions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('session')),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    evseId: text('evse_id').references(() => evses.id),
    connectorId: text('connector_id').references(() => connectors.id),
    driverId: text('driver_id').references(() => drivers.id),
    transactionId: varchar('transaction_id', { length: 36 }).notNull().unique(),
    status: sessionStatusEnum('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    meterStart: integer('meter_start'),
    meterStop: integer('meter_stop'),
    energyDeliveredWh: numeric('energy_delivered_wh'),
    stoppedReason: varchar('stopped_reason', { length: 50 }),
    isRoaming: boolean('is_roaming').notNull().default(false),
    remoteStartId: integer('remote_start_id'),
    reservationId: text('reservation_id').references(() => reservations.id),
    currentCostCents: integer('current_cost_cents'),
    finalCostCents: integer('final_cost_cents'),
    currency: varchar('currency', { length: 3 }),
    tariffId: text('tariff_id').references(() => tariffs.id),
    tariffPricePerKwh: numeric('tariff_price_per_kwh'),
    tariffPricePerMinute: numeric('tariff_price_per_minute'),
    tariffPricePerSession: numeric('tariff_price_per_session'),
    tariffIdleFeePricePerMinute: numeric('tariff_idle_fee_price_per_minute'),
    tariffTaxRate: numeric('tariff_tax_rate'),
    idleStartedAt: timestamp('idle_started_at', { withTimezone: true }),
    idleMinutes: numeric('idle_minutes').notNull().default('0'),
    lastUpdateNotifiedAt: timestamp('last_update_notified_at', { withTimezone: true }),
    metadata: jsonb('metadata'),
    freeVend: boolean('free_vend').notNull().default(false),
    co2AvoidedKg: numeric('co2_avoided_kg'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_sessions_station_id').on(table.stationId),
    index('idx_sessions_status').on(table.status),
    index('idx_sessions_transaction_id').on(table.transactionId),
    index('idx_sessions_started_at').on(table.startedAt),
    index('idx_sessions_driver_id').on(table.driverId),
    index('idx_sessions_reservation_id').on(table.reservationId),
    index('idx_sessions_status_idle').on(table.status, table.idleStartedAt),
    index('idx_sessions_created_at').on(table.createdAt),
    index('idx_sessions_station_status').on(table.stationId, table.status),
    index('idx_sessions_evse_id').on(table.evseId),
    index('idx_sessions_connector_id').on(table.connectorId),
    index('idx_sessions_tariff_id').on(table.tariffId),
    index('idx_sessions_driver_status').on(table.driverId, table.status),
  ],
);

export const transactionEvents = pgTable(
  'transaction_events',
  {
    id: serial('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => chargingSessions.id, { onDelete: 'cascade' }),
    eventType: transactionEventTypeEnum('event_type').notNull(),
    seqNo: integer('seq_no').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    triggerReason: varchar('trigger_reason', { length: 50 }).notNull(),
    offline: boolean('offline').notNull().default(false),
    numberOfPhasesUsed: integer('number_of_phases_used'),
    cableMaxCurrent: integer('cable_max_current'),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_transaction_events_session_id').on(table.sessionId),
    index('idx_transaction_events_timestamp').on(table.timestamp),
  ],
);

export const meterValues = pgTable(
  'meter_values',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    evseId: text('evse_id').references(() => evses.id),
    sessionId: text('session_id').references(() => chargingSessions.id, { onDelete: 'cascade' }),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    measurand: varchar('measurand', { length: 100 }),
    phase: varchar('phase', { length: 10 }),
    location: varchar('location', { length: 20 }),
    unit: varchar('unit', { length: 20 }),
    value: numeric('value').notNull(),
    context: varchar('context', { length: 50 }),
    signedData: jsonb('signed_data'),
    source: varchar('source', { length: 30 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_meter_values_station_id').on(table.stationId),
    index('idx_meter_values_session_id').on(table.sessionId),
    index('idx_meter_values_timestamp').on(table.timestamp),
  ],
);
