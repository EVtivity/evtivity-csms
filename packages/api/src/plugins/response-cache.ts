// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createLogger } from '@evtivity/lib';
import { config } from '../lib/config.js';
import { authorize } from '../middleware/rbac.js';
import { successResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';

const logger = createLogger('response-cache');

export interface CacheRule {
  pattern: string;
  ttlSeconds: number;
  tags: string[];
}

// First match wins. Patterns ending in '*' are prefix matches, everything
// else is an exact pathname match (query string is part of the cache key,
// not the rule match). Only application/json 200 responses are ever stored,
// so CSV exports and presigned-URL downloads under a prefix rule pass
// through untouched.
//
// Settings reads (/v1/settings*) are deliberately absent: the generic GET
// path decrypts *Enc credentials, and decrypted secrets must never persist
// in Redis. /v1/security/public is safe (publishable values only).
export const CACHE_RULES: CacheRule[] = [
  // Static reference data
  { pattern: '/v1/carbon/factors*', ttlSeconds: 300, tags: ['carbon'] },
  { pattern: '/v1/roles', ttlSeconds: 300, tags: ['roles'] },
  { pattern: '/v1/vendors', ttlSeconds: 300, tags: ['vendors'] },
  // Public config
  { pattern: '/v1/security/public', ttlSeconds: 60, tags: ['security'] },
  // Slow-changing lists
  { pattern: '/v1/sites', ttlSeconds: 30, tags: ['sites'] },
  { pattern: '/v1/users', ttlSeconds: 30, tags: ['users'] },
  { pattern: '/v1/drivers', ttlSeconds: 30, tags: ['drivers'] },
  { pattern: '/v1/fleets', ttlSeconds: 30, tags: ['fleets'] },
  { pattern: '/v1/tokens', ttlSeconds: 30, tags: ['tokens'] },
  { pattern: '/v1/pricing-groups', ttlSeconds: 30, tags: ['pricing'] },
  { pattern: '/v1/pricing-holidays', ttlSeconds: 30, tags: ['pricing'] },
  // Operational lists
  { pattern: '/v1/stations', ttlSeconds: 10, tags: ['stations'] },
  { pattern: '/v1/sessions', ttlSeconds: 10, tags: ['sessions'] },
  { pattern: '/v1/reservations', ttlSeconds: 10, tags: ['reservations'] },
  { pattern: '/v1/support-cases', ttlSeconds: 10, tags: ['support-cases'] },
  { pattern: '/v1/notifications', ttlSeconds: 10, tags: ['notifications'] },
  // Dashboard aggregations
  { pattern: '/v1/dashboard/*', ttlSeconds: 10, tags: ['dashboard'] },
  // Detail pages and sub-resources
  { pattern: '/v1/sites/*', ttlSeconds: 5, tags: ['sites'] },
  { pattern: '/v1/stations/*', ttlSeconds: 5, tags: ['stations'] },
  { pattern: '/v1/sessions/*', ttlSeconds: 5, tags: ['sessions'] },
  { pattern: '/v1/support-cases/*', ttlSeconds: 5, tags: ['support-cases'] },
  // Portal public charger browsing
  { pattern: '/v1/portal/chargers/*', ttlSeconds: 10, tags: ['portal'] },
];

// Writes to a resource bust its own tag plus these extras.
export const CROSS_INVALIDATION: Record<string, string[]> = {
  sites: ['dashboard'],
  stations: ['dashboard'],
  sessions: ['dashboard'],
  'pricing-groups': ['pricing'],
  'pricing-holidays': ['pricing'],
  holidays: ['pricing'],
  settings: ['security'],
  security: ['security'],
  drivers: ['tokens'],
  tokens: ['drivers'],
};

export function matchCacheRule(pathname: string): CacheRule | null {
  for (const rule of CACHE_RULES) {
    if (rule.pattern.endsWith('*')) {
      if (pathname.startsWith(rule.pattern.slice(0, -1))) return rule;
    } else if (pathname === rule.pattern) {
      return rule;
    }
  }
  return null;
}

// /v1/{resource}/... -> resource; /v1/portal/... -> 'portal'.
export function extractWriteResource(pathname: string): string | null {
  const match = /^\/v1\/([^/?]+)/.exec(pathname);
  if (match?.[1] == null) return null;
  return match[1] === 'portal' ? 'portal' : match[1];
}

export function tagsForWrite(resource: string): string[] {
  return [resource, ...(CROSS_INVALIDATION[resource] ?? [])];
}

function requestUserId(request: FastifyRequest): string {
  const user = request.user as { userId?: string; driverId?: string } | undefined;
  return user?.userId ?? user?.driverId ?? 'anon';
}

export function buildCacheKey(tagVersions: string, userId: string, url: string): string {
  const urlHash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return `rc:${tagVersions}:${userId}:${urlHash}`;
}

interface CacheCtx {
  key: string;
  ttlSeconds: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    responseCacheCtx: CacheCtx | null;
  }
}

