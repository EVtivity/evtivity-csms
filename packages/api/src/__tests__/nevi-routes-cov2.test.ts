// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { state, rec, getUserSiteIdsMock, deleteMock } = vi.hoisted(() => ({
  state: { results: [] as unknown[][], index: 0 },
  rec: { set: [] as unknown[], where: [] as unknown[], values: [] as unknown[] },
  getUserSiteIdsMock: vi.fn(),
  deleteMock: vi.fn(),
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
    'offset',
    'innerJoin',
    'returning',
    'onConflictDoUpdate',
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  chain['where'] = vi.fn((w: unknown) => {
    rec.where.push(w);
    return chain;
  });
  chain['set'] = vi.fn((s: unknown) => {
    rec.set.push(s);
    return chain;
  });
  chain['values'] = vi.fn((v: unknown) => {
    rec.values.push(v);
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

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: (...args: unknown[]) => {
      deleteMock(...args);
      return makeChain();
    },
  },
  neviStationData: { stationId: 'nsd.station_id' },
  neviExcludedDowntime: {
    id: 'ned.id',
    stationId: 'ned.station_id',
    startedAt: 'ned.started_at',
  },
  chargingStations: { id: 'st.id', stationId: 'st.station_id', siteId: 'st.site_id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ eq: [c, v] })),
  and: vi.fn((...p: unknown[]) => ({ and: p })),
  inArray: vi.fn((c: unknown, v: unknown) => ({ inArray: [c, v] })),
  gte: vi.fn((c: unknown, v: unknown) => ({ gte: [c, v] })),
  lte: vi.fn((c: unknown, v: unknown) => ({ lte: [c, v] })),
  sql: Object.assign(
    vi.fn(() => ({ sql: 'now()' })),
    { raw: vi.fn() },
  ),
  desc: vi.fn(),
  count: vi.fn(),
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

import { registerAuth } from '../plugins/auth.js';
import { neviRoutes } from '../routes/nevi.js';

const STATION_ID = 'sta_000000000001';
const DOWNTIME_NOT_FOUND = {
  error: 'Excluded downtime record not found',
  code: 'DOWNTIME_NOT_FOUND',
};

function downtime(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    stationId: STATION_ID,
    evseId: 1,
    reason: 'vandalism',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('NEVI routes site access (cov2)', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    neviRoutes(app);
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
    rec.set.length = 0;
    rec.where.length = 0;
    rec.values.length = 0;
    getUserSiteIdsMock.mockReset().mockResolvedValue(['sit_a']);
  });

  describe('GET /nevi/station-data', () => {
    it('returns no rows without querying for an operator with no sites', async () => {
      getUserSiteIdsMock.mockResolvedValue([]);
      const res = await app.inject({ method: 'GET', url: '/nevi/station-data', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [] });
      expect(rec.where).toEqual([]);
    });

    it('filters station data to the operator sites', async () => {
      setupDbResults([]);
      const res = await app.inject({ method: 'GET', url: '/nevi/station-data', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(rec.where[0]).toEqual({ and: [{ inArray: ['st.site_id', ['sit_a']] }] });
    });
  });

  describe('PUT /nevi/station-data/:stationId', () => {
    it('404s a station at a site the operator cannot see', async () => {
      setupDbResults([{ id: STATION_ID, siteId: 'sit_other' }]);
      const res = await app.inject({
        method: 'PUT',
        url: `/nevi/station-data/${STATION_ID}`,
        headers: auth,
        payload: { operatorName: 'Acme' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      expect(rec.values).toEqual([]);
    });
  });

  describe('GET /nevi/excluded-downtime', () => {
    it('returns an empty page for an operator with no sites', async () => {
      getUserSiteIdsMock.mockResolvedValue([]);
      const res = await app.inject({
        method: 'GET',
        url: '/nevi/excluded-downtime',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });

    it('combines station, date range and site filters', async () => {
      setupDbResults([downtime()], [{ count: 1 }]);
      const res = await app.inject({
        method: 'GET',
        url: `/nevi/excluded-downtime?stationId=${STATION_ID}&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z&page=2&limit=10`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ total: 1, data: [{ id: 1, reason: 'vandalism' }] });
      expect(rec.where[0]).toEqual({
        and: [
          { eq: ['ned.station_id', STATION_ID] },
          { gte: ['ned.started_at', new Date('2026-01-01T00:00:00Z')] },
          { lte: ['ned.started_at', new Date('2026-02-01T00:00:00Z')] },
          { inArray: ['st.site_id', ['sit_a']] },
        ],
      });
      // The count query shares the filter.
      expect(rec.where[1]).toBe(rec.where[0]);
    });
  });

  describe('POST /nevi/excluded-downtime', () => {
    const payload = {
      stationId: STATION_ID,
      evseId: 1,
      reason: 'utility_outage',
      startedAt: '2026-01-01T00:00:00Z',
    };

    it('404s an unknown station', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/nevi/excluded-downtime',
        headers: auth,
        payload,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
    });

    it('404s a station at a site the operator cannot see', async () => {
      setupDbResults([{ siteId: 'sit_other' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/nevi/excluded-downtime',
        headers: auth,
        payload,
      });
      expect(res.statusCode).toBe(404);
      expect(rec.values).toEqual([]);
    });

    it('stores an end time and notes when given', async () => {
      setupDbResults([{ siteId: 'sit_a' }], [downtime({ reason: 'utility_outage' })]);
      const res = await app.inject({
        method: 'POST',
        url: '/nevi/excluded-downtime',
        headers: auth,
        payload: { ...payload, endedAt: '2026-01-02T00:00:00Z', notes: 'grid' },
      });
      expect(res.statusCode).toBe(200);
      expect(rec.values[0]).toEqual({
        stationId: STATION_ID,
        evseId: 1,
        reason: 'utility_outage',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        endedAt: new Date('2026-01-02T00:00:00Z'),
        notes: 'grid',
        createdById: 'usr_000000000001',
      });
    });
  });

  describe('PATCH /nevi/excluded-downtime/:id', () => {
    it('404s a record at a site the operator cannot see', async () => {
      setupDbResults([{ id: 1, stationId: STATION_ID, siteId: 'sit_other' }]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/nevi/excluded-downtime/1',
        headers: auth,
        payload: { reason: 'vandalism' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(DOWNTIME_NOT_FOUND);
      expect(rec.set).toEqual([]);
    });

    it('updates every given field and clears the end time on an empty value', async () => {
      setupDbResults([{ id: 1, stationId: STATION_ID, siteId: 'sit_a' }], [downtime()]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/nevi/excluded-downtime/1',
        headers: auth,
        payload: {
          stationId: 'sta_000000000002',
          evseId: 2,
          reason: 'natural_disaster',
          startedAt: '2026-03-01T00:00:00Z',
          endedAt: '',
          notes: 'storm',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(rec.set[0]).toEqual({
        updatedAt: { sql: 'now()' },
        stationId: 'sta_000000000002',
        evseId: 2,
        reason: 'natural_disaster',
        startedAt: new Date('2026-03-01T00:00:00Z'),
        endedAt: null,
        notes: 'storm',
      });
    });

    it('sets the end time when given', async () => {
      setupDbResults([{ id: 1, stationId: STATION_ID, siteId: null }], [downtime()]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/nevi/excluded-downtime/1',
        headers: auth,
        payload: { endedAt: '2026-03-02T00:00:00Z' },
      });
      expect(res.statusCode).toBe(200);
      expect(rec.set[0]).toEqual({
        updatedAt: { sql: 'now()' },
        endedAt: new Date('2026-03-02T00:00:00Z'),
      });
    });
  });

  describe('DELETE /nevi/excluded-downtime/:id', () => {
    it('404s a record at a site the operator cannot see and keeps it', async () => {
      setupDbResults([{ id: 1, siteId: 'sit_other' }]);
      deleteMock.mockClear();
      const res = await app.inject({
        method: 'DELETE',
        url: '/nevi/excluded-downtime/1',
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(DOWNTIME_NOT_FOUND);
      expect(deleteMock).not.toHaveBeenCalled();
    });
  });
});
