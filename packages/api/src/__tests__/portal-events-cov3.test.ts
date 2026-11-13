// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const { subscribe, handlers, unsubscribe, logger } = vi.hoisted(() => {
  const handlers: Array<(payload: string) => void> = [];
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((_channel: string, handler: (payload: string) => void) => {
    handlers.push(handler);
    return Promise.resolve({ unsubscribe });
  });
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { subscribe, handlers, unsubscribe, logger };
});

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  createLogger: () => logger,
}));
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: vi.fn(), subscribe, close: vi.fn() }),
}));

import {
  closeDriverEventStreams,
  portalEventRoutes,
  writeToClient,
} from '../routes/portal/events.js';

async function build(perDriver?: number): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate('authenticateDriver', async (request: FastifyRequest) => {
    const exp = request.headers['x-exp'];
    (request as unknown as { user: unknown }).user = {
      driverId: String(request.headers['x-driver']),
      ...(exp != null ? { exp: Number(exp) } : {}),
    };
  });
  portalEventRoutes(app, perDriver != null ? { perDriver } : {});
  await app.ready();
  return app;
}

const streamOf = (app: FastifyInstance, driverId: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url: '/portal/events',
    headers: { 'x-driver': driverId, ...headers },
  });

let app: FastifyInstance;

beforeEach(() => {
  handlers.length = 0;
  unsubscribe.mockResolvedValue(undefined);
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('portal event stream', () => {
  it('sends the own driver events and keepalives, then unsubscribes when the last stream ends', async () => {
    const intervals: Array<() => void> = [];
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
      intervals.push(fn);
      return realSetInterval(() => undefined, ms);
    }) as typeof setInterval);
    app = await build();
    const pending = streamOf(app, 'drv_1');
    await vi.waitFor(() => {
      expect(handlers).toHaveLength(1);
    });
    expect(subscribe).toHaveBeenCalledWith('portal_events', expect.any(Function));
    const handler = handlers[0];
    handler?.(JSON.stringify({ driverId: 'drv_1', type: 'session.updated' }));
    handler?.(JSON.stringify({ driverId: 'drv_other', type: 'secret' }));
    handler?.('not json');
    intervals[0]?.();
    closeDriverEventStreams('drv_1');
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toContain(': connected');
    expect(res.body).toContain('"type":"session.updated"');
    expect(res.body).not.toContain('secret');
    expect(res.body).toContain(': keepalive');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('ends the stream when the token has expired', async () => {
    app = await build();
    const res = await streamOf(app, 'drv_1', {
      'x-exp': String(Math.floor(Date.now() / 1000) - 5),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(': connected');
  });

  it('ends the oldest stream of a driver over the limit', async () => {
    app = await build(1);
    const first = streamOf(app, 'drv_1');
    await vi.waitFor(() => {
      expect(handlers).toHaveLength(1);
    });
    const second = streamOf(app, 'drv_1');
    const firstRes = await first;
    expect(firstRes.body).toContain(': connected');
    closeDriverEventStreams('drv_1');
    expect((await second).body).toContain(': connected');
  });

  it('logs a failed unsubscribe when the last stream ends', async () => {
    unsubscribe.mockRejectedValue(new Error('redis down'));
    app = await build();
    const pending = streamOf(app, 'drv_1');
    await vi.waitFor(() => {
      expect(handlers).toHaveLength(1);
    });
    closeDriverEventStreams('drv_1');
    await pending;
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Unsubscribing the portal events listener failed',
      );
    });
  });

  it('ends open streams on close and unsubscribes, logging a failure', async () => {
    unsubscribe.mockRejectedValue(new Error('redis down'));
    app = await build();
    const pending = streamOf(app, 'drv_1');
    await vi.waitFor(() => {
      expect(handlers).toHaveLength(1);
    });
    await app.close();
    const res = await pending;
    expect(res.body).toContain(': connected');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Unsubscribing the portal events listener on close failed',
    );
  });
});

describe('writeToClient', () => {
  it('drops a client whose write throws', async () => {
    app = await build();
    const client = {
      id: 99,
      driverId: 'drv_9',
      reply: {
        raw: {
          write: () => {
            throw new Error('socket closed');
          },
        },
      },
      expiryTimer: setTimeout(() => undefined, 60_000),
    };
    writeToClient(client as never, 'data: x\n\n');
    expect(client.expiryTimer).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 99, driverId: 'drv_9' }),
      'SSE write failed, dropping client',
    );
  });
});
