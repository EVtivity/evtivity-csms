// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  text,
  serial,
  integer,
  varchar,
  boolean,
  timestamp,
  jsonb,
  numeric,
  index,
  unique,
  uniqueIndex,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createId } from '../lib/id.js';
import { sites } from './assets.js';
import { chargingSessions } from './charging.js';
import { pricingGroups, tariffs } from './pricing.js';

export const ocpiPartnerStatusEnum = pgEnum('ocpi_partner_status', [
  'pending',
  'connected',
  'suspended',
  'disconnected',
]);

export const ocpiTokenDirectionEnum = pgEnum('ocpi_token_direction', ['issued', 'received']);

export const ocpiInterfaceRoleEnum = pgEnum('ocpi_interface_role', ['SENDER', 'RECEIVER']);

export const ocpiCdrPushStatusEnum = pgEnum('ocpi_cdr_push_status', [
  'pending',
  'sent',
  'confirmed',
  'failed',
]);

export const ocpiSyncDirectionEnum = pgEnum('ocpi_sync_direction', ['push', 'pull']);

export const ocpiSyncStatusEnum = pgEnum('ocpi_sync_status', ['started', 'completed', 'failed']);

export const ocpiPartners = pgTable(
  'ocpi_partners',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('ocpiPartner')),
    name: varchar('name', { length: 255 }).notNull(),
    countryCode: varchar('country_code', { length: 2 }).notNull(),
    partyId: varchar('party_id', { length: 3 }).notNull(),
    roles: jsonb('roles').notNull().default([]),
    ourRoles: jsonb('our_roles').notNull().default([]),
    status: ocpiPartnerStatusEnum('status').notNull().default('pending'),
    version: varchar('version', { length: 10 }),
    versionUrl: text('version_url'),
    // OCPI 2.2.1 Token C — the partner's out-of-band registration token used
    // when WE are the Sender (outbound registration). Encrypted at rest via
    // SETTINGS_ENCRYPTION_KEY; null for partners that registered inbound.
    partnerRegistrationTokenEnc: text('partner_registration_token_enc'),
    // Operator-set: the partner may be reached on loopback and private
    // addresses (private peering, local simulators). Off: every outbound OCPI
    // request and command callback must resolve to public addresses only.
    allowPrivateNetwork: boolean('allow_private_network').notNull().default(false),
    // When the partner was sent REMOVED for the EVSE uids published before
    // v0.1.32 ({siteId}-{evseNumber}). Null: still to send (partners that
    // existed at migration 0139). New partners never saw them: default now().
    legacyEvseUidsRemovedAt: timestamp('legacy_evse_uids_removed_at', {
      withTimezone: true,
    }).defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('ocpi_partners_country_party').on(table.countryCode, table.partyId),
    index('idx_ocpi_partners_status').on(table.status),
  ],
);

export const ocpiPartnerEndpoints = pgTable(
  'ocpi_partner_endpoints',
  {
    id: serial('id').primaryKey(),
    partnerId: text('partner_id')
      .notNull()
      .references(() => ocpiPartners.id, { onDelete: 'cascade' }),
    module: varchar('module', { length: 50 }).notNull(),
    interfaceRole: ocpiInterfaceRoleEnum('interface_role').notNull(),
    url: text('url').notNull(),
  },
  (table) => [
    unique('ocpi_partner_endpoints_unique').on(table.partnerId, table.module, table.interfaceRole),
    index('idx_ocpi_partner_endpoints_partner').on(table.partnerId),
  ],
);

