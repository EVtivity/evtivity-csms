// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The MCP tool call log (`ai_mcp_calls`, migration 0438). This service is
 * its only writer (P3). A log row is written after the call, fail-open: a
 * failed insert is logged at warn and the client still gets its answer (P9).
 * The `delivered` claim is the exception: it decides whether a proposal's
 * result may be returned, so it fails closed.
 */

import { generateId } from '@evtivity/lib';
import type { ServiceLogger } from '@evtivity/lib';
import { db, aiMcpCalls } from '@evtivity/database';
import type { AiMcpCallStatus } from '@evtivity/database';
import { redactToolValue } from '@evtivity/ai/redact';
import type { RedactionCounts } from '@evtivity/ai/redact';

const MAX_CLIENT_NAME = 100;
const MAX_CLIENT_VERSION = 50;

export interface McpCallRecord {
  /** Minted before the call runs, so the audit rows of the injected route name it. */
  id: string;
  apiKeyId: number;
  userId: string;
  clientName: string | null;
  clientVersion: string | null;
  protocolVersion: string | null;
  toolName: string;
  operationId: string | null;
  method: string | null;
  path: string | null;
  /** The arguments as sent; redacted before they are stored. */
  args: Record<string, unknown> | null;
  status: AiMcpCallStatus;
  httpStatus: number | null;
  errorCode: string | null;
  latencyMs: number | null;
  redactionCounts: RedactionCounts | null;
  proposalId: string | null;
}

/** A new call id (`amc_...`), for `via_ai.mcpCallId`. */
export function newMcpCallId(): string {
  return generateId('aiMcpCall');
}

/** Client name and version from `_meta` clientInfo: untrusted, cut to the column size. */
export function clientInfoOf(value: unknown): { name: string | null; version: string | null } {
  if (typeof value !== 'object' || value === null) return { name: null, version: null };
  const record = value as Record<string, unknown>;
  const name = typeof record['name'] === 'string' ? record['name'].slice(0, MAX_CLIENT_NAME) : null;
  const version =
    typeof record['version'] === 'string' ? record['version'].slice(0, MAX_CLIENT_VERSION) : null;
  return { name, version };
}

function rowOf(record: McpCallRecord) {
  return {
    id: record.id,
    apiKeyId: record.apiKeyId,
    userId: record.userId,
    clientName: record.clientName,
    clientVersion: record.clientVersion,
    protocolVersion: record.protocolVersion,
    toolName: record.toolName.slice(0, 200),
    operationId: record.operationId,
    method: record.method,
    path: record.path,
    args: record.args === null ? null : redactToolValue(record.args, 'chatbot').value,
    status: record.status,
    httpStatus: record.httpStatus,
    errorCode: record.errorCode,
    latencyMs: record.latencyMs,
    redactionCounts: record.redactionCounts,
    proposalId: record.proposalId,
  };
}

/** Writes the log row of a finished call. Fail-open (P9). */
export async function recordMcpCall(record: McpCallRecord, log: ServiceLogger): Promise<void> {
  try {
    await db.insert(aiMcpCalls).values(rowOf(record));
  } catch (err) {
    log.warn({ err, mcpCallId: record.id, toolName: record.toolName }, 'MCP call log write failed');
  }
}

/**
 * Claims the one return of a decided proposal's result: inserts the call
 * row as `delivered`. True when this call won the claim; false when the
 * result was returned before (the unique `delivered` row per proposal).
 * Fails closed: a database error throws and nothing is returned.
 */
export async function claimMcpDelivery(record: McpCallRecord): Promise<boolean> {
  if (record.proposalId === null) throw new Error('A delivery names its proposal');
  const rows = await db
    .insert(aiMcpCalls)
    .values({ ...rowOf(record), status: 'delivered' })
    .onConflictDoNothing()
    .returning({ id: aiMcpCalls.id });
  return rows.length > 0;
}
