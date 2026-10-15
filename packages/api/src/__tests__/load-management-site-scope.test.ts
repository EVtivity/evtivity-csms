// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Unmanaged loads and circuits live under a site URL. A load or circuit id of
// another site must answer 404 there and stay unchanged, so a site-restricted
// user cannot reach another site's row through a site of their own.

const { state, rec, getUserSiteIdsMock, deleteMock, updateMock } = vi.hoisted(() => ({
  state: { results: [] as unknown[][], index: 0 },
  rec: { where: [] as unknown[] },
  getUserSiteIdsMock: vi.fn(),
  deleteMock: vi.fn(),
  updateMock: vi.fn(),
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
  chain['where'] = vi.fn((w: unknown) => {
    rec.where.push(w);
    return chain;
  });
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
    update: (...args: unknown[]) => {
      updateMock(...args);
      return makeChain();
    },
    delete: (...args: unknown[]) => {
      deleteMock(...args);
      return makeChain();
    },
  },
  panels: { id: 'panels.id', siteId: 'panels.site_id' },
  circuits: { id: 'circuits.id', panelId: 'circuits.panel_id', sortOrder: 'circuits.sort_order' },
  unmanagedLoads: {
    id: 'ul.id',
    panelId: 'ul.panel_id',
    circuitId: 'ul.circuit_id',
  },
  chargingStations: { id: 'st.id', circuitId: 'st.circuit_id', siteId: 'st.site_id' },
  connectors: { evseId: 'c.evse_id', maxPowerKw: 'c.max_power_kw' },
  evses: { id: 'e.id', stationId: 'e.station_id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ eq: [c, v] })),
  and: vi.fn((...p: unknown[]) => ({ and: p })),
  inArray: vi.fn((c: unknown, v: unknown) => ({ inArray: [c, v] })),
  sql: Object.assign(
    vi.fn(() => ({ sql: true })),
    { raw: vi.fn() },
  ),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: getUserSiteIdsMock,
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

const siteAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/load-management-audit.js', () => ({
  writeSiteLoadManagementAudit: (...args: unknown[]) => siteAuditMock(...args) as Promise<void>,
  writeStationLoadAudit: vi.fn().mockResolvedValue(undefined),
}));

import { registerAuth } from '../plugins/auth.js';
import { unmanagedLoadRoutes } from '../routes/unmanaged-loads.js';
import { circuitRoutes } from '../routes/circuits.js';

const LOAD_NOT_FOUND = { error: 'Load not found', code: 'LOAD_NOT_FOUND' };
const CIRCUIT_NOT_FOUND = { error: 'Circuit not found', code: 'CIRCUIT_NOT_FOUND' };

function load(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    panelId: 'pnl_b',
    circuitId: null,
    name: 'HVAC',
    estimatedDrawKw: '5',
    meterDeviceId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** True when some recorded where clause pins panels.site_id to the site. */
function scopedToSite(siteId: string): boolean {
  return JSON.stringify(rec.where).includes(JSON.stringify({ eq: ['panels.site_id', siteId] }));
}

describe('Load management site scope', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    unmanagedLoadRoutes(app);
    circuitRoutes(app);
    await app.ready();
    auth = {
      authorization: `Bearer ${app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_1' })}`,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    rec.where.length = 0;
    deleteMock.mockClear();
    updateMock.mockClear();
    siteAuditMock.mockClear();
    getUserSiteIdsMock.mockReset().mockResolvedValue(['sit_a']);
  });

  describe('PATCH /sites/:siteId/unmanaged-loads/:id', () => {
    it.each([
      ['a panel of another site', load({ panelId: 'pnl_b' })],
      ['a circuit of another site', load({ panelId: null, circuitId: 'cir_b' })],
    ])('404s a load on %s and leaves it unchanged', async (_label, row) => {
      // existing load, then the panel or circuit lookup in the URL site (none)
      setupDbResults([row], []);
      const res = await app.inject({
        method: 'PATCH',
        url: '/sites/sit_a/unmanaged-loads/7',
        headers: auth,
        payload: { name: 'renamed' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(LOAD_NOT_FOUND);
      expect(updateMock).not.toHaveBeenCalled();
      expect(scopedToSite('sit_a')).toBe(true);
    });

    it('updates a load whose circuit belongs to the URL site', async () => {
      const row = load({ panelId: null, circuitId: 'cir_a' });
      setupDbResults([row], [{ id: 'cir_a' }], [{ ...row, name: 'renamed' }]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/sites/sit_a/unmanaged-loads/7',
        headers: auth,
        payload: { name: 'renamed' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: 7, name: 'renamed', estimatedDrawKw: 5 });
      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(siteAuditMock).toHaveBeenCalledWith(expect.anything(), 'sit_a', {
        before: { unmanagedLoadId: 7, name: 'HVAC' },
        after: { unmanagedLoadId: 7, name: 'renamed' },
        notes: 'unmanaged load updated: renamed',
      });
    });
  });

  describe('DELETE /sites/:siteId/unmanaged-loads/:id', () => {
    it('404s a load of another site and keeps it', async () => {
      setupDbResults([load({ panelId: 'pnl_b' })], []);
      const res = await app.inject({
        method: 'DELETE',
        url: '/sites/sit_a/unmanaged-loads/7',
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(LOAD_NOT_FOUND);
      expect(deleteMock).not.toHaveBeenCalled();
      expect(siteAuditMock).not.toHaveBeenCalled();
    });

    it('deletes a load on a panel of the URL site', async () => {
      setupDbResults([load({ panelId: 'pnl_a' })], [{ id: 'pnl_a' }]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/sites/sit_a/unmanaged-loads/7',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(siteAuditMock).toHaveBeenCalledWith(expect.anything(), 'sit_a', {
        before: { unmanagedLoad: expect.objectContaining({ id: 7, name: 'HVAC' }) },
        after: null,
        notes: 'unmanaged load deleted: HVAC',
      });
    });
  });

  describe('DELETE /sites/:siteId/panels/:panelId/circuits/:circuitId', () => {
    it('404s a circuit whose panel is not in the URL site and changes nothing', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/sites/sit_a/panels/pnl_b/circuits/cir_b',
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(CIRCUIT_NOT_FOUND);
      expect(updateMock).not.toHaveBeenCalled();
      expect(deleteMock).not.toHaveBeenCalled();
      expect(scopedToSite('sit_a')).toBe(true);
    });

    it('deletes a circuit of the URL site', async () => {
      setupDbResults([{ id: 'cir_a', panelId: 'pnl_a', name: 'Bay 1' }]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/sites/sit_a/panels/pnl_a/circuits/cir_a',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(siteAuditMock).toHaveBeenCalledWith(expect.anything(), 'sit_a', {
        before: { circuit: { id: 'cir_a', panelId: 'pnl_a', name: 'Bay 1' } },
        after: null,
        notes: 'circuit deleted: Bay 1',
      });
    });

    it('404s for a site outside the user scope before any query', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/sites/sit_b/panels/pnl_b/circuits/cir_b',
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(rec.where).toEqual([]);
    });
  });

  describe('GET /sites/:siteId/panels/:panelId/circuits', () => {
    it('filters circuits to a panel of the URL site', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: '/sites/sit_a/panels/pnl_b/circuits',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      expect(scopedToSite('sit_a')).toBe(true);
      // The station count leaves out conformance test stations.
      const { operatorStationSql } = await import('@evtivity/database');
      expect(vi.mocked(operatorStationSql)).toHaveBeenCalledWith('charging_stations');
    });
  });
});
