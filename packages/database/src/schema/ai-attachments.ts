// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  uuid,
  integer,
  varchar,
  timestamp,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';
import { aiConversations } from './ai.js';

export const AI_ATTACHMENT_STATUSES = ['pending', 'ready'] as const;
export type AiAttachmentStatus = (typeof AI_ATTACHMENT_STATUSES)[number];

export const AI_ATTACHMENT_KINDS = ['image', 'pdf', 'text'] as const;
export type AiAttachmentKind = (typeof AI_ATTACHMENT_KINDS)[number];

/**
 * Files an operator attaches to an AI assistant chat. Written only by the
 * chat attachment service (`packages/api/src/services/ai/attachments/`).
 *
 * - `pending`: an upload URL was issued for `quarantine_key`; nothing is read
 *   from it until confirm checks and sanitizes the object.
 * - `ready`: the sanitized file is at `s3_key`, with its sniffed type.
 *
 * `conversation_id` is set when a message uses the attachment. A row with
 * `deleted_at`, without a user, or never bound to a conversation for a day
 * is removed (S3 object first) by the `ai-retention-prune` cron.
 */
export const aiAttachments = pgTable(
  'ai_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    conversationId: text('conversation_id').references(() => aiConversations.id, {
      onDelete: 'set null',
    }),
    status: varchar('status', { length: 16 }).$type<AiAttachmentStatus>().notNull(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    declaredType: varchar('declared_type', { length: 100 }).notNull(),
    declaredSize: integer('declared_size').notNull(),
    contentType: varchar('content_type', { length: 100 }),
    kind: varchar('kind', { length: 16 }).$type<AiAttachmentKind>(),
    sizeBytes: integer('size_bytes'),
    pageCount: integer('page_count'),
    width: integer('width'),
    height: integer('height'),
    s3Bucket: varchar('s3_bucket', { length: 255 }).notNull(),
    quarantineKey: varchar('quarantine_key', { length: 1024 }).notNull(),
    s3Key: varchar('s3_key', { length: 1024 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_ai_attachments_user_created').on(table.userId, table.createdAt),
    index('idx_ai_attachments_conversation').on(table.conversationId),
    check('ai_attachments_status_check', sql`${table.status} IN ('pending', 'ready')`),
    check(
      'ai_attachments_kind_check',
      sql`${table.kind} IS NULL OR ${table.kind} IN ('image', 'pdf', 'text')`,
    ),
  ],
);
