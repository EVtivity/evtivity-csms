// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * MCP server endpoint: stateless
 * Streamable HTTP at `POST /v1/mcp` (protocol 2026-07-28, and 2025-era
 * clients through the SDK's stateless fallback). The checks run in this
 * order, before the MCP SDK sees the request:
 *
 * 1. `ai.mcp.enabled` off: 404 in Fastify's not-found shape, for every method.
 * 2. `Origin` present and not in `ai.mcp.allowedOrigins`: 403 `FORBIDDEN`.
 * 3. Only an API key (`Authorization: Bearer <64 hex>`) authenticates: a JWT,
 *    a cookie session or nothing answers 401 with `WWW-Authenticate: Bearer`.
 * 4. The key's scope must hold `aiMcp:read` (`AI_MCP_USE_PERMISSION`): 403.
 * 5. A JSON-RPC batch (an array body) answers 400 with a JSON-RPC -32600
 *    error and code `VALIDATION_ERROR`: the limits below count one POST, and
 *    the SDK's 2025-era fallback would run every message of a batch.
 * 6. Per-key limits (`ai.mcp.rateLimitPerMinute`, `ai.mcp.dailyCallsPerKey`):
 *    429 with a JSON-RPC error whose `data.code` is `AI_MCP_RATE_LIMITED`.
 * 7. `?toolsets=` names known categories, else 400 `VALIDATION_ERROR`.
 *
 * GET and DELETE answer 405 (no session stream, no session to delete).
 *
 * Write tools are listed and run only while `ai.mcp.allowWrites` is on and
 * the key holds `aiMcp:write`; they then run directly under the key's own
 * permissions and site scope.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getAiMcpSettings, isAiMcpEnabled } from '@evtivity/database';
import { AI_MCP_USE_PERMISSION } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES, ERROR_MESSAGES } from '../lib/error-codes.generated.js';
import { APP_VERSION } from '../lib/app-version.js';
import { requestHasPermission } from '../middleware/rbac.js';
import type { JwtPayload } from '../plugins/auth.js';
import { parseMcpToolsets } from '../services/ai/mcp/exposure.js';
import { checkMcpRateLimit } from '../services/ai/mcp/rate-limit.js';
import { createMcpRequestHandler, mcpAuthInfo } from '../services/ai/mcp/server.js';
import { AI_MCP_WRITE_PERMISSION } from '../services/ai/mcp/tool-call.js';
import type { McpCaller, McpWriteAccess } from '../services/ai/mcp/tool-call.js';

const API_KEY_HEADER = /^Bearer\s+([0-9a-f]{64})$/i;
const WWW_AUTHENTICATE = 'Bearer realm="evtivity-mcp"';

const querySchema = z.object({
  toolsets: z
    .string()
    .max(1000)
    .optional()
    .describe(
      'Comma-separated tool categories (OpenAPI tags in lower case with dashes, such as stations,sessions,ocpp-2-1-commands). Default: ai-insights, sessions, sites, stations, tokens',
    ),
});

const jsonRpcResponse = z
  .object({
    jsonrpc: z.literal('2.0').describe('JSON-RPC version'),
    id: z.unknown().describe('The id of the request this answers: a string, a number or null'),
    result: z
      .record(z.unknown())
      .optional()
      .describe('The MCP result (server/discover, tools/list, tools/call)'),
    error: z
      .object({
        code: z.number().int().describe('JSON-RPC error code'),
        message: z.string().describe('Error message'),
        data: z.unknown().optional().describe('Error detail'),
      })
      .passthrough()
      .optional()
      .describe('The JSON-RPC error, when the request failed'),
  })
  .passthrough();

const rateLimitedResponse = z
  .object({
    jsonrpc: z.literal('2.0').describe('JSON-RPC version'),
    id: z.unknown().describe('The id of the refused request: a string, a number or null'),
    error: z
      .object({
        code: z.number().int().describe('JSON-RPC error code (-32000)'),
        message: z.string().describe('Error message'),
        data: z
          .object({
            code: z.literal('AI_MCP_RATE_LIMITED').describe('EVtivity error code'),
            scope: z.enum(['minute', 'day']).describe('Which limit was reached'),
            retryAfterSeconds: z.number().int().describe('Seconds until the window resets'),
          })
          .passthrough()
          .describe('EVtivity detail'),
      })
      .passthrough()
      .describe('The JSON-RPC error'),
  })
  .passthrough()
  .describe('MCP rate limit of the API key reached');

