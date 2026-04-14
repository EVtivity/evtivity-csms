// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { MiddlewarePipeline } from '../server/middleware/pipeline.js';
import type { HandlerContext } from '../server/middleware/pipeline.js';

const logger = pino({ level: 'silent' });

function makeCtx(): HandlerContext {
  return {
    stationId: 'CS-001',
    stationDbId: null,
    session: {
      stationId: 'CS-001',
      stationDbId: null,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      ocppProtocol: 'ocpp2.1',
      bootStatus: null,
    },
    messageId: 'msg-1',
    action: 'Heartbeat',
    protocolVersion: 'ocpp2.1',
    payload: {},
    logger,
    eventBus: { publish: vi.fn(), subscribe: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
}

describe('MiddlewarePipeline', () => {
  it('executes middlewares in order', async () => {
    const order: number[] = [];
    const pipeline = new MiddlewarePipeline();

    pipeline.use(async (_ctx, next) => {
      order.push(1);
      await next();
      order.push(4);
    });
    pipeline.use(async (_ctx, next) => {
      order.push(2);
      await next();
      order.push(3);
    });

    await pipeline.execute(makeCtx());
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('stops if middleware does not call next', async () => {
    const pipeline = new MiddlewarePipeline();
    const secondMiddleware = vi.fn();

    pipeline.use(() => Promise.resolve());
    pipeline.use(secondMiddleware);

    await pipeline.execute(makeCtx());
    expect(secondMiddleware).not.toHaveBeenCalled();
  });

  it('propagates errors', async () => {
    const pipeline = new MiddlewarePipeline();

    pipeline.use(() => {
      throw new Error('test error');
    });

    await expect(pipeline.execute(makeCtx())).rejects.toThrow('test error');
  });

  it('allows middleware to modify context', async () => {
    const pipeline = new MiddlewarePipeline();

    pipeline.use(async (ctx, next) => {
      ctx.response = { modified: true };
      await next();
    });

    const ctx = makeCtx();
    await pipeline.execute(ctx);
    expect(ctx.response).toEqual({ modified: true });
  });
});
