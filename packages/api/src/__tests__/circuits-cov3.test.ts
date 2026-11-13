// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const h = vi.hoisted(() => {
  const state = { results: [] as unknown[][], index: 0, sets: [] as unknown[] };
  function chain(): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'innerJoin', 'leftJoin', 'returning']) {
      c[m] = () => c;
    }
    c['set'] = (v: unknown) => {
      state.sets.push(v);
      return c;
    };
    let result: unknown[] | undefined;
    c['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
      if (result === undefined) {
        result = state.results[state.index] ?? [];
        state.index++;
      }
      return Promise.resolve(result).then(resolve, reject);
    };
    return c;
  }
  return {
    state,
    chain,
    createCircuit: vi.fn(),
    updateCircuit: vi.fn(),
    deleteCircuit: vi.fn(),
    writeAudit: vi.fn(),
    markSitePlanStale: vi.fn(),
    getUserSiteIds: vi.fn(),
  };
});

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
  db: { select: vi.fn(() => h.chain()), update: vi.fn(() => h.chain()) },
  panels: {},
  circuits: {},
  chargingStations: {},
  connectors: {},
  evses: {},
  createCircuit: h.createCircuit,
  updateCircuit: h.updateCircuit,
  deleteCircuit: h.deleteCircuit,
  markSitePlanStale: h.markSitePlanStale,
  writeAudit: h.writeAudit,
  siteAuditLog: { name: 'site_audit_log' },
  stationAuditLog: { name: 'station_audit_log' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

vi.mock('../lib/site-access.js', () => ({ getUserSiteIds: h.getUserSiteIds }));
vi.mock('../middleware/rbac.js', () => ({
  authorize: () => async (request: { jwtVerify: () => Promise<void> }) => {
    await request.jwtVerify();
  },
}));

import { registerAuth } from '../plugins/auth.js';
import { circuitRoutes } from '../routes/circuits.js';

const SITE = 'sit_a';
const T = '2026-01-01T00:00:00.000Z';
const panel = { id: 'pnl_a', siteId: SITE, voltageV: 240, phases: 1 };
const circuitRow = {
  id: 'cir_a',
  panelId: 'pnl_a',
  name: 'Bay 1',
  breakerRatingAmps: 40,
  maxContinuousKw: '7.68',
  phaseConnections: null as string | null,
  voltageV: null as number | null,
  sortOrder: 0,
  createdAt: T,
  updatedAt: T,
};

let app: FastifyInstance;
let auth: Record<string, string>;

beforeAll(async () => {
  app = Fastify();
  await registerAuth(app);
  app.register(async (instance) => {
    circuitRoutes(instance);
  });
  await app.ready();
  auth = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' })}` };
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.state.results = [];
  h.state.index = 0;
  h.state.sets = [];
  h.getUserSiteIds.mockResolvedValue(null);
  h.markSitePlanStale.mockResolvedValue(undefined);
  h.writeAudit.mockResolvedValue(undefined);
});

function results(...r: unknown[][]): void {
  h.state.results = r;
  h.state.index = 0;
}

function send(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: auth,
    ...(payload != null ? { payload: payload as Record<string, unknown> } : {}),
  });
}

const base = `/sites/${SITE}/panels/pnl_a/circuits`;

describe('POST circuits', () => {
  it('answers 404 outside the scope and for a panel of another site', async () => {
    h.getUserSiteIds.mockResolvedValue(['sit_other']);
    expect((await send('POST', base, { name: 'C', breakerRatingAmps: 20 })).statusCode).toBe(404);
    h.getUserSiteIds.mockResolvedValue(null);
    results([]);
    const res = await send('POST', base, { name: 'C', breakerRatingAmps: 20 });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('PANEL_NOT_FOUND');
    expect(h.createCircuit).not.toHaveBeenCalled();
  });

  it('refuses a circuit voltage above the panel voltage', async () => {
    results([{ ...panel, voltageV: 120 }]);
    const res = await send('POST', base, { name: 'C', breakerRatingAmps: 20, voltageV: 240 });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('circuit voltage is allowed only');
  });

  it('creates a 120 V branch with its computed capacity', async () => {
    results([panel]);
    h.createCircuit.mockResolvedValue({ ...circuitRow, voltageV: 120, maxContinuousKw: '1.92' });
    const res = await send('POST', base, {
      name: 'C',
      breakerRatingAmps: 20,
      voltageV: 120,
      phaseConnections: 'L1',
      sortOrder: 2,
    });
    expect(res.statusCode).toBe(201);
    expect(h.createCircuit).toHaveBeenCalledWith(
      SITE,
      expect.objectContaining({
        panelId: 'pnl_a',
        voltageV: 120,
        phaseConnections: 'L1',
        sortOrder: 2,
        maxContinuousKw: '1.92',
      }),
      expect.anything(),
    );
    expect(res.json()).toMatchObject({ maxContinuousKw: 1.92, stationCount: 0 });
  });

  it('answers 500 CREATE_FAILED when the writer returns no row', async () => {
    results([panel]);
    h.createCircuit.mockResolvedValue(undefined);
    const res = await send('POST', base, { name: 'C', breakerRatingAmps: 20 });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ code: string }>().code).toBe('CREATE_FAILED');
  });
});

