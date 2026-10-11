// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * MCP limits per API key:
 * `ai.mcp.rateLimitPerMinute` and
 * `ai.mcp.dailyCallsPerKey`, as shared Redis counters
 * `ai:rl:mcp:<keyId>:m:<minute>` and `ai:rl:mcp:<keyId>:d:<UTC day>`, so every
 * API pod counts the same windows. Every POST to `/v1/mcp` counts once. The
 * injected tool requests a call makes are not counted again (the per-key API
 * limiter skips them, `plugins/auth.ts`).
 *
 * A Redis failure does not block the request (logged, fail-open), like the
 * chat limits: the per-key API limiter on the POST itself still applies.
 */

import type { Redis } from 'ioredis';
import { createLogger, createRedisClient } from '@evtivity/lib';
import type { AiMcpSettings } from '@evtivity/lib/ai-config';
import { config } from '../../../lib/config.js';
import { AI_RATE_LIMIT_KEY_PREFIX, redisCounterStore } from '../engine/limits.js';
import type { AiCounterStore } from '../engine/limits.js';

const logger = createLogger('ai-mcp-limits');

let redis: Redis | null = null;

function redisClient(): Redis {
  if (redis == null) {
    redis = createRedisClient(config.REDIS_URL, 'ai-mcp-limits', { maxRetriesPerRequest: 2 });
  }
  return redis;
}

const redisStore = redisCounterStore(redisClient);
let store: AiCounterStore = redisStore;

/** Tests replace the store; null restores Redis. */
export function setMcpCounterStore(next: AiCounterStore | null): void {
  store = next ?? redisStore;
}

const MINUTE_SECONDS = 60;
const DAY_SECONDS = 86_400;

export interface McpRateLimitRefusal {
  code: 'AI_MCP_RATE_LIMITED';
  scope: 'minute' | 'day';
  retryAfterSeconds: number;
}

/** Counts one MCP request of the key. Null when it may run, else the refusal (429). */
export async function checkMcpRateLimit(input: {
  apiKeyId: string;
  settings: Pick<AiMcpSettings, 'rateLimitPerMinute' | 'dailyCallsPerKey'>;
  now?: Date;
}): Promise<McpRateLimitRefusal | null> {
  const now = input.now ?? new Date();
  const seconds = Math.floor(now.getTime() / 1000);
  const prefix = `${AI_RATE_LIMIT_KEY_PREFIX}mcp:${input.apiKeyId}`;
  try {
    const minute = await store.increment(
      `${prefix}:m:${String(Math.floor(seconds / MINUTE_SECONDS))}`,
      MINUTE_SECONDS,
    );
    if (minute > input.settings.rateLimitPerMinute) {
      return {
        code: 'AI_MCP_RATE_LIMITED',
        scope: 'minute',
        retryAfterSeconds: MINUTE_SECONDS - (seconds % MINUTE_SECONDS),
      };
    }
    const day = await store.increment(
      `${prefix}:d:${now.toISOString().slice(0, 10)}`,
      DAY_SECONDS + MINUTE_SECONDS,
    );
    if (day > input.settings.dailyCallsPerKey) {
      return {
        code: 'AI_MCP_RATE_LIMITED',
        scope: 'day',
        retryAfterSeconds: DAY_SECONDS - (seconds % DAY_SECONDS),
      };
    }
  } catch (err) {
    logger.warn({ err, apiKeyId: input.apiKeyId }, 'MCP rate limit counter failed, the call runs');
  }
  return null;
}
