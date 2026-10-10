// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import {
  pgTable,
  serial,
  text,
  varchar,
  timestamp,
  index,
  integer,
  jsonb,
  bigint,
  check,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';
import { supportCases } from './support-cases.js';
import { createId } from '../lib/id.js';

export const chatbotAiConfigs = pgTable(
  'chatbot_ai_configs',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' })
      .unique(),
    provider: varchar('provider', { length: 20 }).notNull(),
    apiKeyEnc: text('api_key_enc').notNull(),
    model: varchar('model', { length: 100 }),
    effort: varchar('effort', { length: 10 }),
    systemPrompt: text('system_prompt'),
    supportAiProvider: varchar('support_ai_provider', { length: 20 }),
    supportAiApiKeyEnc: text('support_ai_api_key_enc'),
    supportAiModel: varchar('support_ai_model', { length: 100 }),
    supportAiEffort: varchar('support_ai_effort', { length: 10 }),
    supportAiSystemPrompt: text('support_ai_system_prompt'),
    supportAiTone: varchar('support_ai_tone', { length: 20 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_chatbot_ai_configs_user').on(table.userId)],
);

// AI conversations (migrations 0375-0378). The API conversation service
// (`packages/api/src/services/ai/conversation.service.ts`) is the only writer.

/** One conversation of an operator with an AI surface (chatbot or support assist). */
export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('aiConversation')),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'chatbot' or 'support'. */
    surface: varchar('surface', { length: 20 }).notNull(),
    /** The case a support assist conversation drafts for. */
    supportCaseId: text('support_case_id').references(() => supportCases.id, {
      onDelete: 'cascade',
    }),
    /** Provider and model of the latest turn. */
    provider: varchar('provider', { length: 20 }).notNull(),
    model: varchar('model', { length: 200 }).notNull(),
    title: varchar('title', { length: 200 }).notNull().default(''),
    /** Set while a turn runs (a lease): a second turn on the conversation is refused. */
    turnStartedAt: timestamp('turn_started_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_ai_conversations_user_updated').on(table.userId, table.updatedAt),
    index('idx_ai_conversations_support_case').on(table.supportCaseId),
    check('ai_conversations_surface_check', sql`${table.surface} IN ('chatbot', 'support')`),
  ],
);

/**
 * One message: a user message, an assistant response (text and tool calls,
 * with the provider's opaque state) or the tool results that answer it.
 * `parts` holds neutral `AiPart` objects, tool results already redacted.
 */
export const aiMessages = pgTable(
  'ai_messages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('aiMessage')),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    /** 'user', 'assistant' or 'tool'. */
    role: varchar('role', { length: 20 }).notNull(),
    parts: jsonb('parts').notNull(),
    providerState: jsonb('provider_state'),
    /** Token usage of the model calls that produced an assistant message. */
    usage: jsonb('usage'),
    /** Provider cost in micro-USD; null when the model has no recorded prices. */
    costMicros: bigint('cost_micros', { mode: 'number' }),
    /** Why an assistant message ended (end, stopped, tool_use, ...). */
    finishReason: varchar('finish_reason', { length: 30 }),
    /**
     * Access fingerprint (sites plus effective permissions) of the caller that
     * produced a tool message. Reads and replays hide its tool results when
     * the current caller's fingerprint differs (null: always differs).
     */
    accessScope: varchar('access_scope', { length: 32 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ai_messages_conversation').on(table.conversationId, table.createdAt),
    index('idx_ai_messages_created_at').on(table.createdAt),
    check('ai_messages_role_check', sql`${table.role} IN ('user', 'assistant', 'tool')`),
  ],
);

/** One tool call the model made, with its outcome. Arguments are stored redacted. */
export const aiToolCalls = pgTable(
  'ai_tool_calls',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('aiToolCall')),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    /** The assistant message that requested the call. */
    messageId: text('message_id')
      .notNull()
      .references(() => aiMessages.id, { onDelete: 'cascade' }),
    /** The provider's tool call id. */
    toolCallId: varchar('tool_call_id', { length: 200 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    /** Null when the model named a tool that is not in its catalog. */
    operationId: varchar('operation_id', { length: 200 }),
    method: varchar('method', { length: 10 }),
    path: text('path'),
    args: jsonb('args'),
    /** ok, refused, error, pending_confirmation, confirmed, rejected. */
    status: varchar('status', { length: 30 }).notNull(),
    httpStatus: integer('http_status'),
    latencyMs: integer('latency_ms'),
    /** What the redactor removed or masked: { keys, values, pii }. */
    redactionCounts: jsonb('redaction_counts'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ai_tool_calls_conversation').on(table.conversationId),
    index('idx_ai_tool_calls_message').on(table.messageId),
  ],
);

/**
 * A write tool call waiting for the user's confirmation. The nonce is stored
 * hashed. The arguments are kept as they will run (pins applied) and bound by
 * `args_hash`, so a confirm runs exactly what the card showed.
 */
export const aiPendingActions = pgTable(
  'ai_pending_actions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('aiPendingAction')),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    toolCallRowId: text('tool_call_row_id')
      .notNull()
      .references(() => aiToolCalls.id, { onDelete: 'cascade' }),
    /** The tool message whose result part the decision fills in. */
    toolMessageId: text('tool_message_id')
      .notNull()
      .references(() => aiMessages.id, { onDelete: 'cascade' }),
    toolCallId: varchar('tool_call_id', { length: 200 }).notNull(),
    operationId: varchar('operation_id', { length: 200 }).notNull(),
    args: jsonb('args').notNull(),
    argsHash: varchar('args_hash', { length: 64 }).notNull(),
    nonceHash: varchar('nonce_hash', { length: 64 }).notNull(),
    /** pending, confirmed, rejected, expired, superseded. */
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ai_pending_actions_conversation').on(table.conversationId, table.status),
    check(
      'ai_pending_actions_status_check',
      sql`${table.status} IN ('pending', 'confirmed', 'rejected', 'expired', 'superseded')`,
    ),
  ],
);
