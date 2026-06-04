// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRateLimitMiddleware } from '../server/middleware/rate-limit.js';
import type { HandlerContext } from '../server/middleware/pipeline.js';

function createMockContext(stationId: string): HandlerContext {
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
    messageId: 'test-msg',
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

describe('Rate limit middleware', () => {
  it('allows messages under the limit', async () => {
    const middleware = createRateLimitMiddleware(10);
    const ctx = createMockContext('RATE-001');
    let nextCalled = false;

    await middleware(ctx, () => {
      nextCalled = true;
      return Promise.resolve();
    });
    expect(nextCalled).toBe(true);
  });

  it('blocks messages over the limit', async () => {
    const middleware = createRateLimitMiddleware(2);

    for (let i = 0; i < 2; i++) {
      const ctx = createMockContext('RATE-002');
      await middleware(ctx, () => Promise.resolve());
    }

    const ctx = createMockContext('RATE-002');
    await expect(middleware(ctx, () => Promise.resolve())).rejects.toThrow('Rate limit exceeded');
  });

  it('tracks rate limits per station', async () => {
    const middleware = createRateLimitMiddleware(1);

    const ctx1 = createMockContext('RATE-003');
    let called1 = false;
    await middleware(ctx1, () => {
      called1 = true;
      return Promise.resolve();
    });
    expect(called1).toBe(true);

    const ctx2 = createMockContext('RATE-004');
    let called2 = false;
    await middleware(ctx2, () => {
      called2 = true;
      return Promise.resolve();
    });
    expect(called2).toBe(true);
  });

  it('throws OcppError and does not call next when over the limit', async () => {
    const middleware = createRateLimitMiddleware(1);
    const ctx = createMockContext('RATE-OVER');
    const warnSpy = vi.spyOn(ctx.logger, 'warn');

    await middleware(ctx, () => Promise.resolve());

    const next = vi.fn();
    await expect(middleware(ctx, next)).rejects.toMatchObject({ errorCode: 'GenericError' });
    await expect(middleware(ctx, () => Promise.resolve())).rejects.toThrow('Rate limit exceeded');
    expect(next).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'RATE-OVER', count: 2 }),
      'Rate limit exceeded',
    );
  });

  it('resets the per-station window after WINDOW_MS elapses', async () => {
    vi.useFakeTimers();
    try {
      const start = 1_000_000;
      vi.setSystemTime(start);
      const middleware = createRateLimitMiddleware(1);
      const ctx = createMockContext('RATE-WINDOW');

      // First message in the window: allowed.
      const first = vi.fn();
      await middleware(ctx, first);
      expect(first).toHaveBeenCalledTimes(1);

      // Second message in the same window: blocked.
      await expect(middleware(ctx, () => Promise.resolve())).rejects.toThrow('Rate limit exceeded');

      // Advance past the 1s window so the counter resets.
      vi.setSystemTime(start + 1001);
      const third = vi.fn();
      await middleware(ctx, third);
      expect(third).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Rate limit middleware stale-entry cleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('deletes counters for stations idle beyond the stale threshold', async () => {
    vi.useFakeTimers();
    const start = 5_000_000;
    vi.setSystemTime(start);

    // Re-import the module under fake timers so its module-level setInterval is
    // registered against the fake clock.
    const mod = await import('../server/middleware/rate-limit.js');
    const middleware = mod.createRateLimitMiddleware(50);
    const ctx = createMockContext('STALE-001');

    await middleware(ctx, () => Promise.resolve());

    // Advance beyond the 300s stale threshold; the 60s cleanup interval fires
    // and removes the idle station's counter. After removal a fresh window is
    // created, so the station is allowed again at full quota.
    vi.setSystemTime(start + 300_001);
    await vi.advanceTimersByTimeAsync(60_000);

    let called = false;
    await middleware(ctx, () => {
      called = true;
      return Promise.resolve();
    });
    expect(called).toBe(true);
  });
});
