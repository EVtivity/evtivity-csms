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
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { createId } from '../lib/id.js';
import { drivers } from './drivers.js';
import { chargingSessions } from './charging.js';
import { chargingStations } from './assets.js';
import { users } from './identity.js';

export const supportCaseStatusEnum = pgEnum('support_case_status', [
  'open',
  'in_progress',
  'waiting_on_driver',
  'resolved',
  'closed',
]);

export const supportCaseCategoryEnum = pgEnum('support_case_category', [
  'billing_dispute',
  'charging_failure',
  'connector_damage',
  'account_issue',
  'payment_problem',
  'reservation_issue',
  'general_inquiry',
]);

export const supportCasePriorityEnum = pgEnum('support_case_priority', [
  'low',
  'medium',
  'high',
  'urgent',
]);

export const supportCaseMessageSenderEnum = pgEnum('support_case_message_sender', [
  'driver',
  'operator',
  'system',
]);

export const supportCases = pgTable(
  'support_cases',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('supportCase')),
    caseNumber: varchar('case_number', { length: 20 }).notNull().unique(),
    subject: varchar('subject', { length: 255 }).notNull(),
    description: text('description').notNull(),
    status: supportCaseStatusEnum('status').notNull().default('open'),
    category: supportCaseCategoryEnum('category').notNull(),
    priority: supportCasePriorityEnum('priority').notNull().default('medium'),
    driverId: text('driver_id').references(() => drivers.id),
    stationId: text('station_id').references(() => chargingStations.id, { onDelete: 'set null' }),
    assignedTo: text('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    createdByDriver: boolean('created_by_driver').notNull().default(false),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_support_cases_driver_id').on(table.driverId),
    index('idx_support_cases_status').on(table.status),
    index('idx_support_cases_category').on(table.category),
    index('idx_support_cases_priority').on(table.priority),
    index('idx_support_cases_assigned_to').on(table.assignedTo),
    index('idx_support_cases_case_number').on(table.caseNumber),
    index('idx_support_cases_created_at').on(table.createdAt),
    index('idx_support_cases_station_id').on(table.stationId),
    index('idx_support_cases_status_assigned').on(table.status, table.assignedTo),
  ],
);

export const supportCaseMessages = pgTable(
  'support_case_messages',
  {
    id: serial('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => supportCases.id, { onDelete: 'cascade' }),
    senderType: supportCaseMessageSenderEnum('sender_type').notNull(),
    senderId: text('sender_id'),
    body: text('body').notNull(),
    isInternal: boolean('is_internal').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_support_case_messages_case_id').on(table.caseId)],
);

export const supportCaseAttachments = pgTable(
  'support_case_attachments',
  {
    id: serial('id').primaryKey(),
    messageId: integer('message_id')
      .notNull()
      .references(() => supportCaseMessages.id, { onDelete: 'cascade' }),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    fileSize: integer('file_size').notNull(),
    contentType: varchar('content_type', { length: 100 }).notNull(),
    s3Key: varchar('s3_key', { length: 1024 }).notNull(),
    s3Bucket: varchar('s3_bucket', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_support_case_attachments_message_id').on(table.messageId)],
);

export const supportCaseReads = pgTable(
  'support_case_reads',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    caseId: text('case_id')
      .notNull()
      .references(() => supportCases.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.caseId] }),
    index('idx_support_case_reads_user_id').on(table.userId),
  ],
);

export const supportCaseSessions = pgTable(
  'support_case_sessions',
  {
    caseId: text('case_id')
      .notNull()
      .references(() => supportCases.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => chargingSessions.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.caseId, table.sessionId] }),
    index('idx_support_case_sessions_session_id').on(table.sessionId),
  ],
);
