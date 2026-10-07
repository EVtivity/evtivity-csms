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
  unique,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { LOAD_ALLOCATION_STRATEGIES } from '@evtivity/lib/load-allocation';
import { createId } from '../lib/id.js';

export const chargingStationStatusEnum = pgEnum('charging_station_status', [
  'available',
  'unavailable',
  'faulted',
]);

// Why a station is switched off: by an operator, or by the critical-security
// auto-disable. Null means enabled.
export const stationDisabledReasonEnum = pgEnum('station_disabled_reason', [
  'operator',
  'security',
]);

// Firmware install state that affects availability. Null means none.
export const stationFirmwareStateEnum = pgEnum('station_firmware_state', ['installing', 'failed']);

export const onboardingStatusEnum = pgEnum('onboarding_status', ['pending', 'accepted', 'blocked']);

export const connectorStatusEnum = pgEnum('connector_status', [
  'available',
  'occupied',
  'reserved',
  'unavailable',
  'faulted',
  'charging',
  'preparing',
  'suspended_ev',
  'suspended_evse',
  'finishing',
  'idle',
  'discharging',
  'ev_connected',
]);

export const sites = pgTable(
  'sites',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('site')),
    name: varchar('name', { length: 255 }).notNull(),
    address: varchar('address', { length: 500 }),
    city: varchar('city', { length: 255 }),
    state: varchar('state', { length: 100 }),
    postalCode: varchar('postal_code', { length: 20 }),
    country: varchar('country', { length: 100 }),
    latitude: varchar('latitude', { length: 20 }),
    longitude: varchar('longitude', { length: 20 }),
    timezone: varchar('timezone', { length: 100 }).notNull().default('America/New_York'),
    contactName: varchar('contact_name', { length: 255 }),
    contactEmail: varchar('contact_email', { length: 255 }),
    contactPhone: varchar('contact_phone', { length: 50 }),
    contactIsPublic: boolean('contact_is_public').notNull().default(false),
    hoursOfOperation: text('hours_of_operation'),
    metadata: jsonb('metadata'),
    reservationsEnabled: boolean('reservations_enabled').notNull().default(true),
    freeVendEnabled: boolean('free_vend_enabled').notNull().default(false),
    freeVendTemplateId21: text('free_vend_template_id_21'),
    freeVendTemplateId16: text('free_vend_template_id_16'),
    carbonRegionCode: varchar('carbon_region_code', { length: 20 }),
    // Station display language of the site; null follows stationMessage.language.
    stationMessageLanguage: varchar('station_message_language', { length: 10 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('sites_name_unique').on(table.name),
    check(
      'sites_station_message_language_check',
      sql`${table.stationMessageLanguage} IN ('en', 'de', 'es', 'ko', 'zh', 'zh-TW')`,
    ),
  ],
);

export const vendors = pgTable('vendors', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId('vendor')),
  name: varchar('name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chargingStations = pgTable(
  'charging_stations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('station')),
    stationId: varchar('station_id', { length: 255 }).notNull().unique(),
    siteId: text('site_id').references(() => sites.id),
    vendorId: text('vendor_id').references(() => vendors.id),
    model: varchar('model', { length: 255 }),
    serialNumber: varchar('serial_number', { length: 255 }),
    firmwareVersion: varchar('firmware_version', { length: 255 }),
    iccid: varchar('iccid', { length: 20 }),
    imsi: varchar('imsi', { length: 20 }),
    availability: chargingStationStatusEnum('availability').notNull().default('available'),
    // The status the station reports for itself as a whole: OCPP 1.6
    // connector 0, OCPP 2.x NotifyEvent ChargingStation AvailabilityState.
    reportedStatus: chargingStationStatusEnum('reported_status'),
    // The station's own timestamp of reported_status. An older report does not
    // overwrite it (station-status.ts).
    reportedStatusAt: timestamp('reported_status_at', { withTimezone: true }),
    disabledReason: stationDisabledReasonEnum('disabled_reason'),
    firmwareState: stationFirmwareStateEnum('firmware_state'),
    onboardingStatus: onboardingStatusEnum('onboarding_status').notNull().default('pending'),
    lastHeartbeat: timestamp('last_heartbeat', { withTimezone: true }),
    isOnline: boolean('is_online').notNull().default(false),
    isSimulator: boolean('is_simulator').notNull().default(false),
    // Last connection to this simulator-flagged station that the OCPP server
    // could not attribute to the simulator. The station page asks the
    // operator to confirm a real station. Cleared with the flag.
    simulatorConflictAt: timestamp('simulator_conflict_at', { withTimezone: true }),
    loadPriority: integer('load_priority').notNull().default(5),
    circuitId: text('circuit_id'),
    securityProfile: integer('security_profile').notNull().default(1),
    pendingSecurityProfile: integer('pending_security_profile'),
    ocppProtocol: varchar('ocpp_protocol', { length: 20 }),
    basicAuthPasswordHash: varchar('basic_auth_password_hash', { length: 512 }),
    metadata: jsonb('metadata'),
    latitude: varchar('latitude', { length: 20 }),
    longitude: varchar('longitude', { length: 20 }),
    reservationsEnabled: boolean('reservations_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_charging_stations_availability').on(table.availability),
    index('idx_charging_stations_onboarding_status').on(table.onboardingStatus),
    index('idx_charging_stations_is_online').on(table.isOnline),
    index('idx_charging_stations_is_simulator').on(table.isSimulator),
    index('idx_charging_stations_site_id').on(table.siteId),
    index('idx_charging_stations_vendor_id').on(table.vendorId),
  ],
);

