// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * One MCP `tools/call`, under the same tool policy, argument checks,
 * redaction and site scope as the chat. Every call runs through
 * `runToolCall` as the API key's user (`app.inject` with `Bearer <key>`, so
 * the route applies its RBAC and site scope, exactly like an API call with
 * that key), redacted for the chatbot surface, in an AI tool call context
 * `{ channel: 'mcp', mcpCallId }`.
 *
 * A write runs only while `ai.mcp.allowWrites` is on and the key holds
 * `aiMcp:write`; then it runs directly, with no proposal and no
 * confirmation. Otherwise write tools are not listed and a call to one is
 * refused (`writes_disabled` or `forbidden`). The OCPP version is mapped
 * first, as in the chat.
 */

import type { FastifyInstance } from 'fastify';
import type { ServiceLogger } from '@evtivity/lib';
import { buildToolRequest, prepareToolCall, runToolCall } from '../tools/execute.js';
import type { PreparedToolCall, Toolset, ToolsetEntry } from '../tools/execute.js';
import { checkOcppCommandVersion } from '../tools/ocpp-command-check.js';
import { mcpOffers, toolPolicy } from '../tools/policy.js';
import { isMcpWriteTool } from './exposure.js';
import { recordMcpCall } from './mcp-call.service.js';
import type { McpCallRecord } from './mcp-call.service.js';

/** The scope a key needs to write (`aiMcp:read` only reads). */
export const AI_MCP_WRITE_PERMISSION = 'aiMcp:write';

/**
 * Whether the request may write: `allowed` (`ai.mcp.allowWrites` on and the
 * key holds `aiMcp:write`), `disabled` (the setting is off) or `forbidden`
 * (the key lacks `aiMcp:write`).
 */
export type McpWriteAccess = 'allowed' | 'disabled' | 'forbidden';

/** The API key and user an MCP request runs as. */
export interface McpCaller {
  userId: string;
  /** `refresh_tokens.id` of the key, as text. */
  apiKeyId: string;
  /** `Bearer <key>`: the injected tool requests authenticate with it. */
  authorization: string;
  hasPermission: (permission: string) => Promise<boolean>;
  log: ServiceLogger;
}

/** What the request tells about the client (from the `_meta` envelope). */
export interface McpClientInfo {
  name: string | null;
  version: string | null;
  protocolVersion: string | null;
}

export interface McpToolCallDeps {
  app: FastifyInstance;
  now?: () => Date;
}

export interface McpToolCallInput {
  name: string;
  args: Record<string, unknown>;
  signal: AbortSignal | undefined;
  /** Minted before the call, recorded as `via_ai.mcpCallId`. */
  callId: string;
}

export interface McpToolCallResult {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

function errorResult(code: string, message: string): McpToolCallResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { code, message },
    isError: true,
  };
}

type RecordCall = (
  status: McpCallRecord['status'],
  fields?: Partial<Omit<McpCallRecord, 'status'>>,
) => Promise<void>;

function callLog(
  caller: McpCaller,
  client: McpClientInfo,
  input: McpToolCallInput,
  started: number,
  now: () => Date,
): RecordCall {
  const base: McpCallRecord = {
    id: input.callId,
    apiKeyId: Number(caller.apiKeyId),
    userId: caller.userId,
    clientName: client.name,
    clientVersion: client.version,
    protocolVersion: client.protocolVersion,
    toolName: input.name,
    operationId: null,
    method: null,
    path: null,
    args: input.args,
    status: 'refused',
    httpStatus: null,
    errorCode: null,
    latencyMs: null,
    redactionCounts: null,
  };
  return (status, fields = {}) =>
    recordMcpCall({ ...base, latencyMs: now().getTime() - started, ...fields, status }, caller.log);
}

function operationFields(entry: ToolsetEntry, args: Record<string, unknown>) {
  const request = buildToolRequest(entry.tool, args);
  return { operationId: entry.tool.operationId, method: request.method, path: request.url };
}

