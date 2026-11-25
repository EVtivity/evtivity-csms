// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { state, tree, siteIdsMock, markSitePlanStaleMock } = vi.hoisted(() => {
  class LoadTreeValidationError extends Error {
    public readonly field: string;
    public readonly statusCode = 400;
    public readonly code = 'VALIDATION_ERROR';
    constructor(message: string, field: string) {
      super(message);
      this.field = field;
    }
  }
  return {
    state: { results: [] as unknown[][], index: 0 },
    tree: {
      LoadTreeValidationError,
      setUnitLoadBudget: vi.fn(),
      clearUnitLoadBudget: vi.fn(),
      readUnitLoadBudgets: vi.fn(),
      readStationUnits: vi.fn(),
      unitChargingKind: vi.fn(),
      circuitPhaseDefault: vi.fn(),
    },
    siteIdsMock: vi.fn(),
    markSitePlanStaleMock: vi.fn(),
  };
});

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = state.results[state.index] ?? [];
    state.index++;
    return Promise.resolve(r).then(resolve, reject);
  };
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()) },
  chargingStations: {},
  markSitePlanStale: markSitePlanStaleMock,
  ...tree,
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn() }));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: siteIdsMock,
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
import { unitLoadBudgetRoutes } from '../routes/unit-load-budgets.js';

const SITE = 'sit_000000000001';
const STATION = 'sta_000000000001';
const UNIT = 'unt_000000000001';
const USER = 'usr_000000000001';
const BUDGET_URL = `/sites/${SITE}/stations/${STATION}/units/${UNIT}/load-budget`;

const acBudget = {
  unitId: UNIT,
  stationId: STATION,
  kind: 'ac',
  maxCurrentA: 32,
  phases: 3,
  maxPowerKw: null,
};

