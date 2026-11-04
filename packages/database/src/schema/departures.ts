// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import type { DepartureReadiness, DepartureReadinessReason } from '@evtivity/lib/charging-plan';
import { createId } from '../lib/id.js';
import { evses, sites } from './assets.js';
import { chargingSessions } from './charging.js';
import { depotSystems } from './depot-systems.js';
import { vehicles } from './drivers.js';

/** What a departure asks for: an amount of energy or a state of charge. */
export const DEPARTURE_TARGET_KINDS = ['energy', 'soc'] as const;
export type DepartureTargetKind = (typeof DEPARTURE_TARGET_KINDS)[number];

/**
 * Where a departure came from. `vehicle` comes with a later phase;
 * `depot_system` is a charging request of a bus depot system (VDV 463).
 */
export const DEPARTURE_SOURCES = [
  'manual',
  'schedule',
  'import',
  'vehicle',
  'depot_system',
] as const;
export type DepartureSource = (typeof DEPARTURE_SOURCES)[number];

/** Why a departure was cancelled without a person (null: a person cancelled it). */
export const DEPARTURE_CANCEL_REASONS = [
  'removed_by_depot_system',
  'terminated_by_depot_system',
  'superseded_by_depot_system',
] as const;
export type DepartureCancelReason = (typeof DEPARTURE_CANCEL_REASONS)[number];

/** Preconditioning climate types (VDV 463 automatic preconditioning, our names). */
export const DEPARTURE_PRECONDITIONING_CLIMATES = [
  'warm_water_ventilation',
  'hot_water_heating',
  'no_heating_cooling_ventilation',
  'none',
] as const;
export type DeparturePreconditioningClimate = (typeof DEPARTURE_PRECONDITIONING_CLIMATES)[number];

/** Departure status. `cancelled` and `completed` are terminal (P5). */
export const DEPARTURE_STATUSES = ['scheduled', 'cancelled', 'completed'] as const;
export type DepartureStatus = (typeof DEPARTURE_STATUSES)[number];

/** Set when a departure completes. */
export const DEPARTURE_OUTCOMES = ['met', 'short', 'no_vehicle'] as const;
export type DepartureOutcome = (typeof DEPARTURE_OUTCOMES)[number];

/** What the planner predicts for a departure: `DepartureReadiness` of `@evtivity/lib/charging-plan`. */
export const DEPARTURE_READINESS_STATES = [
  'ready',
  'on_track',
  'at_risk',
  'cannot_meet',
  'waiting_for_vehicle',
] as const satisfies readonly DepartureReadiness[];

/** Why the planner expects a departure to be short or late: `DepartureReadinessReason` of the planner. */
export const DEPARTURE_READINESS_REASONS = [
  'site_capacity',
  'not_plugged_in',
  'late_arrival',
  'charger_not_following',
  'profile_rejected',
  'station_offline',
  'vehicle_power',
  'unknown_soc',
] as const satisfies readonly DepartureReadinessReason[];

/** Operator notices sent once per departure and kind. */
export const DEPARTURE_NOTICE_KINDS = ['at_risk', 'missed'] as const;
export type DepartureNoticeKind = (typeof DEPARTURE_NOTICE_KINDS)[number];