export const evses = pgTable(
  'evses',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('evse')),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    evseId: integer('evse_id').notNull(),
    autoCreated: boolean('auto_created').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_evses_station_id').on(table.stationId),
    uniqueIndex('uq_evses_station_evse').on(table.stationId, table.evseId),
  ],
);

export const connectors = pgTable(
  'connectors',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('connector')),
    evseId: text('evse_id')
      .notNull()
      .references(() => evses.id, { onDelete: 'cascade' }),
    connectorId: integer('connector_id').notNull(),
    status: connectorStatusEnum('status').notNull().default('unavailable'),
    // The station's own timestamp of status. An older report does not
    // overwrite it (station-status.ts).
    statusReportedAt: timestamp('status_reported_at', { withTimezone: true }),
    connectorType: varchar('connector_type', { length: 50 }),
    maxPowerKw: numeric('max_power_kw'),
    maxCurrentAmps: integer('max_current_amps'),
    autoCreated: boolean('auto_created').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_connectors_evse_id').on(table.evseId),
    index('idx_connectors_evse_status').on(table.evseId, table.status),
    uniqueIndex('uq_connectors_evse_connector').on(table.evseId, table.connectorId),
  ],
);

export const stationLayoutPositions = pgTable(
  'station_layout_positions',
  {
    id: serial('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' })
      .unique(),
    positionX: numeric('position_x').notNull().default('0'),
    positionY: numeric('position_y').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_station_layout_site').on(table.siteId)],
);

export const loadAllocationStrategyEnum = pgEnum(
  'load_allocation_strategy',
  LOAD_ALLOCATION_STRATEGIES,
);

export const sitePowerLimits = pgTable('site_power_limits', {
  id: serial('id').primaryKey(),
  siteId: text('site_id')
    .notNull()
    .references(() => sites.id, { onDelete: 'cascade' })
    .unique(),
  maxPowerKw: numeric('max_power_kw').notNull(),
  safetyMarginKw: numeric('safety_margin_kw').notNull().default('0'),
  strategy: loadAllocationStrategyEnum('strategy').notNull().default('equal_share'),
  isEnabled: boolean('is_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const siteElectricityRatePeriods = pgTable(
  'site_electricity_rate_periods',
  {
    id: serial('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    ratePerKwh: numeric('rate_per_kwh', { precision: 10, scale: 6 }).notNull(),
    restrictions: jsonb('restrictions'),
    priority: integer('priority').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_electricity_rate_periods_site_id').on(table.siteId)],
);

export const stationImages = pgTable(
  'station_images',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    fileSize: integer('file_size').notNull(),
    contentType: varchar('content_type', { length: 100 }).notNull(),
    s3Key: text('s3_key').notNull(),
    s3Bucket: text('s3_bucket').notNull(),
    caption: text('caption'),
    tags: text('tags').array().notNull().default([]),
    isDriverVisible: boolean('is_driver_visible').notNull().default(false),
    isMainImage: boolean('is_main_image').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    uploadedBy: text('uploaded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_station_images_station_id').on(table.stationId)],
);