/** Why a write tool is not in the request's toolset. */
function writeRefusal(name: string, writes: McpWriteAccess): McpToolCallResult | null {
  if (writes === 'allowed' || !isMcpWriteTool(name)) return null;
  if (writes === 'disabled') {
    return errorResult(
      'writes_disabled',
      `${name} is a write tool and MCP writes are turned off. An administrator turns them on in EVtivity CSMS > Settings > AI > MCP (Allow Writes).`,
    );
  }
  return errorResult(
    'forbidden',
    `${name} is a write tool: it needs an API key with the ${AI_MCP_WRITE_PERMISSION} scope.`,
  );
}

/** Runs one tool call. */
export async function runMcpToolCall(
  deps: McpToolCallDeps,
  caller: McpCaller,
  client: McpClientInfo,
  toolset: Toolset,
  writes: McpWriteAccess,
  input: McpToolCallInput,
): Promise<McpToolCallResult> {
  const now = deps.now ?? (() => new Date());
  const record = callLog(caller, client, input, now().getTime(), now);
  const entry = toolset.byName.get(input.name);
  if (entry === undefined || !mcpOffers(entry.tool.operationId)) {
    const refused = writeRefusal(input.name, writes);
    if (refused !== null) {
      await record('refused', { errorCode: refused.structuredContent['code'] as string });
      return refused;
    }
    await record('refused', { errorCode: 'unavailable' });
    return errorResult('unavailable', `Tool not available: ${input.name}`);
  }
  const write = toolPolicy(entry.tool.operationId).exposure === 'write';
  // The toolset lists no write without access; checked again here (P11).
  if (write && writes !== 'allowed') {
    const refused = writeRefusal(input.name, writes);
    await record('refused', { errorCode: refused?.structuredContent['code'] as string });
    return refused ?? errorResult('unavailable', `Tool not available: ${input.name}`);
  }

  const prepared = prepareToolCall(toolset, input.name, input.args);
  if (!prepared.ok) {
    await record('refused', { errorCode: prepared.refusal.reason });
    return errorResult(prepared.refusal.reason, prepared.refusal.modelText);
  }
  let call: Extract<PreparedToolCall, { ok: true }> = prepared;
  if (write) {
    // A 1.6 command for a 2.1 station (or the reverse) is mapped first, as in the chat.
    const checked = await checkOcppCommandVersion(
      { userId: caller.userId, hasPermission: caller.hasPermission },
      prepared,
    );
    if (!checked.ok) {
      await record('refused', { errorCode: checked.refusal.reason });
      return errorResult(checked.refusal.reason, checked.refusal.modelText);
    }
    if (!mcpOffers(checked.entry.tool.operationId)) {
      await record('refused', {
        ...operationFields(checked.entry, checked.args),
        errorCode: 'ocpp_version_mismatch',
      });
      return errorResult(
        'ocpp_version_mismatch',
        `The station's equivalent command ${checked.entry.tool.name} is not available over MCP.`,
      );
    }
    call = { ok: true, entry: checked.entry, args: checked.args };
  }

  const fields = operationFields(call.entry, call.args);
  let outcome: Awaited<ReturnType<typeof runToolCall>>;
  try {
    outcome = await runToolCall(
      deps.app,
      call,
      caller.authorization,
      {
        surface: 'chatbot',
        userId: caller.userId,
        via: { channel: 'mcp', mcpCallId: input.callId },
      },
      // A read stops when the client goes away. A write runs to its end, so
      // the route's answer and its audit rows are complete.
      !write && input.signal !== undefined ? { signal: input.signal } : {},
    );
  } catch (err) {
    // Recoverable: the client gets an error result (an aborted or failed inject).
    caller.log.warn({ err, tool: input.name, mcpCallId: input.callId }, 'MCP tool call failed');
    await record('error', { ...fields, errorCode: 'tool_failed' });
    return errorResult('tool_failed', 'The tool call failed.');
  }
  await record(outcome.status, {
    ...fields,
    httpStatus: outcome.httpStatus,
    redactionCounts: outcome.redactionCounts,
  });
  return {
    content: [{ type: 'text', text: outcome.content }],
    structuredContent: { httpStatus: outcome.httpStatus, data: outcome.value },
    isError: outcome.status === 'error',
  };
}