// Weekly repeating departures of one vehicle from one site. The expand cron
// turns each occurrence into a vehicle_departures row.
export const vehicleDepartureSchedules = pgTable(
  'vehicle_departure_schedules',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('departureSchedule')),
    vehicleId: text('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'cascade' }),
    // The site the vehicle leaves from.
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    // ISO days of the week, 1 (Monday) to 7 (Sunday).
    daysOfWeek: smallint('days_of_week').array().notNull(),
    // HH:MM, local time of the site (sites.timezone).
    departureTime: varchar('departure_time', { length: 5 }).notNull(),
    targetKind: varchar('target_kind', { length: 10 }).$type<DepartureTargetKind>().notNull(),
    targetEnergyKwh: numeric('target_energy_kwh', { precision: 7, scale: 2 }),
    // The minimum target SoC; readiness and the outcome measure it.
    targetSocPercent: smallint('target_soc_percent'),
    // Charge further up to this SoC from capacity no departure needs.
    targetSocMaxPercent: smallint('target_soc_max_percent'),
    // 1 lowest to 10 highest, the scale of the station load priority.
    priority: smallint('priority').notNull().default(5),
    validFrom: date('valid_from'),
    validTo: date('valid_to'),
    isActive: boolean('is_active').notNull().default(true),
    notes: varchar('notes', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_vehicle_departure_schedules_vehicle').on(table.vehicleId),
    index('idx_vehicle_departure_schedules_site').on(table.siteId),
    check(
      'vds_target_check',
      sql`(${table.targetKind} = 'energy' AND ${table.targetEnergyKwh} IS NOT NULL AND ${table.targetSocPercent} IS NULL) OR (${table.targetKind} = 'soc' AND ${table.targetSocPercent} IS NOT NULL AND ${table.targetEnergyKwh} IS NULL)`,
    ),
    check(
      'vds_target_range_check',
      sql`(${table.targetEnergyKwh} IS NULL OR ${table.targetEnergyKwh} BETWEEN 0.1 AND 2000) AND (${table.targetSocPercent} IS NULL OR ${table.targetSocPercent} BETWEEN 1 AND 100)`,
    ),
    check(
      'vds_days_check',
      sql`cardinality(${table.daysOfWeek}) > 0 AND ${table.daysOfWeek} <@ ARRAY[1,2,3,4,5,6,7]::smallint[]`,
    ),
    check('vds_time_check', sql`${table.departureTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
    check('vds_priority_check', sql`${table.priority} BETWEEN 1 AND 10`),
    check(
      'vds_soc_max_check',
      sql`${table.targetSocMaxPercent} IS NULL OR (${table.targetKind} = 'soc' AND ${table.targetSocMaxPercent} BETWEEN ${table.targetSocPercent} AND 100)`,
    ),
    check(
      'vds_valid_range_check',
      sql`${table.validFrom} IS NULL OR ${table.validTo} IS NULL OR ${table.validFrom} <= ${table.validTo}`,
    ),
  ],
);

// Every departure, one-off or an occurrence of a schedule. The planner writes
// the readiness columns; cancelled and completed are terminal.
export const vehicleDepartures = pgTable(
  'vehicle_departures',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('departure')),
    vehicleId: text('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    // Set for rows a schedule created.
    scheduleId: text('schedule_id').references(() => vehicleDepartureSchedules.id, {
      onDelete: 'set null',
    }),
    // The local date of a schedule occurrence.
    occurrenceDate: date('occurrence_date'),
    // Null only for an ad hoc departure (charge from arrival, no departure time).
    departureAt: timestamp('departure_at', { withTimezone: true }),
    adHoc: boolean('ad_hoc').notNull().default(false),
    targetKind: varchar('target_kind', { length: 10 }).$type<DepartureTargetKind>().notNull(),
    targetEnergyKwh: numeric('target_energy_kwh', { precision: 7, scale: 2 }),
    // The minimum target SoC; readiness and the outcome measure it.
    targetSocPercent: smallint('target_soc_percent'),
    // Charge further up to this SoC from capacity no departure needs.
    targetSocMaxPercent: smallint('target_soc_max_percent'),
    // When the vehicle is expected to plug in, and with which SoC.
    expectedArrivalAt: timestamp('expected_arrival_at', { withTimezone: true }),
    expectedArrivalSocPercent: smallint('expected_arrival_soc_percent'),
    // The EVSE the depot system assigned; the vehicle may still plug in elsewhere.
    requestedEvseId: text('requested_evse_id').references(() => evses.id, { onDelete: 'set null' }),
    priority: smallint('priority').notNull().default(5),
    source: varchar('source', { length: 12 }).$type<DepartureSource>().notNull(),
    // The depot system and its charging request id (source depot_system).
    depotSystemId: text('depot_system_id').references(() => depotSystems.id, {
      onDelete: 'set null',
    }),
    externalRequestId: varchar('external_request_id', { length: 255 }),
    // The priority as the depot system sent it (smaller is more important).
    externalPriority: integer('external_priority'),
    cancelReason: varchar('cancel_reason', { length: 30 }).$type<DepartureCancelReason>(),
    // A person changed this occurrence, so a schedule edit leaves it alone.
    overridden: boolean('overridden').notNull().default(false),
    status: varchar('status', { length: 10 })
      .$type<DepartureStatus>()
      .notNull()
      .default('scheduled'),
    outcome: varchar('outcome', { length: 12 }).$type<DepartureOutcome>(),
    readiness: varchar('readiness', { length: 20 }).$type<DepartureReadiness>(),
    // The session charging for it.
    sessionId: text('session_id').references(() => chargingSessions.id, { onDelete: 'set null' }),
    plannedKwh: numeric('planned_kwh', { precision: 8, scale: 2 }),
    deliveredKwh: numeric('delivered_kwh', { precision: 8, scale: 2 }),
    shortfallKwh: numeric('shortfall_kwh', { precision: 8, scale: 2 }),
    predictedReadyAt: timestamp('predicted_ready_at', { withTimezone: true }),
    // When the plan reaches the maximum target SoC.
    predictedMaxReadyAt: timestamp('predicted_max_ready_at', { withTimezone: true }),
    readinessReason: varchar('readiness_reason', { length: 30 }).$type<DepartureReadinessReason>(),
    // When the planner last wrote it.
    plannedAt: timestamp('planned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per schedule occurrence, so the expand cron can run twice (P7).
    uniqueIndex('uq_vehicle_departures_occurrence')
      .on(table.scheduleId, table.occurrenceDate)
      .where(sql`${table.scheduleId} IS NOT NULL`),
    index('idx_vehicle_departures_site_scheduled')
      .on(table.siteId, table.departureAt)
      .where(sql`${table.status} = 'scheduled'`),
    // The departure-close cron reads scheduled departures across every site by time.
    index('idx_vehicle_departures_scheduled_due')
      .on(table.departureAt, table.id)
      .where(sql`${table.status} = 'scheduled'`),
    index('idx_vehicle_departures_vehicle').on(table.vehicleId, table.departureAt),
    index('idx_vehicle_departures_session').on(table.sessionId),
    // A depot system request id names one scheduled departure (P7).
    uniqueIndex('uq_vehicle_departures_external')
      .on(table.depotSystemId, table.externalRequestId)
      .where(sql`${table.status} = 'scheduled' AND ${table.depotSystemId} IS NOT NULL`),
    index('idx_vehicle_departures_ad_hoc')
      .on(table.siteId)
      .where(sql`${table.adHoc} AND ${table.status} = 'scheduled'`),
    check(
      'vdp_target_check',
      sql`(${table.targetKind} = 'energy' AND ${table.targetEnergyKwh} IS NOT NULL AND ${table.targetSocPercent} IS NULL) OR (${table.targetKind} = 'soc' AND ${table.targetSocPercent} IS NOT NULL AND ${table.targetEnergyKwh} IS NULL)`,
    ),
    check(
      'vdp_target_range_check',
      sql`(${table.targetEnergyKwh} IS NULL OR ${table.targetEnergyKwh} BETWEEN 0.1 AND 2000) AND (${table.targetSocPercent} IS NULL OR ${table.targetSocPercent} BETWEEN 0 AND 100)`,
    ),
    check(
      'vdp_soc_max_check',
      sql`${table.targetSocMaxPercent} IS NULL OR (${table.targetKind} = 'soc' AND ${table.targetSocMaxPercent} BETWEEN ${table.targetSocPercent} AND 100)`,
    ),
    check('vdp_ad_hoc_check', sql`${table.adHoc} = (${table.departureAt} IS NULL)`),
    check(
      'vdp_arrival_check',
      sql`(${table.expectedArrivalSocPercent} IS NULL OR ${table.expectedArrivalSocPercent} BETWEEN 0 AND 100) AND (${table.expectedArrivalAt} IS NULL OR ${table.departureAt} IS NULL OR ${table.expectedArrivalAt} < ${table.departureAt})`,
    ),
    check(
      'vdp_external_check',
      sql`(${table.source} = 'depot_system') = (${table.externalRequestId} IS NOT NULL) AND (${table.source} = 'depot_system' OR ${table.depotSystemId} IS NULL)`,
    ),
    check(
      'vdp_cancel_reason_check',
      sql`${table.cancelReason} IS NULL OR (${table.status} = 'cancelled' AND ${table.cancelReason} IN ('removed_by_depot_system', 'terminated_by_depot_system', 'superseded_by_depot_system'))`,
    ),
    check('vdp_priority_check', sql`${table.priority} BETWEEN 1 AND 10`),
    check(
      'vdp_source_check',
      sql`${table.source} IN ('manual', 'schedule', 'import', 'vehicle', 'depot_system')`,
    ),
    check('vdp_status_check', sql`${table.status} IN ('scheduled', 'cancelled', 'completed')`),
    check(
      'vdp_outcome_check',
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('met', 'short', 'no_vehicle')`,
    ),
    check(
      'vdp_readiness_check',
      sql`${table.readiness} IS NULL OR ${table.readiness} IN ('ready', 'on_track', 'at_risk', 'cannot_meet', 'waiting_for_vehicle')`,
    ),
    check(
      'vdp_readiness_reason_check',
      sql`${table.readinessReason} IS NULL OR ${table.readinessReason} IN ('site_capacity', 'not_plugged_in', 'late_arrival', 'charger_not_following', 'profile_rejected', 'station_offline', 'vehicle_power', 'unknown_soc')`,
    ),
    check(
      'vdp_completed_outcome_check',
      sql`(${table.status} = 'completed') = (${table.outcome} IS NOT NULL)`,
    ),
  ],
);