export interface ResponseCacheRedis {
  mget(...keys: string[]): Promise<(string | null)[]>;
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  incr(key: string): Promise<number>;
  scan(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<number>;
}

let cacheRedis: ResponseCacheRedis | null = null;

function getCacheRedis(): ResponseCacheRedis {
  if (cacheRedis == null) {
    // Unit tests inject a fake via setResponseCacheRedis; never let a test
    // run connect to a real Redis and leak cached bodies across tests.
    if (process.env['NODE_ENV'] === 'test') {
      throw new Error('response cache disabled in tests');
    }
    const redis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    // Fail-fast cache connection: commands throw while disconnected and every
    // call site degrades to an uncached pass-through.
    redis.on('error', (err: Error) => {
      logger.debug({ err: err.message }, 'response cache redis error');
    });
    void redis.connect().catch(() => {});
    realRedisClient = redis;
    cacheRedis = redis;
  }
  return cacheRedis;
}

let realRedisClient: Redis | null = null;

export function setResponseCacheRedis(redis: ResponseCacheRedis | null): void {
  cacheRedis = redis;
}

async function versionedKey(
  redis: ResponseCacheRedis,
  rule: CacheRule,
  request: FastifyRequest,
): Promise<string> {
  const versions = await redis.mget(...rule.tags.map((t) => `rc:ver:${t}`));
  const tagVersions = versions.map((v) => v ?? '0').join(':');
  return buildCacheKey(tagVersions, requestUserId(request), request.url);
}

export function registerResponseCache(app: FastifyInstance): void {
  app.decorateRequest('responseCacheCtx', null);

  // Tie the connection to the app lifecycle: a dangling auto-reconnecting
  // client keeps the event loop alive after app.close() and hangs one-shot
  // scripts (OpenAPI and AI-tools codegen build the app and exit).
  app.addHook('onClose', (_instance, done) => {
    if (realRedisClient != null) {
      realRedisClient.disconnect();
      if (cacheRedis === realRedisClient) cacheRedis = null;
      realRedisClient = null;
    }
    done();
  });

  // Start the Redis connection during app boot so the first requests are not
  // lost to the lazy-connect race (commands fail fast while disconnected).
  if (process.env['NODE_ENV'] !== 'test') {
    try {
      getCacheRedis();
    } catch {
      // Redis down at boot: every request degrades to uncached pass-through.
    }
  }

  // Runs after route-level onRequest (auth), so request.user is populated
  // and unauthenticated requests were already rejected.
  app.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'GET') return;
    const pathname = request.url.split('?')[0] ?? request.url;
    const rule = matchCacheRule(pathname);
    if (rule == null) return;

    try {
      const redis = getCacheRedis();
      const key = await versionedKey(redis, rule, request);
      const cached = await redis.get(key);
      if (cached != null) {
        return await reply
          .header('X-Cache', 'HIT')
          .type('application/json; charset=utf-8')
          .send(cached);
      }
      request.responseCacheCtx = { key, ttlSeconds: rule.ttlSeconds };
    } catch {
      // Redis down: pass through uncached.
    }
    return;
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const ctx = request.responseCacheCtx;
    if (ctx == null) return payload;
    const contentType = String(reply.getHeader('content-type') ?? '');
    if (reply.statusCode !== 200 || typeof payload !== 'string') return payload;
    if (!contentType.includes('application/json')) return payload;

    reply.header('X-Cache', 'MISS');
    try {
      await getCacheRedis().setex(ctx.key, ctx.ttlSeconds, payload);
    } catch {
      // Redis down: response still goes out, just not cached.
    }
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    if (reply.statusCode >= 400) return;
    const pathname = request.url.split('?')[0] ?? request.url;
    const resource = extractWriteResource(pathname);
    if (resource == null) return;

    try {
      const redis = getCacheRedis();
      await Promise.all(tagsForWrite(resource).map((tag) => redis.incr(`rc:ver:${tag}`)));
    } catch {
      // Redis down: nothing was being served from cache either.
    }
  });
}

export function cacheRoutes(app: FastifyInstance): void {
  app.post(
    '/cache/flush',
    {
      onRequest: [authorize('settings:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Flush the HTTP response cache',
        operationId: 'flushResponseCache',
        security: [{ bearerAuth: [] }],
        response: {
          200: successResponse,
          500: errorWith('Cache backend unreachable', [ERROR_CODES.INTERNAL_ERROR]),
        },
      },
    },
    async (request, reply) => {
      try {
        const redis = getCacheRedis();
        let cursor = '0';
        let deleted = 0;
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', 'rc:ver:*', 'COUNT', 200);
          cursor = next;
          if (keys.length > 0) deleted += await redis.del(...keys);
        } while (cursor !== '0');
        request.log.info({ deleted }, 'response cache flushed');
        return { success: true };
      } catch {
        await reply
          .status(500)
          .send({ error: 'Cache backend unreachable', code: 'INTERNAL_ERROR' });
        return;
      }
    },
  );
}
