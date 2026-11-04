// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { createId } from '../lib/id.js';
import { sites } from './assets.js';

/** The two kinds of depot system of VDV 463. */
export const DEPOT_SYSTEM_TYPES = ['BMS', 'ITCS'] as const;
export type DepotSystemType = (typeof DEPOT_SYSTEM_TYPES)[number];

// A bus depot management system or ITCS that connects over VDV 463 (the bus
// depot interface, features/vdv-463.md). One writer: lib/depot-systems.ts.
export const depotSystems = pgTable(
  'depot_systems',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('depotSystem')),
    // The VDV PresystemId, also the Basic authentication user name.
    presystemId: varchar('presystem_id', { length: 255 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    systemType: varchar('system_type', { length: 4 }).$type<DepotSystemType>().notNull(),
    // argon2id; the password is only ever verified, never sent.
    passwordHash: text('password_hash').notNull(),
    isEnabled: boolean('is_enabled').notNull().default(false),
    infoIntervalSeconds: smallint('info_interval_seconds').notNull().default(30),
    requestTimeoutSeconds: smallint('request_timeout_seconds').notNull().default(30),
    maxRetries: smallint('max_retries').notNull().default(3),
    keepaliveTimeoutSeconds: smallint('keepalive_timeout_seconds').notNull().default(180),
    failedAuthCount: smallint('failed_auth_count').notNull().default(0),
    authLockedUntil: timestamp('auth_locked_until', { withTimezone: true }),
    lastConnectedAt: timestamp('last_connected_at', { withTimezone: true }),
    lastBootAt: timestamp('last_boot_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_depot_systems_presystem_id').on(table.presystemId),
    check('depot_systems_type_check', sql`${table.systemType} IN ('BMS', 'ITCS')`),
    check('depot_systems_interval_check', sql`${table.infoIntervalSeconds} BETWEEN 10 AND 600`),
    check('depot_systems_timeout_check', sql`${table.requestTimeoutSeconds} BETWEEN 5 AND 120`),
    check('depot_systems_retries_check', sql`${table.maxRetries} BETWEEN 0 AND 10`),
    check(
      'depot_systems_keepalive_check',
      sql`${table.keepaliveTimeoutSeconds} BETWEEN 30 AND 900`,
    ),
  ],
);

// The bus depot sites a depot system sends requests for and gets reports of.
export const depotSystemSites = pgTable(
  'depot_system_sites',
  {
    depotSystemId: text('depot_system_id')
      .notNull()
      .references(() => depotSystems.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.depotSystemId, table.siteId] })],
);

// Charging requests of the last list that were not applied, with the reason.
// A row goes away when the request applies or leaves the list.
export const depotSystemRefusedRequests = pgTable(
  'depot_system_refused_requests',
  {
    depotSystemId: text('depot_system_id')
      .notNull()
      .references(() => depotSystems.id, { onDelete: 'cascade' }),
    externalRequestId: varchar('external_request_id', { length: 255 }).notNull(),
    vehicleRef: varchar('vehicle_ref', { length: 255 }),
    reason: varchar('reason', { length: 40 }).notNull(),
    refusedAt: timestamp('refused_at', { withTimezone: true }).notNull().defaultNow(),
    // When depot operators were told about this refusal (once per request and reason).
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.depotSystemId, table.externalRequestId] })],
);
