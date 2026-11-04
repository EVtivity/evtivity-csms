// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';

const {
  siteChargingPlanViewMock,
  isFleetChargingEnabledMock,
  isFleetEnabledMock,
  requestHasPermissionMock,
} = vi.hoisted(() => ({
  siteChargingPlanViewMock: vi.fn(),
  isFleetChargingEnabledMock: vi.fn(() => Promise.resolve(true)),
  isFleetEnabledMock: vi.fn(() => Promise.resolve(true)),
  requestHasPermissionMock: vi.fn((_permission: string) => Promise.resolve(true)),
}));
import rateLimit from '@fastify/rate-limit';
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
  requestHasPermission: (_request: unknown, permission: string) =>
    requestHasPermissionMock(permission) as unknown,
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

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
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
  isFleetChargingEnabled: () => isFleetChargingEnabledMock() as unknown,
  isFleetEnabled: () => isFleetEnabledMock() as unknown,
  markSitePlanStale: (...args: unknown[]) => markSitePlanStaleMock(...args) as unknown,
}));

vi.mock('../lib/charging-plan-view.js', async () => {
  const { z } = await import('zod');
  return {
    sitePlanItem: z
      .object({ planning: z.boolean().describe('Planning'), departures: z.array(z.unknown()) })
      .loose(),
    siteChargingPlanView: (...args: unknown[]) => siteChargingPlanViewMock(...args) as unknown,
  };
});

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
  isNotNull: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  isAllSiteUser: vi.fn().mockResolvedValue(true),
  invalidateSiteAccessCache: vi.fn(),
}));

vi.mock('@evtivity/services/load-management.service', () => ({
  computeSiteAllocation: vi.fn(async (siteId: string, strategy: string) => {
    const svc = await import('@evtivity/services/load-management.service');
    const status = await svc.getSitePowerStatus(siteId);
    const hierarchy = await svc.buildSiteHierarchy(siteId, status.stations);
    const allocations =
      hierarchy.length > 0 ? svc.computeHierarchicalAllocation(hierarchy, strategy as never) : [];
    return { status, hierarchy, managed: [], reservedKw: new Map(), allocations };
  }),
  clearLoadManagementProfiles: vi.fn().mockResolvedValue(true),
  clearPlanProfilesOnDisable: vi.fn().mockResolvedValue(undefined),
  parseAppliedAllocations: vi.fn(() => null),
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
        minPowerKw: 0,
        rateUnit: 'W',
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
        minPowerKw: 0,
        rateUnit: 'W',
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

const siteAuditMock = vi.fn().mockResolvedValue(undefined);
const markSitePlanStaleMock = vi.fn().mockResolvedValue(true);
const stationAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/load-management-audit.js', () => ({
  writeSiteLoadManagementAudit: (...args: unknown[]) => siteAuditMock(...args) as Promise<void>,
  writeStationLoadAudit: (...args: unknown[]) => stationAuditMock(...args) as Promise<void>,
}));

