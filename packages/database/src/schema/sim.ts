// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  bigint,
  bigserial,
  boolean,
  check,
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
import { createId } from '../lib/id.js';
import { chargingStations, sites } from './assets.js';
import { users } from './identity.js';
import { paymentTerminals } from './payment-terminals.js';

/** Where an attachment came from. */
export const SIM_ATTACHMENT_SOURCES = ['reported', 'entered', 'attached', 'imported'] as const;
export type SimAttachmentSource = (typeof SIM_ATTACHMENT_SOURCES)[number];

/** Why an attachment was closed. `deactivated`: the SIM was made inactive. */
export const SIM_DETACH_REASONS = [
  'detached',
  'iccid_changed',
  'replaced',
  'displaced',
  'deactivated',
] as const;
export type SimDetachReason = (typeof SIM_DETACH_REASONS)[number];

/**
 * The CSMS status of a SIM, set by an operator. Never mixed with the provider
 * status, which is `last_status` from a Refresh.
 */
export const SIM_STATUSES = ['active', 'inactive'] as const;
export type SimStatus = (typeof SIM_STATUSES)[number];

/**
 * One row per physical SIM (the SIM inventory), keyed by its normalized ICCID.
 * Holds the provider lookup and the fetch state of the last Refresh.
 */
export const sims = pgTable(
  'sims',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('sim')),
    // Normalized: trimmed, upper case, a trailing F removed (normalizeIccid).
    iccid: varchar('iccid', { length: 20 }).notNull(),
    imsi: varchar('imsi', { length: 15 }),
    provider: varchar('provider', { length: 32 }),
    providerRef: varchar('provider_ref', { length: 128 }),
    providerMeta: jsonb('provider_meta'),
    lookupMissedAt: timestamp('lookup_missed_at', { withTimezone: true }),
    lookupMissReason: varchar('lookup_miss_reason', { length: 32 }),
    label: varchar('label', { length: 100 }),
    notes: text('notes'),
    lastStatus: jsonb('last_status'),
    statusFetchedAt: timestamp('status_fetched_at', { withTimezone: true }),
    openSessionBeganAt: timestamp('open_session_began_at', { withTimezone: true }),
    lastRecordId: varchar('last_record_id', { length: 64 }),
    sessionsSyncedAt: timestamp('sessions_synced_at', { withTimezone: true }),
    alertsSyncedAt: timestamp('alerts_synced_at', { withTimezone: true }),
    status: varchar('status', { length: 16 }).$type<SimStatus>().notNull().default('active'),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    deactivatedBy: text('deactivated_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Raised to the close time by every attachment close and every delete of a
     * station holding the SIM's attachment, never lowered. Station reads show
     * only the SIM's rows after it; null shows them all.
     */
    historyFloorAt: timestamp('history_floor_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_sims_iccid').on(table.iccid),
    uniqueIndex('uq_sims_provider_ref')
      .on(table.provider, table.providerRef)
      .where(sql`${table.providerRef} IS NOT NULL`),
    index('idx_sims_created_at').on(table.createdAt),
    check('sims_status_check', sql`${table.status} IN ('active', 'inactive')`),
  ],
);

/**
 * Which station (or, later, payment terminal) a SIM sits in, with the history
 * kept. Exactly one target is set. At most one open attachment (`detached_at`
 * null) per SIM and per target.
 */