export const ocpiCredentialsTokens = pgTable(
  'ocpi_credentials_tokens',
  {
    id: serial('id').primaryKey(),
    partnerId: text('partner_id').references(() => ocpiPartners.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: varchar('token_prefix', { length: 8 }).notNull(),
    direction: ocpiTokenDirectionEnum('direction').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    outboundTokenEnc: text('outbound_token_enc'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ocpi_credentials_tokens_prefix_active').on(table.tokenPrefix, table.isActive),
    index('idx_ocpi_credentials_tokens_partner').on(table.partnerId),
  ],
);

export const ocpiLocationPublish = pgTable('ocpi_location_publish', {
  id: serial('id').primaryKey(),
  siteId: text('site_id')
    .notNull()
    .unique()
    .references(() => sites.id, { onDelete: 'cascade' }),
  isPublished: boolean('is_published').notNull().default(false),
  publishToAll: boolean('publish_to_all').notNull().default(true),
  ocpiLocationId: varchar('ocpi_location_id', { length: 36 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ocpiLocationPublishPartners = pgTable(
  'ocpi_location_publish_partners',
  {
    locationPublishId: integer('location_publish_id')
      .notNull()
      .references(() => ocpiLocationPublish.id, { onDelete: 'cascade' }),
    partnerId: text('partner_id')
      .notNull()
      .references(() => ocpiPartners.id, { onDelete: 'cascade' }),
  },
  (table) => [
    unique('ocpi_location_publish_partners_unique').on(table.locationPublishId, table.partnerId),
  ],
);

// A published OCPI tariff: the OCPI tariff id a partner sees and the internal
// tariff or pricing group it is generated from (exactly one of the two). The
// OCPI server renders the tariff from that source on every request and push,
// so prices, tax, and currency always match what is billed. partner_id null
// publishes to every partner; a partner-specific mapping with the same
// ocpi_tariff_id replaces the global one for that partner.
export const ocpiTariffMappings = pgTable(
  'ocpi_tariff_mappings',
  {
    id: serial('id').primaryKey(),
    tariffId: text('tariff_id').references(() => tariffs.id, { onDelete: 'cascade' }),
    pricingGroupId: text('pricing_group_id').references(() => pricingGroups.id, {
      onDelete: 'cascade',
    }),
    partnerId: text('partner_id').references(() => ocpiPartners.id, { onDelete: 'cascade' }),
    ocpiTariffId: varchar('ocpi_tariff_id', { length: 36 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ocpi_tariff_mappings_tariff').on(table.tariffId),
    index('idx_ocpi_tariff_mappings_pricing_group').on(table.pricingGroupId),
    index('idx_ocpi_tariff_mappings_partner').on(table.partnerId),
    unique('uq_ocpi_tariff_mappings_partner_tariff_id')
      .on(table.partnerId, table.ocpiTariffId)
      .nullsNotDistinct(),
    check(
      'ocpi_tariff_mappings_one_source',
      sql`(${table.tariffId} IS NULL) <> (${table.pricingGroupId} IS NULL)`,
    ),
  ],
);

export const ocpiExternalTokens = pgTable(
  'ocpi_external_tokens',
  {
    id: serial('id').primaryKey(),
    partnerId: text('partner_id')
      .notNull()
      .references(() => ocpiPartners.id, { onDelete: 'cascade' }),
    countryCode: varchar('country_code', { length: 2 }).notNull(),
    partyId: varchar('party_id', { length: 3 }).notNull(),
    uid: varchar('uid', { length: 36 }).notNull(),
    tokenType: varchar('token_type', { length: 20 }).notNull(),
    isValid: boolean('is_valid').notNull().default(true),
    whitelist: varchar('whitelist', { length: 20 }).notNull().default('ALLOWED'),
    tokenData: jsonb('token_data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('ocpi_external_tokens_unique').on(table.countryCode, table.partyId, table.uid),
    index('idx_ocpi_external_tokens_partner').on(table.partnerId),
    index('idx_ocpi_external_tokens_uid').on(table.uid),
  ],
);

export const ocpiRoamingSessions = pgTable(
  'ocpi_roaming_sessions',
  {
    id: serial('id').primaryKey(),
    partnerId: text('partner_id')
      .notNull()
      .references(() => ocpiPartners.id, { onDelete: 'cascade' }),
    ocpiSessionId: varchar('ocpi_session_id', { length: 36 }).notNull(),
    chargingSessionId: text('charging_session_id').references(() => chargingSessions.id, {
      onDelete: 'cascade',
    }),
    tokenUid: varchar('token_uid', { length: 36 }).notNull(),
    status: varchar('status', { length: 20 }).notNull(),
    kwh: numeric('kwh', { precision: 10, scale: 4 }).notNull().default('0'),
    totalCost: numeric('total_cost', { precision: 10, scale: 2 }),
    currency: varchar('currency', { length: 3 }),
    sessionData: jsonb('session_data').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ocpi_roaming_sessions_partner').on(table.partnerId),
    index('idx_ocpi_roaming_sessions_ocpi_id').on(table.ocpiSessionId),
    // One CPO roaming session per charging session (rows received from
    // partners as eMSP have no charging session).
    uniqueIndex('uq_ocpi_roaming_sessions_charging_session')
      .on(table.chargingSessionId)
      .where(sql`charging_session_id IS NOT NULL`),
  ],
);

// An EVSE that left a location: deleted, or its station moved to another
// site. OCPI 8.1: EVSEs are never deleted for partners; the location keeps
// serving it with status REMOVED (GET and push) for a retention period. The
// live `evses` table stays the only source of live EVSEs: a row here is
// ignored while the EVSE is live at the same site again. Written by
// `recordRemovedOcpiEvses` (lib/ocpi-removed-evses.ts) only.
export const ocpiRemovedEvses = pgTable(
  'ocpi_removed_evses',
  {
    // The OCPI uid: the internal EVSE id (no foreign key, the EVSE can be gone).
    evseUid: text('evse_uid').notNull(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    stationOcppId: varchar('station_ocpp_id', { length: 255 }).notNull(),
    evseNumber: integer('evse_number').notNull(),
    // Connector snapshot (OCPI requires at least one connector per EVSE).
    connectors: jsonb('connectors').notNull().default([]),
    removedAt: timestamp('removed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.evseUid, table.siteId] }),
    index('idx_ocpi_removed_evses_site').on(table.siteId),
    index('idx_ocpi_removed_evses_removed_at').on(table.removedAt),
  ],
);

// The one-time CDR backfill (one row, id 1): CDRs for completed roaming
// sessions that ended in the 30 days before `cutoff_at` (the time migration
// 0141 ran). The cursor makes a crash resume where it stopped; `completed_at`
// stops it for good. Internal state, written only by the OCPI server's
// cdr-jobs.ts.
export const ocpiCdrBackfill = pgTable(
  'ocpi_cdr_backfill',
  {
    id: integer('id').primaryKey().default(1),
    cutoffAt: timestamp('cutoff_at', { withTimezone: true }).notNull().defaultNow(),
    cursorEndedAt: timestamp('cursor_ended_at', { withTimezone: true }),
    cursorSessionId: text('cursor_session_id'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [check('ocpi_cdr_backfill_single_row', sql`${table.id} = 1`)],
);

export const ocpiCdrs = pgTable(
  'ocpi_cdrs',
  {
    id: serial('id').primaryKey(),
    partnerId: text('partner_id')
      .notNull()
      .references(() => ocpiPartners.id, { onDelete: 'cascade' }),
    ocpiCdrId: varchar('ocpi_cdr_id', { length: 36 }).notNull(),
    chargingSessionId: text('charging_session_id').references(() => chargingSessions.id),
    totalEnergy: numeric('total_energy', { precision: 10, scale: 4 }).notNull(),
    totalCost: numeric('total_cost', { precision: 10, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    cdrData: jsonb('cdr_data').notNull(),
    isCredit: boolean('is_credit').notNull().default(false),
    pushStatus: ocpiCdrPushStatusEnum('push_status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ocpi_cdrs_partner').on(table.partnerId),
    index('idx_ocpi_cdrs_ocpi_id').on(table.ocpiCdrId),
    index('idx_ocpi_cdrs_push_status').on(table.pushStatus),
    index('idx_ocpi_cdrs_charging').on(table.chargingSessionId),
  ],
);

export const ocpiExternalLocations = pgTable(
  'ocpi_external_locations',
  {
    id: serial('id').primaryKey(),
    partnerId: text('partner_id')
      .notNull()
      .references(() => ocpiPartners.id, { onDelete: 'cascade' }),
    countryCode: varchar('country_code', { length: 2 }).notNull(),
    partyId: varchar('party_id', { length: 3 }).notNull(),
    locationId: varchar('location_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 255 }),
    latitude: varchar('latitude', { length: 20 }),
    longitude: varchar('longitude', { length: 20 }),
    evseCount: varchar('evse_count', { length: 10 }).notNull().default('0'),
    locationData: jsonb('location_data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('ocpi_external_locations_unique').on(
      table.partnerId,
      table.countryCode,
      table.partyId,
      table.locationId,
    ),
    index('idx_ocpi_external_locations_partner').on(table.partnerId),
    index('idx_ocpi_external_locations_coords').on(table.latitude, table.longitude),
  ],
);

export const ocpiExternalTariffs = pgTable(
  'ocpi_external_tariffs',
  {
    id: serial('id').primaryKey(),
    partnerId: text('partner_id')
      .notNull()
      .references(() => ocpiPartners.id, { onDelete: 'cascade' }),
    countryCode: varchar('country_code', { length: 2 }).notNull(),
    partyId: varchar('party_id', { length: 3 }).notNull(),
    tariffId: varchar('tariff_id', { length: 36 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    tariffData: jsonb('tariff_data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('ocpi_external_tariffs_unique').on(
      table.partnerId,
      table.countryCode,
      table.partyId,
      table.tariffId,
    ),
    index('idx_ocpi_external_tariffs_partner').on(table.partnerId),
  ],
);

export const ocpiSyncLog = pgTable(
  'ocpi_sync_log',
  {
    id: serial('id').primaryKey(),
    partnerId: text('partner_id')
      .notNull()
      .references(() => ocpiPartners.id, { onDelete: 'cascade' }),
    module: varchar('module', { length: 50 }).notNull(),
    direction: ocpiSyncDirectionEnum('direction').notNull(),
    action: varchar('action', { length: 50 }).notNull(),
    status: ocpiSyncStatusEnum('status').notNull(),
    objectsCount: varchar('objects_count', { length: 10 }).notNull().default('0'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ocpi_sync_log_partner').on(table.partnerId),
    index('idx_ocpi_sync_log_created').on(table.createdAt),
  ],
);