describe('GET circuits', () => {
  it('answers 404 outside the scope', async () => {
    h.getUserSiteIds.mockResolvedValue([]);
    const res = await send('GET', base);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('SITE_NOT_FOUND');
  });

  it('lists the circuits with numeric capacities', async () => {
    results([{ ...circuitRow, stationCount: 3 }]);
    const res = await send('GET', base);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ id: 'cir_a', maxContinuousKw: 7.68, stationCount: 3 }),
    ]);
  });
});

describe('PATCH circuits', () => {
  const url = `${base}/cir_a`;

  it('answers 404 outside the scope, for an unknown panel and an unknown circuit', async () => {
    h.getUserSiteIds.mockResolvedValue(['sit_other']);
    expect((await send('PATCH', url, { name: 'X' })).statusCode).toBe(404);
    h.getUserSiteIds.mockResolvedValue(null);
    results([]);
    expect((await send('PATCH', url, { name: 'X' })).json<{ code: string }>().code).toBe(
      'CIRCUIT_NOT_FOUND',
    );
    results([panel], []);
    expect((await send('PATCH', url, { name: 'X' })).statusCode).toBe(404);
    expect(h.updateCircuit).not.toHaveBeenCalled();
  });

  it('refuses a circuit voltage on a three-phase panel', async () => {
    results([{ ...panel, phases: 3, voltageV: 277 }], [circuitRow]);
    const res = await send('PATCH', url, { voltageV: 120 });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('VALIDATION_ERROR');
  });

  it('recomputes the capacity from the stored values the body leaves out', async () => {
    results([panel], [{ ...circuitRow, voltageV: 120, phaseConnections: 'L1' }], [{ count: 2 }]);
    h.updateCircuit.mockResolvedValue({
      ...circuitRow,
      breakerRatingAmps: 30,
      maxContinuousKw: '2.88',
    });
    const res = await send('PATCH', url, { breakerRatingAmps: 30, name: 'New', sortOrder: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ maxContinuousKw: 2.88, stationCount: 2 });
    const arg = h.updateCircuit.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    // 30 A at the stored 120 V: 2.88 kW.
    expect(arg.set).toMatchObject({
      name: 'New',
      breakerRatingAmps: 30,
      sortOrder: 1,
      maxContinuousKw: '2.88',
    });
    expect(arg.set).not.toHaveProperty('voltageV');
    expect(arg.set).not.toHaveProperty('phaseConnections');
  });

  it('puts the circuit back on the panel voltage and phases', async () => {
    results([panel], [{ ...circuitRow, voltageV: 120, phaseConnections: 'L1' }], []);
    h.updateCircuit.mockResolvedValue(circuitRow);
    const res = await send('PATCH', url, { voltageV: null, phaseConnections: null });
    expect(res.statusCode).toBe(200);
    // No count row: 0 stations.
    expect(res.json<{ stationCount: number }>().stationCount).toBe(0);
    const arg = h.updateCircuit.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    expect(arg.set).toMatchObject({
      voltageV: null,
      phaseConnections: null,
      maxContinuousKw: '7.68',
    });
  });

  it('writes no capacity for a rename and answers 404 when no row changed', async () => {
    results([panel], [circuitRow]);
    h.updateCircuit.mockResolvedValue(undefined);
    const res = await send('PATCH', url, { name: 'X' });
    expect(res.statusCode).toBe(404);
    const arg = h.updateCircuit.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    expect(arg.set).not.toHaveProperty('maxContinuousKw');
  });
});

