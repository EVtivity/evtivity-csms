// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

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
    'onConflictDoNothing',
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

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
  invalidatePermissionCache: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([{ val: '1' }])),
  },
  client: {},
  supportCases: {},
  supportCaseMessages: {},
  supportCaseAttachments: {},
  supportCaseSessions: {},
  supportCaseReads: { userId: 'user_id', caseId: 'case_id' },
  drivers: {},
  users: {},
  chargingSessions: {},
  chargingStations: {},
  paymentRecords: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(() => 'sql'),
  desc: vi.fn(),
  count: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@evtivity/lib', () => ({
  dispatchDriverNotification: vi.fn(),
}));

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
  })),
  setPubSub: vi.fn(),
}));

vi.mock('../services/s3.service.js', () => ({
  getS3Config: vi.fn(),
  generateUploadUrl: vi.fn(),
  generateDownloadUrl: vi.fn(),
  buildS3Key: vi.fn(),
}));

vi.mock('../services/stripe.service.js', () => ({
  getStripeConfig: vi.fn(),
  createRefund: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { supportCaseRoutes } from '../routes/support-cases.js';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const VALID_CASE_ID = 'cas_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  app.register(async (instance) => {
    supportCaseRoutes(instance);
  });
  await app.ready();
  return app;
}

function authHeader(app: FastifyInstance): string {
  return `Bearer ${app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID })}`;
}

describe('Support Case Read Tracking', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbCallIndex = 0;
    dbResults = [];
  });

  describe('GET /v1/support-cases/unread-count', () => {
    it('returns unread count', async () => {
      setupDbResults([{ count: 3 }]);

      const res = await app.inject({
        method: 'GET',
        url: '/support-cases/unread-count',
        headers: { authorization: authHeader(app) },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { count: number };
      expect(body.count).toBe(3);
    });

    it('returns 0 when no unread cases', async () => {
      setupDbResults([{ count: 0 }]);

      const res = await app.inject({
        method: 'GET',
        url: '/support-cases/unread-count',
        headers: { authorization: authHeader(app) },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { count: number };
      expect(body.count).toBe(0);
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/support-cases/unread-count',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /v1/support-cases/:id/read', () => {
    it('marks case as read', async () => {
      setupDbResults([{ success: true }]);

      const res = await app.inject({
        method: 'POST',
        url: `/support-cases/${VALID_CASE_ID}/read`,
        headers: { authorization: authHeader(app) },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { success: boolean };
      expect(body.success).toBe(true);
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/support-cases/${VALID_CASE_ID}/read`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /v1/support-cases (isRead field)', () => {
    it('includes isRead in list response', async () => {
      const now = new Date().toISOString();
      setupDbResults(
        [
          {
            id: VALID_CASE_ID,
            caseNumber: 'CASE-00001',
            subject: 'Test',
            status: 'open',
            category: 'general_inquiry',
            priority: 'medium',
            createdByDriver: false,
            driverName: null,
            assignedToName: null,
            assignedTo: null,
            driverId: null,
            isRead: false,
            createdAt: now,
          },
        ],
        [{ count: 1 }],
      );

      const res = await app.inject({
        method: 'GET',
        url: '/support-cases?page=1&limit=10',
        headers: { authorization: authHeader(app) },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { data: Array<{ isRead: boolean }>; total: number };
      expect(body.data[0]?.isRead).toBe(false);
      expect(body.total).toBe(1);
    });
  });
});
