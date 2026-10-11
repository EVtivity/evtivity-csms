// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * One MCP `tools/call`,
 * under the same tool policy, argument
 * checks, redaction and site scope as the chat:
 *
 * - A read runs through `runToolCall` as the API key's user (`app.inject`, so
 *   the route applies its RBAC and site scope), redacted for the chatbot
 *   surface, in an AI tool call context `{ channel: 'mcp', mcpCallId }`.
 * - A write never runs. After the argument and OCPP version checks it becomes
 *   an AI proposal that only the same user may approve, in the CSMS. A client
 *   that declares URL elicitation gets `input_required` with the approval URL
 *   and a sealed `requestState`; any other client gets `pending_approval` and
 *   polls `get_ai_proposal`.
 * - A retry with `requestState` reports the proposal's stored status. Its
 *   `inputResponses` never count: a form answer, or an "accept" of the URL
 *   elicitation, is not a confirmation (decision D7). An executed or failed
 *   proposal's result is returned once.
 */

import type { FastifyInstance } from 'fastify';
import { aiArgsHash } from '@evtivity/lib';
import type { ServiceLogger } from '@evtivity/lib';
import { and, eq } from 'drizzle-orm';
import { db, aiProposals, chargingStations } from '@evtivity/database';
import {
  AiProposalInputError,
  createAiProposal,
  getAiProposal,
} from '@evtivity/services/ai-proposal.service';
import type { AiProposalRow } from '@evtivity/services/ai-proposal.service';
import { aiProposalResultSchema } from '@evtivity/lib/ai-proposals';
import type { AiProposalResult } from '@evtivity/lib/ai-proposals';
import { frameUntrusted } from '@evtivity/ai/prompt';
import { getUserSiteIds } from '../../../lib/site-access.js';
import { siteInScope } from '../../../lib/site-scope.js';
import { buildToolRequest, prepareToolCall, runToolCall } from '../tools/execute.js';
import type { Toolset, ToolsetEntry } from '../tools/execute.js';
import { checkOcppCommandVersion } from '../tools/ocpp-command-check.js';
import { mcpOffers, toolPolicy } from '../tools/policy.js';
import { claimMcpDelivery, recordMcpCall } from './mcp-call.service.js';
import type { McpCallRecord } from './mcp-call.service.js';
import { APPROVE_IN, approvalMessage } from './messages.js';
import { sealMcpRequestState, verifyMcpRequestState } from './request-state.js';

/** The scope a key needs to propose a write (`aiMcp:read` only reads). */
export const AI_MCP_WRITE_PERMISSION = 'aiMcp:write';

/** How long after the proposal expiry a retry may still collect its result. */
export const MCP_RESULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The API key and user an MCP request runs as. */
export interface McpCaller {
  userId: string;
  /** `refresh_tokens.id` of the key, as text. */
  apiKeyId: string;
  /** `Bearer <key>`: the injected tool requests authenticate with it. */
  authorization: string;
  /** The user's CSMS language, for the approval message. */
  language: string;
  hasPermission: (permission: string) => Promise<boolean>;
  log: ServiceLogger;
}

/** What the request tells about the client (from the `_meta` envelope). */
export interface McpClientInfo {
  name: string | null;
  version: string | null;
  protocolVersion: string | null;
  /** The client declared `elicitation.url` on a 2026-07-28 request. */
  urlElicitation: boolean;
}

export interface McpToolCallDeps {
  app: FastifyInstance;
  /** `SETTINGS_ENCRYPTION_KEY`: the request state key derives from it. */
  secret: string;
  /** Base URL of the CSMS, for the approval link. */
  csmsUrl: string;
  proposalTtlMinutes: () => Promise<number>;
  now?: () => Date;
  /** Thrown for a request state that fails verification (the SDK's InvalidParams error). */
  invalidRequestState: () => Error;
}

export interface McpToolCallInput {
  name: string;
  args: Record<string, unknown>;
  /** The raw `requestState` of a retry, undefined on a first call. */
  requestState: unknown;
  signal: AbortSignal | undefined;
  /** Minted before the call, recorded as `via_ai.mcpCallId`. */
  callId: string;
}

export interface McpTextResult {
  kind: 'result';
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

export interface McpInputRequired {
  kind: 'input_required';
  url: string;
  message: string;
  requestState: string;
}

export type McpToolCallResult = McpTextResult | McpInputRequired;

function errorResult(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): McpTextResult {
  return {
    kind: 'result',
    content: [{ type: 'text', text: message }],
    structuredContent: { code, message, ...extra },
    isError: true,
  };
}

interface CallLog {
  record: (
    status: McpCallRecord['status'],
    fields?: Partial<Omit<McpCallRecord, 'status'>>,
  ) => Promise<void>;
  base: McpCallRecord;
}

function callLog(
  caller: McpCaller,
  client: McpClientInfo,
  input: McpToolCallInput,
  started: number,
  now: () => Date,
): CallLog {
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
    proposalId: null,
  };
  return {
    base,
    record: (status, fields = {}) =>
      recordMcpCall(
        { ...base, latencyMs: now().getTime() - started, ...fields, status },
        caller.log,
      ),
  };
}

