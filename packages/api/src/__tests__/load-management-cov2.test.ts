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
  markSitePlanStale: vi.fn().mockResolvedValue(true),
  isFleetChargingEnabled: () => isFleetChargingEnabledMock() as unknown,
  isFleetEnabled: () => isFleetEnabledMock() as unknown,
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
  // Without a supply credit the capacity is the rating less the margin.
  nodeCapacityKw: vi.fn(
    (n: { maxContinuousKw: number; safetyMarginKw: number; supplyCreditKw?: number }) =>
      n.maxContinuousKw - n.safetyMarginKw + (n.supplyCreditKw ?? 0),
  ),
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
  computeSiteAllocation,
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
    setupDbResults([{ strategy: 'priority_based', isEnabled: true, departureBufferMinutes: 45 }]);

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE}/load-management`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.config).toEqual({
      strategy: 'priority_based',
      isEnabled: true,
      departureBufferMinutes: 45,
    });
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

  it('marks a station whose limit is power kept for it, not a limit sent', async () => {
    const circuit = node({
      type: 'circuit',
      id: 'cir_1',
      name: 'Circuit A',
      maxContinuousKw: 40,
      safetyMarginKw: 0,
      stations: [station('sit_000000000001', 10, 22), station('sit_000000000002', 0, 100)],
    });
    const root = node({ children: [circuit] });
    vi.mocked(buildSiteHierarchy).mockResolvedValue([root] as never);
    vi.mocked(computeSiteAllocation).mockImplementationOnce(async () => ({
      status: {
        totalDrawKw: 10,
        stations: [station('sit_000000000001', 10, 22), station('sit_000000000002', 0, 100)],
      } as never,
      hierarchy: [root] as never,
      managed: [],
      // Offline with a session: kept at its maximum, above its circuit.
      reservedKw: new Map([['sit_000000000002', 100]]),
      allocations: [{ stationDbId: 'sit_000000000001', allocatedKw: 30 }] as never,
      baseKw: new Map(),
      creditValidToMs: null,
    }));
    setupDbResults([{ strategy: 'equal_share', isEnabled: true, departureBufferMinutes: 30 }]);

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE}/load-management`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const stations = res.json().stations as {
      id: string;
      allocatedLimitKw: number | null;
      limitReserved: boolean;
    }[];
    expect(stations.find((s) => s.id === 'sit_000000000001')).toMatchObject({
      allocatedLimitKw: 30,
      limitReserved: false,
    });
    expect(stations.find((s) => s.id === 'sit_000000000002')).toMatchObject({
      allocatedLimitKw: 100,
      limitReserved: true,
    });
  });

  it('returns transformer nodes with their supply credit and assets', async () => {
    const sub = node({ id: 'pnl_sub', name: 'Sub', maxContinuousKw: 50, safetyMarginKw: 0 });
    const stepDown = node({
      type: 'transformer',
      transformerKind: 'step_down',
      id: 'tfm_sd',
      name: 'Step Down',
      maxContinuousKw: 70,
      safetyMarginKw: 0,
      supplyCreditKw: 20,
      children: [sub],
    });
    const board = node({
      id: 'pnl_main',
      maxContinuousKw: 200,
      safetyMarginKw: 0,
      currentDrawKw: 10,
      supplyLoadKw: 10,
      children: [stepDown],
      energyAssets: [
        {
          id: 'ena_1',
          name: 'Battery',
          type: 'battery',
          phases: 3,
          telemetry: 'api',
          connection: 'panel',
          state: 'stale',
          creditKw: 0,
          loadKw: 10,
          creditApplied: false,
          readingReceivedAt: new Date('2026-11-03T12:00:00Z'),
          socPercent: 50,
        },
      ],
    });
    const service = node({
      type: 'transformer',
      transformerKind: 'service',
      id: 'tfm_svc',
      name: 'Service',
      maxContinuousKw: 285,
      safetyMarginKw: 0,
      currentDrawKw: 10,
      supplyCreditKw: 20,
      children: [board],
    });
    vi.mocked(buildSiteHierarchy).mockResolvedValue([service] as never);
    setupDbResults([{ strategy: 'equal_share', isEnabled: true, departureBufferMinutes: 30 }]);

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE}/load-management`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const root = res.json().hierarchy[0];
    // The credit raises the capacity: 285 + 20 - 10 drawn.
    expect(root).toMatchObject({
      type: 'transformer',
      transformerKind: 'service',
      supplyCreditKw: 20,
      availableKw: 295,
    });
    const main = root.childPanels[0];
    expect(main).toMatchObject({ id: 'pnl_main', supplyLoadKw: 10 });
    expect(main.energyAssets[0]).toEqual({
      id: 'ena_1',
      name: 'Battery',
      type: 'battery',
      connection: 'panel',
      supply: {
        state: 'stale',
        creditKw: 0,
        loadKw: 10,
        creditApplied: false,
        readingReceivedAt: '2026-11-03T12:00:00.000Z',
        socPercent: 50,
      },
    });
    expect(main.childPanels[0]).toMatchObject({ type: 'transformer', id: 'tfm_sd' });
    expect(main.childPanels[0].childPanels[0]).toMatchObject({ type: 'panel', id: 'pnl_sub' });
  });

  it('builds its route schemas without a recursive reference warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fresh = Fastify();
    try {
      await registerAuth(fresh);
      loadManagementRoutes(fresh);
      await fresh.ready();
    } finally {
      await fresh.close();
      warn.mockRestore();
    }
    const recursive = warn.mock.calls.filter((args) =>
      String(args[0]).includes('Recursive reference'),
    );
    expect(recursive).toEqual([]);
  });

  it('returns sub-panels nested below a sub-panel with every field', async () => {
    const grandchild = node({ id: 'pnl_3', name: 'Sub Sub', maxContinuousKw: 6 });
    const child = node({ id: 'pnl_2', name: 'Sub', children: [grandchild] });
    vi.mocked(buildSiteHierarchy).mockResolvedValue([node({ children: [child] })] as never);
    setupDbResults([]);
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE}/load-management`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const nested = res.json().hierarchy[0].childPanels[0].childPanels[0];
    expect(nested).toMatchObject({
      id: 'pnl_3',
      name: 'Sub Sub',
      maxContinuousKw: 6,
      circuits: [],
      childPanels: [],
      unmanagedLoads: [],
    });
    expect(typeof nested.availableKw).toBe('number');
    expect(typeof nested.utilization).toBe('number');
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