describe('DELETE circuits', () => {
  const url = `${base}/cir_a`;

  it('answers 404 outside the scope and for an unknown circuit', async () => {
    h.getUserSiteIds.mockResolvedValue(['sit_other']);
    expect((await send('DELETE', url)).statusCode).toBe(404);
    h.getUserSiteIds.mockResolvedValue(null);
    results([]);
    const res = await send('DELETE', url);
    expect(res.json<{ code: string }>().code).toBe('CIRCUIT_NOT_FOUND');
    expect(h.deleteCircuit).not.toHaveBeenCalled();
  });

  it('deletes the circuit through the writer', async () => {
    results([circuitRow]);
    const res = await send('DELETE', url);
    expect(res.statusCode).toBe(200);
    expect(h.deleteCircuit).toHaveBeenCalledWith(
      { siteId: SITE, circuit: circuitRow },
      expect.anything(),
    );
  });
});

describe('PATCH station circuit', () => {
  const url = `/sites/${SITE}/stations/sta_1/circuit`;
  const station = { id: 'sta_1', stationId: 'CS-1', siteId: SITE, circuitId: null };

  it('answers 404 outside the scope, for an unknown station and one of another site', async () => {
    h.getUserSiteIds.mockResolvedValue(['sit_other']);
    expect((await send('PATCH', url, { circuitId: 'cir_a' })).statusCode).toBe(404);
    h.getUserSiteIds.mockResolvedValue(null);
    results([]);
    expect((await send('PATCH', url, { circuitId: 'cir_a' })).statusCode).toBe(404);
    results([{ ...station, siteId: 'sit_other' }]);
    const res = await send('PATCH', url, { circuitId: 'cir_a' });
    expect(res.json<{ code: string }>().code).toBe('STATION_NOT_FOUND');
  });

  it('answers 400 INVALID_CIRCUIT for a circuit outside the site', async () => {
    results([station], []);
    const res = await send('PATCH', url, { circuitId: 'cir_x' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_CIRCUIT');
    expect(h.state.sets).toHaveLength(0);
  });

  it('refuses an assignment past the panel effective capacity', async () => {
    results(
      [station],
      [
        {
          id: 'cir_a',
          panelId: 'pnl_a',
          panelMaxKw: '10',
          panelOversubRatio: '1.5',
          panelSiteId: SITE,
        },
      ],
      [{ id: 'cir_a' }],
      [{ id: 'sta_2' }],
      [
        { stationId: 'sta_1', maxPowerKw: '11' },
        { stationId: 'sta_2', maxPowerKw: '7' },
        { stationId: 'sta_2', maxPowerKw: null },
      ],
    );
    const res = await send('PATCH', url, { circuitId: 'cir_a' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Total connected capacity (18.0 kW) exceeds panel effective capacity (15.0 kW)',
      code: 'OVERSUBSCRIPTION_EXCEEDED',
    });
    expect(h.state.sets).toHaveLength(0);
  });

  it('assigns within the oversubscription with a warning header and audits the change', async () => {
    results(
      [station],
      [
        {
          id: 'cir_a',
          panelId: 'pnl_a',
          panelMaxKw: '10',
          panelOversubRatio: '2',
          panelSiteId: SITE,
        },
      ],
      [],
      [],
      [{ stationId: 'sta_1', maxPowerKw: '12' }],
      [{ id: 'sta_1', stationId: 'CS-1', circuitId: 'cir_a' }],
    );
    const res = await send('PATCH', url, { circuitId: 'cir_a' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-oversubscription-warning']).toBe('true');
    expect(res.json()).toEqual({ id: 'sta_1', stationId: 'CS-1', circuitId: 'cir_a' });
    expect(h.state.sets[0]).toMatchObject({ circuitId: 'cir_a' });
    expect(h.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ idColumn: 'station_id' }),
      expect.objectContaining({
        entityId: 'sta_1',
        action: 'updated',
        before: { circuitId: null },
        after: { circuitId: 'cir_a' },
        notes: 'assigned to circuit',
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(h.markSitePlanStale).toHaveBeenCalledWith(
      SITE,
      'station_circuit_changed',
      expect.anything(),
      { departureAwareOnly: true },
    );
  });

  it('answers 404 when the station moved before the write', async () => {
    results([station], []);
    const res = await send('PATCH', url, { circuitId: null });
    expect(res.statusCode).toBe(404);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });
});
