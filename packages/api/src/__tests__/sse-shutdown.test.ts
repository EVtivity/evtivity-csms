// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

vi.mock('@evtivity/database', () => ({
  db: {},
  client: {},
  refreshTokens: {},
  users: {},
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
}));

const unsubscribe = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({
    publish: vi.fn(),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe }),
    close: vi.fn(),
  }),
}));

import { registerAuth } from '../plugins/auth.js';
import { eventStreamRoutes } from '../routes/events.js';

function openStream(port: number, token: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: `/events/stream?token=${token}`, method: 'GET' },
      (res) => {
        res.setEncoding('utf8');
        res.once('data', () => {
          resolve(res);
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('SSE streams at shutdown', () => {
  it('app.close() ends open event streams instead of waiting on them', async () => {
    const app = Fastify();
    await app.register(cookie);
    await registerAuth(app);
    eventStreamRoutes(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address != null ? address.port : 0;
    const token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });

    const stream = await openStream(port, token);
    const ended = new Promise<void>((resolve) => {
      stream.on('end', () => {
        resolve();
      });
    });

    await app.close();
    await ended;

    expect(unsubscribe).toHaveBeenCalled();
  }, 5000);
});
