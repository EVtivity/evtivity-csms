// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { OcppError } from '@evtivity/lib';
import { OcppErrorCode } from '../../protocol/error-codes.js';
import type { Middleware } from './pipeline.js';

const DEFAULT_MAX_MESSAGES_PER_SECOND = 50;
const WINDOW_MS = 1000;
const CLEANUP_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 300_000;

const stationCounters = new Map<string, { count: number; windowStart: number }>();

// Periodic cleanup of stale entries from disconnected stations
setInterval(() => {
  const now = Date.now();
  for (const [stationId, counter] of stationCounters) {
    if (now - counter.windowStart > STALE_THRESHOLD_MS) {
      stationCounters.delete(stationId);
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

export function createRateLimitMiddleware(
  maxPerSecond: number = DEFAULT_MAX_MESSAGES_PER_SECOND,
): Middleware {
  return async (ctx, next) => {
    const now = Date.now();
    let counter = stationCounters.get(ctx.stationId);

    if (counter == null || now - counter.windowStart >= WINDOW_MS) {
      counter = { count: 0, windowStart: now };
      stationCounters.set(ctx.stationId, counter);
    }

    counter.count++;

    if (counter.count > maxPerSecond) {
      ctx.logger.warn({ stationId: ctx.stationId, count: counter.count }, 'Rate limit exceeded');
      throw new OcppError(OcppErrorCode.GenericError, 'Rate limit exceeded');
    }

    await next();
  };
}
