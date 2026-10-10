// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * AI rate limits and the daily token budget. The per-minute limits are
 * shared Redis counters (every API pod counts the same window), keyed per
 * user and, for support assist, per site. The budget sums the tokens the
 * user's conversations used since midnight UTC, from the stored usage.
 *
 * A Redis failure does not block a turn (logged, fail-open): the budget,
 * the per-turn tool cap and the provider's own limits still apply.
 */

import type { Redis } from 'ioredis';
import { createLogger, createRedisClient } from '@evtivity/lib';
import { config } from '../../../lib/config.js';
import { tokensUsedSince } from '../conversation.service.js';
import type { AiLimits } from '@evtivity/lib/ai-config';

const logger = createLogger('ai-limits');

/** Counter store: increments a key and returns the new count; the key expires after the window. */
export interface AiCounterStore {
  increment(key: string, windowSeconds: number): Promise<number>;
}

let redis: Redis | null = null;

function redisClient(): Redis {
  if (redis == null) {
    redis = createRedisClient(config.REDIS_URL, 'ai-limits', { maxRetriesPerRequest: 2 });
  }
  return redis;
}

/**
 * Prefix of the per-minute counter keys. The api Redis user must hold
 * `~ai:rl:*` (docker/redis/acl-rules.conf), or every counter fails with
 * NOPERM and the limits never apply.
 */
export const AI_RATE_LIMIT_KEY_PREFIX = 'ai:rl:';

/** Counter store on a Redis client (MULTI INCR + EXPIRE NX). */
export function redisCounterStore(client: () => Redis): AiCounterStore {
  return {
    async increment(key, windowSeconds) {
      const result = await client().multi().incr(key).expire(key, windowSeconds, 'NX').exec();
      const [err, count] = result?.[0] ?? [new Error('Redis transaction was discarded'), null];
      if (err != null) throw err;
      if (typeof count !== 'number') throw new Error('Redis INCR returned no count');
      return count;
    },
  };
}

const redisStore = redisCounterStore(redisClient);

let store: AiCounterStore = redisStore;

/** Tests replace the store; null restores Redis. */
export function setAiCounterStore(next: AiCounterStore | null): void {
  store = next ?? redisStore;
}

const WINDOW_SECONDS = 60;

export type AiLimitRefusal =
  | { code: 'AI_RATE_LIMITED'; scope: 'user' | 'site'; retryAfterSeconds: number }
  | { code: 'AI_BUDGET_EXCEEDED'; retryAfterSeconds: number };

function windowKey(scope: string, id: string, now: Date): string {
  return `${AI_RATE_LIMIT_KEY_PREFIX}${scope}:${id}:${String(Math.floor(now.getTime() / 1000 / WINDOW_SECONDS))}`;
}

function secondsToWindowEnd(now: Date): number {
  return WINDOW_SECONDS - (Math.floor(now.getTime() / 1000) % WINDOW_SECONDS);
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Counts one turn against the limits. Null when the turn may run, else the
 * refusal (429). The budget is checked first, so a refused turn does not use
 * up the rate limit.
 */
export async function checkAiLimits(input: {
  userId: string;
  /** The case's site for support assist; null for the chatbot. */
  siteId: string | null;
  limits: AiLimits;
  now?: Date;
}): Promise<AiLimitRefusal | null> {
  const now = input.now ?? new Date();
  if (input.limits.userDailyTokens > 0) {
    const used = await tokensUsedSince(input.userId, startOfUtcDay(now));
    if (used >= input.limits.userDailyTokens) {
      const tomorrow = startOfUtcDay(new Date(now.getTime() + 86_400_000));
      return {
        code: 'AI_BUDGET_EXCEEDED',
        retryAfterSeconds: Math.ceil((tomorrow.getTime() - now.getTime()) / 1000),
      };
    }
  }
  try {
    if (input.limits.userPerMinute > 0) {
      const count = await store.increment(windowKey('user', input.userId, now), WINDOW_SECONDS);
      if (count > input.limits.userPerMinute) {
        return {
          code: 'AI_RATE_LIMITED',
          scope: 'user',
          retryAfterSeconds: secondsToWindowEnd(now),
        };
      }
    }
    if (input.siteId != null && input.limits.sitePerMinute > 0) {
      const count = await store.increment(windowKey('site', input.siteId, now), WINDOW_SECONDS);
      if (count > input.limits.sitePerMinute) {
        return {
          code: 'AI_RATE_LIMITED',
          scope: 'site',
          retryAfterSeconds: secondsToWindowEnd(now),
        };
      }
    }
  } catch (err) {
    logger.warn({ err, userId: input.userId }, 'AI rate limit counter failed, the turn runs');
  }
  return null;
}
