// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  serial,
  integer,
  varchar,
  text,
  timestamp,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { chargingStations } from './assets.js';

export const displayMessagePriorityEnum = pgEnum('display_message_priority', [
  'AlwaysFront',
  'InFront',
  'NormalCycle',
]);

export const displayMessageFormatEnum = pgEnum('display_message_format', [
  'ASCII',
  'HTML',
  'URI',
  'UTF8',
  'QRCODE',
]);

export const displayMessageStateEnum = pgEnum('display_message_state', [
  'Charging',
  'Faulted',
  'Idle',
  'Unavailable',
  'Suspended',
  'Discharging',
]);

export const displayMessageStatusEnum = pgEnum('display_message_status', [
  'pending',
  'accepted',
  'rejected',
  'cleared',
  'expired',
]);

export const displayMessages = pgTable(
  'display_messages',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    ocppMessageId: integer('ocpp_message_id').notNull(),
    priority: displayMessagePriorityEnum('priority').notNull(),
    status: displayMessageStatusEnum('status').notNull().default('pending'),
    state: displayMessageStateEnum('state'),
    format: displayMessageFormatEnum('format').notNull(),
    language: varchar('language', { length: 8 }),
    content: text('content').notNull(),
    startDateTime: timestamp('start_date_time', { withTimezone: true }),
    endDateTime: timestamp('end_date_time', { withTimezone: true }),
    transactionId: varchar('transaction_id', { length: 36 }),
    evseId: integer('evse_id'),
    messageExtra: jsonb('message_extra'),
    ocppResponse: jsonb('ocpp_response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_display_messages_station_id').on(table.stationId),
    index('idx_display_messages_status').on(table.status),
    unique('display_messages_station_id_ocpp_message_id_unique').on(
      table.stationId,
      table.ocppMessageId,
    ),
  ],
);
