// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  bigint,
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { chargingStations } from './assets.js';
import { users } from './identity.js';

/**
 * A station's SIM at its provider, kept apart from charging_stations so no
 * station reply or audit snapshot changes. A row without a provider holds an
 * operator-entered ICCID or a cached lookup miss. Only
 * `lib/station-sim-match.ts` writes it.
 */
export const stationSimMatches = pgTable(
  'station_sim_matches',
  {
    stationId: text('station_id')
      .primaryKey()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }),
    providerRef: varchar('provider_ref', { length: 128 }),
    meta: jsonb('meta'),
    enteredIccid: varchar('entered_iccid', { length: 20 }),
    enteredBy: text('entered_by').references(() => users.id, { onDelete: 'set null' }),
    enteredWithAllSites: boolean('entered_with_all_sites').notNull().default(false),
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: text('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    lookupMissedAt: timestamp('lookup_missed_at', { withTimezone: true }),
    lookupMissReason: varchar('lookup_miss_reason', { length: 32 }),
    sessionsSyncedAt: timestamp('sessions_synced_at', { withTimezone: true }),
    lastRecordId: varchar('last_record_id', { length: 64 }),
    alertsSyncedAt: timestamp('alerts_synced_at', { withTimezone: true }),
    openSessionBeganAt: timestamp('open_session_began_at', { withTimezone: true }),
    lastStatus: jsonb('last_status'),
    statusFetchedAt: timestamp('status_fetched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One provider SIM has one confirmed station: a station cannot pick another
    // station's SIM as its network reset target. Unconfirmed matches fetch nothing.
    uniqueIndex('uq_station_sim_matches_confirmed_ref')
      .on(table.provider, table.providerRef)
      .where(sql`${table.confirmedAt} IS NOT NULL`),
  ],
);

/**
 * Closed cellular data sessions fetched by a Refresh. Written by the station SIM
 * service only. `provider_sim_id` is the match's provider ref: reads show only
 * the sessions of the station's current confirmed SIM.
 */
export const simSessions = pgTable(
  'sim_sessions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    providerSimId: varchar('provider_sim_id', { length: 128 }).notNull(),
    providerSessionId: varchar('provider_session_id', { length: 64 }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
    bytes: bigint('bytes', { mode: 'number' }),
    networkName: varchar('network_name', { length: 128 }),
    radioAccessTechnology: varchar('radio_access_technology', { length: 32 }),
    cellId: varchar('cell_id', { length: 64 }),
    apn: varchar('apn', { length: 128 }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_sim_sessions_provider_session').on(table.provider, table.providerSessionId),
    index('idx_sim_sessions_station_started').on(table.stationId, table.startedAt),
    index('idx_sim_sessions_started').on(table.startedAt),
  ],
);

/** SIM alerts (data limit, data warning, device change) fetched by a Refresh, for one SIM. */
export const simAlerts = pgTable(
  'sim_alerts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    providerAlertId: varchar('provider_alert_id', { length: 64 }).notNull(),
    // The provider ref of the SIM the alert was fetched for (the match's
    // provider_ref): reads show only the alerts of the current confirmed SIM.
    providerRef: varchar('provider_ref', { length: 128 }),
    kind: varchar('kind', { length: 32 }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_sim_alerts_provider_alert').on(table.provider, table.providerAlertId),
    index('idx_sim_alerts_station_received').on(table.stationId, table.receivedAt),
    index('idx_sim_alerts_received').on(table.receivedAt),
  ],
);

/**
 * The time ranges a Refresh fetched for a station's SIM (`provider_ref`), merged
 * per SIM, so the timeline shows which days have data for the current SIM.
 */
export const simFetchCoverage = pgTable(
  'sim_fetch_coverage',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    providerRef: varchar('provider_ref', { length: 128 }),
    coveredFrom: timestamp('covered_from', { withTimezone: true }).notNull(),
    coveredTo: timestamp('covered_to', { withTimezone: true }).notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_sim_fetch_coverage_station_from').on(table.stationId, table.coveredFrom)],
);
