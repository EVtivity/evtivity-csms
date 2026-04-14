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
  siteLoadManagement: {},
  chargingStations: {},
  loadAllocationLog: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  between: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

vi.mock('../services/load-management.service.js', () => ({
  getSitePowerStatus: vi.fn().mockResolvedValue({
    totalDrawKw: 50,
    stations: [
      {
        id: 'sit_000000000001',
        stationId: 'STATION-001',
        circuitId: null,
        currentDrawKw: 25,
        maxPowerKw: 50,
        loadPriority: 5,
        isOnline: true,
        hasActiveSession: true,
      },
      {
        id: 'sit_000000000002',
        stationId: 'STATION-002',
        circuitId: null,
        currentDrawKw: 25,
        maxPowerKw: 50,
        loadPriority: 3,
        isOnline: true,
        hasActiveSession: false,
      },
    ],
  }),
  buildSiteHierarchy: vi.fn().mockResolvedValue([]),
  computeHierarchicalAllocation: vi.fn().mockReturnValue([
    {
      stationDbId: 'sit_000000000001',
      allocatedKw: 45,
      stationId: 'STATION-001',
      currentDrawKw: 25,
    },
  ]),
}));

import { registerAuth } from '../plugins/auth.js';
import { loadManagementRoutes } from '../routes/load-management.js';

const VALID_SITE_ID = 'sit_000000000001';
const VALID_STATION_ID = 'sta_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  loadManagementRoutes(app);
  await app.ready();
  return app;
}

describe('Load management routes', () => {
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

  // --- Auth requirements ---

  it('GET /v1/sites/:id/load-management returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/sites/${VALID_SITE_ID}/load-management`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('PUT /v1/sites/:id/load-management returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/sites/${VALID_SITE_ID}/load-management`,
      payload: { strategy: 'equal_share', isEnabled: true },
    });
    expect(response.statusCode).toBe(401);
  });

  it('PATCH /v1/sites/:id/stations/:stationId/load-priority returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/sites/${VALID_SITE_ID}/stations/${VALID_STATION_ID}/load-priority`,
      payload: { loadPriority: 5 },
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/sites/:id/load-management/history returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/sites/${VALID_SITE_ID}/load-management/history`,
    });
    expect(response.statusCode).toBe(401);
  });

  // --- Schema validation ---

  it('PUT /v1/sites/:id/load-management rejects empty body', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/sites/${VALID_SITE_ID}/load-management`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('PUT /v1/sites/:id/load-management rejects invalid strategy', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/sites/${VALID_SITE_ID}/load-management`,
      headers: { authorization: `Bearer ${token}` },
      payload: { strategy: 'invalid_strategy', isEnabled: true },
    });
    expect(response.statusCode).toBe(400);
  });

  it('PATCH load-priority rejects priority outside range', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/sites/${VALID_SITE_ID}/stations/${VALID_STATION_ID}/load-priority`,
      headers: { authorization: `Bearer ${token}` },
      payload: { loadPriority: 0 },
    });
    expect(response.statusCode).toBe(400);
  });

  // --- Happy paths ---

  it('GET /v1/sites/:id/load-management returns config, hierarchy, and stations', async () => {
    setupDbResults([
      {
        siteId: VALID_SITE_ID,
        strategy: 'equal_share',
        isEnabled: true,
      },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: `/sites/${VALID_SITE_ID}/load-management`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('config');
    expect(body).toHaveProperty('hierarchy');
    expect(body).toHaveProperty('stations');
    expect(body.config.strategy).toBe('equal_share');
    expect(body.config.isEnabled).toBe(true);
    expect(Array.isArray(body.hierarchy)).toBe(true);
    expect(Array.isArray(body.stations)).toBe(true);
  });

  it('GET /v1/sites/:id/load-management returns null config when no config exists', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'GET',
      url: `/sites/${VALID_SITE_ID}/load-management`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.config).toBeNull();
  });

  it('PUT /v1/sites/:id/load-management updates existing config', async () => {
    setupDbResults(
      [
        {
          siteId: VALID_SITE_ID,
          strategy: 'equal_share',
          isEnabled: false,
        },
      ],
      [
        {
          siteId: VALID_SITE_ID,
          strategy: 'equal_share',
          isEnabled: true,
        },
      ],
    );
    const response = await app.inject({
      method: 'PUT',
      url: `/sites/${VALID_SITE_ID}/load-management`,
      headers: { authorization: `Bearer ${token}` },
      payload: { strategy: 'equal_share', isEnabled: true },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.strategy).toBe('equal_share');
  });

  it('PUT /v1/sites/:id/load-management creates new config when none exists', async () => {
    setupDbResults(
      [],
      [
        {
          siteId: VALID_SITE_ID,
          strategy: 'priority_based',
          isEnabled: true,
        },
      ],
    );
    const response = await app.inject({
      method: 'PUT',
      url: `/sites/${VALID_SITE_ID}/load-management`,
      headers: { authorization: `Bearer ${token}` },
      payload: { strategy: 'priority_based', isEnabled: true },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.strategy).toBe('priority_based');
  });

  it('PATCH load-priority updates station priority', async () => {
    setupDbResults([{ id: VALID_STATION_ID, stationId: 'STATION-001', loadPriority: 7 }]);
    const response = await app.inject({
      method: 'PATCH',
      url: `/sites/${VALID_SITE_ID}/stations/${VALID_STATION_ID}/load-priority`,
      headers: { authorization: `Bearer ${token}` },
      payload: { loadPriority: 7 },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.stationId).toBe('STATION-001');
    expect(body.loadPriority).toBe(7);
  });

  it('PATCH load-priority returns 404 when station not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'PATCH',
      url: `/sites/${VALID_SITE_ID}/stations/${VALID_STATION_ID}/load-priority`,
      headers: { authorization: `Bearer ${token}` },
      payload: { loadPriority: 5 },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('GET /v1/sites/:id/load-management/history returns allocation log', async () => {
    setupDbResults([
      {
        id: '1',
        siteLimitKw: '100',
        totalDrawKw: '50',
        availableKw: '90',
        strategy: 'equal_share',
        allocations: [{ stationId: 'STATION-001', allocatedKw: 45 }],
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: `/sites/${VALID_SITE_ID}/load-management/history`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty('siteLimitKw', 100);
    expect(body[0]).toHaveProperty('totalDrawKw', 50);
    expect(body[0]).toHaveProperty('strategy', 'equal_share');
    expect(body[0]).toHaveProperty('allocations');
    expect(body[0]).toHaveProperty('createdAt');
  });
});
