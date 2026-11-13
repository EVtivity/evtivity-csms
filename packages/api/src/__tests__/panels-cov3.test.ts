// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const h = vi.hoisted(() => {
  const state = { results: [] as unknown[][], index: 0 };
  function chain(): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'innerJoin', 'leftJoin']) {
      c[m] = () => c;
    }
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
  class LoadTreeValidationError extends Error {
    constructor(
      message: string,
      readonly field: string,
    ) {
      super(message);
    }
  }
  return {
    state,
    chain,
    LoadTreeValidationError,
    createPanel: vi.fn(),
    updatePanel: vi.fn(),
    deletePanel: vi.fn(),
    markSitePlanStale: vi.fn(),
    getUserSiteIds: vi.fn(),
    siteExists: vi.fn(),
  };
});

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
  db: { select: vi.fn(() => h.chain()) },
  panels: {},
  circuits: {},
  unmanagedLoads: {},
  createPanel: h.createPanel,
  updatePanel: h.updatePanel,
  deletePanel: h.deletePanel,
  markSitePlanStale: h.markSitePlanStale,
  LoadTreeValidationError: h.LoadTreeValidationError,
  writeAudit: vi.fn(),
  siteAuditLog: {},
  stationAuditLog: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

vi.mock('../lib/site-exists.js', () => ({ siteExists: h.siteExists }));
vi.mock('../lib/site-access.js', () => ({ getUserSiteIds: h.getUserSiteIds }));
vi.mock('../middleware/rbac.js', () => ({
  authorize: () => async (request: { jwtVerify: () => Promise<void> }) => {
    await request.jwtVerify();
  },
}));

import { registerAuth } from '../plugins/auth.js';
import { panelRoutes } from '../routes/panels.js';

