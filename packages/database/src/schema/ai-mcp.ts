// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  varchar,
  timestamp,
  index,
  integer,
  jsonb,
  check,
} from 'drizzle-orm/pg-core';
import { users, refreshTokens } from './identity.js';
import { createId } from '../lib/id.js';

/** Statuses of an MCP tool call (`ai_mcp_calls.status`). */
export const AI_MCP_CALL_STATUSES = [
  /** The tool ran and the route answered below 400. */
  'ok',
  /** The tool ran and the route answered 400 or above, or the call failed. */
  'error',
  /** Refused before anything ran: unknown tool, writes off, invalid arguments. */
  'refused',
] as const;
export type AiMcpCallStatus = (typeof AI_MCP_CALL_STATUSES)[number];

/**
 * One MCP `tools/call` (migration 0438), reads and writes. The single writer is
 * `packages/api/src/services/ai/mcp/mcp-call.service.ts` (P3). Client name and
 * version come from the request `_meta` and are untrusted. Pruned with
 * `ai.conversationRetentionDays`.
 */
export const aiMcpCalls = pgTable(
  'ai_mcp_calls',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('aiMcpCall')),
    apiKeyId: integer('api_key_id').references(() => refreshTokens.id, { onDelete: 'set null' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    clientName: varchar('client_name', { length: 100 }),
    clientVersion: varchar('client_version', { length: 50 }),
    protocolVersion: varchar('protocol_version', { length: 20 }),
    toolName: varchar('tool_name', { length: 200 }).notNull(),
    /** The operation that ran (after the OCPP version mapping), null when refused early. */
    operationId: varchar('operation_id', { length: 200 }),
    method: varchar('method', { length: 10 }),
    path: text('path'),
    /** The arguments as sent, redacted. */
    args: jsonb('args'),
    status: varchar('status', { length: 20 }).notNull(),
    httpStatus: integer('http_status'),
    /** Error code or refusal reason, when the call did not succeed. */
    errorCode: varchar('error_code', { length: 60 }),
    latencyMs: integer('latency_ms'),
    redactionCounts: jsonb('redaction_counts'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ai_mcp_calls_key_created').on(table.apiKeyId, table.createdAt),
    index('idx_ai_mcp_calls_created').on(table.createdAt),
    check('ai_mcp_calls_status_check', sql`${table.status} IN ('ok', 'error', 'refused')`),
  ],
);