// The at-risk and missed notices already sent for a departure: one per kind,
// so a re-plan never notifies twice.
export const vehicleDepartureNotices = pgTable(
  'vehicle_departure_notices',
  {
    departureId: text('departure_id')
      .notNull()
      .references(() => vehicleDepartures.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 12 }).$type<DepartureNoticeKind>().notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.departureId, table.kind] }),
    check('vehicle_departure_notices_kind_check', sql`${table.kind} IN ('at_risk', 'missed')`),
  ],
);

// The current charging plan of a site: one row per site, overwritten by each
// plan. stale_at, set by the re-plan triggers, makes the next cycle plan again.
export const siteChargingPlans = pgTable('site_charging_plans', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  staleAt: timestamp('stale_at', { withTimezone: true }),
  // Why the last plan ran.
  trigger: varchar('trigger', { length: 30 }),
  // Slot start times (ISO).
  slotStarts: jsonb('slot_starts'),
  // Per departure: slot kW, station, EVSE, profile hash and reply state.
  plan: jsonb('plan'),
  // Planned site load per slot.
  siteLoadKw: jsonb('site_load_kw'),
  // Root headroom per slot.
  capacityKw: jsonb('capacity_kw'),
  // Electricity rate per slot.
  pricePerKwh: jsonb('price_per_kwh'),
  runtimeMs: integer('runtime_ms'),
});

