// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  text,
  serial,
  integer,
  uniqueIndex,
  varchar,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { chargingStations } from './assets.js';
import { createId } from '../lib/id.js';

export const firmwareCampaignStatusEnum = pgEnum('firmware_campaign_status', [
  'draft',
  'active',
  'completed',
  'cancelled',
]);

export const firmwareCampaignStationStatusEnum = pgEnum('firmware_campaign_station_status', [
  'pending',
  'downloading',
  'downloaded',
  'installing',
  'installed',
  'failed',
]);

export const firmwareCampaigns = pgTable(
  'firmware_campaigns',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('firmwareCampaign')),
    name: varchar('name', { length: 200 }).notNull(),
    firmwareUrl: text('firmware_url').notNull(),
    version: varchar('version', { length: 100 }),
    // Secure firmware update (OCPP 2.1 L01, 1.6 SignedUpdateFirmware): the
    // Firmware Signing certificate (PEM) and the firmware signature (base64).
    // Both set or both null.
    signingCertificate: text('signing_certificate'),
    signature: text('signature'),
    // UpdateFirmware download retries and the seconds between them; null
    // leaves both to the station.
    retries: integer('retries'),
    retryInterval: integer('retry_interval'),
    // Install time sent as firmware.installDateTime (2.1 and 1.6
    // SignedUpdateFirmware); null installs as soon as the station can.
    installDateTime: timestamp('install_date_time', { withTimezone: true }),
    status: firmwareCampaignStatusEnum('status').notNull().default('draft'),
    targetFilter: jsonb('target_filter'),
    createdById: text('created_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_firmware_campaigns_status').on(table.status)],
);

export const firmwareCampaignStations = pgTable(
  'firmware_campaign_stations',
  {
    id: serial('id').primaryKey(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => firmwareCampaigns.id, { onDelete: 'cascade' }),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    status: firmwareCampaignStationStatusEnum('status').notNull().default('pending'),
    errorInfo: text('error_info'),
    // When UpdateFirmware was sent. Null for a station that was offline at
    // the start: it gets the update when it connects (claimed once, P7).
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_firmware_campaign_stations_campaign').on(table.campaignId),
    index('idx_firmware_campaign_stations_station').on(table.stationId),
    // Auto-complete EXISTS check in the FirmwareStatusNotification projection
    // hits this table once per status notification across the lifetime of an
    // active campaign. The composite index turns the scan into a covered
    // range lookup.
    index('idx_firmware_campaign_stations_campaign_status').on(table.campaignId, table.status),
    uniqueIndex('uq_firmware_campaign_stations_campaign_station').on(
      table.campaignId,
      table.stationId,
    ),
  ],
);
