// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  text,
  varchar,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { createId } from '../lib/id.js';

export const cssStationStatusEnum = pgEnum('css_station_status', [
  'disconnected',
  'booting',
  'available',
  'charging',
  'faulted',
  'unavailable',
]);

export const cssTransactionStatusEnum = pgEnum('css_transaction_status', [
  'active',
  'completed',
  'faulted',
]);

export const cssConnectorTypeEnum = pgEnum('css_connector_type', [
  'ac_type2',
  'ac_type1',
  'dc_ccs2',
  'dc_ccs1',
  'dc_chademo',
]);

// Credentials (password, clientCert, clientKey, caCert) are stored as plaintext intentionally.
// This table is for the charging station simulator used in development and testing only.
// The simulator reads these values directly to establish WebSocket and TLS connections.
export const cssStations = pgTable(
  'css_stations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('cssStation')),
    stationId: varchar('station_id', { length: 255 }).notNull().unique(),
    ocppProtocol: varchar('ocpp_protocol', { length: 10 }).notNull().default('ocpp2.1'),
    securityProfile: integer('security_profile').notNull().default(1),
    targetUrl: text('target_url').notNull(),
    password: varchar('password', { length: 255 }),
    vendorName: varchar('vendor_name', { length: 255 }).notNull().default('EVtivity'),
    model: varchar('model', { length: 255 }).notNull().default('CSS-1000'),
    serialNumber: varchar('serial_number', { length: 255 }),
    firmwareVersion: varchar('firmware_version', { length: 50 }).notNull().default('1.0.0'),
    clientCert: text('client_cert'),
    clientKey: text('client_key'),
    caCert: text('ca_cert'),
    status: cssStationStatusEnum('status').notNull().default('disconnected'),
    availabilityState: varchar('availability_state', { length: 50 }).notNull().default('Operative'),
    bootReason: varchar('boot_reason', { length: 50 }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    lastBootAt: timestamp('last_boot_at', { withTimezone: true }),
    sourceType: varchar('source_type', { length: 20 }).notNull().default('api'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_css_stations_enabled').on(table.enabled),
    index('idx_css_stations_status').on(table.status),
  ],
);

export const cssEvses = pgTable(
  'css_evses',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('cssEvse')),
    cssStationId: text('css_station_id')
      .notNull()
      .references(() => cssStations.id, { onDelete: 'cascade' }),
    evseId: integer('evse_id').notNull(),
    connectorId: integer('connector_id').notNull().default(1),
    connectorType: cssConnectorTypeEnum('connector_type').notNull().default('ac_type2'),
    maxPowerW: integer('max_power_w').notNull().default(22000),
    phases: integer('phases').notNull().default(3),
    voltage: integer('voltage').notNull().default(230),
    status: varchar('status', { length: 50 }).notNull().default('Available'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('css_evses_station_evse_connector').on(
      table.cssStationId,
      table.evseId,
      table.connectorId,
    ),
    index('idx_css_evses_css_station_id').on(table.cssStationId),
  ],
);

export const cssTransactions = pgTable(
  'css_transactions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('cssTransaction')),
    cssStationId: text('css_station_id')
      .notNull()
      .references(() => cssStations.id, { onDelete: 'cascade' }),
    evseId: integer('evse_id').notNull(),
    transactionId: varchar('transaction_id', { length: 255 }).notNull(),
    idToken: varchar('id_token', { length: 255 }),
    tokenType: varchar('token_type', { length: 50 }),
    status: cssTransactionStatusEnum('status').notNull().default('active'),
    meterStartWh: integer('meter_start_wh').notNull().default(0),
    meterStopWh: integer('meter_stop_wh'),
    currentPowerW: real('current_power_w').notNull().default(0),
    currentSoc: real('current_soc'),
    chargingState: varchar('charging_state', { length: 50 }),
    seqNo: integer('seq_no').notNull().default(0),
    idleStartedAt: timestamp('idle_started_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    stoppedReason: varchar('stopped_reason', { length: 50 }),
  },
  (table) => [
    unique('css_transactions_station_transaction').on(table.cssStationId, table.transactionId),
    index('idx_css_transactions_css_station_id').on(table.cssStationId),
    index('idx_css_transactions_status').on(table.status),
  ],
);