export const simAttachments = pgTable(
  'sim_attachments',
  {
    id: serial('id').primaryKey(),
    simId: text('sim_id')
      .notNull()
      .references(() => sims.id, { onDelete: 'cascade' }),
    stationId: text('station_id').references(() => chargingStations.id, { onDelete: 'cascade' }),
    paymentTerminalId: text('payment_terminal_id').references(() => paymentTerminals.id, {
      onDelete: 'cascade',
    }),
    // A payment terminal attachment: the terminal's site when it was attached.
    // A site change of the terminal closes the attachment, so this is the
    // site of the whole window (the SIM site windows read it, security case
    // 276). Null for a station attachment, which follows the station.
    siteId: text('site_id').references(() => sites.id, { onDelete: 'set null' }),
    source: varchar('source', { length: 16 }).$type<SimAttachmentSource>().notNull(),
    attachedAt: timestamp('attached_at', { withTimezone: true }).notNull().defaultNow(),
    attachedBy: text('attached_by').references(() => users.id, { onDelete: 'set null' }),
    attachedWithAllSites: boolean('attached_with_all_sites').notNull().default(false),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: text('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    detachedAt: timestamp('detached_at', { withTimezone: true }),
    detachedBy: text('detached_by').references(() => users.id, { onDelete: 'set null' }),
    detachReason: varchar('detach_reason', { length: 32 }).$type<SimDetachReason>(),
  },
  (table) => [
    check(
      'sim_attachments_one_target_check',
      sql`num_nonnulls(${table.stationId}, ${table.paymentTerminalId}) = 1`,
    ),
    check(
      'sim_attachments_source_check',
      sql`${table.source} IN ('reported', 'entered', 'attached', 'imported')`,
    ),
    check(
      'sim_attachments_detach_reason_check',
      sql`${table.detachReason} IS NULL OR ${table.detachReason} IN ('detached', 'iccid_changed', 'replaced', 'displaced', 'deactivated')`,
    ),
    uniqueIndex('uq_sim_attachments_open_sim')
      .on(table.simId)
      .where(sql`${table.detachedAt} IS NULL`),
    uniqueIndex('uq_sim_attachments_open_station')
      .on(table.stationId)
      .where(sql`${table.detachedAt} IS NULL AND ${table.stationId} IS NOT NULL`),
    uniqueIndex('uq_sim_attachments_open_terminal')
      .on(table.paymentTerminalId)
      .where(sql`${table.detachedAt} IS NULL AND ${table.paymentTerminalId} IS NOT NULL`),
    index('idx_sim_attachments_sim_attached').on(table.simId, table.attachedAt.desc()),
    index('idx_sim_attachments_station_attached').on(table.stationId, table.attachedAt.desc()),
    index('idx_sim_attachments_terminal_attached').on(
      table.paymentTerminalId,
      table.attachedAt.desc(),
    ),
  ],
);

/** Closed cellular data sessions of a SIM, fetched by a Refresh. Written by the station SIM service only. */
export const simSessions = pgTable(
  'sim_sessions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    simId: text('sim_id')
      .notNull()
      .references(() => sims.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
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
    index('idx_sim_sessions_sim_started').on(table.simId, table.startedAt),
    index('idx_sim_sessions_started').on(table.startedAt),
  ],
);

/** SIM alerts (data limit, data warning, device change) of a SIM, fetched by a Refresh. */
export const simAlerts = pgTable(
  'sim_alerts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    simId: text('sim_id')
      .notNull()
      .references(() => sims.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    providerAlertId: varchar('provider_alert_id', { length: 64 }).notNull(),
    kind: varchar('kind', { length: 32 }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_sim_alerts_provider_alert').on(table.provider, table.providerAlertId),
    index('idx_sim_alerts_sim_received').on(table.simId, table.receivedAt),
    index('idx_sim_alerts_received').on(table.receivedAt),
  ],
);

/** The time ranges a Refresh fetched for a SIM, merged per SIM, so the timeline shows which days have data. */
export const simFetchCoverage = pgTable(
  'sim_fetch_coverage',
  {
    id: serial('id').primaryKey(),
    simId: text('sim_id')
      .notNull()
      .references(() => sims.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    coveredFrom: timestamp('covered_from', { withTimezone: true }).notNull(),
    coveredTo: timestamp('covered_to', { withTimezone: true }).notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_sim_fetch_coverage_sim_from').on(table.simId, table.coveredFrom)],
);
