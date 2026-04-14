// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// DB mock helpers
let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'delete',
    'insert',
    'update',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
  },
  notifications: { metadata: {} },
  drivers: {},
}));

vi.mock('drizzle-orm', () => {
  const sqlTag = (...args: unknown[]) => ({ __brand: 'SQL', args });
  return {
    eq: vi.fn(),
    and: vi.fn(),
    gt: vi.fn(),
    sql: sqlTag,
    desc: vi.fn(),
    count: vi.fn(),
  };
});

import { registerAuth } from '../plugins/auth.js';
import { portalNotificationRoutes } from '../routes/portal/notifications.js';

const DRIVER_ID = 'drv_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalNotificationRoutes);
  await app.ready();
  return app;
}

describe('Portal notification routes', () => {
  let app: FastifyInstance;
  let driverToken: string;

  beforeAll(async () => {
    app = await buildApp();
    driverToken = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.clearAllMocks();
  });

  describe('GET /v1/portal/notifications', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({ method: 'GET', url: '/portal/notifications' });
      expect(response.statusCode).toBe(401);
    });

    it('returns paginated notifications', async () => {
      setupDbResults(
        [
          {
            id: 1,
            eventType: 'session.Completed',
            channel: 'email',
            subject: 'Session complete',
            createdAt: new Date(),
          },
        ],
        [{ count: 1 }],
      );
      const response = await app.inject({
        method: 'GET',
        url: '/portal/notifications',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
    });
  });

  describe('GET /v1/portal/notifications/unread-count', () => {
    it('returns unread count when driver has never read notifications', async () => {
      setupDbResults([{ lastNotificationReadAt: null }], [{ count: 3 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/notifications/unread-count',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().count).toBe(3);
    });

    it('returns unread count since last read', async () => {
      setupDbResults(
        [{ lastNotificationReadAt: new Date('2026-01-01T00:00:00Z') }],
        [{ count: 2 }],
      );
      const response = await app.inject({
        method: 'GET',
        url: '/portal/notifications/unread-count',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().count).toBe(2);
    });

    it('returns zero when no unread notifications', async () => {
      setupDbResults([{ lastNotificationReadAt: new Date() }], [{ count: 0 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/notifications/unread-count',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().count).toBe(0);
    });
  });

  describe('POST /v1/portal/notifications/mark-read', () => {
    it('marks notifications as read', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/notifications/mark-read',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });
  });
});
