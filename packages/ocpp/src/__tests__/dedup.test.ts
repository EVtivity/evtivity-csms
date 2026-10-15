// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createDedupMiddleware,
  clearDedupCache,
  MAX_DEDUP_ENTRIES_PER_STATION,
} from '../server/middleware/dedup.js';
import type { HandlerContext } from '../server/middleware/pipeline.js';

function createMockContext(stationId: string, messageId: string): HandlerContext {
  return {
    stationId,
    stationDbId: null,
    session: {
      stationId,
      stationDbId: null,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      pendingMessages: new Map(),
      authenticated: true,
      ocppProtocol: 'ocpp2.1',
      bootStatus: null,
      readyAnnounced: false,
    },
    messageId,
    action: 'Heartbeat',
    protocolVersion: 'ocpp2.1',
    payload: {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as HandlerContext['logger'],
    eventBus: {
      publish: () => Promise.resolve(),
      subscribe: () => {},
      drain: () => Promise.resolve(true),
      track: <T>(work: Promise<T>) => work,
    },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
}

describe('Dedup middleware', () => {
  beforeEach(() => {
    clearDedupCache();
  });

  it('passes through unique messages', async () => {
    const middleware = createDedupMiddleware();
    const ctx = createMockContext('DEDUP-001', 'msg-1');
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
      ctx.response = { currentTime: '2024-01-01T00:00:00Z' };
    });

    expect(nextCalled).toBe(true);
    expect(ctx.response).toEqual({ currentTime: '2024-01-01T00:00:00Z' });
  });

  it('returns cached response for duplicate messageId from same station', async () => {
    const middleware = createDedupMiddleware();
    const expectedResponse = { currentTime: '2024-01-01T00:00:00Z' };

    // First call
    const ctx1 = createMockContext('DEDUP-002', 'msg-dup');
    await middleware(ctx1, async () => {
      ctx1.response = expectedResponse;
    });

    // Duplicate call
    const ctx2 = createMockContext('DEDUP-002', 'msg-dup');
    let nextCalled = false;
    await middleware(ctx2, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(ctx2.response).toEqual(expectedResponse);
  });

  it('allows same messageId from different stations', async () => {
    const middleware = createDedupMiddleware();

    const ctx1 = createMockContext('DEDUP-003', 'msg-shared');
    await middleware(ctx1, async () => {
      ctx1.response = { from: 'station1' };
    });

    const ctx2 = createMockContext('DEDUP-004', 'msg-shared');
    let nextCalled = false;
    await middleware(ctx2, async () => {
      nextCalled = true;
      ctx2.response = { from: 'station2' };
    });

    expect(nextCalled).toBe(true);
    expect(ctx2.response).toEqual({ from: 'station2' });
  });

  it('does not re-cache when no response is set', async () => {
    const middleware = createDedupMiddleware();
    const ctx = createMockContext('DEDUP-006', 'msg-noresponse');

    // First call - next doesn't set response
    await middleware(ctx, async () => {
      // intentionally not setting ctx.response
    });

    // Second call with same messageId - should call next (not cached)
    let nextCalled = false;
    const ctx2 = createMockContext('DEDUP-006', 'msg-noresponse');
    await middleware(ctx2, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it('allows different messageIds from same station', async () => {
    const middleware = createDedupMiddleware();

    const ctx1 = createMockContext('DEDUP-005', 'msg-a');
    await middleware(ctx1, async () => {
      ctx1.response = { id: 'a' };
    });

    const ctx2 = createMockContext('DEDUP-005', 'msg-b');
    let nextCalled = false;
    await middleware(ctx2, async () => {
      nextCalled = true;
      ctx2.response = { id: 'b' };
    });

    expect(nextCalled).toBe(true);
    expect(ctx2.response).toEqual({ id: 'b' });
  });
});

describe('Dedup middleware: message identity', () => {
  beforeEach(() => {
    clearDedupCache();
  });

  async function run(
    middleware: ReturnType<typeof createDedupMiddleware>,
    ctx: HandlerContext,
    response: Record<string, unknown>,
  ): Promise<boolean> {
    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
      ctx.response = response;
    });
    return nextCalled;
  }

  it('processes a reused message id with another action as a new message', async () => {
    const middleware = createDedupMiddleware();
    const first = createMockContext('DEDUP-ACT', 'msg-reused');
    await run(middleware, first, { currentTime: '2024-01-01T00:00:00Z' });

    const second = createMockContext('DEDUP-ACT', 'msg-reused');
    second.action = 'StatusNotification';
    const called = await run(middleware, second, {});

    expect(called).toBe(true);
    expect(second.response).toEqual({});
  });

  it('processes a reused message id with another payload as a new message', async () => {
    const middleware = createDedupMiddleware();
    const first = createMockContext('DEDUP-PAY', 'msg-reused');
    first.action = 'Authorize';
    first.payload = { idToken: { idToken: 'A', type: 'ISO14443' } };
    await run(middleware, first, { idTokenInfo: { status: 'Accepted' } });

    const second = createMockContext('DEDUP-PAY', 'msg-reused');
    second.action = 'Authorize';
    second.payload = { idToken: { idToken: 'B', type: 'ISO14443' } };
    const called = await run(middleware, second, { idTokenInfo: { status: 'Invalid' } });

    expect(called).toBe(true);
    expect(second.response).toEqual({ idTokenInfo: { status: 'Invalid' } });

    // The newer message now answers its own retransmission.
    const retry = createMockContext('DEDUP-PAY', 'msg-reused');
    retry.action = 'Authorize';
    retry.payload = { idToken: { idToken: 'B', type: 'ISO14443' } };
    expect(await run(middleware, retry, {})).toBe(false);
    expect(retry.response).toEqual({ idTokenInfo: { status: 'Invalid' } });
  });

  it('keeps at most MAX_DEDUP_ENTRIES_PER_STATION entries, dropping the oldest', async () => {
    const middleware = createDedupMiddleware();
    for (let i = 0; i <= MAX_DEDUP_ENTRIES_PER_STATION; i++) {
      await run(middleware, createMockContext('DEDUP-CAP', `msg-${String(i)}`), { n: i });
    }

    // msg-0 was evicted, so it runs again; the newest is still cached.
    expect(await run(middleware, createMockContext('DEDUP-CAP', 'msg-0'), { n: 0 })).toBe(true);
    const newest = `msg-${String(MAX_DEDUP_ENTRIES_PER_STATION)}`;
    expect(await run(middleware, createMockContext('DEDUP-CAP', newest), {})).toBe(false);
  });
});

describe('Dedup cleanup timer', () => {
  it('removes expired entries after TTL passes', async () => {
    vi.useFakeTimers({ now: 0 });
    vi.resetModules();

    const { createDedupMiddleware: freshCreate } = await import('../server/middleware/dedup.js');

    const middleware = freshCreate();

    const ctx = createMockContext('TIMER-001', 'msg-timer');
    await middleware(ctx, async () => {
      ctx.response = { ok: true };
    });

    // Advance past TTL (5 min) and one cleanup interval (60s)
    const DEDUP_TTL_MS = 5 * 60 * 1000;
    const CLEANUP_INTERVAL_MS = 60 * 1000;
    vi.advanceTimersByTime(DEDUP_TTL_MS + CLEANUP_INTERVAL_MS + 1);

    // Entry should be cleaned up, so next should be called again
    const ctx2 = createMockContext('TIMER-001', 'msg-timer');
    let nextCalled = false;
    await middleware(ctx2, async () => {
      nextCalled = true;
      ctx2.response = { ok: true };
    });

    expect(nextCalled).toBe(true);

    vi.useRealTimers();
  });

  it('startCleanup only creates one timer even when called multiple times', async () => {
    vi.useFakeTimers({ now: 0 });
    vi.resetModules();

    const { createDedupMiddleware: freshCreate } = await import('../server/middleware/dedup.js');

    // Multiple calls should only register one interval
    freshCreate();
    const spyCalls = vi.getTimerCount();
    freshCreate();
    freshCreate();
    // Timer count should not increase after first createDedupMiddleware
    expect(vi.getTimerCount()).toBe(spyCalls);

    vi.useRealTimers();
  });
});