function operationFields(entry: ToolsetEntry, args: Record<string, unknown>) {
  const request = buildToolRequest(entry.tool, args);
  return { operationId: entry.tool.operationId, method: request.method, path: request.url };
}

/** Runs one tool call. */
export async function runMcpToolCall(
  deps: McpToolCallDeps,
  caller: McpCaller,
  client: McpClientInfo,
  toolset: Toolset,
  input: McpToolCallInput,
): Promise<McpToolCallResult> {
  const now = deps.now ?? (() => new Date());
  const log = callLog(caller, client, input, now().getTime(), now);
  const entry = toolset.byName.get(input.name);
  if (entry === undefined || !mcpOffers(entry.tool.operationId)) {
    await log.record('refused', { errorCode: 'unavailable' });
    return errorResult('unavailable', `Tool not available: ${input.name}`);
  }
  if (toolPolicy(entry.tool.operationId).exposure === 'read') {
    return runRead(deps, caller, toolset, input, log);
  }
  // A write needs the key's write scope: aiMcp:read keys only read. Its
  // station lookup also needs stations:read, so a key without it learns
  // nothing about which stations exist.
  if (
    !(await caller.hasPermission(AI_MCP_WRITE_PERMISSION)) ||
    !(await caller.hasPermission('stations:read'))
  ) {
    await log.record('refused', { errorCode: 'forbidden' });
    return errorResult(
      'forbidden',
      `Proposing a write needs an API key with the ${AI_MCP_WRITE_PERMISSION} and stations:read scope.`,
    );
  }
  if (input.requestState !== undefined) {
    return retryWrite(deps, caller, client, input, log, now);
  }
  return proposeWrite(deps, caller, client, toolset, input, log, now);
}

async function runRead(
  deps: McpToolCallDeps,
  caller: McpCaller,
  toolset: Toolset,
  input: McpToolCallInput,
  log: CallLog,
): Promise<McpToolCallResult> {
  const prepared = prepareToolCall(toolset, input.name, input.args);
  if (!prepared.ok) {
    await log.record('refused', { errorCode: prepared.refusal.reason });
    return errorResult(prepared.refusal.reason, prepared.refusal.modelText);
  }
  const fields = operationFields(prepared.entry, prepared.args);
  let outcome: Awaited<ReturnType<typeof runToolCall>>;
  try {
    outcome = await runToolCall(
      deps.app,
      prepared,
      caller.authorization,
      {
        surface: 'chatbot',
        userId: caller.userId,
        via: { channel: 'mcp', mcpCallId: input.callId },
      },
      input.signal !== undefined ? { signal: input.signal } : {},
    );
  } catch (err) {
    // Recoverable: the client gets an error result (an aborted or failed inject).
    caller.log.warn({ err, tool: input.name, mcpCallId: input.callId }, 'MCP tool call failed');
    await log.record('error', { ...fields, errorCode: 'tool_failed' });
    return errorResult('tool_failed', 'The tool call failed.');
  }
  await log.record(outcome.status, {
    ...fields,
    httpStatus: outcome.httpStatus,
    redactionCounts: outcome.redactionCounts,
  });
  return {
    kind: 'result',
    content: [{ type: 'text', text: outcome.content }],
    structuredContent: { httpStatus: outcome.httpStatus, data: outcome.value },
    isError: outcome.status === 'error',
  };
}

interface ProposalStation {
  id: string;
  siteId: string | null;
}

/** The station a write names, by its OCPP identity, when the user's sites include it. */
async function proposalStation(userId: string, ocppId: string): Promise<ProposalStation | null> {
  const [station] = await db
    .select({ id: chargingStations.id, siteId: chargingStations.siteId })
    .from(chargingStations)
    .where(eq(chargingStations.stationId, ocppId));
  if (station === undefined) return null;
  return siteInScope(await getUserSiteIds(userId), station.siteId) ? station : null;
}

function approvalUrl(csmsUrl: string, proposalId: string): string {
  return `${csmsUrl.replace(/\/+$/, '')}/ai/inbox/${encodeURIComponent(proposalId)}`;
}

