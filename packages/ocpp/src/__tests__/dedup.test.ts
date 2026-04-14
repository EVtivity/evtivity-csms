// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDedupMiddleware, clearDedupCache } from '../server/middleware/dedup.js';
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
