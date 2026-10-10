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
import { tryParseJson } from '@evtivity/lib';
import type { AiToolRefusalReason } from '@evtivity/lib/ai-stream';
import type { AiToolDefinition } from '../core/types.js';
import type { AiCatalogTool, AiToolMethod } from './catalog-types.js';
import type { AiSurface } from './policy.js';
import { redactToolText, redactToolValue } from './redact.js';
import type { RedactionCounts } from './redact.js';
import { dropStrictNulls } from './schema.js';
import { frameUntrusted } from '../engine/prompt.js';

// ---------------------------------------------------------------------------
// AI tool call context
// ---------------------------------------------------------------------------

export interface AiToolCallContext {
  conversationId: string;
  /** The `ai_tool_calls` row id. */
  toolCallRowId: string;
  surface: AiSurface;
  userId: string;
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
      runWithAuditViaAi(
        { conversationId: ctx.conversationId, toolCallId: ctx.toolCallRowId },
        done,
      );
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
  /** Redacted and framed as untrusted: what the model and the database get. */
  content: string;
  /** Redacted, short: what the client's tool step shows. */
  summary: string;
  redactionCounts: RedactionCounts;
  latencyMs: number;
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated: ${String(text.length - MAX_TOOL_RESULT_CHARS)} more characters]`
    : text;
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
): Promise<ToolOutcome> {
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
    });
  } finally {
    inFlight.delete(token);
  }
  const latencyMs = Math.round(performance.now() - started);
  const parsed = tryParseJson(response.body);
  let text: string;
  let counts: RedactionCounts;
  if (parsed !== undefined) {
    const redacted = redactToolValue(parsed, ctx.surface);
    text = JSON.stringify(redacted.value);
    counts = redacted.counts;
  } else {
    const redacted = redactToolText(response.body, ctx.surface);
    text = redacted.text;
    counts = redacted.counts;
  }
  const status = response.statusCode < 400 ? 'ok' : 'error';
  return {
    status,
    httpStatus: response.statusCode,
    content: frameUntrusted(
      'tool_result',
      call.entry.tool.name,
      truncate(`HTTP ${String(response.statusCode)}\n${text}`),
    ),
    summary: `${request.method} ${request.url} ${String(response.statusCode)}`,
    redactionCounts: counts,
    latencyMs,
  };
}
