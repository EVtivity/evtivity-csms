// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// The transformer routes and the panel transformer link: site scope, the
// writer called in the caller's name, the 400 VALIDATION_ERROR with `field`
// for a link the tree writer refuses. The writer itself (capacity, link
// rules, audit) is covered by the database package tests.

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
      createTransformer: vi.fn(),
      updateTransformer: vi.fn(),
      deleteTransformer: vi.fn(),
      createPanel: vi.fn(),
      updatePanel: vi.fn(),
      deletePanel: vi.fn(),
    },
    siteIdsMock: vi.fn(),
    markSitePlanStaleMock: vi.fn(),
  };
});

function setupDbResults(...results: unknown[][]): void {
  state.results = results;
  state.index = 0;
}

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'returning', 'set', 'values']) {
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

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()) },
  panels: {},
  circuits: {},
  unmanagedLoads: {},
  transformers: {},
  operatorStationSql: vi.fn(() => 'true'),
  markSitePlanStale: markSitePlanStaleMock,
  ...tree,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  asc: vi.fn(),
  isNotNull: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

const siteExistsMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../lib/site-exists.js', () => ({ siteExists: siteExistsMock }));
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
import { transformerRoutes } from '../routes/transformers.js';
import { panelRoutes } from '../routes/panels.js';

const SITE = 'sit_a';
const USER = 'usr_000000000001';
const created = '2026-11-03T00:00:00.000Z';

const transformerRow = {
  id: 'tfm_a',
  siteId: SITE,
  kind: 'service',
  name: 'Service',
  ratedKva: '500',
  phases: 3,
  secondaryVoltageV: 277,
  powerFactor: '0.95',
  loadingLimitPercent: 100,
  safetyMarginKw: '0',
  fedFromPanelId: null,
  maxContinuousKw: '475',
  sortOrder: 0,
  createdAt: created,
  updatedAt: created,
};

const panelRow = {
  id: 'pnl_a',
  siteId: SITE,
  parentPanelId: null,
  name: 'Main',
  breakerRatingAmps: 800,
  voltageV: 277,
  phases: 3,
  maxContinuousKw: '532',
  safetyMarginKw: '0',
  oversubscriptionRatio: '1',
  phaseConnections: null,
  transformerId: null,
  sortOrder: 0,
  createdAt: created,
  updatedAt: created,
};

