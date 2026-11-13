// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const h = vi.hoisted(() => {
  const state = { results: [] as unknown[][], index: 0, sets: [] as unknown[], deletes: 0 };
  function chain(): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'innerJoin', 'leftJoin', 'returning', 'values']) {
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
    writeAudit: vi.fn(),
    markSitePlanStale: vi.fn(),
    getUserSiteIds: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => h.chain()),
    insert: vi.fn(() => h.chain()),
    update: vi.fn(() => h.chain()),
    delete: vi.fn(() => {
      h.state.deletes++;
      return h.chain();
    }),
  },
  panels: {},
  circuits: {},
  unmanagedLoads: {},
  markSitePlanStale: h.markSitePlanStale,
  writeAudit: h.writeAudit,
  siteAuditLog: { name: 'site_audit_log' },
  stationAuditLog: { name: 'station_audit_log' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

vi.mock('../lib/site-access.js', () => ({ getUserSiteIds: h.getUserSiteIds }));
vi.mock('../middleware/rbac.js', () => ({
  authorize: () => async (request: { jwtVerify: () => Promise<void> }) => {
    await request.jwtVerify();
  },
}));

import { registerAuth } from '../plugins/auth.js';
import { unmanagedLoadRoutes } from '../routes/unmanaged-loads.js';

const SITE = 'sit_a';
const T = '2026-01-01T00:00:00.000Z';
const load = {
  id: 7,
  panelId: 'pnl_a' as string | null,
  circuitId: null as string | null,
  name: 'HVAC',
  estimatedDrawKw: '4.5',
  meterDeviceId: null,
  createdAt: T,
  updatedAt: T,
};

let app: FastifyInstance;
let auth: Record<string, string>;

beforeAll(async () => {
  app = Fastify();
  await registerAuth(app);
  app.register(async (instance) => {
    unmanagedLoadRoutes(instance);
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
  h.state.deletes = 0;
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

const base = `/sites/${SITE}/unmanaged-loads`;

describe('POST unmanaged loads', () => {
  it('answers 404 outside the caller scope', async () => {
    h.getUserSiteIds.mockResolvedValue(['sit_other']);
    const res = await send('POST', base, { panelId: 'pnl_a', name: 'L', estimatedDrawKw: 1 });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('SITE_NOT_FOUND');
  });

  it('answers 400 INVALID_PANEL and INVALID_CIRCUIT for a parent outside the site', async () => {
    results([]);
    const panel = await send('POST', base, { panelId: 'pnl_x', name: 'L', estimatedDrawKw: 1 });
    expect(panel.statusCode).toBe(400);
    expect(panel.json<{ code: string }>().code).toBe('INVALID_PANEL');
    results([]);
    const circuit = await send('POST', base, { circuitId: 'cir_x', name: 'L', estimatedDrawKw: 1 });
    expect(circuit.json<{ code: string }>().code).toBe('INVALID_CIRCUIT');
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('creates a circuit load and audits it', async () => {
    const created = { ...load, panelId: null, circuitId: 'cir_a' };
    results([{ id: 'cir_a' }], [created]);
    const res = await send('POST', base, {
      circuitId: 'cir_a',
      name: 'HVAC',
      estimatedDrawKw: 4.5,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 7, circuitId: 'cir_a', estimatedDrawKw: 4.5 });
    expect(h.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ idColumn: 'site_id' }),
      expect.objectContaining({
        action: 'load_management_changed',
        before: null,
        notes: 'unmanaged load created: HVAC',
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('answers 500 CREATE_FAILED when the insert returns no row', async () => {
    results([{ id: 'pnl_a' }], []);
    const res = await send('POST', base, { panelId: 'pnl_a', name: 'L', estimatedDrawKw: 1 });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ code: string }>().code).toBe('CREATE_FAILED');
    expect(h.writeAudit).not.toHaveBeenCalled();
  });
});

describe('GET unmanaged loads', () => {
  it('answers 404 outside the caller scope', async () => {
    h.getUserSiteIds.mockResolvedValue([]);
    expect((await send('GET', base)).statusCode).toBe(404);
  });

  it('merges panel and circuit loads by id', async () => {
    results(
      [load, { ...load, id: 8, name: 'Lights', estimatedDrawKw: '1' }],
      [{ ...load, id: 8, panelId: null, circuitId: 'cir_a', name: 'Lights', estimatedDrawKw: '1' }],
    );
    const res = await send('GET', base);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ id: 7, estimatedDrawKw: 4.5 }),
      expect.objectContaining({ id: 8, circuitId: 'cir_a', estimatedDrawKw: 1 }),
    ]);
  });
});

describe('PATCH unmanaged loads', () => {
  const url = `${base}/7`;

  it('answers 404 outside the scope, for an unknown load and one of another site', async () => {
    h.getUserSiteIds.mockResolvedValue(['sit_other']);
    expect((await send('PATCH', url, { name: 'X' })).statusCode).toBe(404);
    h.getUserSiteIds.mockResolvedValue(null);
    results([]);
    expect((await send('PATCH', url, { name: 'X' })).json<{ code: string }>().code).toBe(
      'LOAD_NOT_FOUND',
    );
    // A panel load whose panel is not at the site, and a circuit load whose circuit is not.
    results([load], []);
    expect((await send('PATCH', url, { name: 'X' })).statusCode).toBe(404);
    results([{ ...load, panelId: null, circuitId: 'cir_x' }], []);
    expect((await send('PATCH', url, { name: 'X' })).statusCode).toBe(404);
    results([{ ...load, panelId: null, circuitId: null }]);
    expect((await send('PATCH', url, { name: 'X' })).statusCode).toBe(404);
    expect(h.state.sets).toHaveLength(0);
  });

  it('refuses a change that leaves the load on neither a panel nor a circuit', async () => {
    results([load], [{ id: 'pnl_a' }]);
    const res = await send('PATCH', url, { panelId: null });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'A load needs a panelId or a circuitId',
      code: 'VALIDATION_ERROR',
    });
  });

  it('refuses a new panel or circuit outside the site', async () => {
    results([load], [{ id: 'pnl_a' }], []);
    const panel = await send('PATCH', url, { panelId: 'pnl_x' });
    expect(panel.json<{ code: string }>().code).toBe('INVALID_PANEL');
    results([load], [{ id: 'pnl_a' }], []);
    const circuit = await send('PATCH', url, { circuitId: 'cir_x', panelId: null });
    expect(circuit.json<{ code: string }>().code).toBe('INVALID_CIRCUIT');
    expect(h.state.sets).toHaveLength(0);
  });

  it('moves the load to a circuit and audits the changed fields only', async () => {
    const updated = {
      ...load,
      panelId: null,
      circuitId: 'cir_a',
      estimatedDrawKw: '6',
      name: 'HVAC 2',
    };
    results([load], [{ id: 'pnl_a' }], [{ id: 'cir_a' }], [updated]);
    const res = await send('PATCH', url, {
      panelId: null,
      circuitId: 'cir_a',
      estimatedDrawKw: 6,
      name: 'HVAC 2',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ circuitId: 'cir_a', estimatedDrawKw: 6, name: 'HVAC 2' });
    expect(h.state.sets[0]).toMatchObject({
      panelId: null,
      circuitId: 'cir_a',
      estimatedDrawKw: '6',
      name: 'HVAC 2',
    });
    const entry = h.writeAudit.mock.calls[0]?.[1] as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      notes: string;
    };
    expect(entry.notes).toBe('unmanaged load updated: HVAC 2');
    expect(entry.before).toMatchObject({ unmanagedLoadId: 7, panelId: 'pnl_a', circuitId: null });
    expect(entry.after).toMatchObject({ unmanagedLoadId: 7, panelId: null, circuitId: 'cir_a' });
  });

  it('answers 404 when the update returns no row', async () => {
    results([load], [{ id: 'pnl_a' }], []);
    const res = await send('PATCH', url, { name: 'X' });
    expect(res.statusCode).toBe(404);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });
});

describe('DELETE unmanaged loads', () => {
  const url = `${base}/7`;

  it('answers 404 outside the scope and for a load of another site', async () => {
    h.getUserSiteIds.mockResolvedValue(['sit_other']);
    expect((await send('DELETE', url)).statusCode).toBe(404);
    h.getUserSiteIds.mockResolvedValue(null);
    results([load], []);
    expect((await send('DELETE', url)).statusCode).toBe(404);
    expect(h.state.deletes).toBe(0);
  });

  it('deletes the load and audits it', async () => {
    results([load], [{ id: 'pnl_a' }], []);
    const res = await send('DELETE', url);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(h.state.deletes).toBe(1);
    expect(h.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ after: null, notes: 'unmanaged load deleted: HVAC' }),
      expect.anything(),
      expect.anything(),
    );
  });
});
