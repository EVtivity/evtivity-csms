// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import rateLimit from '@fastify/rate-limit';
import { config } from '../lib/config.js';
import { isAiToolRequest } from '../services/ai/tools/execute.js';
import { routePath } from './encoded-path-guard.js';

/** Key prefix of the shared counters (the api Redis user holds `~rl:*`). */
export const RATE_LIMIT_KEY_PREFIX = 'rl:';

export interface RateLimitOptions {
  /**
   * Shared counter store. With it every API replica counts against one limit
   * per client; without it (unit tests) each process counts alone.
   */
  redis?: Redis;
}

export async function registerRateLimit(
  app: FastifyInstance,
  options: RateLimitOptions = {},
): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    ...(options.redis != null
      ? {
          redis: options.redis,
          nameSpace: RATE_LIMIT_KEY_PREFIX,
          // A Redis outage must not answer 500 to every request: the limit is
          // skipped (fail-open, P9) while the account lockouts in the database
          // still hold. The client logs the connection errors.
          skipOnError: true,
        }
      : {}),
    // AI tool calls are injected requests from 127.0.0.1: they would share
    // one bucket for every user. The AI limits count them instead (per user
    // and site per minute, and the per-turn tool call cap).
    allowList: (request) =>
      routePath(request).startsWith('/v1/ocpp/commands/') || isAiToolRequest(),
  });
}