describe('Station Unit budget routes', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    unitLoadBudgetRoutes(app);
    await app.ready();
    auth = { authorization: `Bearer ${app.jwt.sign({ userId: USER, roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.results = [];
    state.index = 0;
    siteIdsMock.mockReset().mockResolvedValue(null);
    for (const fn of Object.values(tree)) {
      if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
    }
    markSitePlanStaleMock.mockReset().mockResolvedValue(true);
  });

  it('GET lists the units with their kind and budget', async () => {
    state.results = [[{ id: STATION, circuitId: 'cir_1' }]];
    tree.readStationUnits.mockResolvedValue([
      { id: UNIT, name: 'Box 1', evseNumbers: [1, 2] },
      { id: 'unt_000000000002', name: 'Box 2', evseNumbers: [3, 4] },
    ]);
    tree.readUnitLoadBudgets.mockResolvedValue([acBudget]);
    tree.circuitPhaseDefault.mockResolvedValue(3);
    tree.unitChargingKind.mockResolvedValueOnce('ac').mockResolvedValueOnce('mixed');
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE}/stations/${STATION}/unit-budgets`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      stationId: STATION,
      defaultPhases: 3,
      units: [
        {
          unitId: UNIT,
          name: 'Box 1',
          evseNumbers: [1, 2],
          chargingKind: 'ac',
          budget: { unitId: UNIT, kind: 'ac', maxCurrentA: 32, phases: 3, maxPowerKw: null },
        },
        {
          unitId: 'unt_000000000002',
          name: 'Box 2',
          evseNumbers: [3, 4],
          chargingKind: 'mixed',
          budget: null,
        },
      ],
    });
  });

  it('answers SITE_NOT_FOUND outside the caller sites and STATION_NOT_FOUND for another site', async () => {
    siteIdsMock.mockResolvedValue(['sit_000000000009']);
    const out = await app.inject({
      method: 'GET',
      url: `/sites/${SITE}/stations/${STATION}/unit-budgets`,
      headers: auth,
    });
    expect(out.statusCode).toBe(404);
    expect(out.json().code).toBe('SITE_NOT_FOUND');
    siteIdsMock.mockResolvedValue(null);
    state.results = [[]];
    const other = await app.inject({
      method: 'GET',
      url: `/sites/${SITE}/stations/${STATION}/unit-budgets`,
      headers: auth,
    });
    expect(other.statusCode).toBe(404);
    expect(other.json().code).toBe('STATION_NOT_FOUND');
  });

  it('PUT stores an AC budget in the caller name and marks the plan stale', async () => {
    tree.setUnitLoadBudget.mockResolvedValue({ ok: true, changed: true, budget: acBudget });
    const res = await app.inject({
      method: 'PUT',
      url: BUDGET_URL,
      headers: auth,
      payload: { kind: 'ac', maxCurrentA: 32 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'ac', maxCurrentA: 32, phases: 3, changed: true });
    expect(tree.setUnitLoadBudget).toHaveBeenCalledWith(
      { siteId: SITE, stationId: STATION, unitId: UNIT, budget: { kind: 'ac', maxCurrentA: 32 } },
      expect.objectContaining({ actor: 'operator', actorUserId: USER }),
    );
    await vi.waitFor(() =>
      expect(markSitePlanStaleMock).toHaveBeenCalledWith(
        SITE,
        'unit_budget_changed',
        expect.anything(),
        { departureAwareOnly: true },
      ),
    );
  });

  it.each([
    [{ kind: 'ac' }, 'maxCurrentA'],
    [{ kind: 'ac', maxCurrentA: 32.25 }, 'maxCurrentA'],
    [{ kind: 'ac', maxCurrentA: 32, maxPowerKw: 10 }, 'maxPowerKw'],
    [{ kind: 'dc' }, 'maxPowerKw'],
    [{ kind: 'dc', maxPowerKw: 50.125 }, 'maxPowerKw'],
    [{ kind: 'dc', maxPowerKw: 50, phases: 3 }, 'phases'],
  ])('PUT refuses %j naming %s', async (payload, field) => {
    const res = await app.inject({ method: 'PUT', url: BUDGET_URL, headers: auth, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR', field });
    expect(tree.setUnitLoadBudget).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'ac', maxCurrentA: 5 }],
    // 80 percent of a 7.4 A fuse is below the 6 A an AC session needs.
    [{ kind: 'ac', maxCurrentA: 7.4 }],
    [{ kind: 'ac', maxCurrentA: 32, phases: 2 }],
    [{ kind: 'dc', maxPowerKw: 0 }],
    [{ kind: 'dc', maxPowerKw: 5000.01 }],
  ])('PUT refuses an out of range %j by schema', async (payload) => {
    const res = await app.inject({ method: 'PUT', url: BUDGET_URL, headers: auth, payload });
    expect(res.statusCode).toBe(400);
    expect(tree.setUnitLoadBudget).not.toHaveBeenCalled();
  });

  it.each([
    ['mixed_unit', 400, 'UNIT_LOAD_BUDGET_MIXED_UNIT'],
    ['kind_mismatch', 400, 'UNIT_LOAD_BUDGET_KIND_MISMATCH'],
    ['station_not_found', 404, 'STATION_NOT_FOUND'],
    ['unit_not_found', 404, 'STATION_UNIT_NOT_FOUND'],
  ])('PUT answers the writer refusal %s', async (reason, status, code) => {
    tree.setUnitLoadBudget.mockResolvedValue({ ok: false, reason });
    const res = await app.inject({
      method: 'PUT',
      url: BUDGET_URL,
      headers: auth,
      payload: { kind: 'dc', maxPowerKw: 50 },
    });
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
  });

  it('PUT answers a phases refusal of the writer with the field', async () => {
    tree.setUnitLoadBudget.mockRejectedValue(
      new tree.LoadTreeValidationError('The station is on no circuit', 'phases'),
    );
    const res = await app.inject({
      method: 'PUT',
      url: BUDGET_URL,
      headers: auth,
      payload: { kind: 'ac', maxCurrentA: 16 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR', field: 'phases' });
  });

  it('DELETE removes the budget and answers a unit of another station', async () => {
    tree.clearUnitLoadBudget.mockResolvedValue({ ok: true, removed: true });
    const res = await app.inject({ method: 'DELETE', url: BUDGET_URL, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: true });
    tree.clearUnitLoadBudget.mockResolvedValue({ ok: false, reason: 'unit_not_found' });
    const missing = await app.inject({ method: 'DELETE', url: BUDGET_URL, headers: auth });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('STATION_UNIT_NOT_FOUND');
  });
});
