// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The MCP server behind `POST /v1/mcp`, on
 * `@modelcontextprotocol/server` 2.3.x. Stateless: `createMcpHandler` builds a
 * fresh server per HTTP request from one factory, which fits several API pods
 * without shared state. It serves protocol 2026-07-28 and, through the SDK's
 * stateless legacy fallback, 2025-era clients (decision D18): on the legacy
 * path no client capabilities reach the server, so a write answers
 * `pending_approval` instead of a URL elicitation.
 *
 * Only tools: `tools/list` (the request's toolsets, `ttlMs` 300000,
 * `cacheScope: private`) and `tools/call` (`tool-call.ts`). The server makes
 * no model calls: the client brings its own model.
 */

import type { FastifyInstance } from 'fastify';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  createMcpHandler,
  inputRequired,
} from '@modelcontextprotocol/server';
import type {
  AuthInfo,
  CallToolResult,
  InputRequiredResult,
  McpHttpHandler,
  McpRequestContext,
} from '@modelcontextprotocol/server';
import { createLogger } from '@evtivity/lib';
import type { Toolset } from '../tools/execute.js';
import { mcpToolList, mcpToolset } from './exposure.js';
import { clientInfoOf, newMcpCallId } from './mcp-call.service.js';
import { runMcpToolCall } from './tool-call.js';
import type { McpCaller, McpClientInfo, McpToolCallDeps } from './tool-call.js';

const logger = createLogger('ai-mcp');

/** The protocol revision whose requests carry client capabilities (MRTR). */
export const MCP_MODERN_PROTOCOL_VERSION = '2026-07-28';

/** `tools/list` cache hint. */
export const MCP_TOOLS_LIST_TTL_MS = 300_000;

/** What the route hands the per-request server, through `authInfo.extra`. */
export interface McpRequestAuth {
  caller: McpCaller;
  toolsets: readonly string[];
  /** The key may propose writes (`aiMcp:write` and `stations:read`); else write tools are not listed. */
  writes: boolean;
}

const AUTH_KEY = 'evtivityMcp';

/** The `authInfo` the route passes to `handler.fetch`. */
export function mcpAuthInfo(auth: McpRequestAuth): AuthInfo {
  return {
    // The key itself stays in the caller (in-process only); the SDK never needs it.
    token: 'api-key',
    clientId: auth.caller.apiKeyId,
    scopes: [],
    extra: { [AUTH_KEY]: auth },
  };
}

function authOf(ctx: McpRequestContext): McpRequestAuth {
  const auth = ctx.authInfo?.extra?.[AUTH_KEY] as McpRequestAuth | undefined;
  if (auth === undefined) throw new Error('MCP request without its caller');
  return auth;
}

/** Client name, version, protocol and URL elicitation support, from the request envelope. */
export function mcpClientInfo(
  envelope: Readonly<Record<string, unknown>> | undefined,
  negotiatedVersion: string | undefined,
): McpClientInfo {
  const info = clientInfoOf(envelope?.[CLIENT_INFO_META_KEY]);
  const protocol = envelope?.[PROTOCOL_VERSION_META_KEY];
  const protocolVersion =
    typeof protocol === 'string' ? protocol.slice(0, 20) : (negotiatedVersion ?? null);
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as
    | { elicitation?: { url?: unknown } }
    | undefined;
  const url = capabilities?.elicitation?.url;
  return {
    name: info.name,
    version: info.version,
    protocolVersion,
    urlElicitation:
      protocolVersion === MCP_MODERN_PROTOCOL_VERSION && typeof url === 'object' && url !== null,
  };
}

function toCallToolResult(
  server: McpServer,
  result: Awaited<ReturnType<typeof runMcpToolCall>>,
): CallToolResult | InputRequiredResult {
  if (result.kind === 'input_required') {
    return inputRequired({
      inputRequests: {
        approve: inputRequired.elicitUrl({ message: result.message, url: result.url }),
      },
      requestState: result.requestState,
    });
  }
  return server.server.projectCallToolResult(
    {
      content: result.content,
      structuredContent: result.structuredContent,
      ...(result.isError ? { isError: true } : {}),
    },
    undefined,
  );
}

function buildServer(deps: McpToolCallDeps, version: string, ctx: McpRequestContext): McpServer {
  const { caller, toolsets, writes } = authOf(ctx);
  const toolset: Toolset = mcpToolset(toolsets, undefined, { writes });
  const headerVersion = ctx.requestInfo?.headers.get('mcp-protocol-version') ?? null;
  const server = new McpServer(
    { name: 'evtivity-csms', version },
    {
      instructions:
        'EVtivity CSMS tools. Reads run with the API key user permissions and sites. Writes never run directly: each becomes a proposal the same user approves in EVtivity CSMS > AI Inbox.',
      cacheHints: { 'tools/list': { ttlMs: MCP_TOOLS_LIST_TTL_MS, cacheScope: 'private' } },
    },
  );
  server.server.registerCapabilities({ tools: { listChanged: false } });
  server.server.setRequestHandler('tools/list', () => ({ tools: mcpToolList(toolset) }));
  server.server.setRequestHandler('tools/call', async (request, callCtx) => {
    const envelope = callCtx.mcpReq.envelope as Readonly<Record<string, unknown>> | undefined;
    // A 2025-era request has no envelope: its version comes from the header.
    const client = mcpClientInfo(envelope, headerVersion ?? undefined);
    const args = request.params.arguments;
    const result = await runMcpToolCall(deps, caller, client, toolset, {
      name: request.params.name,
      args: args ?? {},
      requestState: callCtx.mcpReq.requestState(),
      signal: callCtx.mcpReq.signal,
      callId: newMcpCallId(),
    });
    return toCallToolResult(server, result);
  });
  return server;
}

/** The request handler: one per API process, a fresh server per request. */
export function createMcpRequestHandler(
  app: FastifyInstance,
  options: {
    secret: string;
    csmsUrl: string;
    version: string;
    proposalTtlMinutes: () => Promise<number>;
  },
): McpHttpHandler {
  const deps: McpToolCallDeps = {
    app,
    secret: options.secret,
    csmsUrl: options.csmsUrl,
    proposalTtlMinutes: options.proposalTtlMinutes,
    invalidRequestState: () =>
      new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid or expired requestState', {
        reason: 'invalid_request_state',
      }),
  };
  return createMcpHandler((ctx) => buildServer(deps, options.version, ctx), {
    legacy: 'stateless',
    responseMode: 'auto',
    onerror: (err) => {
      logger.info({ err }, 'MCP request refused or failed');
    },
  });
}
