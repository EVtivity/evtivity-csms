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
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users, refreshTokens } from './identity.js';
import { aiProposals } from './ai-proposals.js';
import { createId } from '../lib/id.js';

/** Statuses of an MCP tool call (`ai_mcp_calls.status`). */
export const AI_MCP_CALL_STATUSES = [
  /** A read ran and the route answered below 400. */
  'ok',
  /** A read ran and the route answered 400 or above, or the call failed. */
  'error',
  /** Refused before anything ran: unknown tool, invalid arguments, station not found. */
  'refused',
  /** A write became a new proposal. */
  'proposed',
  /** A retry of a write whose proposal is still pending. */
  'pending',
  /** A retry that returned the result of the executed (or failed) proposal, once. */
  'delivered',
  /** A retry of a proposal that was rejected, expired, stale, or whose result was returned before. */
  'decided',
] as const;
export type AiMcpCallStatus = (typeof AI_MCP_CALL_STATUSES)[number];

/**
 * One MCP `tools/call` (migration 0438). The single writer is
 * `packages/api/src/services/ai/mcp/mcp-call.service.ts` (P3). Client name and
 * version come from the request `_meta` and are untrusted. A `delivered` row
 * is unique per proposal: it is the claim that returns a proposal's result to
 * the MCP client once. Pruned with `ai.conversationRetentionDays`.
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
    /** The operation that ran or was proposed (after the OCPP version mapping), null when refused early. */
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
    proposalId: text('proposal_id').references(() => aiProposals.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ai_mcp_calls_key_created').on(table.apiKeyId, table.createdAt),
    index('idx_ai_mcp_calls_created').on(table.createdAt),
    index('idx_ai_mcp_calls_proposal').on(table.proposalId),
    uniqueIndex('uq_ai_mcp_calls_delivered_proposal')
      .on(table.proposalId)
      .where(sql`${table.status} = 'delivered'`),
    check(
      'ai_mcp_calls_status_check',
      sql`${table.status} IN ('ok', 'error', 'refused', 'proposed', 'pending', 'delivered', 'decided')`,
    ),
  ],
);
