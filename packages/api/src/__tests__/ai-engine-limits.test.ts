// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tokensUsedSince = vi.hoisted(() => vi.fn<(userId: string, since: Date) => Promise<number>>());
vi.mock('../services/ai/conversation.service.js', () => ({ tokensUsedSince }));

import type { Redis } from 'ioredis';
import {
  AI_RATE_LIMIT_KEY_PREFIX,
  checkAiLimits,
  redisCounterStore,
  setAiCounterStore,
} from '../services/ai/engine/limits.js';
import type { AiCounterStore } from '../services/ai/engine/limits.js';

const LIMITS = {
  userPerMinute: 2,
  sitePerMinute: 3,
  userDailyTokens: 1_000,
  maxToolCallsPerTurn: 20,
  conversationRetentionDays: 30,
  attachmentsMaxBytes: 1,
  attachmentsMaxPerMessage: 1,
};

function memoryStore(): AiCounterStore & { keys: Map<string, number> } {
  const keys = new Map<string, number>();
  return {
    keys,
    increment: async (key) => {
      const n = (keys.get(key) ?? 0) + 1;
      keys.set(key, n);
      return n;
    },
  };
}

const NOW = new Date('2026-10-09T12:00:30Z');

describe('AI limits', () => {
  let store: ReturnType<typeof memoryStore>;

  beforeEach(() => {
    store = memoryStore();
    setAiCounterStore(store);
    tokensUsedSince.mockReset().mockResolvedValue(0);
  });

  afterEach(() => {
    setAiCounterStore(null);
  });

  it('allows the per-user limit, then refuses with the seconds to the next window', async () => {
    const input = { userId: 'usr_1', siteId: null, limits: LIMITS, now: NOW };
    expect(await checkAiLimits(input)).toBeNull();
    expect(await checkAiLimits(input)).toBeNull();
    expect(await checkAiLimits(input)).toEqual({
      code: 'AI_RATE_LIMITED',
      scope: 'user',
      retryAfterSeconds: 30,
    });
    // Another user has its own counter.
    expect(await checkAiLimits({ ...input, userId: 'usr_2' })).toBeNull();
  });

  it('TC-AI-L-02 counts the site across users for support assist', async () => {
    const results = [];
    for (const userId of ['usr_1', 'usr_2', 'usr_3', 'usr_4']) {
      results.push(await checkAiLimits({ userId, siteId: 'sit_1', limits: LIMITS, now: NOW }));
    }
    expect(results.slice(0, 3)).toEqual([null, null, null]);
    expect(results[3]).toMatchObject({ code: 'AI_RATE_LIMITED', scope: 'site' });
  });

  it('TC-AI-L-03 refuses once the daily token budget is used, counting from midnight UTC', async () => {
    tokensUsedSince.mockResolvedValue(1_000);
    const refusal = await checkAiLimits({
      userId: 'usr_1',
      siteId: null,
      limits: LIMITS,
      now: NOW,
    });
    expect(refusal).toEqual({ code: 'AI_BUDGET_EXCEEDED', retryAfterSeconds: 12 * 3600 - 30 });
    expect(tokensUsedSince).toHaveBeenCalledWith('usr_1', new Date('2026-10-09T00:00:00Z'));
    // A refused turn does not use up the rate limit.
    expect(store.keys.size).toBe(0);
  });

  it('a budget of 0 means no budget', async () => {
    tokensUsedSince.mockResolvedValue(10_000_000);
    expect(
      await checkAiLimits({
        userId: 'usr_1',
        siteId: null,
        limits: { ...LIMITS, userDailyTokens: 0 },
        now: NOW,
      }),
    ).toBeNull();
    expect(tokensUsedSince).not.toHaveBeenCalled();
  });

  it('keys every counter under the ai:rl: prefix', async () => {
    await checkAiLimits({ userId: 'usr_1', siteId: 'sit_1', limits: LIMITS, now: NOW });
    expect([...store.keys.keys()]).toEqual([
      `${AI_RATE_LIMIT_KEY_PREFIX}user:usr_1:29859120`,
      `${AI_RATE_LIMIT_KEY_PREFIX}site:sit_1:29859120`,
    ]);
    expect(AI_RATE_LIMIT_KEY_PREFIX).toBe('ai:rl:');
  });

  it('lets the turn run when the counter store fails', async () => {
    setAiCounterStore({ increment: () => Promise.reject(new Error('redis down')) });
    expect(
      await checkAiLimits({ userId: 'usr_1', siteId: 'sit_1', limits: LIMITS, now: NOW }),
    ).toBeNull();
  });
});

describe('redisCounterStore', () => {
  function fakeRedis(exec: () => Promise<unknown>): () => Redis {
    const chain = {
      incr: () => chain,
      expire: () => chain,
      exec,
    };
    return () => ({ multi: () => chain }) as unknown as Redis;
  }

  it('returns the INCR count', async () => {
    const store = redisCounterStore(
      fakeRedis(() =>
        Promise.resolve([
          [null, 3],
          [null, 1],
        ]),
      ),
    );
    await expect(store.increment('ai:rl:user:u:1', 60)).resolves.toBe(3);
  });

  it('throws a per-command error instead of counting 0', async () => {
    const store = redisCounterStore(
      fakeRedis(() =>
        Promise.resolve([
          [new Error('NOPERM'), null],
          [null, 1],
        ]),
      ),
    );
    await expect(store.increment('ai:rl:user:u:1', 60)).rejects.toThrow('NOPERM');
  });

  it('throws when the transaction was discarded', async () => {
    const store = redisCounterStore(fakeRedis(() => Promise.resolve(null)));
    await expect(store.increment('ai:rl:user:u:1', 60)).rejects.toThrow('discarded');
  });
});
