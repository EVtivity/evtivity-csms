// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Tool execution. A model's tool call is checked against the turn's toolset
 * (unknown tools are refused), its pinned arguments are filled from the case,
 * its arguments are validated against the operation's schema, and only then
 * it runs through `app.inject` as the user: the route applies its own RBAC
 * and site scope with the caller's token.
 *
 * The injected request runs in an AI tool call context (AsyncLocalStorage),
 * so the audit rows its route writes record `via_ai` and the global rate
 * limiter leaves it to the AI limits. `app.inject` does not carry the
 * caller's async context into the request, so the context travels as a
 * single-use token in a header that the first onRequest hook
 * (`registerAiToolCallContext`) swaps for the context. The token is random,
 * lives only in this process while the inject runs, and is accepted only
 * from an injected request.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { runWithAuditViaAi } from '@evtivity/database';
import { aiArgsHash, tryParseJson } from '@evtivity/lib';
import type { AiToolRefusalReason } from '@evtivity/lib/ai-stream';
import type { AiAuditVia, AiProposalRefusalReason } from '@evtivity/lib/ai-proposals';
import type { AiToolDefinition } from '@evtivity/ai/core';
import { findCommandStation } from '../../../lib/command-station.js';
import type { CommandStation } from '../../../lib/command-station.js';
import type { AiCatalogTool, AiToolMethod } from './catalog-types.js';
import { AI_TOOL_CATALOG } from './catalog.js';
import { mapOcppCommand, toolOcppVersion } from './ocpp-version.js';
import type { OcppVersion } from './ocpp-version.js';
import { surfaceOffers, toolPolicy } from './policy.js';
import type { AiSurface } from './policy.js';
import { redactToolText, redactToolValue } from '@evtivity/ai/redact';
import type { AiSearchResult } from '@evtivity/ai/core';
import {
  DOCS_SEARCH_OPERATION_ID,
  docsSearchResponseIds,
  searchResultsForIds,
} from '../docs/docs-search.js';
import type { RedactionCounts } from '@evtivity/ai/redact';
import { dropStrictNulls } from './schema.js';
import { frameUntrusted } from '@evtivity/ai/prompt';

// ---------------------------------------------------------------------------
// AI tool call context
// ---------------------------------------------------------------------------

export interface AiToolCallContext {
  surface: AiSurface;
  /** The user the call runs as. */
  userId: string;
  /**
   * What the audit rows the injected route writes record as `via_ai`: the
   * chat tool call (`ai_tool_calls` row id), or the confirmed proposal.
   */
  via: AiAuditVia;
}

const toolCallStorage = new AsyncLocalStorage<AiToolCallContext>();

/** The AI tool call the current request runs for, if any. */
export function currentAiToolCall(): AiToolCallContext | undefined {
  return toolCallStorage.getStore();
}

/** True inside a request an AI tool call injected (the global rate limiter skips it). */
export function isAiToolRequest(): boolean {
  return toolCallStorage.getStore() !== undefined;
}

export const AI_TOOL_CALL_HEADER = 'x-evtivity-ai-tool-call';

/** Contexts of the tool calls being injected, by single-use token. */
const inFlight = new Map<string, AiToolCallContext>();

/**
 * Registers the onRequest hook that puts an injected tool call into its AI
 * context. Register it before every other global hook (the rate limiter
 * reads the context).
 */
export function registerAiToolCallContext(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    const token = request.headers[AI_TOOL_CALL_HEADER];
    const ctx = typeof token === 'string' ? inFlight.get(token) : undefined;
    // Injected requests come from light-my-request's 127.0.0.1 socket.
    if (ctx === undefined || request.ip !== '127.0.0.1') {
      done();
      return;
    }
    inFlight.delete(token as string);
    toolCallStorage.run(ctx, () => {
      runWithAuditViaAi(ctx.via, done);
    });
  });
}

// ---------------------------------------------------------------------------
// Toolset
// ---------------------------------------------------------------------------