// Preconditioning of a departure, from a bus depot system request (VDV 463):
// the automatic group (climate type, temperature, window) and the manual group
// (HVAC and system start times and power) are both optional. One row per
// departure; one writer, lib/vehicle-departures.ts.
export const vehicleDeparturePreconditioning = pgTable(
  'vehicle_departure_preconditioning',
  {
    departureId: text('departure_id')
      .primaryKey()
      .references(() => vehicleDepartures.id, { onDelete: 'cascade' }),
    climate: varchar('climate', { length: 30 }).$type<DeparturePreconditioningClimate>(),
    ambientTemperatureC: smallint('ambient_temperature_c'),
    startAt: timestamp('start_at', { withTimezone: true }),
    finishAt: timestamp('finish_at', { withTimezone: true }),
    hvacStartAt: timestamp('hvac_start_at', { withTimezone: true }),
    hvacKw: numeric('hvac_kw', { precision: 6, scale: 2 }),
    systemStartAt: timestamp('system_start_at', { withTimezone: true }),
    systemKw: numeric('system_kw', { precision: 6, scale: 2 }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'vdpc_climate_check',
      sql`${table.climate} IS NULL OR ${table.climate} IN ('warm_water_ventilation', 'hot_water_heating', 'no_heating_cooling_ventilation', 'none')`,
    ),
    check(
      'vdpc_temperature_check',
      sql`${table.ambientTemperatureC} IS NULL OR ${table.ambientTemperatureC} BETWEEN -50 AND 70`,
    ),
    check(
      'vdpc_window_check',
      sql`${table.startAt} IS NULL OR ${table.finishAt} IS NULL OR ${table.startAt} < ${table.finishAt}`,
    ),
    check(
      'vdpc_power_check',
      sql`(${table.hvacKw} IS NULL OR ${table.hvacKw} BETWEEN 0 AND 500) AND (${table.systemKw} IS NULL OR ${table.systemKw} BETWEEN 0 AND 500)`,
    ),
  ],
);
