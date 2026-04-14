// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
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
  chatbotAiConfigs: {},
  settings: {},
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

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
}));

const mockHandleSupportAiAssist = vi.hoisted(() => vi.fn());

vi.mock('../services/ai/support-assist.service.js', () => ({
  handleSupportAiAssist: mockHandleSupportAiAssist,
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

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(cookie);
  app.register(async (instance) => {
    supportCaseRoutes(instance);
  });
  await app.ready();
  return app;
}

describe('Support AI Assist', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    mockHandleSupportAiAssist.mockReset();
  });

  it('POST /support-cases/:id/ai-assist returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/support-cases/cas_000000000001/ai-assist',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /support-cases/:id/ai-assist returns 404 when case not found', async () => {
    setupDbResults([]);

    const response = await app.inject({
      method: 'POST',
      url: '/support-cases/cas_000000000001/ai-assist',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('CASE_NOT_FOUND');
  });

  it('POST /support-cases/:id/ai-assist returns 400 when support AI not configured', async () => {
    setupDbResults([{ id: 'cas_000000000001', stationId: null }]);

    const err = new Error('Support AI is not configured') as Error & { code?: string };
    err.code = 'SUPPORT_AI_NOT_CONFIGURED';
    mockHandleSupportAiAssist.mockRejectedValue(err);

    const response = await app.inject({
      method: 'POST',
      url: '/support-cases/cas_000000000001/ai-assist',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('SUPPORT_AI_NOT_CONFIGURED');
  });

  it('POST /support-cases/:id/ai-assist returns draft on success', async () => {
    setupDbResults([{ id: 'cas_000000000001', stationId: null }]);

    mockHandleSupportAiAssist.mockResolvedValue({ draft: 'Here is my reply...', apiCallsMade: 3 });

    const response = await app.inject({
      method: 'POST',
      url: '/support-cases/cas_000000000001/ai-assist',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.draft).toBe('Here is my reply...');
    expect(body.apiCallsMade).toBe(3);
  });

  it('POST /support-cases/:id/ai-assist with isInternalNote: true passes flag through', async () => {
    setupDbResults([{ id: 'cas_000000000001', stationId: null }]);

    mockHandleSupportAiAssist.mockResolvedValue({ draft: 'Internal analysis...', apiCallsMade: 2 });

    const response = await app.inject({
      method: 'POST',
      url: '/support-cases/cas_000000000001/ai-assist',
      headers: { authorization: `Bearer ${token}` },
      payload: { isInternalNote: true },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.draft).toBe('Internal analysis...');

    expect(mockHandleSupportAiAssist).toHaveBeenCalledWith(
      expect.anything(),
      VALID_USER_ID,
      'cas_000000000001',
      true,
      expect.any(String),
    );
  });
});