/** One tool as a turn offers it. */
export interface ToolsetEntry {
  tool: AiCatalogTool;
  definition: AiToolDefinition;
  /** Arguments the server sets (support pins), overriding the model. */
  fixedArgs: Readonly<Record<string, string>>;
  /** Arguments limited to a set of values (the case's sessions). */
  allowedValues: Readonly<Record<string, readonly string[]>>;
  /** Arguments the model may never send (policy `omit`). */
  omitted: readonly string[];
}

export interface Toolset {
  definitions: AiToolDefinition[];
  byName: ReadonlyMap<string, ToolsetEntry>;
}

export function createToolset(entries: readonly ToolsetEntry[]): Toolset {
  const sorted = [...entries].sort((a, b) => a.tool.name.localeCompare(b.tool.name));
  return {
    definitions: sorted.map((e) => e.definition),
    byName: new Map(sorted.map((e) => [e.tool.name, e])),
  };
}

// ---------------------------------------------------------------------------
// Preparing a call
// ---------------------------------------------------------------------------

const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
const validators = new WeakMap<AiCatalogTool, ValidateFunction>();

function validatorFor(tool: AiCatalogTool): ValidateFunction {
  let validate = validators.get(tool);
  if (validate === undefined) {
    validate = ajv.compile(tool.validation);
    validators.set(tool, validate);
  }
  return validate;
}

/** A refused call: the reason the client localizes, the text the model gets. */
export interface AiToolRefusal {
  reason: AiToolRefusalReason;
  modelText: string;
}

export type PreparedToolCall =
  | { ok: true; entry: ToolsetEntry; args: Record<string, unknown> }
  | { ok: false; entry: ToolsetEntry | null; refusal: AiToolRefusal };

/**
 * Checks a model's tool call before anything runs (TC-AI-T-08, TC-AI-T-11):
 * the tool must be in the turn's toolset, pinned arguments are overwritten
 * with the case's values, constrained ones must be one of the allowed values,
 * omitted ones are refused, and the result must match the operation schema.
 */
export function prepareToolCall(
  toolset: Toolset,
  name: string,
  rawArgs: Record<string, unknown>,
): PreparedToolCall {
  const entry = toolset.byName.get(name);
  if (entry === undefined) {
    return {
      ok: false,
      entry: null,
      refusal: { reason: 'unavailable', modelText: `Tool not available: ${name}` },
    };
  }
  for (const key of entry.omitted) {
    if (key in rawArgs) {
      return {
        ok: false,
        entry,
        refusal: {
          reason: 'unavailable',
          modelText: `Argument '${key}' cannot be set by the assistant`,
        },
      };
    }
  }
  const args = dropStrictNulls(rawArgs, entry.tool.validation) as Record<string, unknown>;
  for (const [key, allowed] of Object.entries(entry.allowedValues)) {
    const value = args[key];
    if (typeof value !== 'string' || !allowed.includes(value)) {
      return {
        ok: false,
        entry,
        refusal: {
          reason: 'invalid_arguments',
          modelText: `Argument '${key}' must be one of: ${allowed.join(', ')}`,
        },
      };
    }
  }
  Object.assign(args, entry.fixedArgs);
  const validate = validatorFor(entry.tool);
  if (!validate(args)) {
    const first = validate.errors?.[0];
    const where =
      first?.instancePath !== undefined && first.instancePath !== ''
        ? first.instancePath
        : 'arguments';
    return {
      ok: false,
      entry,
      refusal: {
        reason: 'invalid_arguments',
        modelText: `Invalid arguments: ${where} ${first?.message ?? 'do not match the schema'}`,
      },
    };
  }
  // A dot segment would move the request to another route once the URL is
  // normalized (/v1/sites/../settings). encodeURIComponent keeps "." and "..".
  for (const key of entry.tool.pathParams) {
    const value = args[key];
    if (value === '.' || value === '..') {
      return {
        ok: false,
        entry,
        refusal: { reason: 'invalid_arguments', modelText: `Invalid path value for ${key}` },
      };
    }
  }
  return { ok: true, entry, args };
}