describe('transformer routes', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    transformerRoutes(app);
    panelRoutes(app);
    await app.ready();
    auth = { authorization: `Bearer ${app.jwt.sign({ userId: USER, roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    siteIdsMock.mockReset().mockResolvedValue(null);
    for (const fn of Object.values(tree)) {
      if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
    }
    markSitePlanStaleMock.mockReset().mockResolvedValue(true);
  });

  const caller = expect.objectContaining({ actor: 'operator', actorUserId: USER });

  it('GET lists the transformers with numbers and the panels each one feeds', async () => {
    setupDbResults([transformerRow], [{ id: 'pnl_a', transformerId: 'tfm_a' }]);
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE}/transformers`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({
        id: 'tfm_a',
        ratedKva: 500,
        powerFactor: 0.95,
        maxContinuousKw: 475,
        panelIds: ['pnl_a'],
      }),
    ]);
  });

  it('answers 404 SITE_NOT_FOUND for a site outside the caller scope', async () => {
    siteIdsMock.mockResolvedValue(['sit_other']);
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE}/transformers`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('SITE_NOT_FOUND');
  });

  it('POST creates through the writer in the caller name with the defaults', async () => {
    tree.createTransformer.mockResolvedValue(transformerRow);
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE}/transformers`,
      headers: auth,
      payload: { kind: 'service', name: 'Service', ratedKva: 500, secondaryVoltageV: 277 },
    });
    expect(res.statusCode).toBe(201);
    expect(tree.createTransformer).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: SITE,
        kind: 'service',
        ratedKva: '500',
        phases: 3,
        powerFactor: '0.95',
        loadingLimitPercent: 100,
        fedFromPanelId: null,
      }),
      caller,
    );
    expect(res.json()).toEqual(expect.objectContaining({ maxContinuousKw: 475, panelIds: [] }));
  });

  it('POST refuses a power factor below 0.80 and a loading limit above 100', async () => {
    for (const payload of [
      { kind: 'service', name: 'T', ratedKva: 500, powerFactor: 0.79 },
      { kind: 'service', name: 'T', ratedKva: 500, loadingLimitPercent: 110 },
      { kind: 'service', name: 'T', ratedKva: 0 },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE}/transformers`,
        headers: auth,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(tree.createTransformer).not.toHaveBeenCalled();
  });

  it('POST refuses a line to line secondary voltage on a three-phase transformer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE}/transformers`,
      headers: auth,
      payload: { kind: 'service', name: 'T', ratedKva: 500, secondaryVoltageV: 480 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(
      expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'secondaryVoltageV' }),
    );
  });

  it('POST answers a writer refusal with 400 VALIDATION_ERROR and the field', async () => {
    tree.createTransformer.mockRejectedValue(
      new tree.LoadTreeValidationError(
        'A step-down transformer needs the panel that feeds it',
        'fedFromPanelId',
      ),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE}/transformers`,
      headers: auth,
      payload: { kind: 'step_down', name: 'T', ratedKva: 75 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'A step-down transformer needs the panel that feeds it',
      code: 'VALIDATION_ERROR',
      field: 'fedFromPanelId',
    });
  });

  it('PATCH updates through the writer with the row it read and marks the plan stale', async () => {
    setupDbResults([transformerRow], [{ id: 'pnl_a' }]);
    tree.updateTransformer.mockResolvedValue({ ...transformerRow, loadingLimitPercent: 80 });
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE}/transformers/tfm_a`,
      headers: auth,
      payload: { loadingLimitPercent: 80, ratedKva: null },
    });
    expect(res.statusCode).toBe(200);
    expect(tree.updateTransformer).toHaveBeenCalledWith(
      {
        siteId: SITE,
        transformerId: 'tfm_a',
        existing: transformerRow,
        set: { loadingLimitPercent: 80, ratedKva: null },
      },
      caller,
    );
    expect(res.json().panelIds).toEqual(['pnl_a']);
    await new Promise((resolve) => setImmediate(resolve));
    expect(markSitePlanStaleMock).toHaveBeenCalledWith(
      SITE,
      'transformer_changed',
      expect.anything(),
      { departureAwareOnly: true },
    );
  });

  it('PATCH and DELETE answer 404 TRANSFORMER_NOT_FOUND for another site or an unknown id', async () => {
    siteIdsMock.mockResolvedValue(['sit_other']);
    const outside = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE}/transformers/tfm_a`,
      headers: auth,
      payload: { name: 'X' },
    });
    expect(outside.statusCode).toBe(404);
    expect(outside.json().code).toBe('TRANSFORMER_NOT_FOUND');

    siteIdsMock.mockResolvedValue(null);
    setupDbResults([]);
    const missing = await app.inject({
      method: 'DELETE',
      url: `/sites/${SITE}/transformers/tfm_x`,
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('TRANSFORMER_NOT_FOUND');
    expect(tree.updateTransformer).not.toHaveBeenCalled();
    expect(tree.deleteTransformer).not.toHaveBeenCalled();
  });

  it('DELETE deletes through the writer', async () => {
    setupDbResults([transformerRow]);
    tree.deleteTransformer.mockResolvedValue(undefined);
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${SITE}/transformers/tfm_a`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(tree.deleteTransformer).toHaveBeenCalledWith(
      { siteId: SITE, transformer: transformerRow },
      caller,
    );
  });

  describe('panel transformer link', () => {
    it('POST transformer and panel answer 404 SITE_NOT_FOUND for a site that does not exist', async () => {
      siteExistsMock.mockResolvedValue(false);
      const transformer = await app.inject({
        method: 'POST',
        url: `/sites/${SITE}/transformers`,
        headers: auth,
        payload: { kind: 'service', name: 'Service', ratedKva: 500, phases: 3 },
      });
      const panel = await app.inject({
        method: 'POST',
        url: `/sites/${SITE}/panels`,
        headers: auth,
        payload: { name: 'Main', breakerRatingAmps: 800, voltageV: 277, phases: 3 },
      });
      siteExistsMock.mockResolvedValue(true);
      expect([transformer.statusCode, panel.statusCode]).toEqual([404, 404]);
      expect(transformer.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
      expect(panel.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
      expect(tree.createTransformer).not.toHaveBeenCalled();
      expect(tree.createPanel).not.toHaveBeenCalled();
    });

    it('POST panel passes transformerId to the writer', async () => {
      tree.createPanel.mockResolvedValue({ ...panelRow, transformerId: 'tfm_a' });
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE}/panels`,
        headers: auth,
        payload: {
          name: 'Main',
          breakerRatingAmps: 800,
          voltageV: 277,
          phases: 3,
          transformerId: 'tfm_a',
        },
      });
      expect(res.statusCode).toBe(201);
      expect(tree.createPanel).toHaveBeenCalledWith(
        expect.objectContaining({ transformerId: 'tfm_a' }),
        caller,
      );
      expect(res.json().transformerId).toBe('tfm_a');
    });

    it('PATCH panel with transformerId null clears the link', async () => {
      setupDbResults([{ ...panelRow, transformerId: 'tfm_a' }], [{ count: 0 }]);
      tree.updatePanel.mockResolvedValue(panelRow);
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE}/panels/pnl_a`,
        headers: auth,
        payload: { transformerId: null },
      });
      expect(res.statusCode).toBe(200);
      expect(tree.updatePanel).toHaveBeenCalledWith(
        expect.objectContaining({ set: expect.objectContaining({ transformerId: null }) }),
        caller,
      );
    });

    it('PATCH panel answers a refused link with 400 and field transformerId', async () => {
      setupDbResults([panelRow]);
      tree.updatePanel.mockRejectedValue(
        new tree.LoadTreeValidationError('Transformer not found on this site', 'transformerId'),
      );
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE}/panels/pnl_a`,
        headers: auth,
        payload: { transformerId: 'tfm_other_site' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual(
        expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'transformerId' }),
      );
    });

    it('PATCH panel without transformerId leaves the link alone', async () => {
      setupDbResults([panelRow], [{ count: 0 }]);
      tree.updatePanel.mockResolvedValue(panelRow);
      await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE}/panels/pnl_a`,
        headers: auth,
        payload: { name: 'Main Service' },
      });
      const set = (tree.updatePanel.mock.calls[0]?.[0] as { set: Record<string, unknown> }).set;
      expect('transformerId' in set).toBe(false);
    });
  });
});
