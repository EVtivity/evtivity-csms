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
  check,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createId } from '../lib/id.js';
import { tariffs } from './pricing.js';
import { chargingStations, evses, connectors } from './assets.js';
import { drivers, driverTokens, vehicles, fleets } from './drivers.js';
import { reservations } from './reservations.js';
import { invoices } from './invoices.js';

export const sessionStatusEnum = pgEnum('session_status', [
  'active',
  'completed',
  'invalid',
  'faulted',
  'failed',
]);

/** charging_sessions.rebill_status: the state of an operator re-bill. */
export const SESSION_REBILL_STATUSES = ['in_progress', 'billed', 'manual'] as const;
export type SessionRebillStatus = (typeof SESSION_REBILL_STATUSES)[number];

/** charging_sessions.billing_mode: how a driver session is paid (fleet account billing). */
export const SESSION_BILLING_MODES = ['card', 'account'] as const;
export type SessionBillingMode = (typeof SESSION_BILLING_MODES)[number];

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
    // Unique per station only (OCPP 2.1 E01.FR.08): uq_charging_sessions_station_transaction.
    transactionId: varchar('transaction_id', { length: 36 }).notNull(),
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
    currency: varchar('currency', { length: 3 }).notNull(),
    tariffId: text('tariff_id').references(() => tariffs.id),
    tariffPricePerKwh: numeric('tariff_price_per_kwh'),
    tariffPricePerMinute: numeric('tariff_price_per_minute'),
    tariffPricePerSession: numeric('tariff_price_per_session'),
    tariffIdleFeePricePerMinute: numeric('tariff_idle_fee_price_per_minute'),
    tariffTaxRate: numeric('tariff_tax_rate'),
    // Reservation holding fee per minute of the tariff snapshot (issue #33).
    tariffReservationFeePerMinute: numeric('tariff_reservation_fee_per_minute'),
    // Tax basis ('net' or 'gross') the snapshot prices were entered in,
    // written with the tariff snapshot. Null when the session has no tariff.
    taxBasis: varchar('tax_basis', { length: 5 }),
    // The cost split: net_cents + tax_cents = coalesce(final_cost_cents,
    // current_cost_cents), written in the same statement as the cost by
    // @evtivity/database session-pricing. cost_breakdown holds the
    // SessionCostBreakdown (tax lines per rate and billed components).
    netCents: integer('net_cents'),
    taxCents: integer('tax_cents'),
    costBreakdown: jsonb('cost_breakdown'),
    // The most the session can be billed, tax included, stamped when the
    // session starts: the authorized amount of a guest's card hold (OCPP 2.1
    // C25: the authorization is the ceiling for the cost) or a prepaid
    // token's credit (C17.FR.03). The cost assembly bills at most this
    // amount. Null: no ceiling.
    costCeilingCents: integer('cost_ceiling_cents'),
    // The ceiling last sent to an OCPP 2.1 station as transactionLimit.maxCost.
    costCeilingSentCents: integer('cost_ceiling_sent_cents'),
    idleStartedAt: timestamp('idle_started_at', { withTimezone: true }),
    idleMinutes: numeric('idle_minutes').notNull().default('0'),
    // The idle_started_at the idle notification was sent for (one per idle period).
    idleNotifiedAt: timestamp('idle_notified_at', { withTimezone: true }),
    lastUpdateNotifiedAt: timestamp('last_update_notified_at', { withTimezone: true }),
    // A durable request to end the session the normal way (completed and
    // billed) because the station will not: 'GhostRecovered' or 'Superseded'.
    // end_claimed_at is the lease of the OCPP pod processing it (retried by the
    // OCPP sweep). See packages/ocpp/src/server/csms-session-end.ts.
    endRequestReason: varchar('end_request_reason', { length: 32 }),
    endClaimedAt: timestamp('end_claimed_at', { withTimezone: true }),
    // Claims taken for the end request; the sweep gives up after a cap.
    endAttempts: integer('end_attempts').notNull().default(0),
    // Operator re-bill of a session the CSMS gave up ending (stopped reason
    // EndRequestFailed): 'in_progress' while a request holds the claim
    // (rebill_claimed_at is its lease), then 'billed' (charged, debited or
    // nothing to charge) or 'manual' (collected outside the platform). Null:
    // never re-billed. See packages/api/src/services/session-rebill.service.ts.
    rebillStatus: varchar('rebill_status', { length: 16 }).$type<SessionRebillStatus>(),
    rebillClaimedAt: timestamp('rebill_claimed_at', { withTimezone: true }),
    // The invoice that bills this session, set in the invoice transaction only
    // while null, so a session is never on two invoices. A voided invoice
    // releases it.
    invoiceId: text('invoice_id').references((): AnyPgColumn => invoices.id, {
      onDelete: 'set null',
    }),
    // How the driver session is paid, decided once at its start and never
    // rewritten (write-once stamp, P5): 'card' (the driver's card) or
    // 'account' (billed to billing_fleet_id on the fleet invoice). Stamped by
    // the portal start or the payment gate on TransactionEvent Started after
    // roaming, free vend and prepaid are ruled out. Null: older sessions and
    // sessions without a driver, roaming, free vend or prepaid.
    billingMode: varchar('billing_mode', { length: 8 }).$type<SessionBillingMode>(),
    billingFleetId: text('billing_fleet_id').references((): AnyPgColumn => fleets.id, {
      onDelete: 'restrict',
    }),
    metadata: jsonb('metadata'),
    freeVend: boolean('free_vend').notNull().default(false),
    co2AvoidedKg: numeric('co2_avoided_kg'),
    electricityCostCents: integer('electricity_cost_cents'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_sessions_station_id').on(table.stationId),
    index('idx_sessions_status').on(table.status),
    uniqueIndex('uq_charging_sessions_station_transaction').on(
      table.stationId,
      table.transactionId,
    ),
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
    index('idx_charging_sessions_end_request')
      .on(table.endRequestReason)
      .where(sql`status = 'active' AND end_request_reason IS NOT NULL`),
    index('idx_charging_sessions_rebill_manual')
      .on(table.createdAt)
      .where(sql`rebill_status = 'manual'`),
    index('idx_sessions_invoice_id')
      .on(table.invoiceId)
      .where(sql`invoice_id IS NOT NULL`),
    index('idx_sessions_billing_fleet_id')
      .on(table.billingFleetId)
      .where(sql`billing_fleet_id IS NOT NULL`),
    index('idx_sessions_account_unbilled')
      .on(table.billingFleetId)
      .where(sql`billing_mode = 'account' AND invoice_id IS NULL`),
    check(
      'charging_sessions_billing_mode_check',
      sql`billing_mode IS NULL OR billing_mode IN ('card', 'account')`,
    ),
    check(
      'charging_sessions_billing_fleet_check',
      sql`coalesce(billing_mode = 'account', false) = (billing_fleet_id IS NOT NULL)`,
    ),
    check(
      'charging_sessions_rebill_status_check',
      sql`rebill_status IS NULL OR rebill_status IN ('in_progress', 'billed', 'manual')`,
    ),
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