function pendingApproval(row: AiProposalRow, toolName: string): McpTextResult {
  const expiresAt = row.expiresAt.toISOString();
  return {
    kind: 'result',
    content: [
      {
        type: 'text',
        text: `Proposal ${row.id} (${toolName}) waits for approval in ${APPROVE_IN} until ${expiresAt}. It does not run until the user approves it there. Poll it with get_ai_proposal.`,
      },
    ],
    structuredContent: {
      status: 'pending_approval',
      proposalId: row.id,
      approveIn: APPROVE_IN,
      expiresAt,
    },
    isError: false,
  };
}

function inputRequiredFor(
  deps: McpToolCallDeps,
  caller: McpCaller,
  row: AiProposalRow,
  input: McpToolCallInput,
): McpInputRequired {
  const station = typeof row.args === 'object' && row.args !== null ? row.args : {};
  const stationId = (station as Record<string, unknown>)['stationId'];
  return {
    kind: 'input_required',
    url: approvalUrl(deps.csmsUrl, row.id),
    message: approvalMessage(
      caller.language,
      input.name,
      typeof stationId === 'string' ? stationId : '',
    ),
    requestState: sealMcpRequestState(
      {
        proposalId: row.id,
        userId: caller.userId,
        apiKeyId: caller.apiKeyId,
        toolName: input.name,
        argsHash: aiArgsHash(input.args),
        // A result approved just before the proposal expired can still be
        // collected for a day; the delivered claim keeps it single use.
        expiresAt: new Date(row.expiresAt.getTime() + MCP_RESULT_WINDOW_MS),
      },
      deps.secret,
    ),
  };
}

/** A write's first call: checks, then a new proposal. */
async function proposeWrite(
  deps: McpToolCallDeps,
  caller: McpCaller,
  client: McpClientInfo,
  toolset: Toolset,
  input: McpToolCallInput,
  log: CallLog,
  now: () => Date,
): Promise<McpToolCallResult> {
  const prepared = prepareToolCall(toolset, input.name, input.args);
  if (!prepared.ok) {
    await log.record('refused', { errorCode: prepared.refusal.reason });
    return errorResult(prepared.refusal.reason, prepared.refusal.modelText);
  }
  // The OCPP version is mapped before anything is proposed, as in the chat.
  const checked = await checkOcppCommandVersion(
    { userId: caller.userId, hasPermission: caller.hasPermission },
    prepared,
  );
  if (!checked.ok) {
    await log.record('refused', { errorCode: checked.refusal.reason });
    return errorResult(checked.refusal.reason, checked.refusal.modelText);
  }
  const fields = operationFields(checked.entry, checked.args);
  if (!mcpOffers(checked.entry.tool.operationId)) {
    await log.record('refused', { ...fields, errorCode: 'ocpp_version_mismatch' });
    return errorResult(
      'ocpp_version_mismatch',
      `The station's equivalent command ${checked.entry.tool.name} is not available over MCP.`,
    );
  }
  const ocppId = checked.args['stationId'];
  const station = typeof ocppId === 'string' ? await proposalStation(caller.userId, ocppId) : null;
  if (station === null || typeof ocppId !== 'string') {
    await log.record('refused', { ...fields, errorCode: 'station_not_found' });
    return errorResult(
      'station_not_found',
      `Station not found: ${typeof ocppId === 'string' ? ocppId : ''}`,
    );
  }
  const ttlMinutes = await deps.proposalTtlMinutes();
  // A client that resends the same call (a timeout) gets the open proposal,
  // not a second one that could run the command twice (P7).
  const dedupKey = `mcp:${caller.apiKeyId}:${fields.operationId}:${aiArgsHash(checked.args)}`;
  let row: AiProposalRow | null;
  try {
    row = await createAiProposal(
      {
        source: 'mcp',
        requestedByUserId: caller.userId,
        apiKeyId: Number(caller.apiKeyId),
        siteId: station.siteId,
        stationId: station.id,
        operationId: fields.operationId,
        method: fields.method,
        path: fields.path,
        args: checked.args,
        summary: {
          toolName: checked.entry.tool.name,
          stationId: ocppId,
          ...(checked.entry.tool.name !== input.name ? { requestedTool: input.name } : {}),
          ...(client.name !== null ? { clientName: client.name } : {}),
        },
        dedupKey,
        expiresAt: new Date(now().getTime() + ttlMinutes * 60_000),
        actor: {
          actor: 'api_key',
          actorUserId: caller.userId,
          actorApiKeyId: caller.apiKeyId,
        },
      },
      caller.log,
    );
  } catch (err) {
    if (!(err instanceof AiProposalInputError)) throw err;
    await log.record('refused', { ...fields, errorCode: 'invalid_arguments' });
    return errorResult('invalid_arguments', err.message);
  }
  row ??= await openProposal(caller.userId, dedupKey);
  if (row === null) throw new Error('An MCP proposal was neither created nor found open');
  await log.record('proposed', { ...fields, proposalId: row.id });
  if (client.urlElicitation) return inputRequiredFor(deps, caller, row, input);
  return pendingApproval(row, input.name);
}

