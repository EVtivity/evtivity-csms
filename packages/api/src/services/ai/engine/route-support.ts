// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Pieces the AI routes share: the caller's authorization for tool calls, the
 * checks before a stream opens (configuration, adapter, limits), and opening
 * and closing the stream around a turn.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_MESSAGES } from '../../../lib/error-codes.generated.js';
import { openAiEventStream } from '../core/sse.js';
import type { AiEventStream } from '../core/sse.js';
import { AiNotConfiguredError, resolveSurfaceConfig } from '../surfaces/config.js';
import type { AiSurfaceConfig } from '../surfaces/config.js';
import { getAiSettings } from '@evtivity/database';
import type { AiLimits } from '@evtivity/lib/ai-config';
import type { AiSurface } from '../tools/policy.js';
import { claimTurn, releaseTurn } from '../conversation.service.js';
import { checkAiLimits } from './limits.js';
import { hasAiAdapter } from './providers.js';

/** The permission that lets an operator chat with the assistant. */
export const AI_ASSISTANT_PERMISSION = 'aiAssistant:write';
/** The permission that lets an operator see whether the assistant is available. */
export const AI_ASSISTANT_READ_PERMISSION = 'aiAssistant:read';

/**
 * The Authorization header tool calls run with: the request's own (a JWT or
 * an API key), or the CSMS session cookie as a bearer token. Tools then pass
 * the same authentication, RBAC and site scope as the user's own requests.
 */
export function callerAuthorization(request: FastifyRequest): string {
  const header = request.headers.authorization ?? '';
  if (header !== '') return header;
  const raw = request.cookies['csms_token'] ?? '';
  if (raw === '') return '';
  const unsigned = request.unsignCookie(raw);
  return `Bearer ${unsigned.valid ? unsigned.value : raw}`;
}

/**
 * Resolves the surface configuration, or replies 400 and returns null. A
 * provider without an adapter in this build counts as not configured.
 */
export async function surfaceConfigOrReply(
  surface: AiSurface,
  userId: string,
  reply: FastifyReply,
): Promise<AiSurfaceConfig | null> {
  try {
    const config = await resolveSurfaceConfig(surface, userId);
    if (!hasAiAdapter(config.provider)) throw new AiNotConfiguredError(surface);
    return config;
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      await reply.status(400).send({ error: ERROR_MESSAGES[err.code], code: err.code });
      return null;
    }
    throw err;
  }
}

/** Counts the turn against the AI limits, or replies 429 and returns null. */
export async function limitsOrReply(
  userId: string,
  siteId: string | null,
  reply: FastifyReply,
): Promise<AiLimits | null> {
  const { limits } = await getAiSettings();
  const refusal = await checkAiLimits({ userId, siteId, limits });
  if (refusal !== null) {
    await reply
      .status(429)
      .header('Retry-After', String(refusal.retryAfterSeconds))
      .send({ error: ERROR_MESSAGES[refusal.code], code: refusal.code });
    return null;
  }
  return limits;
}

/** Takes the conversation's turn lease, or replies 409 and returns false. */
export async function claimTurnOrReply(
  conversationId: string,
  reply: FastifyReply,
): Promise<boolean> {
  if (await claimTurn(conversationId)) return true;
  await reply
    .status(409)
    .send({ error: ERROR_MESSAGES.AI_CONVERSATION_BUSY, code: 'AI_CONVERSATION_BUSY' });
  return false;
}

/**
 * Hands the response over to a stream (the CORS and other headers already on
 * the reply are kept), runs `turn`, then releases the lease and ends the
 * stream whatever happened.
 */
export async function streamTurn(
  request: FastifyRequest,
  reply: FastifyReply,
  conversationId: string,
  config: AiSurfaceConfig,
  turn: (stream: AiEventStream) => Promise<unknown>,
): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (typeof value === 'string' || Array.isArray(value)) headers[name] = value;
    else if (typeof value === 'number') headers[name] = String(value);
  }
  reply.hijack();
  const stream = openAiEventStream(reply.raw, { headers });
  try {
    await turn(stream);
  } finally {
    try {
      await releaseTurn(conversationId, { provider: config.provider, model: config.model });
    } catch (err) {
      request.log.warn(
        { err, conversationId },
        'AI turn lease release failed, it expires on its own',
      );
    }
    stream.close();
  }
}
