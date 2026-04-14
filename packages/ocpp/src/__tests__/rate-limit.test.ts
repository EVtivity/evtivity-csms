// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
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
});