import { registerAuth } from '../plugins/auth.js';
import { loadManagementRoutes } from '../routes/load-management.js';
import {
  clearLoadManagementProfiles,
  clearPlanProfilesOnDisable,
} from '@evtivity/services/load-management.service';

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
    siteAuditMock.mockClear();
    stationAuditMock.mockClear();
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
        departureBufferMinutes: 30,
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
    // NODE_ENV test allows simulated battery and solar readings.
    expect(body.simulatedEnergyAssetsAllowed).toBe(true);
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
          id: 1,
          siteId: VALID_SITE_ID,
          strategy: 'equal_share',
          isEnabled: false,
          departureBufferMinutes: 30,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      [
        {
          id: 1,
          siteId: VALID_SITE_ID,
          strategy: 'equal_share',
          isEnabled: true,
          departureBufferMinutes: 30,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-02T00:00:00Z'),
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
    expect(siteAuditMock).toHaveBeenCalledWith(expect.anything(), VALID_SITE_ID, {
      before: { isEnabled: false },
      after: { isEnabled: true },
      notes: 'load management configuration updated',
    });
    // A site switched to or from departure-aware replans on the next cycle.
    await vi.waitFor(() => {
      expect(markSitePlanStaleMock).toHaveBeenCalledWith(
        VALID_SITE_ID,
        'load_management_changed',
        expect.anything(),
        { departureAwareOnly: true },
      );
    });
  });

  it('PUT with an unchanged config writes no audit row', async () => {
    const row = {
      id: 1,
      siteId: VALID_SITE_ID,
      strategy: 'equal_share',
      isEnabled: true,
      departureBufferMinutes: 30,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    setupDbResults([row], [row]);
    const response = await app.inject({
      method: 'PUT',
      url: `/sites/${VALID_SITE_ID}/load-management`,
      headers: { authorization: `Bearer ${token}` },
      payload: { strategy: 'equal_share', isEnabled: true },
    });
    expect(response.statusCode).toBe(200);
    expect(siteAuditMock).not.toHaveBeenCalled();
  });

  it('PUT turning load management off clears the limit of every managed station', async () => {
    vi.mocked(clearLoadManagementProfiles).mockClear();
    setupDbResults(
      [
        {
          id: 1,
          siteId: VALID_SITE_ID,
          strategy: 'equal_share',
          isEnabled: true,
          departureBufferMinutes: 30,
          appliedAllocations: [
            { stationId: 'STATION-OLD', stationDbId: 'sta_old', allocatedKw: 10 },
          ],
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      [
        {
          id: 1,
          siteId: VALID_SITE_ID,
          strategy: 'equal_share',
          isEnabled: false,
          departureBufferMinutes: 30,
          appliedAllocations: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-02T00:00:00Z'),
        },
      ],
      [{ stationId: 'STATION-001' }],
    );
    const response = await app.inject({
      method: 'PUT',
      url: `/sites/${VALID_SITE_ID}/load-management`,
      headers: { authorization: `Bearer ${token}` },
      payload: { strategy: 'equal_share', isEnabled: false },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.isEnabled).toBe(false);
    // The stored allocations stay internal.
    expect(body).not.toHaveProperty('appliedAllocations');
    expect(clearLoadManagementProfiles).toHaveBeenCalledWith(
      expect.arrayContaining(['STATION-001']),
      expect.anything(),
    );
    // The depot plan TxProfiles of the site are cleared too.
    expect(clearPlanProfilesOnDisable).toHaveBeenCalledWith(VALID_SITE_ID, expect.anything());
    // Load management never manages a conformance test station.
    const { isOperatorStation } = await import('@evtivity/database');
    expect(vi.mocked(isOperatorStation)).toHaveBeenCalled();
  });

  it('PUT /v1/sites/:id/load-management creates new config when none exists', async () => {
    setupDbResults(
      [],
      [
        {
          id: 1,
          siteId: VALID_SITE_ID,
          strategy: 'priority_based',
          isEnabled: true,
          departureBufferMinutes: 30,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
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
    expect(siteAuditMock).toHaveBeenCalledWith(expect.anything(), VALID_SITE_ID, {
      before: null,
      after: { strategy: 'priority_based', isEnabled: true, departureBufferMinutes: 30 },
      notes: 'load management configuration created',
    });
  });

  it('PATCH load-priority updates station priority', async () => {
    setupDbResults(
      [{ loadPriority: 3 }],
      [{ id: VALID_STATION_ID, stationId: 'STATION-001', loadPriority: 7 }],
    );
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
    expect(stationAuditMock).toHaveBeenCalledWith(expect.anything(), VALID_STATION_ID, {
      before: { loadPriority: 3 },
      after: { loadPriority: 7 },
      notes: 'load priority changed',
    });
  });

  it('PATCH load-priority with the same value writes no audit row', async () => {
    setupDbResults(
      [{ loadPriority: 7 }],
      [{ id: VALID_STATION_ID, stationId: 'STATION-001', loadPriority: 7 }],
    );
    const response = await app.inject({
      method: 'PATCH',
      url: `/sites/${VALID_SITE_ID}/stations/${VALID_STATION_ID}/load-priority`,
      headers: { authorization: `Bearer ${token}` },
      payload: { loadPriority: 7 },
    });
    expect(response.statusCode).toBe(200);
    expect(stationAuditMock).not.toHaveBeenCalled();
  });

  it('PATCH load-min-power sets and clears the station minimum', async () => {
    setupDbResults(
      [{ loadMinPowerKw: null }],
      [{ id: VALID_STATION_ID, stationId: 'STATION-001', loadMinPowerKw: '4.1' }],
    );
    const set = await app.inject({
      method: 'PATCH',
      url: `/sites/${VALID_SITE_ID}/stations/${VALID_STATION_ID}/load-min-power`,
      headers: { authorization: `Bearer ${token}` },
      payload: { loadMinPowerKw: 4.1 },
    });
    expect(set.statusCode).toBe(200);
    expect(JSON.parse(set.body).loadMinPowerKw).toBe(4.1);
    expect(stationAuditMock).toHaveBeenLastCalledWith(expect.anything(), VALID_STATION_ID, {
      before: { loadMinPowerKw: null },
      after: { loadMinPowerKw: 4.1 },
      notes: 'load minimum power changed',
    });

    setupDbResults(
      [{ loadMinPowerKw: '4.1' }],
      [{ id: VALID_STATION_ID, stationId: 'STATION-001', loadMinPowerKw: null }],
    );
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/sites/${VALID_SITE_ID}/stations/${VALID_STATION_ID}/load-min-power`,
      headers: { authorization: `Bearer ${token}` },
      payload: { loadMinPowerKw: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(JSON.parse(cleared.body).loadMinPowerKw).toBeNull();
    expect(stationAuditMock).toHaveBeenLastCalledWith(expect.anything(), VALID_STATION_ID, {
      before: { loadMinPowerKw: 4.1 },
      after: { loadMinPowerKw: null },
      notes: 'load minimum power changed',
    });

    const negative = await app.inject({
      method: 'PATCH',
      url: `/sites/${VALID_SITE_ID}/stations/${VALID_STATION_ID}/load-min-power`,
      headers: { authorization: `Bearer ${token}` },
      payload: { loadMinPowerKw: -1 },
    });
    expect(negative.statusCode).toBe(400);
  });

  it('PATCH load-min-power and load-priority refuse an OCPP station identifier', async () => {
    // The AI assistant sent the OCPP identifier (CS-0084) for the station: the
    // params schema refuses it before any write instead of a 404 after confirm.
    for (const [path, payload] of [
      ['load-min-power', { loadMinPowerKw: 7 }],
      ['load-priority', { loadPriority: 5 }],
    ] as const) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}/stations/CS-0084/${path}`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    const badSite = await app.inject({
      method: 'PATCH',
      url: `/sites/Community%20Center/stations/${VALID_STATION_ID}/load-min-power`,
      headers: { authorization: `Bearer ${token}` },
      payload: { loadMinPowerKw: 7 },
    });
    expect(badSite.statusCode).toBe(400);
  });

  it('PATCH load-priority returns 404 when station not found', async () => {
    setupDbResults([], []);
    const response = await app.inject({
      method: 'PATCH',
      url: `/sites/${VALID_SITE_ID}/stations/${VALID_STATION_ID}/load-priority`,
      headers: { authorization: `Bearer ${token}` },
      payload: { loadPriority: 5 },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('STATION_NOT_FOUND');
    expect(stationAuditMock).not.toHaveBeenCalled();
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

  // --- Depot charging plan (route-aware charging) ---

  const existingConfig = (strategy: string) => ({
    id: 1,
    siteId: VALID_SITE_ID,
    strategy,
    isEnabled: true,
    departureBufferMinutes: 30,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });

  it('GET /v1/sites/:id/charging-plan returns the plan view of the site', async () => {
    siteChargingPlanViewMock.mockResolvedValueOnce({ planning: false, departures: [] });
    const response = await app.inject({
      method: 'GET',
      url: `/sites/${VALID_SITE_ID}/charging-plan`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ planning: false, departures: [] });
    expect(siteChargingPlanViewMock).toHaveBeenCalledWith(
      VALID_SITE_ID,
      {
        departures: true,
        driverIds: true,
        sessionIds: true,
        sessionDriverIds: true,
        depotSystemNames: true,
      },
      expect.any(Date),
      'scheduled',
    );
  });

  it('GET charging-plan leaves out departures without fleets:read or with Fleet off, driver ids without drivers:read', async () => {
    const get = () =>
      app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/charging-plan`,
        headers: { authorization: `Bearer ${token}` },
      });
    siteChargingPlanViewMock.mockResolvedValue({ planning: false });
    try {
      requestHasPermissionMock.mockImplementation((permission: string) =>
        Promise.resolve(permission !== 'fleets:read' && permission !== 'drivers:read'),
      );
      await get();
      expect(siteChargingPlanViewMock).toHaveBeenLastCalledWith(
        VALID_SITE_ID,
        {
          departures: false,
          driverIds: false,
          sessionIds: true,
          sessionDriverIds: false,
          depotSystemNames: true,
        },
        expect.any(Date),
        'scheduled',
      );

      requestHasPermissionMock.mockImplementation((permission: string) =>
        Promise.resolve(permission !== 'drivers:read'),
      );
      await get();
      expect(siteChargingPlanViewMock).toHaveBeenLastCalledWith(
        VALID_SITE_ID,
        {
          departures: true,
          driverIds: false,
          sessionIds: true,
          sessionDriverIds: false,
          depotSystemNames: true,
        },
        expect.any(Date),
        'scheduled',
      );

      // Session ids, and session driver ids, need sessions:read.
      requestHasPermissionMock.mockImplementation((permission: string) =>
        Promise.resolve(permission !== 'sessions:read'),
      );
      await get();
      expect(siteChargingPlanViewMock).toHaveBeenLastCalledWith(
        VALID_SITE_ID,
        {
          departures: true,
          driverIds: true,
          sessionIds: false,
          sessionDriverIds: false,
          depotSystemNames: true,
        },
        expect.any(Date),
        'scheduled',
      );

      requestHasPermissionMock.mockImplementation(() => Promise.resolve(true));
      isFleetEnabledMock.mockResolvedValueOnce(false);
      await get();
      expect(siteChargingPlanViewMock).toHaveBeenLastCalledWith(
        VALID_SITE_ID,
        {
          departures: false,
          driverIds: true,
          sessionIds: true,
          sessionDriverIds: true,
          depotSystemNames: true,
        },
        expect.any(Date),
        'scheduled',
      );
    } finally {
      requestHasPermissionMock.mockImplementation(() => Promise.resolve(true));
      siteChargingPlanViewMock.mockReset();
    }
  });

  it('GET charging-plan strips the departure, vehicle and session ids of the stored plan by permission', async () => {
    const entry = {
      departureId: 'vdp_1',
      vehicleId: 'veh_1',
      sessionId: 'ses_1',
      stationDbId: 'sta_1',
      powerKw: [7],
    };
    siteChargingPlanViewMock.mockResolvedValue({ planning: true, departures: [], plan: [entry] });
    const planOf = async () =>
      (
        await app.inject({
          method: 'GET',
          url: `/sites/${VALID_SITE_ID}/charging-plan`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).json().plan as Record<string, unknown>[];
    try {
      expect(await planOf()).toEqual([entry]);

      requestHasPermissionMock.mockImplementation((permission: string) =>
        Promise.resolve(permission !== 'sessions:read'),
      );
      expect(await planOf()).toEqual([
        { departureId: 'vdp_1', vehicleId: 'veh_1', stationDbId: 'sta_1', powerKw: [7] },
      ]);

      requestHasPermissionMock.mockImplementation((permission: string) =>
        Promise.resolve(permission !== 'fleets:read'),
      );
      expect(await planOf()).toEqual([{ stationDbId: 'sta_1', powerKw: [7] }]);
    } finally {
      requestHasPermissionMock.mockImplementation(() => Promise.resolve(true));
      siteChargingPlanViewMock.mockReset();
    }
  });

  it('POST .../charging-plan/recalculate marks the plan stale, audits and answers 202', async () => {
    markSitePlanStaleMock.mockClear();
    const response = await app.inject({
      method: 'POST',
      url: `/sites/${VALID_SITE_ID}/charging-plan/recalculate`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(202);
    expect(markSitePlanStaleMock).toHaveBeenCalledWith(
      VALID_SITE_ID,
      'manual_recalculate',
      expect.anything(),
      { departureAwareOnly: true },
    );
    expect(siteAuditMock).toHaveBeenCalledWith(expect.anything(), VALID_SITE_ID, {
      before: null,
      after: { chargingPlan: 'recalculate_requested' },
      notes: 'depot charging plan recalculation requested',
    });
  });

  it('limits recalculations to 6 a minute per user', async () => {
    const limited = Fastify();
    await limited.register(rateLimit, { global: false });
    await registerAuth(limited);
    loadManagementRoutes(limited);
    await limited.ready();
    try {
      const post = (userId: string) =>
        limited.inject({
          method: 'POST',
          url: `/sites/${VALID_SITE_ID}/charging-plan/recalculate`,
          headers: {
            authorization: `Bearer ${limited.jwt.sign({ userId, roleId: VALID_ROLE_ID })}`,
          },
        });
      for (let i = 0; i < 6; i++) {
        expect((await post(VALID_USER_ID)).statusCode).toBe(202);
      }
      expect((await post(VALID_USER_ID)).statusCode).toBe(429);
      // Another user keeps a budget of its own.
      expect((await post('usr_000000000002')).statusCode).toBe(202);
    } finally {
      await limited.close();
    }
  });

  it('refuses a recalculation and a switch to departure_aware while fleet charging is off', async () => {
    isFleetChargingEnabledMock.mockResolvedValue(false);
    try {
      markSitePlanStaleMock.mockClear();
      const recalc = await app.inject({
        method: 'POST',
        url: `/sites/${VALID_SITE_ID}/charging-plan/recalculate`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(recalc.statusCode).toBe(400);
      expect(recalc.json().code).toBe('FLEET_CHARGING_DISABLED');
      expect(markSitePlanStaleMock).not.toHaveBeenCalled();

      setupDbResults([existingConfig('equal_share')]);
      const put = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/load-management`,
        headers: { authorization: `Bearer ${token}` },
        payload: { strategy: 'departure_aware', isEnabled: true },
      });
      expect(put.statusCode).toBe(400);
      expect(put.json().code).toBe('FLEET_CHARGING_DISABLED');
      expect(siteAuditMock).not.toHaveBeenCalled();

      // A site already on Departure Aware keeps saving its other fields.
      setupDbResults(
        [existingConfig('departure_aware')],
        [{ ...existingConfig('departure_aware'), departureBufferMinutes: 60 }],
      );
      const kept = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/load-management`,
        headers: { authorization: `Bearer ${token}` },
        payload: { strategy: 'departure_aware', isEnabled: true, departureBufferMinutes: 60 },
      });
      expect(kept.statusCode).toBe(200);
      expect(kept.json().departureBufferMinutes).toBe(60);
      expect(siteAuditMock).toHaveBeenCalledWith(expect.anything(), VALID_SITE_ID, {
        before: { departureBufferMinutes: 30 },
        after: { departureBufferMinutes: 60 },
        notes: 'load management configuration updated',
      });
    } finally {
      isFleetChargingEnabledMock.mockResolvedValue(true);
    }
  });

  it('refuses a departure buffer outside 0 to 180 minutes', async () => {
    for (const departureBufferMinutes of [-1, 181, 1.5]) {
      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/load-management`,
        headers: { authorization: `Bearer ${token}` },
        payload: { strategy: 'equal_share', isEnabled: true, departureBufferMinutes },
      });
      expect(response.statusCode).toBe(400);
    }
  });
});