const SITE = 'sit_a';
const T = '2026-01-01T00:00:00.000Z';
const panelRow = {
  id: 'pnl_a',
  siteId: SITE,
  parentPanelId: null as string | null,
  name: 'Main',
  breakerRatingAmps: 200,
  voltageV: 240,
  phases: 1,
  maxContinuousKw: '38.4',
  safetyMarginKw: '1.5',
  oversubscriptionRatio: '1.2',
  phaseConnections: null as string | null,
  transformerId: null,
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
    panelRoutes(instance);
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
  h.getUserSiteIds.mockResolvedValue(null);
  h.siteExists.mockResolvedValue(true);
  h.markSitePlanStale.mockResolvedValue(undefined);
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

const createBody = { name: 'Sub', breakerRatingAmps: 100, voltageV: 120, phases: 1 };

describe('POST /sites/:siteId/panels', () => {
  it('answers 404 for a site outside the caller scope or unknown', async () => {
    h.getUserSiteIds.mockResolvedValue(['sit_other']);
    const res = await send('POST', `/sites/${SITE}/panels`, createBody);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
    h.getUserSiteIds.mockResolvedValue(null);
    h.siteExists.mockResolvedValue(false);
    expect((await send('POST', `/sites/${SITE}/panels`, createBody)).statusCode).toBe(404);
    expect(h.createPanel).not.toHaveBeenCalled();
  });

  it('answers 400 INVALID_PARENT_PANEL for an unknown parent or one of another site', async () => {
    results([]);
    const res = await send('POST', `/sites/${SITE}/panels`, { ...createBody, parentPanelId: 'p' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_PARENT_PANEL');
    results([{ id: 'p', siteId: 'sit_other', phases: 3 }]);
    const other = await send('POST', `/sites/${SITE}/panels`, {
      ...createBody,
      parentPanelId: 'p',
    });
    expect(other.json<{ code: string }>().code).toBe('INVALID_PARENT_PANEL');
    expect(h.createPanel).not.toHaveBeenCalled();
  });

  it('refuses a line to line voltage on a three-phase panel', async () => {
    const res = await send('POST', `/sites/${SITE}/panels`, {
      ...createBody,
      voltageV: 208,
      phases: 3,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string; code: string }>()).toMatchObject({
      code: 'VALIDATION_ERROR',
      error: expect.stringContaining('three-phase panel takes its phase to neutral voltage'),
    });
  });

  it('refuses phase connections without a three-phase parent', async () => {
    const res = await send('POST', `/sites/${SITE}/panels`, {
      ...createBody,
      phaseConnections: 'L1',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('Phase connections apply only');
    expect(h.createPanel).not.toHaveBeenCalled();
  });

  it('creates a sub-panel on a three-phase parent with its phase connection', async () => {
    results([{ id: 'pnl_p', siteId: SITE, phases: 3 }]);
    h.createPanel.mockResolvedValue({
      ...panelRow,
      id: 'pnl_s',
      parentPanelId: 'pnl_p',
      voltageV: 120,
      phaseConnections: 'L2',
      maxContinuousKw: '9.6',
    });
    const res = await send('POST', `/sites/${SITE}/panels`, {
      ...createBody,
      parentPanelId: 'pnl_p',
      phaseConnections: 'L2',
      transformerId: 'tfm_1',
      sortOrder: 3,
    });
    expect(res.statusCode).toBe(201);
    expect(h.createPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: SITE,
        parentPanelId: 'pnl_p',
        phaseConnections: 'L2',
        transformerId: 'tfm_1',
        sortOrder: 3,
        maxContinuousKw: '9.6',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1',
      }),
      expect.anything(),
    );
    expect(res.json()).toMatchObject({
      id: 'pnl_s',
      maxContinuousKw: 9.6,
      safetyMarginKw: 1.5,
      oversubscriptionRatio: 1.2,
      circuitCount: 0,
    });
    expect(h.markSitePlanStale).toHaveBeenCalledWith(SITE, 'panel_changed', expect.anything(), {
      departureAwareOnly: true,
    });
  });

  it('answers the field the tree writer refuses', async () => {
    h.createPanel.mockRejectedValue(
      new h.LoadTreeValidationError('Not a rated transformer', 'transformerId'),
    );
    const res = await send('POST', `/sites/${SITE}/panels`, {
      ...createBody,
      transformerId: 'tfm_x',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Not a rated transformer',
      code: 'VALIDATION_ERROR',
      field: 'transformerId',
    });
    expect(h.markSitePlanStale).not.toHaveBeenCalled();
  });

  it('answers 500 CREATE_FAILED when the writer returns no row', async () => {
    h.createPanel.mockResolvedValue(undefined);
    const res = await send('POST', `/sites/${SITE}/panels`, createBody);
    expect(res.statusCode).toBe(500);
    expect(res.json<{ code: string }>().code).toBe('CREATE_FAILED');
  });
});

describe('GET /sites/:siteId/panels', () => {
  it('answers 404 outside the caller scope', async () => {
    h.getUserSiteIds.mockResolvedValue([]);
    const res = await send('GET', `/sites/${SITE}/panels`);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('SITE_NOT_FOUND');
  });

  it('lists the panels with numeric capacities', async () => {
    results([{ ...panelRow, circuitCount: 2 }]);
    const res = await send('GET', `/sites/${SITE}/panels`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({
        id: 'pnl_a',
        maxContinuousKw: 38.4,
        safetyMarginKw: 1.5,
        oversubscriptionRatio: 1.2,
        circuitCount: 2,
      }),
    ]);
  });
});

describe('GET /sites/:siteId/panels/:panelId', () => {
  it('answers 404 outside the scope and for an unknown panel', async () => {
    h.getUserSiteIds.mockResolvedValue(['sit_other']);
    expect((await send('GET', `/sites/${SITE}/panels/pnl_a`)).statusCode).toBe(404);
    h.getUserSiteIds.mockResolvedValue(null);
    results([]);
    const res = await send('GET', `/sites/${SITE}/panels/pnl_a`);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('PANEL_NOT_FOUND');
  });

  it('returns the panel with its circuits and unmanaged loads', async () => {
    results(
      [panelRow],
      [
        {
          id: 'cir_a',
          panelId: 'pnl_a',
          name: 'Bay 1',
          breakerRatingAmps: 40,
          maxContinuousKw: '7.68',
          phaseConnections: null,
          voltageV: null,
          sortOrder: 0,
          createdAt: T,
          updatedAt: T,
          stationCount: 1,
        },
      ],
      [
        {
          id: 1,
          panelId: 'pnl_a',
          circuitId: null,
          name: 'HVAC',
          estimatedDrawKw: '4.5',
          meterDeviceId: null,
          createdAt: T,
          updatedAt: T,
        },
      ],
    );
    const res = await send('GET', `/sites/${SITE}/panels/pnl_a`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      maxContinuousKw: number;
      circuits: Array<{ maxContinuousKw: number; stationCount: number }>;
      unmanagedLoads: Array<{ estimatedDrawKw: number }>;
    }>();
    expect(body.maxContinuousKw).toBe(38.4);
    expect(body.circuits).toEqual([
      expect.objectContaining({ maxContinuousKw: 7.68, stationCount: 1 }),
    ]);
    expect(body.unmanagedLoads).toEqual([expect.objectContaining({ estimatedDrawKw: 4.5 })]);
  });
});

describe('PATCH /sites/:siteId/panels/:panelId', () => {
  it('answers 404 outside the scope and for an unknown panel', async () => {
    h.getUserSiteIds.mockResolvedValue(['sit_other']);
    expect((await send('PATCH', `/sites/${SITE}/panels/pnl_a`, { name: 'X' })).statusCode).toBe(
      404,
    );
    h.getUserSiteIds.mockResolvedValue(null);
    results([]);
    const res = await send('PATCH', `/sites/${SITE}/panels/pnl_a`, { name: 'X' });
    expect(res.json<{ code: string }>().code).toBe('PANEL_NOT_FOUND');
    expect(h.updatePanel).not.toHaveBeenCalled();
  });

  it('refuses a change to three-phase at a line to line voltage', async () => {
    results([{ ...panelRow, voltageV: 208 }]);
    const res = await send('PATCH', `/sites/${SITE}/panels/pnl_a`, { phases: 3 });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('VALIDATION_ERROR');
    expect(h.updatePanel).not.toHaveBeenCalled();
  });

  it('refuses phase connections on a top-level panel and below a single-phase parent', async () => {
    results([panelRow]);
    const top = await send('PATCH', `/sites/${SITE}/panels/pnl_a`, { phaseConnections: 'L1' });
    expect(top.statusCode).toBe(400);
    expect(top.json<{ error: string }>().error).toContain('Phase connections apply only');
    results([{ ...panelRow, parentPanelId: 'pnl_p' }], []);
    const unknownParent = await send('PATCH', `/sites/${SITE}/panels/pnl_a`, {
      phaseConnections: 'L1',
    });
    expect(unknownParent.statusCode).toBe(400);
    expect(h.updatePanel).not.toHaveBeenCalled();
  });

  it('writes every changed field and recomputes the capacity', async () => {
    results([{ ...panelRow, parentPanelId: 'pnl_p' }], [{ phases: 3 }], [{ count: 4 }]);
    h.updatePanel.mockResolvedValue({ ...panelRow, name: 'Renamed', voltageV: 120 });
    const res = await send('PATCH', `/sites/${SITE}/panels/pnl_a`, {
      name: 'Renamed',
      breakerRatingAmps: 100,
      voltageV: 120,
      phases: 1,
      safetyMarginKw: 2,
      oversubscriptionRatio: 1.5,
      sortOrder: 4,
      transformerId: null,
      phaseConnections: 'L3',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Renamed', circuitCount: 4, maxContinuousKw: 38.4 });
    const args = h.updatePanel.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
      recomputeCircuits: boolean;
      clearSubPanelPhases: boolean;
    };
    expect(args.set).toMatchObject({
      name: 'Renamed',
      breakerRatingAmps: 100,
      voltageV: 120,
      phases: 1,
      safetyMarginKw: '2',
      oversubscriptionRatio: '1.5',
      sortOrder: 4,
      transformerId: null,
      phaseConnections: 'L3',
      maxContinuousKw: '9.6',
    });
    expect(args.recomputeCircuits).toBe(true);
    expect(args.clearSubPanelPhases).toBe(true);
  });

  it('drops the phase connections of a panel turned three-phase', async () => {
    results([{ ...panelRow, voltageV: 120, phaseConnections: 'L1' }], []);
    h.updatePanel.mockResolvedValue({ ...panelRow, phases: 3 });
    const res = await send('PATCH', `/sites/${SITE}/panels/pnl_a`, { phases: 3 });
    expect(res.statusCode).toBe(200);
    // No count row: 0 circuits.
    expect(res.json<{ circuitCount: number }>().circuitCount).toBe(0);
    const args = h.updatePanel.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    expect(args.set['phaseConnections']).toBeNull();
  });

  it('keeps the capacity and phase connections on a rename', async () => {
    results([{ ...panelRow, phaseConnections: 'L1' }], [{ count: 0 }]);
    h.updatePanel.mockResolvedValue(panelRow);
    const res = await send('PATCH', `/sites/${SITE}/panels/pnl_a`, { name: 'Only the name' });
    expect(res.statusCode).toBe(200);
    const args = h.updatePanel.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
      recomputeCircuits: boolean;
    };
    expect(args.set).not.toHaveProperty('maxContinuousKw');
    expect(args.set).not.toHaveProperty('phaseConnections');
    expect(args.recomputeCircuits).toBe(false);
  });

  it('answers the field a tree refusal names, and 404 when no row changed', async () => {
    results([panelRow]);
    h.updatePanel.mockRejectedValueOnce(new h.LoadTreeValidationError('Cycle', 'transformerId'));
    const refused = await send('PATCH', `/sites/${SITE}/panels/pnl_a`, { transformerId: 'tfm_1' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ field: string }>().field).toBe('transformerId');
    results([panelRow]);
    h.updatePanel.mockResolvedValueOnce(undefined);
    const gone = await send('PATCH', `/sites/${SITE}/panels/pnl_a`, { name: 'X' });
    expect(gone.statusCode).toBe(404);
  });
});

describe('DELETE /sites/:siteId/panels/:panelId', () => {
  it('answers 404 outside the caller scope', async () => {
    h.getUserSiteIds.mockResolvedValue(['sit_other']);
    const res = await send('DELETE', `/sites/${SITE}/panels/pnl_a`);
    expect(res.statusCode).toBe(404);
    expect(h.deletePanel).not.toHaveBeenCalled();
  });

  it('deletes the panel it read through the writer', async () => {
    results([panelRow]);
    h.deletePanel.mockResolvedValue(undefined);
    const res = await send('DELETE', `/sites/${SITE}/panels/pnl_a`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(h.deletePanel).toHaveBeenCalledWith(
      { siteId: SITE, panel: panelRow },
      expect.anything(),
    );
  });
});