const BATCH_REFUSED_MESSAGE =
  'JSON-RPC batch requests are not supported: send one message per POST';

const batchRefusedResponse = z
  .object({
    jsonrpc: z.literal('2.0').describe('JSON-RPC version'),
    id: z.unknown().describe('Always null: a batch has no single id'),
    error: z
      .object({
        code: z.literal(-32600).describe('JSON-RPC error code (-32600, invalid request)'),
        message: z.string().describe(`Error message. Default: "${BATCH_REFUSED_MESSAGE}"`),
        data: z
          .object({
            code: z.literal('VALIDATION_ERROR').describe('EVtivity error code'),
          })
          .passthrough()
          .describe('EVtivity detail'),
      })
      .passthrough()
      .describe('The JSON-RPC error'),
    code: z.literal('VALIDATION_ERROR').describe('EVtivity error code'),
  })
  .passthrough()
  .describe('A JSON-RPC batch (array body) was sent');

const unknownToolsetResponse = z
  .object({
    error: z.string().describe('Error message naming the unknown and the available toolsets'),
    code: z.literal('VALIDATION_ERROR').describe('Error code returned at this status'),
  })
  .passthrough()
  .describe('Unknown toolset');

function notFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  // The shape Fastify gives an unknown route: an MCP server that is off does not exist.
  return reply.status(404).send({
    message: `Route ${request.method}:${request.url} not found`,
    error: 'Not Found',
    statusCode: 404,
  });
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'VALIDATION_ERROR',
  message: string = ERROR_MESSAGES[code],
): FastifyReply {
  if (status === 401) void reply.header('WWW-Authenticate', WWW_AUTHENTICATE);
  return reply.status(status).send({ error: message, code });
}

/** `onRequest`: enabled, Origin, API key, scope. */
async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!(await isAiMcpEnabled())) {
    notFound(request, reply);
    return;
  }
  const origin = request.headers.origin;
  if (origin !== undefined) {
    const { allowedOrigins } = await getAiMcpSettings();
    // Compared as a normalized origin (scheme and host in lower case, default port dropped).
    if (!allowedOrigins.includes(URL.parse(origin)?.origin ?? '')) {
      sendError(reply, 403, 'FORBIDDEN', 'Origin not allowed');
      return;
    }
  }
  if (!API_KEY_HEADER.test(request.headers.authorization ?? '')) {
    sendError(reply, 401, 'UNAUTHORIZED', 'An API key is required');
    return;
  }
  // authenticate answers its own 401s; they carry the challenge too.
  void reply.header('WWW-Authenticate', WWW_AUTHENTICATE);
  await request.server.authenticate(request, reply);
  if (reply.sent) return;
  const user = request.user as JwtPayload;
  // A csms_token cookie can authenticate a request whose key is unknown: only keys count.
  if (user.isApiKey !== true || user.apiKeyId === undefined) {
    sendError(reply, 401, 'UNAUTHORIZED', 'An API key is required');
    return;
  }
  reply.removeHeader('WWW-Authenticate');
  if (!(await requestHasPermission(request, AI_MCP_USE_PERMISSION))) {
    sendError(reply, 403, 'FORBIDDEN', `The API key needs the ${AI_MCP_USE_PERMISSION} scope`);
  }
}

