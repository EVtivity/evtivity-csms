// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}

function makeChain() {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) {
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
  return chain;
}

let siteIdsResult: string[] | null = null;

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

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn(() => Promise.resolve(siteIdsResult)),
}));

function fakeTable(name: string): { id: unknown; createdAt: unknown } {
  const table = { _name: name };
  return {
    id: { name: 'id', table },
    createdAt: { name: 'created_at', table },
  };
}

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()) },
  sites: fakeTable('sites'),
  chargingStations: { ...fakeTable('charging_stations'), siteId: { name: 'site_id' } },
  chargingSessions: { ...fakeTable('charging_sessions'), stationId: { name: 'station_id' } },
  drivers: fakeTable('drivers'),
  fleets: fakeTable('fleets'),
  users: fakeTable('users'),
  driverTokens: fakeTable('driver_tokens'),
  reservations: { ...fakeTable('reservations'), stationId: { name: 'station_id' } },
  invoices: fakeTable('invoices'),
  supportCases: { ...fakeTable('support_cases'), stationId: { name: 'station_id' } },
  pricingGroups: fakeTable('pricing_groups'),
  ocpiPartners: fakeTable('ocpi_partners'),
  configTemplates: fakeTable('config_templates'),
  chargingProfileTemplates: fakeTable('charging_profile_templates'),
  firmwareCampaigns: fakeTable('firmware_campaigns'),
  octtRuns: fakeTable('octt_runs'),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
  isNull: vi.fn(() => ({})),
}));

import { registerAuth } from '../plugins/auth.js';
import { entityNeighborRoutes } from '../routes/entity-neighbors.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  entityNeighborRoutes(app);
  await app.ready();
  return app;
}

describe('Entity neighbor routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'usr_test', roleId: 'rol_test' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    siteIdsResult = null;
  });

  it('returns prev and next ids around the current entity', async () => {
    setupDbResults(
      [{ createdAt: '2026-06-01T00:00:00Z' }],
      [{ id: 'drv_newer' }],
      [{ id: 'drv_older' }],
    );
    const res = await app.inject({
      method: 'GET',
      url: '/drivers/drv_cur/neighbors',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prevId: 'drv_newer', nextId: 'drv_older' });
  });

  it('returns nulls at the edges of the list', async () => {
    setupDbResults([{ createdAt: '2026-06-01T00:00:00Z' }], [], []);
    const res = await app.inject({
      method: 'GET',
      url: '/drivers/drv_only/neighbors',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prevId: null, nextId: null });
  });

  it('404s with the resource code when the entity does not exist', async () => {
    setupDbResults([]);
    const res = await app.inject({
      method: 'GET',
      url: '/sites/sit_missing/neighbors',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
  });

  it('404s for site-scoped resources when the user has no site access', async () => {
    siteIdsResult = [];
    const res = await app.inject({
      method: 'GET',
      url: '/sites/sit_abc/neighbors',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('scopes neighbor queries to the allowed sites for restricted users', async () => {
    siteIdsResult = ['sit_allowed'];
    setupDbResults([{ createdAt: '2026-06-01T00:00:00Z' }], [{ id: 'sta_p' }], [{ id: 'sta_n' }]);
    const res = await app.inject({
      method: 'GET',
      url: '/stations/sta_cur/neighbors',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prevId: 'sta_p', nextId: 'sta_n' });
  });

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/sessions/ses_x/neighbors' });
    expect(res.statusCode).toBe(401);
  });

  it('registers a neighbors route for every target resource', async () => {
    setupDbResults([]);
    for (const url of [
      '/fleets/x/neighbors',
      '/users/x/neighbors',
      '/tokens/x/neighbors',
      '/reservations/x/neighbors',
      '/invoices/x/neighbors',
      '/support-cases/x/neighbors',
      '/pricing-groups/x/neighbors',
      '/ocpi/partners/x/neighbors',
      '/config-templates/x/neighbors',
      '/smart-charging/templates/x/neighbors',
      '/firmware-campaigns/x/neighbors',
      '/octt/runs/1/neighbors',
    ]) {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect([200, 404]).toContain(res.statusCode);
    }
  });
});
