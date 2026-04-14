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
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeChain()),
        insert: vi.fn(() => makeChain()),
        update: vi.fn(() => makeChain()),
        delete: vi.fn(() => makeChain()),
      };
      return fn(tx);
    }),
  },
  neviStationData: { stationId: 'stationId' },
  neviExcludedDowntime: {},
  chargingStations: { id: 'id', stationId: 'stationId' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn(), join: vi.fn() }),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
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

import { registerAuth } from '../plugins/auth.js';
import { neviRoutes } from '../routes/nevi.js';

const VALID_STATION_ID = 'sta_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  neviRoutes(app);
  await app.ready();
  return app;
}

describe('NEVI routes', () => {
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
  });

  it('GET /v1/nevi/station-data returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/nevi/station-data' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/nevi/station-data returns station data list', async () => {
    setupDbResults([{ id: 1, stationId: VALID_STATION_ID, operatorName: 'Test' }]);
    const response = await app.inject({
      method: 'GET',
      url: '/nevi/station-data',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].operatorName).toBe('Test');
  });

  it('PUT /v1/nevi/station-data/:stationId returns 404 when station not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'PUT',
      url: `/nevi/station-data/1`,
      headers: { authorization: `Bearer ${token}` },
      payload: { operatorName: 'Test Operator', operatorEmail: 'test@example.com' },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('STATION_NOT_FOUND');
  });

  it('PUT /v1/nevi/station-data/:stationId upserts station data when found', async () => {
    setupDbResults(
      [{ id: 1 }],
      [{ id: 1, stationId: VALID_STATION_ID, operatorName: 'Test Operator' }],
    );
    const response = await app.inject({
      method: 'PUT',
      url: `/nevi/station-data/1`,
      headers: { authorization: `Bearer ${token}` },
      payload: { operatorName: 'Test Operator', operatorEmail: 'test@example.com' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.operatorName).toBe('Test Operator');
  });

  it('GET /v1/nevi/excluded-downtime returns paginated list', async () => {
    setupDbResults(
      [{ id: 1, stationId: VALID_STATION_ID, reason: 'utility_outage' }],
      [{ count: 1 }],
    );
    const response = await app.inject({
      method: 'GET',
      url: '/nevi/excluded-downtime',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it('POST /v1/nevi/excluded-downtime creates excluded downtime record', async () => {
    setupDbResults(
      [{ siteId: 'sit_000000000001' }],
      [
        {
          id: 1,
          stationId: VALID_STATION_ID,
          evseId: 1,
          reason: 'utility_outage',
        },
      ],
    );
    const response = await app.inject({
      method: 'POST',
      url: '/nevi/excluded-downtime',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        stationId: VALID_STATION_ID,
        evseId: 1,
        reason: 'utility_outage',
        startedAt: '2025-01-01T00:00:00Z',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.reason).toBe('utility_outage');
  });

  it('PATCH /v1/nevi/excluded-downtime/:id returns 404 when not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'PATCH',
      url: `/nevi/excluded-downtime/1`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'vandalism' },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('DOWNTIME_NOT_FOUND');
  });

  it('PATCH /v1/nevi/excluded-downtime/:id updates record when found', async () => {
    setupDbResults([{ id: 1 }], [{ id: 1, reason: 'vandalism' }]);
    const response = await app.inject({
      method: 'PATCH',
      url: `/nevi/excluded-downtime/1`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'vandalism' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.reason).toBe('vandalism');
  });

  it('DELETE /v1/nevi/excluded-downtime/:id returns 404 when not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'DELETE',
      url: `/nevi/excluded-downtime/1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('DOWNTIME_NOT_FOUND');
  });

  it('DELETE /v1/nevi/excluded-downtime/:id deletes record when found', async () => {
    setupDbResults([{ id: 1 }]);
    const response = await app.inject({
      method: 'DELETE',
      url: `/nevi/excluded-downtime/1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });
});