// ---------------------------------------------------------------------------
// Running a call
// ---------------------------------------------------------------------------

export interface ToolRequest {
  method: AiToolMethod;
  url: string;
  query: Record<string, string | string[]>;
  body?: Record<string, unknown>;
}

function queryValue(value: unknown): string | string[] {
  if (Array.isArray(value)) return value.map((v) => queryValue(v)).flat();
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

/** Path parameters into the path, query parameters into the query, the rest into the body. */
export function buildToolRequest(tool: AiCatalogTool, args: Record<string, unknown>): ToolRequest {
  let url = tool.pathTemplate;
  const query: Record<string, string | string[]> = {};
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (tool.pathParams.includes(key)) {
      url = url.replace(`{${key}}`, encodeURIComponent(String(queryValue(value))));
    } else if (tool.queryParams.includes(key)) {
      if (value !== null) query[key] = queryValue(value);
    } else if (tool.bodyParams.includes(key)) {
      body[key] = value;
    }
  }
  return tool.method === 'GET' || Object.keys(body).length === 0
    ? { method: tool.method, url, query }
    : { method: tool.method, url, query, body };
}

/** Upper bound of a tool result sent to the model, in characters. */
export const MAX_TOOL_RESULT_CHARS = 40_000;

export interface ToolOutcome {
  status: 'ok' | 'error';
  httpStatus: number;
  /** The response body, redacted for the surface: parsed JSON, or text (MCP structured content). */
  value: unknown;
  /** Redacted and framed as untrusted: what the model and the database get. */
  content: string;
  /** Redacted, short: what the client's tool step shows. */
  summary: string;
  redactionCounts: RedactionCounts;
  latencyMs: number;
  /**
   * `docs_search` only: the passages it returned, rebuilt from the docs
   * corpus. The model may cite them; the engine accepts no other id.
   */
  searchResults?: AiSearchResult[];
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated: ${String(text.length - MAX_TOOL_RESULT_CHARS)} more characters]`
    : text;
}

interface InjectedResult {
  httpStatus: number;
  /** The response body, redacted for the surface: parsed JSON, or text. */
  value: unknown;
  /** `value` as text (JSON when the body was JSON). */
  text: string;
  redactionCounts: RedactionCounts;
  latencyMs: number;
  request: ToolRequest;
}

/**
 * Runs a prepared call through `app.inject` with the given authorization,
 * inside the AI tool call context, and redacts the answer for the surface
 * before anything else sees it.
 */
async function injectToolCall(
  app: FastifyInstance,
  call: { entry: ToolsetEntry; args: Record<string, unknown> },
  authorization: string,
  ctx: AiToolCallContext,
  options: ToolCallOptions = {},
): Promise<InjectedResult> {
  const request = buildToolRequest(call.entry.tool, call.args);
  const started = performance.now();
  const token = randomBytes(24).toString('base64url');
  inFlight.set(token, ctx);
  let response: Awaited<ReturnType<FastifyInstance['inject']>>;
  try {
    response = await app.inject({
      method: request.method,
      url: request.url,
      query: request.query,
      headers: { authorization, [AI_TOOL_CALL_HEADER]: token },
      ...(request.body !== undefined ? { payload: request.body } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } finally {
    inFlight.delete(token);
  }
  const latencyMs = Math.round(performance.now() - started);
  const parsed = tryParseJson(response.body);
  if (parsed !== undefined) {
    const redacted = redactToolValue(parsed, ctx.surface);
    return {
      httpStatus: response.statusCode,
      value: redacted.value,
      text: JSON.stringify(redacted.value),
      redactionCounts: redacted.counts,
      latencyMs,
      request,
    };
  }
  const redacted = redactToolText(response.body, ctx.surface);
  return {
    httpStatus: response.statusCode,
    value: redacted.text,
    text: redacted.text,
    redactionCounts: redacted.counts,
    latencyMs,
    request,
  };
}

export interface ToolCallOptions {
  /** Aborts the injected request (an MCP client that closed its stream). */
  signal?: AbortSignal;
}

/**
 * Runs a prepared call through `app.inject` with the caller's authorization,
 * inside the AI tool call context. The result is redacted for the surface
 * before anything else sees it.
 */
export async function runToolCall(
  app: FastifyInstance,
  call: { entry: ToolsetEntry; args: Record<string, unknown> },
  authorization: string,
  ctx: AiToolCallContext,
  options: ToolCallOptions = {},
): Promise<ToolOutcome> {
  const result = await injectToolCall(app, call, authorization, ctx, options);
  const ok = result.httpStatus < 400;
  const searchResults =
    ok && call.entry.tool.operationId === DOCS_SEARCH_OPERATION_ID
      ? searchResultsForIds(docsSearchResponseIds(result.value))
      : [];
  return {
    status: ok ? 'ok' : 'error',
    httpStatus: result.httpStatus,
    value: result.value,
    content: frameUntrusted(
      'tool_result',
      call.entry.tool.name,
      truncate(`HTTP ${String(result.httpStatus)}\n${result.text}`),
    ),
    summary: `${result.request.method} ${result.request.url} ${String(result.httpStatus)}`,
    redactionCounts: result.redactionCounts,
    latencyMs: result.latencyMs,
    ...(searchResults.length > 0 ? { searchResults } : {}),
  };
}

// ---------------------------------------------------------------------------
// Running a confirmed call (AI proposals, MCP)
// ---------------------------------------------------------------------------

/** Upper bound of the response excerpt a confirmed call keeps, in characters. */
export const MAX_CONFIRMED_RESULT_CHARS = 4_000;

/** The user who confirmed the call, in an interactive session. */
export interface ConfirmingCaller {
  userId: string;
  /** The confirming request's own authorization (`callerAuthorization`). */
  authorization: string;
  hasPermission: (permission: string) => Promise<boolean>;
}

export interface ConfirmedToolCall {
  operationId: string;
  args: Record<string, unknown>;
  /** The hash stored when the call was proposed; the arguments must still match it. */
  argsHash: string;
  expiresAt: Date;
  /** What the audit rows of the route record: the proposal (or MCP call) and its confirmer. */
  via: AiAuditVia;
  /**
   * A narrower set than the policy (worker proposals: `AI_WORKER_ACTIONS`).
   * Checked on the call as proposed and again after the OCPP version mapping.
   */
  allowAction?: (operationId: string, args: Readonly<Record<string, unknown>>) => boolean;
  /** Re-checks the state the call was proposed for; false: the call is stale. */
  precondition?: () => Promise<boolean>;
}

/** The refusal reasons of a confirmed call (`AI_PROPOSAL_REFUSAL_REASONS`). */
export type ConfirmedRefusalReason = AiProposalRefusalReason;

export type ConfirmedToolCallResult =
  | { kind: 'expired' }
  | { kind: 'stale' }
  /** A code only: the caller logs it and the CSMS localizes it. */
  | { kind: 'refused'; reason: ConfirmedRefusalReason }
  | {
      kind: 'ran';
      /** The operation that ran (after the OCPP version mapping). */
      operationId: string;
      args: Record<string, unknown>;
      httpStatus: number;
      /** The route's answer, redacted, cut to `MAX_CONFIRMED_RESULT_CHARS`. */
      body: unknown;
      redactionCounts: RedactionCounts;
      latencyMs: number;
    };

export interface ConfirmedToolCallDeps {
  now?: () => Date;
  findStation?: (userId: string, ocppStationId: string) => Promise<CommandStation | null>;
}

/** The catalog entry of a write the chatbot may still run, or null. */
function confirmableEntry(operationId: string): ToolsetEntry | null {
  const tool = AI_TOOL_CATALOG.find((t) => t.operationId === operationId);
  if (tool === undefined) return null;
  const policy = toolPolicy(operationId);
  if (policy.exposure !== 'write' || !surfaceOffers(policy, 'chatbot')) return null;
  return {
    tool,
    definition: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    },
    fixedArgs: {},
    allowedValues: {},
    omitted: policy.omit,
  };
}

function isOcppVersion(value: string | null): value is OcppVersion {
  return value === 'ocpp1.6' || value === 'ocpp2.1';
}

function excerpt(value: unknown, text: string): unknown {
  return text.length > MAX_CONFIRMED_RESULT_CHARS
    ? `${text.slice(0, MAX_CONFIRMED_RESULT_CHARS)} [truncated]`
    : value;
}

/**
 * Runs a write that a human confirmed outside the chat (an AI proposal, or an
 * MCP call approved in the CSMS), as the confirming user. Nothing runs unless
 * every check passes, in this order:
 *
 * 1. TTL: at or past `expiresAt` the call is `expired`.
 * 2. The arguments still hash to the stored `argsHash`.
 * 3. The operation is still a policy `write` the chatbot offers, and inside
 *    `allowAction` when given.
 * 4. The precondition still holds (else `stale`).
 * 5. The OCPP version is mapped again for the station as it is now
 *    (`mapOcppCommand`, the station looked up as the confirming user): a
 *    station that changed version gets the equivalent command, or a refusal
 *    when there is none. An unknown or foreign station runs unchanged and the
 *    route answers it (404).
 * 6. The arguments match the operation's schema (`prepareToolCall`).
 *
 * The call then runs through `app.inject` with the confirming user's own
 * authorization, so the route applies its RBAC and site scope at confirm
 * time, and every audit row it writes records `via`.
 */
export async function executeConfirmedToolCall(
  app: FastifyInstance,
  caller: ConfirmingCaller,
  call: ConfirmedToolCall,
  deps: ConfirmedToolCallDeps = {},
): Promise<ConfirmedToolCallResult> {
  const now = deps.now?.() ?? new Date();
  if (now.getTime() >= call.expiresAt.getTime()) return { kind: 'expired' };
  if (aiArgsHash(call.args) !== call.argsHash) {
    return { kind: 'refused', reason: 'args_mismatch' };
  }
  const allowed = (operationId: string, args: Record<string, unknown>): boolean =>
    call.allowAction === undefined || call.allowAction(operationId, args);
  let entry = confirmableEntry(call.operationId);
  if (entry === null || !allowed(call.operationId, call.args)) {
    return { kind: 'refused', reason: 'no_longer_available' };
  }
  if (call.precondition !== undefined && !(await call.precondition())) return { kind: 'stale' };

  let args = call.args;
  const stationId = args['stationId'];
  if (
    toolOcppVersion(entry.tool) !== null &&
    typeof stationId === 'string' &&
    (await caller.hasPermission('stations:read'))
  ) {
    const station = await (deps.findStation ?? findCommandStation)(caller.userId, stationId);
    if (station !== null && isOcppVersion(station.ocppProtocol)) {
      const mapping = mapOcppCommand(entry.tool, args, station.ocppProtocol);
      if (mapping.kind === 'unsupported') {
        return { kind: 'refused', reason: 'ocpp_version_mismatch' };
      }
      if (mapping.kind === 'mapped') {
        const target = confirmableEntry(mapping.operationId);
        if (target === null || !allowed(mapping.operationId, mapping.args)) {
          return { kind: 'refused', reason: 'ocpp_version_mismatch' };
        }
        entry = target;
        args = mapping.args;
      }
    }
  }

  const prepared = prepareToolCall(createToolset([entry]), entry.tool.name, args);
  if (!prepared.ok) {
    return { kind: 'refused', reason: 'invalid_arguments' };
  }
  const result = await injectToolCall(app, prepared, caller.authorization, {
    surface: 'chatbot',
    userId: caller.userId,
    via: call.via,
  });
  return {
    kind: 'ran',
    operationId: prepared.entry.tool.operationId,
    args: prepared.args,
    httpStatus: result.httpStatus,
    body: excerpt(result.value, result.text),
    redactionCounts: result.redactionCounts,
    latencyMs: result.latencyMs,
  };
}
