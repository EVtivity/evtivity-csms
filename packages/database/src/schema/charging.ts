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
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createId } from '../lib/id.js';
import { tariffs } from './pricing.js';
import { chargingStations, evses, connectors } from './assets.js';
import { drivers, driverTokens, vehicles } from './drivers.js';
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
    tokenId: text('token_id').references(() => driverTokens.id, { onDelete: 'set null' }),
    vehicleId: text('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }),
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
    index('idx_sessions_token_id').on(table.tokenId),
    index('idx_sessions_vehicle_id').on(table.vehicleId),
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
    // Station-scoped reads always filter by measurand and a time window
    // (load management power, sites totalDrawKw, station live data); the
    // composite serves station-only lookups via its leading column, so a
    // plain station_id index would be pure insert overhead. Same reasoning
    // dropped the session_id-only index: the (session_id, measurand,
    // timestamp) composite below covers session-only filters. Migration 0076
    // creates this index with INCLUDE ("value") so site-wide power
    // aggregations run as index-only scans; drizzle's index builder cannot
    // express INCLUDE in this version, so the declaration here carries only
    // the key columns.
    index('idx_meter_values_station_measurand_ts_cov').on(
      table.stationId,
      table.measurand,
      table.timestamp,
    ),
    index('idx_meter_values_timestamp').on(table.timestamp),
    // Latest-reading-per-session lookups (e.g. station-message power refresh)
    // run `WHERE session_id = ? AND measurand = ? ORDER BY timestamp DESC
    // LIMIT 1`. Without this composite, the planner walks
    // idx_meter_values_timestamp backwards filtering row-by-row, which scans
    // the entire index when a session has no matching measurand and starves
    // the connection pool under concurrent refreshes.
    index('idx_meter_values_session_measurand_ts').on(
      table.sessionId,
      table.measurand,
      table.timestamp,
    ),
    // Standalone (non-session) meter values per station, newest first. The
    // station Meter Values tab runs `WHERE station_id = ? AND session_id IS
    // NULL ORDER BY timestamp DESC LIMIT n`; without this partial index the
    // planner walks idx_meter_values_timestamp backwards across the whole
    // table (measured 42s on 22M rows for a station with no standalone rows).
    index('idx_meter_values_station_standalone_ts')
      .on(table.stationId, table.timestamp)
      .where(sql`session_id IS NULL`),
    // Dedup retransmits: OCPP allows the station to resend a MeterValues batch
    // if the CALLRESULT is lost. Without this, duplicate rows inflate energy
    // sums in dashboards, cost calculations, and OCPI CDRs. The backing
    // migration 0044_meter_values_dedup_unique.sql creates this index with
    // NULLS NOT DISTINCT (PG 15+) so null phase/location compare equal; the
    // drizzle schema can't express NULLS NOT DISTINCT in this version, so the
    // schema declaration is for drift detection only and the migration is the
    // source of truth.
    uniqueIndex('meter_values_dedup_idx').on(
      table.sessionId,
      table.evseId,
      table.timestamp,
      table.measurand,
      table.phase,
      table.location,
    ),
  ],
);
