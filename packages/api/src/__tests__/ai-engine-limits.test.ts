// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const checkAiBudgets = vi.hoisted(() =>
  vi.fn<(input: AiBudgetCheckInput) => Promise<AiBudgetDecision>>(),
);
vi.mock('@evtivity/database', () => ({ checkAiBudgets }));

import type { Redis } from 'ioredis';
import type { AiBudgetCheckInput, AiBudgetDecision } from '@evtivity/lib/ai-usage';
import {
  AI_RATE_LIMIT_KEY_PREFIX,
  allowDriverAiCase,
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
  companyMonthlyTokens: 0,
  siteMonthlyTokens: 0,
  siteDailyTokens: 0,
  driverDailyTokens: 0,
  driverPerMinute: 2,
  budgetWarnPercent: 80,
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
    checkAiBudgets.mockReset().mockResolvedValue({ allowed: true });
  });

  afterEach(() => {
    setAiCounterStore(null);
  });

  it('allows the per-user limit, then refuses with the seconds to the next window', async () => {
    const input = {
      surface: 'chatbot' as const,
      userId: 'usr_1',
      siteId: null,
      limits: LIMITS,
      now: NOW,
    };
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
      results.push(
        await checkAiLimits({
          surface: 'support',
          userId,
          siteId: 'sit_1',
          limits: LIMITS,
          now: NOW,
        }),
      );
    }
    expect(results.slice(0, 3)).toEqual([null, null, null]);
    expect(results[3]).toMatchObject({ code: 'AI_RATE_LIMITED', scope: 'site' });
  });

  it('TC-AI-US-03 a budget refusal (here the user daily budget) is answered before any counter', async () => {
    checkAiBudgets.mockResolvedValue({
      allowed: false,
      code: 'AI_BUDGET_EXCEEDED',
      scope: 'user',
      period: 'day',
      retryAfterSeconds: 12 * 3600 - 30,
    });
    const refusal = await checkAiLimits({
      surface: 'chatbot',
      userId: 'usr_1',
      siteId: null,
      limits: LIMITS,
      now: NOW,
    });
    expect(refusal).toEqual({
      code: 'AI_BUDGET_EXCEEDED',
      scope: 'user',
      retryAfterSeconds: 12 * 3600 - 30,
    });
    expect(checkAiBudgets).toHaveBeenCalledWith({
      surface: 'chatbot',
      userId: 'usr_1',
      siteId: null,
      now: NOW,
    });
    // A refused turn does not use up the rate limit.
    expect(store.keys.size).toBe(0);
  });

  it('passes a monthly refusal through with its scope, and charges support to the case site', async () => {
    checkAiBudgets.mockResolvedValue({
      allowed: false,
      code: 'AI_MONTHLY_BUDGET_EXCEEDED',
      scope: 'site',
      period: 'month',
      retryAfterSeconds: 99,
    });
    const refusal = await checkAiLimits({
      surface: 'support',
      userId: 'usr_1',
      siteId: 'sit_1',
      limits: LIMITS,
      now: NOW,
    });
    expect(refusal).toEqual({
      code: 'AI_MONTHLY_BUDGET_EXCEEDED',
      scope: 'site',
      retryAfterSeconds: 99,
    });
    expect(checkAiBudgets.mock.calls[0]?.[0]).toMatchObject({
      surface: 'support',
      siteId: 'sit_1',
    });
  });

  it('fails closed when the budget check cannot read the ledger', async () => {
    checkAiBudgets.mockRejectedValue(new Error('db down'));
    await expect(
      checkAiLimits({
        surface: 'chatbot',
        userId: 'usr_1',
        siteId: null,
        limits: LIMITS,
        now: NOW,
      }),
    ).rejects.toThrow('db down');
    expect(store.keys.size).toBe(0);
  });

  it('keys every counter under the ai:rl: prefix', async () => {
    await checkAiLimits({
      surface: 'support',
      userId: 'usr_1',
      siteId: 'sit_1',
      limits: LIMITS,
      now: NOW,
    });
    expect([...store.keys.keys()]).toEqual([
      `${AI_RATE_LIMIT_KEY_PREFIX}user:usr_1:29859120`,
      `${AI_RATE_LIMIT_KEY_PREFIX}site:sit_1:29859120`,
    ]);
    expect(AI_RATE_LIMIT_KEY_PREFIX).toBe('ai:rl:');
  });

  it('lets the turn run when the counter store fails', async () => {
    setAiCounterStore({ increment: () => Promise.reject(new Error('redis down')) });
    expect(
      await checkAiLimits({
        surface: 'support',
        userId: 'usr_1',
        siteId: 'sit_1',
        limits: LIMITS,
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe('allowDriverAiCase', () => {
  afterEach(() => {
    setAiCounterStore(null);
  });

  it('TC-AI-DR-18 counts per driver per minute under ai:rl:driver:<id>:<window>', async () => {
    const store = memoryStore();
    setAiCounterStore(store);
    expect(await allowDriverAiCase('drv_1', 2, NOW)).toBe(true);
    expect(await allowDriverAiCase('drv_1', 2, NOW)).toBe(true);
    expect(await allowDriverAiCase('drv_1', 2, NOW)).toBe(false);
    expect(await allowDriverAiCase('drv_2', 2, NOW)).toBe(true);
    const window = String(Math.floor(NOW.getTime() / 60_000));
    expect([...store.keys.keys()]).toEqual([
      `${AI_RATE_LIMIT_KEY_PREFIX}driver:drv_1:${window}`,
      `${AI_RATE_LIMIT_KEY_PREFIX}driver:drv_2:${window}`,
    ]);
  });

  it('TC-AI-DR-18 allows the case when the counter fails (fail-open)', async () => {
    setAiCounterStore({ increment: () => Promise.reject(new Error('redis down')) });
    expect(await allowDriverAiCase('drv_1', 2, NOW)).toBe(true);
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
