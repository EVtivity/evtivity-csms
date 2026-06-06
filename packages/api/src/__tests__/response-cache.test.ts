// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import {
  matchCacheRule,
  extractWriteResource,
  tagsForWrite,
  buildCacheKey,
  registerResponseCache,
  setResponseCacheRedis,
  type ResponseCacheRedis,
} from '../plugins/response-cache.js';

class FakeRedis implements ResponseCacheRedis {
  store = new Map<string, string>();
  failing = false;

  private check(): void {
    if (this.failing) throw new Error('redis down');
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    this.check();
    return keys.map((k) => this.store.get(k) ?? null);
  }

  async get(key: string): Promise<string | null> {
    this.check();
    return this.store.get(key) ?? null;
  }

  async setex(key: string, _seconds: number, value: string): Promise<unknown> {
    this.check();
    this.store.set(key, value);
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    this.check();
    const next = Number(this.store.get(key) ?? '0') + 1;
    this.store.set(key, String(next));
    return next;
  }

  async scan(
    _cursor: string,
    _matchToken: 'MATCH',
    pattern: string,
    _countToken: 'COUNT',
    _count: number,
  ): Promise<[string, string[]]> {
    this.check();
    const prefix = pattern.replace(/\*$/, '');
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix));
    return ['0', keys];
  }

  async del(...keys: string[]): Promise<number> {
    this.check();
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }
}

describe('matchCacheRule', () => {
  it('matches exact list paths', () => {
    expect(matchCacheRule('/v1/stations')?.tags).toEqual(['stations']);
    expect(matchCacheRule('/v1/stations')?.ttlSeconds).toBe(10);
  });

  it('matches prefix patterns for details and dashboard', () => {
    expect(matchCacheRule('/v1/stations/sta_abc')?.ttlSeconds).toBe(5);
    expect(matchCacheRule('/v1/dashboard/stats')?.tags).toEqual(['dashboard']);
  });

  it('does not match uncacheable routes', () => {
    expect(matchCacheRule('/v1/events')).toBeNull();
    expect(matchCacheRule('/v1/auth/login')).toBeNull();
    expect(matchCacheRule('/v1/settings')).toBeNull();
    expect(matchCacheRule('/health')).toBeNull();
  });

  it('prefers the exact list rule over the detail prefix rule', () => {
    expect(matchCacheRule('/v1/sites')?.ttlSeconds).toBe(30);
    expect(matchCacheRule('/v1/sites/sit_abc')?.ttlSeconds).toBe(5);
  });
});

describe('extractWriteResource', () => {
  it('extracts the first path segment after /v1', () => {
    expect(extractWriteResource('/v1/stations/sta_abc/evses')).toBe('stations');
    expect(extractWriteResource('/v1/pricing-groups')).toBe('pricing-groups');
  });

  it('collapses portal writes to the portal tag', () => {
    expect(extractWriteResource('/v1/portal/tokens/dtk_1')).toBe('portal');
  });

  it('returns null outside /v1', () => {
    expect(extractWriteResource('/health')).toBeNull();
  });
});

describe('tagsForWrite', () => {
  it('adds cross-resource tags', () => {
    expect(tagsForWrite('stations')).toEqual(['stations', 'dashboard']);
    expect(tagsForWrite('pricing-holidays')).toEqual(['pricing-holidays', 'pricing']);
  });

  it('returns only the resource tag when unmapped', () => {
    expect(tagsForWrite('fleets')).toEqual(['fleets']);
  });
});

describe('buildCacheKey', () => {
  it('varies by version, user, and url', () => {
    const a = buildCacheKey('0', 'usr_1', '/v1/stations?page=1');
    expect(a).not.toBe(buildCacheKey('1', 'usr_1', '/v1/stations?page=1'));
    expect(a).not.toBe(buildCacheKey('0', 'usr_2', '/v1/stations?page=1'));
    expect(a).not.toBe(buildCacheKey('0', 'usr_1', '/v1/stations?page=2'));
    expect(a).toBe(buildCacheKey('0', 'usr_1', '/v1/stations?page=1'));
  });
});

describe('response cache hooks', () => {
  let app: FastifyInstance;
  let redis: FakeRedis;
  let handlerCalls: number;

  beforeEach(async () => {
    redis = new FakeRedis();
    setResponseCacheRedis(redis);
    handlerCalls = 0;

    app = Fastify();
    registerResponseCache(app);
    app.addHook('onRequest', async (request) => {
      const header = request.headers['x-test-user'];
      if (typeof header === 'string') {
        (request as { user?: unknown }).user = { userId: header };
      }
    });
    app.get('/v1/stations', async () => {
      handlerCalls++;
      return { data: [{ id: 'sta_1' }], total: 1 };
    });
    app.get('/v1/sites/export', async (_request, reply) => {
      handlerCalls++;
      return reply.type('text/csv').send('a,b\n1,2\n');
    });
    app.post('/v1/stations', async () => ({ id: 'sta_new' }));
    await app.ready();
  });

  afterEach(async () => {
    setResponseCacheRedis(null);
    await app.close();
  });

  it('serves the second identical GET from cache', async () => {
    const first = await app.inject({ method: 'GET', url: '/v1/stations' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-cache']).toBe('MISS');

    const second = await app.inject({ method: 'GET', url: '/v1/stations' });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.json()).toEqual({ data: [{ id: 'sta_1' }], total: 1 });
    expect(handlerCalls).toBe(1);
  });

  it('busts cached responses after a write to the resource', async () => {
    await app.inject({ method: 'GET', url: '/v1/stations' });
    await app.inject({ method: 'POST', url: '/v1/stations' });

    const after = await app.inject({ method: 'GET', url: '/v1/stations' });
    expect(after.headers['x-cache']).toBe('MISS');
    expect(handlerCalls).toBe(2);
    expect(redis.store.get('rc:ver:stations')).toBe('1');
    expect(redis.store.get('rc:ver:dashboard')).toBe('1');
  });

  it('separates cache entries per user', async () => {
    await app.inject({ method: 'GET', url: '/v1/stations', headers: { 'x-test-user': 'usr_a' } });
    const other = await app.inject({
      method: 'GET',
      url: '/v1/stations',
      headers: { 'x-test-user': 'usr_b' },
    });
    expect(other.headers['x-cache']).toBe('MISS');
    expect(handlerCalls).toBe(2);
  });

  it('passes through uncached when redis is down', async () => {
    redis.failing = true;
    const res = await app.inject({ method: 'GET', url: '/v1/stations' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBeUndefined();
    expect(res.json()).toEqual({ data: [{ id: 'sta_1' }], total: 1 });
  });

  it('never stores non-JSON responses matched by a prefix rule', async () => {
    const first = await app.inject({ method: 'GET', url: '/v1/sites/export' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-cache']).toBeUndefined();

    const second = await app.inject({ method: 'GET', url: '/v1/sites/export' });
    expect(second.headers['x-cache']).toBeUndefined();
    expect(handlerCalls).toBe(2);
  });
});
