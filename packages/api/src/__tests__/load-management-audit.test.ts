// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Every load management write (panel, circuit, unmanaged load, station circuit
// assignment) records an audit row: the site `load_management_changed` row or
// the station `updated` row. Unmanaged loads and station assignments write it
// through the real helpers into a mocked writeAudit; panels and circuits go
// through the `@evtivity/database` tree writer (mocked here, its audit rows are
// covered by the database package test), called in the request's name.

const { state, writeAuditMock, markSitePlanStaleMock, tree } = vi.hoisted(() => ({
  state: { results: [] as unknown[][], index: 0 },
  writeAuditMock: vi.fn(),
  markSitePlanStaleMock: vi.fn(),
  tree: {
    createPanel: vi.fn(),
    updatePanel: vi.fn(),
    deletePanel: vi.fn(),
    createCircuit: vi.fn(),
    updateCircuit: vi.fn(),
    deleteCircuit: vi.fn(),
  },
}));

function setupDbResults(...results: unknown[][]): void {
  state.results = results;
  state.index = 0;
}

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'innerJoin',
    'leftJoin',
    'returning',
    'set',
    'values',
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = state.results[state.index] ?? [];
      state.index++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  return chain;
}

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  },
  panels: {},
  circuits: {},
  unmanagedLoads: {},
  chargingStations: {},
  connectors: {},
  evses: {},
  siteAuditLog: { name: 'site_audit_log' },
  stationAuditLog: { name: 'station_audit_log' },
  writeAudit: writeAuditMock,
  ...tree,
  markSitePlanStale: markSitePlanStaleMock,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

vi.mock('../lib/site-exists.js', () => ({ siteExists: vi.fn(async () => true) }));

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
import { panelRoutes } from '../routes/panels.js';
import { circuitRoutes } from '../routes/circuits.js';
import { unmanagedLoadRoutes } from '../routes/unmanaged-loads.js';
import { changedFields } from '../lib/audit-diff.js';

const SITE = 'sit_a';
const USER = 'usr_000000000001';
const created = '2026-01-01T00:00:00.000Z';

const panelRow = {
  id: 'pnl_a',
  siteId: SITE,
  parentPanelId: null,
  name: 'Main',
  breakerRatingAmps: 200,
  voltageV: 240,
  phases: 1,
  maxContinuousKw: '38.4',
  safetyMarginKw: '0',
  oversubscriptionRatio: '1',
  phaseConnections: null,
  transformerId: null,
  sortOrder: 0,
  createdAt: created,
  updatedAt: created,
};

const circuitRow = {
  id: 'cir_a',
  panelId: 'pnl_a',
  name: 'Bay 1',
  breakerRatingAmps: 40,
  maxContinuousKw: '7.68',
  phaseConnections: null,
  voltageV: null,
  sortOrder: 0,
  createdAt: created,
  updatedAt: created,
};

interface AuditCall {
  table: { name: string };
  args: Record<string, unknown>;
}

function auditCalls(): AuditCall[] {
  return writeAuditMock.mock.calls.map((c) => ({
    table: (c[0] as { table: { name: string } }).table,
    args: c[1] as Record<string, unknown>,
  }));
}

