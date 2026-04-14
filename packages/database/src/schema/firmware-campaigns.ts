// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  text,
  serial,
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
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_firmware_campaign_stations_campaign').on(table.campaignId),
    index('idx_firmware_campaign_stations_station').on(table.stationId),
  ],
);
