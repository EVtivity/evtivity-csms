// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * AI rate limits and token budgets of an interactive turn. The budgets
 * (company and site monthly, user daily) come from the usage ledger through
 * `checkAiBudgets` (`@evtivity/database`) and fail closed. The per-minute
 * limits are shared Redis counters (every API pod counts the same window),
 * keyed per user and, for support assist, per site.
 *
 * A Redis failure does not block a turn (logged, fail-open): the budgets,
 * the per-turn tool cap and the provider's own limits still apply.
 */

import type { Redis } from 'ioredis';
import { checkAiBudgets } from '@evtivity/database';
import { createLogger, createRedisClient } from '@evtivity/lib';
import type { AiLimits } from '@evtivity/lib/ai-config';
import type { AiBudgetRefusalCode, AiBudgetScope } from '@evtivity/lib/ai-usage';
import { config } from '../../../lib/config.js';

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
  | { code: AiBudgetRefusalCode; scope: AiBudgetScope; retryAfterSeconds: number };

function windowKey(scope: string, id: string, now: Date): string {
  return `${AI_RATE_LIMIT_KEY_PREFIX}${scope}:${id}:${String(Math.floor(now.getTime() / 1000 / WINDOW_SECONDS))}`;
}

function secondsToWindowEnd(now: Date): number {
  return WINDOW_SECONDS - (Math.floor(now.getTime() / 1000) % WINDOW_SECONDS);
}

/**
 * Counts one driver AI case against `ai.rateLimit.driverPerMinute` (key
 * `ai:rl:driver:<driverId>:<window>`, plan v0.1.45 section 2.7). True when the
 * case may be analyzed. A limit of 0 or below never refuses. A Redis failure
 * allows it (logged, fail-open): the daily case cap and the token budgets
 * still apply in the worker.
 */
export async function allowDriverAiCase(
  driverId: string,
  perMinute: number,
  now: Date = new Date(),
): Promise<boolean> {
  if (perMinute <= 0) return true;
  try {
    const count = await store.increment(windowKey('driver', driverId, now), WINDOW_SECONDS);
    return count <= perMinute;
  } catch (err) {
    logger.warn({ err, driverId }, 'Driver AI rate limit counter failed, the case is analyzed');
    return true;
  }
}

/**
 * Counts one turn against the limits. Null when the turn may run, else the
 * refusal (429). The budgets are checked first, so a refused turn does not
 * use up the rate limit. A budget read failure throws (fail closed).
 */
export async function checkAiLimits(input: {
  /** The interactive surface of the turn. */
  surface: 'chatbot' | 'support';
  userId: string;
  /** The case's site for support assist; null for the chatbot (charged to no site). */
  siteId: string | null;
  limits: AiLimits;
  now?: Date;
}): Promise<AiLimitRefusal | null> {
  const now = input.now ?? new Date();
  const budget = await checkAiBudgets({
    surface: input.surface,
    userId: input.userId,
    siteId: input.siteId,
    now,
  });
  if (!budget.allowed) {
    return { code: budget.code, scope: budget.scope, retryAfterSeconds: budget.retryAfterSeconds };
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
