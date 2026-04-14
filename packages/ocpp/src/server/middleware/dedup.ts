// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Middleware } from './pipeline.js';

const DEDUP_TTL_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

interface DeduplicatedMessage {
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
}

export function createDedupMiddleware(): Middleware {
  startCleanup();

  return async (ctx, next) => {
    let stationMessages = recentMessages.get(ctx.stationId);
    if (stationMessages == null) {
      stationMessages = new Map();
      recentMessages.set(ctx.stationId, stationMessages);
    }

    const cached = stationMessages.get(ctx.messageId);
    if (cached != null) {
      ctx.logger.warn(
        { stationId: ctx.stationId, messageId: ctx.messageId, action: ctx.action },
        'Duplicate message detected, returning cached response',
      );
      ctx.response = cached.response;
      return;
    }

    await next();

    if (ctx.response != null) {
      stationMessages.set(ctx.messageId, {
        response: ctx.response,
        timestamp: Date.now(),
      });
    }
  };
}

// For testing: clear all cached messages
export function clearDedupCache(): void {
  recentMessages.clear();
}