/** The open proposal a resent call already made (same key, operation and arguments). */
async function openProposal(userId: string, dedupKey: string): Promise<AiProposalRow | null> {
  const [open] = await db
    .select({ id: aiProposals.id })
    .from(aiProposals)
    .where(and(eq(aiProposals.dedupKey, dedupKey), eq(aiProposals.status, 'pending')));
  if (open === undefined) return null;
  return getAiProposal({ userId, siteIds: await getUserSiteIds(userId) }, open.id);
}

function storedResult(row: AiProposalRow): AiProposalResult | null {
  const parsed = aiProposalResultSchema.safeParse(row.result);
  return parsed.success ? parsed.data : null;
}

function proposalResult(row: AiProposalRow, toolName: string): McpTextResult {
  const result = storedResult(row);
  const failed = row.status === 'failed';
  return {
    kind: 'result',
    content: [
      {
        type: 'text',
        text: frameUntrusted(
          'tool_result',
          toolName,
          `Proposal ${row.id} ${row.status}: HTTP ${String(result?.httpStatus ?? 0)}\n${JSON.stringify(result?.body ?? null)}`,
        ),
      },
    ],
    structuredContent: { status: row.status, proposalId: row.id, result },
    isError: failed,
  };
}

/** A retry of a write: what became of its proposal. */
async function retryWrite(
  deps: McpToolCallDeps,
  caller: McpCaller,
  client: McpClientInfo,
  input: McpToolCallInput,
  log: CallLog,
  now: () => Date,
): Promise<McpToolCallResult> {
  const verified = verifyMcpRequestState(
    input.requestState,
    {
      userId: caller.userId,
      apiKeyId: caller.apiKeyId,
      toolName: input.name,
      argsHash: aiArgsHash(input.args),
      now: now(),
    },
    deps.secret,
  );
  if (!verified.ok) {
    await log.record('refused', { errorCode: `request_state_${verified.reason}` });
    caller.log.info(
      { reason: verified.reason, mcpCallId: input.callId },
      'MCP request state refused',
    );
    throw deps.invalidRequestState();
  }
  const { proposalId } = verified.payload;
  const row = await getAiProposal(
    { userId: caller.userId, siteIds: await getUserSiteIds(caller.userId) },
    proposalId,
  );
  if (row === null || row.source !== 'mcp' || row.requestedByUserId !== caller.userId) {
    await log.record('decided', { errorCode: 'AI_PROPOSAL_NOT_FOUND' });
    return errorResult('AI_PROPOSAL_NOT_FOUND', 'Proposal not found', { proposalId });
  }
  const fields = { operationId: row.operationId, method: row.method, path: row.path };
  const decided = async (code: string, message: string): Promise<McpTextResult> => {
    await log.record('decided', { ...fields, proposalId: row.id, errorCode: code });
    return errorResult(code, message, { proposalId: row.id, status: row.status });
  };
  switch (row.status) {
    case 'pending': {
      if (row.decidedAt === null && row.expiresAt.getTime() <= now().getTime()) {
        return decided('AI_PROPOSAL_EXPIRED', 'The proposal expired before it was approved.');
      }
      await log.record('pending', { ...fields, proposalId: row.id });
      if (client.urlElicitation) return inputRequiredFor(deps, caller, row, input);
      return pendingApproval(row, input.name);
    }
    case 'executed':
    case 'failed': {
      const claimed = await claimMcpDelivery({
        ...log.base,
        ...fields,
        proposalId: row.id,
        status: 'delivered',
        httpStatus: storedResult(row)?.httpStatus ?? null,
        latencyMs: now().getTime() - row.createdAt.getTime(),
        redactionCounts: null,
      });
      if (!claimed) {
        return decided(
          'AI_PROPOSAL_ALREADY_DECIDED',
          'The result of this proposal was returned before.',
        );
      }
      return proposalResult(row, input.name);
    }
    case 'rejected':
      return decided('AI_PROPOSAL_ALREADY_DECIDED', 'The user rejected the proposal.');
    case 'expired':
      return decided('AI_PROPOSAL_EXPIRED', 'The proposal expired before it was approved.');
    case 'stale':
      return decided('AI_PROPOSAL_STALE', 'The proposal no longer applied when it was approved.');
    default:
      return decided('AI_PROPOSAL_ALREADY_DECIDED', 'The proposal was decided.');
  }
}
