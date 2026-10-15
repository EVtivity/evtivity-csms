// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

vi.mock('../lib/config.js', () => ({
  config: { RATE_LIMIT_MAX: 2, RATE_LIMIT_WINDOW: '1 minute' },
}));

const { registerRateLimit } = await import('../plugins/rate-limit.js');

const PROXY = '10.0.0.2';

/** A request through the load balancer, which appends the client it saw. */
function viaProxy(app: FastifyInstance, forwardedFor: string) {
  return app.inject({
    method: 'GET',
    url: '/ping',
    remoteAddress: PROXY,
    headers: { 'x-forwarded-for': forwardedFor },
  });
}

describe('rate limit behind a trusted proxy (TRUST_PROXY=10.0.0.0/16)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false, trustProxy: '10.0.0.0/16' });
    await registerRateLimit(app);
    app.get('/ping', () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('keys the limit on the client the proxy reports, not the proxy', async () => {
    expect((await viaProxy(app, '203.0.113.1')).statusCode).toBe(200);
    expect((await viaProxy(app, '203.0.113.1')).statusCode).toBe(200);
    expect((await viaProxy(app, '203.0.113.1')).statusCode).toBe(429);
    // Another client through the same proxy has its own bucket.
    expect((await viaProxy(app, '203.0.113.2')).statusCode).toBe(200);
  });

  it('ignores a forged leftmost X-Forwarded-For entry', async () => {
    // The limited client prepends a fake address; the proxy still appends
    // the real one, which stays the key.
    expect((await viaProxy(app, '198.51.100.7, 203.0.113.1')).statusCode).toBe(429);
  });
});

describe('rate limit without a trusted proxy (default)', () => {
  it('keys the limit on the socket and ignores X-Forwarded-For', async () => {
    const app = Fastify({ logger: false });
    await registerRateLimit(app);
    app.get('/ping', () => ({ ok: true }));
    await app.ready();
    expect((await viaProxy(app, '203.0.113.1')).statusCode).toBe(200);
    expect((await viaProxy(app, '203.0.113.2')).statusCode).toBe(200);
    expect((await viaProxy(app, '203.0.113.3')).statusCode).toBe(429);
    await app.close();
  });
});
