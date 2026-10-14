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

import { registerAuth } from '../plugins/auth.js';
import { loadManagementRoutes } from '../routes/load-management.js';
import { getUserSiteIds } from '../lib/site-access.js';
import {
  buildSiteHierarchy,
  computeHierarchicalAllocation,
} from '@evtivity/services/load-management.service';

const SITE = 'sit_000000000001';
const OTHER_SITE = 'sit_000000000009';

function station(id: string, draw: number, max: number) {
  return {
    id,
    stationId: `CS-${id}`,
    circuitId: 'cir_1',
    currentDrawKw: draw,
    maxPowerKw: max,
    loadPriority: 5,
    isOnline: true,
    hasActiveSession: draw > 0,
    minPowerKw: 0,
    rateUnit: 'W',
  };
}

function node(over: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'panel',
    id: 'pnl_1',
    name: 'Main',
    maxContinuousKw: 100,
    safetyMarginKw: 10,
    unmanagedLoadKw: 10,
    currentDrawKw: 30,
    stations: [],
    children: [],
    phases: 3,
    breakerRatingAmps: 200,
    voltageV: 400,
    oversubscriptionRatio: 1,
    phaseConnections: null,
    phaseLoad: null,
    perPhaseCapacityKw: null,
    ...over,
  };
}

describe('Load management routes (hierarchy and site scope)', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    loadManagementRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.mocked(getUserSiteIds).mockResolvedValue(null);
    vi.mocked(buildSiteHierarchy).mockResolvedValue([]);
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  it('annotates panels, circuits, and child panels and applies allocations when enabled', async () => {
    const circuit = node({
      type: 'circuit',
      id: 'cir_1',
      name: 'Circuit A',
      maxContinuousKw: 40,
      safetyMarginKw: 0,
      unmanagedLoadKw: 5,
      currentDrawKw: 25,
      stations: [station('sit_000000000001', 25, 22), station('sit_000000000002', 0, 11)],
      phaseConnections: 'L1',
    });
    // Child panel: effective 10 - 5 = 5, draw 2 (its unmanaged load included)
    const childPanel = node({
      id: 'pnl_2',
      name: 'Sub',
      maxContinuousKw: 10,
      safetyMarginKw: 5,
      unmanagedLoadKw: 5,
      currentDrawKw: 2,
    });
    const root = node({ children: [circuit, childPanel] });
    vi.mocked(buildSiteHierarchy).mockResolvedValue([root] as never);
    setupDbResults([{ strategy: 'priority_based', isEnabled: true }]);

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE}/load-management`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.config).toEqual({ strategy: 'priority_based', isEnabled: true });
    expect(computeHierarchicalAllocation).toHaveBeenCalledWith([root], 'priority_based');

    const panel = body.hierarchy[0];
    // The draw already holds the panel's unmanaged load, so it is not taken off
    // the capacity again: effective = 100 - 10 = 90, available = 90 - 30 = 60.
    expect(panel.availableKw).toBe(60);
    expect(panel.utilization).toBeCloseTo(30 / 90);
    expect(panel.totalConnectedKw).toBe(33);
    expect(panel.circuits).toHaveLength(1);
    expect(panel.circuits[0]).toMatchObject({
      id: 'cir_1',
      name: 'Circuit A',
      // the draw 25 holds the 5 kW unmanaged load: 40 - 25 = 15
      availableKw: 15,
      phaseConnections: 'L1',
      unmanagedLoads: [],
    });
    expect(panel.circuits[0].stations[0]).toMatchObject({
      id: 'sit_000000000001',
      allocatedLimitKw: null,
      maxPowerKw: 22,
    });
    expect(panel.childPanels).toHaveLength(1);
    expect(panel.childPanels[0]).toMatchObject({
      id: 'pnl_2',
      availableKw: 3,
      utilization: 0.4,
      circuits: [],
      childPanels: [],
    });

    const stations = body.stations as { id: string; allocatedLimitKw: number | null }[];
    expect(stations.find((s) => s.id === 'sit_000000000001')?.allocatedLimitKw).toBe(45);
    expect(stations.find((s) => s.id === 'sit_000000000002')?.allocatedLimitKw).toBeNull();
  });

  it('caps utilization at 1 when the panel is over its effective capacity', async () => {
    vi.mocked(buildSiteHierarchy).mockResolvedValue([
      node({ maxContinuousKw: 50, safetyMarginKw: 0, unmanagedLoadKw: 0, currentDrawKw: 80 }),
    ] as never);
    setupDbResults([]);
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE}/load-management`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hierarchy[0]).toMatchObject({ utilization: 1, availableKw: 0 });
    expect(res.json().config).toBeNull();
  });

  it('GET returns 404 SITE_NOT_FOUND for a site outside the user scope', async () => {
    vi.mocked(getUserSiteIds).mockResolvedValue([OTHER_SITE]);
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE}/load-management`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
    expect(buildSiteHierarchy).not.toHaveBeenCalled();
  });

  it('PUT returns 404 SITE_NOT_FOUND for a site outside the user scope', async () => {
    vi.mocked(getUserSiteIds).mockResolvedValue([OTHER_SITE]);
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE}/load-management`,
      headers: auth(),
      payload: { strategy: 'equal_share', isEnabled: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
  });

  it('PATCH load-priority returns 404 STATION_NOT_FOUND for a site outside the user scope', async () => {
    vi.mocked(getUserSiteIds).mockResolvedValue([OTHER_SITE]);
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE}/stations/sta_000000000001/load-priority`,
      headers: auth(),
      payload: { loadPriority: 2 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
  });

  it('history returns 404 SITE_NOT_FOUND for a site outside the user scope', async () => {
    vi.mocked(getUserSiteIds).mockResolvedValue([OTHER_SITE]);
    setupDbResults([
      {
        id: 1,
        siteLimitKw: '100',
        totalDrawKw: '50',
        availableKw: '50',
        strategy: 'equal_share',
        createdAt: new Date(),
      },
    ]);
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE}/load-management/history`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
  });
});