function jsonRpcId(body: unknown): string | number | null {
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/** Whether this request may list and run write tools. */
async function writeAccess(request: FastifyRequest, allowWrites: boolean): Promise<McpWriteAccess> {
  if (!allowWrites) return 'disabled';
  return (await requestHasPermission(request, AI_MCP_WRITE_PERMISSION)) ? 'allowed' : 'forbidden';
}

export function mcpRoutes(app: FastifyInstance): void {
  const handler = createMcpRequestHandler(app, { version: APP_VERSION });
  app.addHook('onClose', async () => {
    await handler.close();
  });

  app.post(
    '/mcp',
    {
      onRequest: [guard],
      schema: {
        tags: ['MCP'],
        summary: 'MCP server (Streamable HTTP)',
        description:
          'Model Context Protocol endpoint, stateless Streamable HTTP, protocol 2026-07-28 (2025-era clients are served statelessly). Authenticate with an API key whose scope holds aiMcp:read; JWTs and cookies are refused. Every tool runs as the key user with the same tool policy, redaction and site scope as the AI assistant. Write tools (OCPP station commands) are listed and run only while ai.mcp.allowWrites is true and the key holds aiMcp:write; they run directly, under the key permissions and sites, with no confirmation. Otherwise a call to one is refused (writes_disabled or forbidden). Off unless ai.mcp.enabled is true (404).',
        operationId: 'postMcp',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(querySchema),
        response: {
          200: zodSchema(jsonRpcResponse.describe('A JSON-RPC response, or an SSE stream')),
          400: zodSchema(
            z
              .union([unknownToolsetResponse, batchRefusedResponse])
              .describe('Unknown toolset, or a JSON-RPC batch (array body)'),
          ),
          401: errorWith('An API key is required', [ERROR_CODES.UNAUTHORIZED]),
          403: errorWith('Origin not allowed, or the key lacks aiMcp:read', [
            ERROR_CODES.FORBIDDEN,
          ]),
          429: zodSchema(rateLimitedResponse),
        },
      },
    },
    async (request, reply) => {
      // One POST counts once against the per-key limits, so it may carry one
      // message only: the SDK's 2025-era fallback runs every message of a batch.
      if (Array.isArray(request.body)) {
        return reply.status(400).send({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32600,
            message: BATCH_REFUSED_MESSAGE,
            data: { code: ERROR_CODES.VALIDATION_ERROR },
          },
          code: ERROR_CODES.VALIDATION_ERROR,
        });
      }
      const user = request.user as JwtPayload;
      const apiKeyId = user.apiKeyId ?? '';
      const settings = await getAiMcpSettings();
      const refusal = await checkMcpRateLimit({ apiKeyId, settings });
      if (refusal !== null) {
        return reply
          .status(429)
          .header('Retry-After', String(refusal.retryAfterSeconds))
          .send({
            jsonrpc: '2.0',
            id: jsonRpcId(request.body),
            error: {
              code: -32000,
              message: ERROR_MESSAGES.AI_MCP_RATE_LIMITED,
              data: {
                code: refusal.code,
                scope: refusal.scope,
                retryAfterSeconds: refusal.retryAfterSeconds,
              },
            },
          });
      }
      const { toolsets } = request.query as z.infer<typeof querySchema>;
      const parsed = parseMcpToolsets(toolsets);
      if (!parsed.ok) {
        return sendError(
          reply,
          400,
          'VALIDATION_ERROR',
          `Unknown toolsets: ${parsed.unknown.join(', ')}. Available: ${parsed.available.join(', ')}`,
        );
      }

      const caller: McpCaller = {
        userId: user.userId,
        apiKeyId,
        authorization: request.headers.authorization ?? '',
        hasPermission: (permission) => requestHasPermission(request, permission),
        log: request.log,
      };
      // Closing the response aborts the request: the SDK cancels the call
      // and the in-flight tool inject (TC-AI-MCP-16).
      const abort = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) abort.abort();
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || name === 'content-length' || name === 'host') continue;
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const response = await handler.fetch(
        new Request(`http://localhost${request.url}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(request.body ?? null),
          signal: abort.signal,
        }),
        {
          parsedBody: request.body,
          authInfo: mcpAuthInfo({
            caller,
            toolsets: parsed.toolsets,
            writes: await writeAccess(request, settings.allowWrites),
          }),
        },
      );
      if (response.headers.get('content-type')?.includes('text/event-stream') === true) {
        void reply.header('X-Accel-Buffering', 'no');
      }
      void reply.header('Cache-Control', 'no-store');
      return reply.send(response);
    },
  );

  // No session stream to open and no session to delete: the server is stateless.
  const methodNotAllowed = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await isAiMcpEnabled())) return notFound(request, reply);
    return reply
      .status(405)
      .header('Allow', 'POST')
      .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get('/mcp', { schema: { hide: true } }, methodNotAllowed);
  app.delete('/mcp', { schema: { hide: true } }, methodNotAllowed);
}
