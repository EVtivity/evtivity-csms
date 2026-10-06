// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import type { IncomingMessage, ClientRequest } from 'node:http';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

vi.mock('@evtivity/database', () => ({
  db: {},
  client: {},
  refreshTokens: {},
  users: {},
}));

const { getUserSiteIds, subscribe, unsubscribe, handlers } = vi.hoisted(() => {
  const handlers: Array<(payload: string) => void> = [];
  const unsubscribe = vi.fn().mockResolvedValue(undefined);
  const subscribe = vi.fn((_channel: string, handler: (payload: string) => void) => {
    handlers.push(handler);
    return Promise.resolve({ unsubscribe });
  });
  return { getUserSiteIds: vi.fn(), subscribe, unsubscribe, handlers };
});

vi.mock('../lib/site-access.js', () => ({ getUserSiteIds }));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: vi.fn(), subscribe, close: vi.fn() }),
}));

import { registerAuth } from '../plugins/auth.js';
import { eventStreamRoutes } from '../routes/events.js';

interface Stream {
  res: IncomingMessage;
  req: ClientRequest;
  chunks: string[];
  waitFor: (text: string) => Promise<void>;
}

function openStream(port: number, token: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: `/events/stream?token=${token}`, method: 'GET' },
      (res) => {
        res.setEncoding('utf8');
        const chunks: string[] = [];
        const waiters: Array<{ text: string; done: () => void }> = [];
        res.on('data', (chunk: string) => {
          chunks.push(chunk);
          const all = chunks.join('');
          for (const w of [...waiters]) {
            if (all.includes(w.text)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.done();
            }
          }
        });
        const waitFor = (text: string): Promise<void> =>
          new Promise((done) => {
            if (chunks.join('').includes(text)) {
              done();
              return;
            }
            waiters.push({ text, done });
          });
        void waitFor(': connected').then(() => {
          resolve({ res, req, chunks, waitFor });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('event stream fan-out', () => {
  let app: FastifyInstance;
  let port: number;

  beforeEach(async () => {
    handlers.length = 0;
    app = Fastify();
    await app.register(cookie);
    await registerAuth(app);
    eventStreamRoutes(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    port = typeof address === 'object' && address != null ? address.port : 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  it('delivers site events only to clients allowed on that site and unscoped events to all', async () => {
    getUserSiteIds.mockResolvedValueOnce(['sit_a']).mockResolvedValueOnce(null);
    const scoped = await openStream(port, app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' }));
    const admin = await openStream(port, app.jwt.sign({ userId: 'usr_2', roleId: 'rol_1' }));

    expect(subscribe).toHaveBeenCalledWith('csms_events', expect.any(Function));
    expect(handlers).toHaveLength(1);
    const handler = handlers[0]!;

    handler(JSON.stringify({ type: 'x', siteId: 'sit_b', n: 1 }));
    handler(JSON.stringify({ type: 'x', siteId: 'sit_a', n: 2 }));
    handler('not-json{');
    handler(JSON.stringify({ type: 'x', n: 3 }));

    await admin.waitFor('"n":3');
    await scoped.waitFor('"n":3');

    const adminText = admin.chunks.join('');
    const scopedText = scoped.chunks.join('');
    expect(adminText).toContain('data: {"type":"x","siteId":"sit_b","n":1}\n\n');
    expect(adminText).toContain('"n":2');
    expect(adminText).toContain('data: not-json{\n\n');
    expect(scopedText).not.toContain('"n":1');
    expect(scopedText).toContain('"siteId":"sit_a","n":2');
    expect(scopedText).toContain('data: not-json{\n\n');

    scoped.req.destroy();
    admin.req.destroy();
  }, 5000);

  it('unsubscribes when the last client disconnects and resubscribes for a new client', async () => {
    getUserSiteIds.mockResolvedValue(null);
    const token = app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' });
    const first = await openStream(port, token);
    expect(subscribe).toHaveBeenCalledTimes(1);

    const closed = new Promise<void>((resolve) => {
      first.res.on('close', () => {
        resolve();
      });
    });
    first.req.destroy();
    await closed;
    await vi.waitFor(() => {
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    const second = await openStream(port, token);
    expect(subscribe).toHaveBeenCalledTimes(2);
    second.req.destroy();
  }, 5000);

  it('sends a keepalive comment every 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    getUserSiteIds.mockResolvedValue(null);
    const stream = await openStream(port, app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' }));
    expect(stream.chunks.join('')).not.toContain(': keepalive');

    vi.advanceTimersByTime(30_000);
    await stream.waitFor(': keepalive\n\n');
    expect(stream.chunks.join('')).toContain(': keepalive\n\n');
    stream.req.destroy();
  }, 5000);
});
