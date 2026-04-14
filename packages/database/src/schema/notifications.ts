// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  serial,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';

export const notificationChannelEnum = pgEnum('notification_channel', [
  'email',
  'webhook',
  'push',
  'sms',
  'log',
]);

export const notificationStatusEnum = pgEnum('notification_status', ['pending', 'sent', 'failed']);

export const notifications = pgTable(
  'notifications',
  {
    id: serial('id').primaryKey(),
    channel: notificationChannelEnum('channel').notNull(),
    recipient: varchar('recipient', { length: 500 }).notNull(),
    subject: varchar('subject', { length: 500 }),
    body: text('body').notNull(),
    status: notificationStatusEnum('status').notNull().default('pending'),
    eventType: varchar('event_type', { length: 255 }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_notifications_status').on(table.status),
    index('idx_notifications_created_at').on(table.createdAt),
    index('idx_notifications_status_created').on(table.status, table.createdAt),
  ],
);

export const notificationTemplates = pgTable(
  'notification_templates',
  {
    id: serial('id').primaryKey(),
    eventType: varchar('event_type', { length: 255 }).notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    language: varchar('language', { length: 10 }).notNull().default('en'),
    subject: varchar('subject', { length: 500 }),
    bodyHtml: text('body_html'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_notification_templates').on(table.eventType, table.channel, table.language),
  ],
);

export const ocppEventSettings = pgTable(
  'ocpp_event_settings',
  {
    id: serial('id').primaryKey(),
    eventType: varchar('event_type', { length: 255 }).notNull(),
    channel: notificationChannelEnum('channel').notNull().default('email'),
    recipient: varchar('recipient', { length: 500 }).notNull().default(''),
    templateHtml: text('template_html'),
    language: varchar('language', { length: 10 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('uq_ocpp_event_settings_event_channel').on(table.eventType, table.channel)],
);

export const driverEventSettings = pgTable(
  'driver_event_settings',
  {
    id: serial('id').primaryKey(),
    eventType: varchar('event_type', { length: 255 }).notNull(),
    isEnabled: boolean('is_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('uq_driver_event_settings_event_type').on(table.eventType)],
);

export const systemEventSettings = pgTable(
  'system_event_settings',
  {
    id: serial('id').primaryKey(),
    eventType: varchar('event_type', { length: 255 }).notNull(),
    isEnabled: boolean('is_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('uq_system_event_settings_event_type').on(table.eventType)],
);