export const cssConfigVariables = pgTable(
  'css_config_variables',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('cssConfigVar')),
    cssStationId: text('css_station_id')
      .notNull()
      .references(() => cssStations.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 255 }).notNull(),
    value: text('value').notNull(),
    readonly: boolean('readonly').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('css_config_variables_station_key').on(table.cssStationId, table.key),
    index('idx_css_config_variables_css_station_id').on(table.cssStationId),
  ],
);

export const cssChargingProfiles = pgTable(
  'css_charging_profiles',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('cssChargingProfile')),
    cssStationId: text('css_station_id')
      .notNull()
      .references(() => cssStations.id, { onDelete: 'cascade' }),
    profileId: integer('profile_id').notNull(),
    evseId: integer('evse_id'),
    profileData: jsonb('profile_data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('css_charging_profiles_station_profile').on(table.cssStationId, table.profileId),
    index('idx_css_charging_profiles_css_station_id').on(table.cssStationId),
  ],
);

export const cssLocalAuthEntries = pgTable(
  'css_local_auth_entries',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('cssLocalAuth')),
    cssStationId: text('css_station_id')
      .notNull()
      .references(() => cssStations.id, { onDelete: 'cascade' }),
    idToken: varchar('id_token', { length: 255 }).notNull(),
    tokenType: varchar('token_type', { length: 50 }),
    authStatus: varchar('auth_status', { length: 50 }).notNull().default('Accepted'),
    listVersion: integer('list_version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('css_local_auth_entries_station_token').on(table.cssStationId, table.idToken),
    index('idx_css_local_auth_entries_css_station_id').on(table.cssStationId),
  ],
);

export const cssInstalledCertificates = pgTable(
  'css_installed_certificates',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('cssCertificate')),
    cssStationId: text('css_station_id')
      .notNull()
      .references(() => cssStations.id, { onDelete: 'cascade' }),
    certificateType: varchar('certificate_type', { length: 100 }).notNull(),
    serialNumber: varchar('serial_number', { length: 255 }).notNull(),
    hashAlgorithm: varchar('hash_algorithm', { length: 20 }).notNull().default('SHA256'),
    issuerNameHash: varchar('issuer_name_hash', { length: 255 }),
    issuerKeyHash: varchar('issuer_key_hash', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('css_installed_certificates_station_serial').on(table.cssStationId, table.serialNumber),
    index('idx_css_installed_certificates_css_station_id').on(table.cssStationId),
  ],
);

export const cssDisplayMessages = pgTable(
  'css_display_messages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('cssDisplayMessage')),
    cssStationId: text('css_station_id')
      .notNull()
      .references(() => cssStations.id, { onDelete: 'cascade' }),
    messageId: integer('message_id').notNull(),
    messageData: jsonb('message_data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('css_display_messages_station_message').on(table.cssStationId, table.messageId),
    index('idx_css_display_messages_css_station_id').on(table.cssStationId),
  ],
);

export const cssReservations = pgTable(
  'css_reservations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('cssReservation')),
    cssStationId: text('css_station_id')
      .notNull()
      .references(() => cssStations.id, { onDelete: 'cascade' }),
    reservationId: integer('reservation_id').notNull(),
    evseId: integer('evse_id').notNull(),
    idToken: varchar('id_token', { length: 255 }).notNull(),
    expiryDateTime: timestamp('expiry_date_time', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('css_reservations_station_reservation').on(table.cssStationId, table.reservationId),
    index('idx_css_reservations_css_station_id').on(table.cssStationId),
  ],
);
