// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';
import type { Middleware } from './pipeline.js';

const DEDUP_TTL_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
// Cached responses kept per station. The oldest is dropped first, so a station
// sending many distinct ids cannot grow the cache without bound.
export const MAX_DEDUP_ENTRIES_PER_STATION = 1000;

interface DeduplicatedMessage {
  action: string;
  payloadHash: string;
  response: Record<string, unknown>;
  timestamp: number;
}

// Map of stationId -> Map of messageId -> cached response
const recentMessages = new Map<string, Map<string, DeduplicatedMessage>>();

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup(): void {
  if (cleanupTimer != null) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [stationId, messages] of recentMessages) {
      for (const [messageId, entry] of messages) {
        if (now - entry.timestamp > DEDUP_TTL_MS) {
          messages.delete(messageId);
        }
      }
      if (messages.size === 0) {
        recentMessages.delete(stationId);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

// The OCPP server refuses a CALL without a payload element and frames nested
// past its depth limit before the pipeline runs, so the payload is a JSON
// value that serializes safely here.
function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('base64');
}

/**
 * Answers a retransmitted CALL (same station, message id, action and payload)
 * with the response already sent, without running the handler again. A reused
 * message id with another action or payload is a new message.
 */
export function createDedupMiddleware(): Middleware {
  startCleanup();

  return async (ctx, next) => {
    let stationMessages = recentMessages.get(ctx.stationId);
    if (stationMessages == null) {
      stationMessages = new Map();
      recentMessages.set(ctx.stationId, stationMessages);
    }

    const payloadHash = hashPayload(ctx.payload);
    const cached = stationMessages.get(ctx.messageId);
    if (cached != null) {
      if (cached.action === ctx.action && cached.payloadHash === payloadHash) {
        ctx.logger.warn(
          { stationId: ctx.stationId, messageId: ctx.messageId, action: ctx.action },
          'Duplicate message detected, returning cached response',
        );
        ctx.response = cached.response;
        return;
      }
      ctx.logger.warn(
        {
          stationId: ctx.stationId,
          messageId: ctx.messageId,
          action: ctx.action,
          cachedAction: cached.action,
        },
        'Message id reused for a different message, processing it as new',
      );
    }

    await next();

    if (ctx.response != null) {
      // Re-insert so the entry moves to the end of the eviction order.
      stationMessages.delete(ctx.messageId);
      stationMessages.set(ctx.messageId, {
        action: ctx.action,
        payloadHash,
        response: ctx.response,
        timestamp: Date.now(),
      });
      while (stationMessages.size > MAX_DEDUP_ENTRIES_PER_STATION) {
        const oldest = stationMessages.keys().next();
        if (oldest.done === true) break;
        stationMessages.delete(oldest.value);
      }
    }
  };
}

// For testing: clear all cached messages
export function clearDedupCache(): void {
  recentMessages.clear();
}