describe('load management audit', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    panelRoutes(app);
    circuitRoutes(app);
    unmanagedLoadRoutes(app);
    await app.ready();
    auth = { authorization: `Bearer ${app.jwt.sign({ userId: USER, roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    writeAuditMock.mockReset().mockResolvedValue(undefined);
    for (const fn of Object.values(tree)) fn.mockReset();
    markSitePlanStaleMock.mockReset().mockResolvedValue(true);
  });

  const caller = expect.objectContaining({ actor: 'operator', actorUserId: USER });

  async function planMarks(): Promise<unknown[][]> {
    await new Promise((resolve) => setImmediate(resolve));
    return markSitePlanStaleMock.mock.calls;
  }

  it('POST panel creates the panel through the writer in the caller name', async () => {
    tree.createPanel.mockResolvedValue(panelRow);
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE}/panels`,
      headers: auth,
      payload: { name: 'Main', breakerRatingAmps: 200, voltageV: 240, phases: 1 },
    });
    expect(res.statusCode).toBe(201);
    expect(tree.createPanel).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE, name: 'Main', breakerRatingAmps: 200 }),
      caller,
    );
    expect(await planMarks()).toEqual([
      [SITE, 'panel_changed', expect.anything(), { departureAwareOnly: true }],
    ]);
  });

  it('PATCH panel updates through the writer with the row it read', async () => {
    setupDbResults([panelRow], [{ count: 0 }]);
    tree.updatePanel.mockResolvedValue({ ...panelRow, name: 'Main Service' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE}/panels/pnl_a`,
      headers: auth,
      payload: { name: 'Main Service' },
    });
    expect(res.statusCode).toBe(200);
    expect(tree.updatePanel).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: SITE,
        panelId: 'pnl_a',
        existing: panelRow,
        set: expect.objectContaining({ name: 'Main Service' }),
        recomputeCircuits: false,
        clearSubPanelPhases: false,
      }),
      caller,
    );
  });

  it('PATCH panel answers 404 when the writer changed no row', async () => {
    setupDbResults([panelRow]);
    tree.updatePanel.mockResolvedValue(null);
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE}/panels/pnl_a`,
      headers: auth,
      payload: { voltageV: 208 },
    });
    expect(res.statusCode).toBe(404);
    expect(tree.updatePanel).toHaveBeenCalledWith(
      expect.objectContaining({ recomputeCircuits: true, clearSubPanelPhases: false }),
      caller,
    );
  });

  it('DELETE panel deletes through the writer', async () => {
    setupDbResults([panelRow]);
    tree.deletePanel.mockResolvedValue(undefined);
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${SITE}/panels/pnl_a`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(tree.deletePanel).toHaveBeenCalledWith({ siteId: SITE, panel: panelRow }, caller);
  });

  it('DELETE of an unknown panel writes no audit row', async () => {
    setupDbResults([]);
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${SITE}/panels/pnl_x`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(tree.deletePanel).not.toHaveBeenCalled();
    expect(await planMarks()).toEqual([]);
  });

  it('POST circuit creates the circuit on the site through the writer', async () => {
    setupDbResults([panelRow]);
    tree.createCircuit.mockResolvedValue(circuitRow);
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE}/panels/pnl_a/circuits`,
      headers: auth,
      payload: { name: 'Bay 1', breakerRatingAmps: 40 },
    });
    expect(res.statusCode).toBe(201);
    expect(tree.createCircuit).toHaveBeenCalledWith(
      SITE,
      expect.objectContaining({ panelId: 'pnl_a', name: 'Bay 1', breakerRatingAmps: 40 }),
      caller,
    );
    expect((await planMarks())[0]?.slice(0, 2)).toEqual([SITE, 'circuit_changed']);
  });

  it('PATCH circuit updates the breaker and capacity through the writer', async () => {
    setupDbResults([panelRow], [circuitRow], [{ count: 1 }]);
    tree.updateCircuit.mockResolvedValue({
      ...circuitRow,
      breakerRatingAmps: 50,
      maxContinuousKw: '9.6',
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE}/panels/pnl_a/circuits/cir_a`,
      headers: auth,
      payload: { breakerRatingAmps: 50 },
    });
    expect(res.statusCode).toBe(200);
    expect(tree.updateCircuit).toHaveBeenCalledWith(
      {
        siteId: SITE,
        circuitId: 'cir_a',
        existing: circuitRow,
        set: expect.objectContaining({
          breakerRatingAmps: 50,
          maxContinuousKw: expect.any(String),
        }),
      },
      caller,
    );
    // The returned station count leaves out conformance test stations.
    const { isOperatorStation } = await import('@evtivity/database');
    expect(vi.mocked(isOperatorStation)).toHaveBeenCalled();
  });

  it('PATCH station circuit writes a station updated row with the circuit change', async () => {
    setupDbResults(
      [{ id: 'sta_1', stationId: 'CS-1', siteId: SITE, circuitId: 'cir_a' }],
      [{ id: 'sta_1', stationId: 'CS-1', circuitId: null }],
    );
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE}/stations/sta_1/circuit`,
      headers: auth,
      payload: { circuitId: null },
    });
    expect(res.statusCode).toBe(200);
    const [call] = auditCalls();
    expect(call?.table.name).toBe('station_audit_log');
    expect(call?.args).toMatchObject({
      entityId: 'sta_1',
      action: 'updated',
      before: { circuitId: 'cir_a' },
      after: { circuitId: null },
      notes: 'unassigned from circuit',
    });
    expect((await planMarks())[0]?.slice(0, 2)).toEqual([SITE, 'station_circuit_changed']);
  });

  it('PATCH station circuit to the same circuit writes no audit row', async () => {
    setupDbResults(
      [{ id: 'sta_1', stationId: 'CS-1', siteId: SITE, circuitId: null }],
      [{ id: 'sta_1', stationId: 'CS-1', circuitId: null }],
    );
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE}/stations/sta_1/circuit`,
      headers: auth,
      payload: { circuitId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('POST unmanaged load writes a site row with the new load', async () => {
    const loadRow = {
      id: 7,
      panelId: 'pnl_a',
      circuitId: null,
      name: 'HVAC',
      estimatedDrawKw: '5',
      meterDeviceId: null,
      createdAt: created,
      updatedAt: created,
    };
    setupDbResults([{ id: 'pnl_a' }], [loadRow]);
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE}/unmanaged-loads`,
      headers: auth,
      payload: { panelId: 'pnl_a', name: 'HVAC', estimatedDrawKw: 5 },
    });
    expect(res.statusCode).toBe(201);
    expect(auditCalls()[0]?.args).toMatchObject({
      action: 'load_management_changed',
      before: null,
      after: { unmanagedLoad: { id: 7, name: 'HVAC' } },
      notes: 'unmanaged load created: HVAC',
    });
    expect((await planMarks())[0]?.slice(0, 2)).toEqual([SITE, 'unmanaged_load_changed']);
  });
});

describe('changedFields', () => {
  it('keeps only changed keys and ignores updatedAt', () => {
    expect(
      changedFields(
        { a: 1, b: 'x', c: { k: 1 }, updatedAt: new Date(1) },
        { a: 1, b: 'y', c: { k: 2 }, updatedAt: new Date(2) },
      ),
    ).toEqual({ before: { b: 'x', c: { k: 1 } }, after: { b: 'y', c: { k: 2 } } });
  });

  it('compares dates by time and maps missing values to null', () => {
    expect(changedFields({ d: new Date(5) }, { d: new Date(5), n: 3 })).toEqual({
      before: { n: null },
      after: { n: 3 },
    });
  });
});
