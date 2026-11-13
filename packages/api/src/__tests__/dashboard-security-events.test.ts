// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// GET /v1/dashboard/security-events against a mocked database: permission,
// site scope, the empty scope, the reply shape and the query parameters. The
// SQL (sort order, severity filter, windows) runs in the integration test
// 173-dashboard-security-events.

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  results: [] as unknown[][],
  queries: [] as unknown[],
  permissions: new Set<string>(['securityEvents:read']),
  siteIds: null as string[] | null,
  windows: [] as Array<{ id: string; since: Date }>,
}));

vi.mock('@evtivity/database', () => ({
  db: {
    execute: vi.fn((query: unknown) => {
      state.queries.push(query);
      return Promise.resolve(state.results.shift() ?? []);
    }),
  },
  operatorStationSql: (alias: string) => `${alias}.is_conformance = false`,
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn(() => Promise.resolve(state.siteIds)),
}));

vi.mock('../lib/security-event-scope.js', () => ({
  securityEventWindows: vi.fn(() => Promise.resolve(state.windows)),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    (...required: string[]) =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
        return;
      }
      if (required.some((p) => !state.permissions.has(p))) {
        await reply.status(403).send({ code: 'INSUFFICIENT_PERMISSIONS' });
      }
    },
}));

import { registerAuth } from '../plugins/auth.js';
import {
  SECURITY_EVENTS_DEFAULT_LIMIT,
  dashboardSecurityEventsRoutes,
} from '../routes/dashboard-security-events.js';
import { securityEventWindows } from '../lib/security-event-scope.js';

const dialect = new PgDialect();
const sqlText = (q: unknown): string => dialect.sqlToQuery(q as SQL).sql;
const sqlParams = (q: unknown): unknown[] => dialect.sqlToQuery(q as SQL).params;

describe('GET /dashboard/security-events', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    dashboardSecurityEventsRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state.results = [];
    state.queries = [];
    state.permissions = new Set(['securityEvents:read']);
    state.siteIds = null;
    state.windows = [];
  });

  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('answers 403 without securityEvents:read', async () => {
    state.permissions = new Set(['dashboard:read']);
    const res = await get('/dashboard/security-events');
    expect(res.statusCode).toBe(403);
    expect(state.queries).toHaveLength(0);
  });

  it('answers the empty reply for a caller without sites', async () => {
    state.siteIds = [];
    const res = await get('/dashboard/security-events');
    expect(res.statusCode).toBe(200);
    const body = res.json<{ range: string; total: number; stations: unknown[] }>();
    expect(body.range).toBe('7d');
    expect(body.total).toBe(0);
    expect(body.stations).toEqual([]);
    expect(state.queries).toHaveLength(0);
  });

  it('answers 404 for a site outside the scope, the same as an unknown one', async () => {
    state.siteIds = ['sit_a'];
    const foreign = await get('/dashboard/security-events?siteId=sit_b');
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json<{ code: string }>().code).toBe('SITE_NOT_FOUND');

    state.siteIds = null;
    state.results = [[]];
    const unknown = await get('/dashboard/security-events?siteId=sit_none');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ code: string }>().code).toBe('SITE_NOT_FOUND');
  });

  it('refuses an unknown range or severity', async () => {
    expect((await get('/dashboard/security-events?range=1y')).statusCode).toBe(400);
    expect((await get('/dashboard/security-events?severity=severe')).statusCode).toBe(400);
  });

  it('returns the counts and the stations as the database orders them', async () => {
    state.results = [
      [
        { severity: 'critical', n: 1 },
        { severity: 'high', n: 3 },
        { severity: 'info', n: 2 },
      ],
      [{ n: 2 }],
      [
        {
          id: 'sta_1',
          ocpp_id: 'CS-1',
          site_id: 'sit_a',
          site_name: 'North',
          critical: 1,
          high: 1,
          medium: 0,
          low: 0,
          info: 0,
          worst_rank: 0,
          total: 2,
          last_event_at: new Date('2026-11-09T10:00:00Z'),
        },
        {
          id: 'sta_2',
          ocpp_id: 'CS-2',
          site_id: null,
          site_name: null,
          critical: 0,
          high: 2,
          medium: 0,
          low: 0,
          info: 2,
          worst_rank: 1,
          total: 4,
          last_event_at: '2026-11-08T10:00:00Z',
        },
      ],
    ];
    const res = await get('/dashboard/security-events?range=30d');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      counts: Record<string, number>;
      total: number;
      stations: Array<{ stationId: string; worstSeverity: string; lastEventAt: string }>;
      stationTotal: number;
      since: string;
    }>();
    expect(body.counts).toEqual({ critical: 1, high: 3, medium: 0, low: 0, info: 2 });
    expect(body.total).toBe(6);
    expect(body.stations.map((s) => [s.stationId, s.worstSeverity])).toEqual([
      ['CS-1', 'critical'],
      ['CS-2', 'high'],
    ]);
    expect(body.stations[1]?.lastEventAt).toBe('2026-11-08T10:00:00.000Z');
    expect(body.stationTotal).toBe(2);
    const age = Date.now() - Date.parse(body.since);
    expect(age).toBeGreaterThan(29.9 * 24 * 3600 * 1000);
    expect(age).toBeLessThan(30.1 * 24 * 3600 * 1000);

    const stationSql = sqlText(state.queries[2]);
    expect(stationSql).toContain('ORDER BY worst_rank ASC, total DESC, last_event_at DESC');
    expect(stationSql).toContain('LIMIT');
    expect(stationSql).toContain('OFFSET');
    expect(sqlParams(state.queries[2])).toEqual(
      expect.arrayContaining([SECURITY_EVENTS_DEFAULT_LIMIT, 0]),
    );
    expect(sqlText(state.queries[1])).not.toContain('LIMIT');
    expect(stationSql).toContain('is_conformance = false');
    expect(stationSql).toContain('e.created_at >=');
    expect(stationSql).not.toContain('HAVING');
  });

  it('narrows only the station list by severity', async () => {
    state.results = [[{ severity: 'low', n: 5 }], [{ n: 0 }], []];
    const res = await get('/dashboard/security-events?severity=high');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ counts: Record<string, number> }>().counts.low).toBe(5);
    expect(sqlText(state.queries[0])).not.toContain('HAVING');
    for (const q of [state.queries[1], state.queries[2]]) {
      expect(sqlText(q)).toContain('HAVING');
      expect(sqlParams(q)).toContain('high');
    }
  });

  it('pages the station list and keeps the counts and the total over every page', async () => {
    state.results = [[{ severity: 'high', n: 40 }], [{ n: 45 }], []];
    const res = await get('/dashboard/security-events?page=3&limit=20');
    expect(res.statusCode).toBe(200);
    const body = res.json<{ total: number; stationTotal: number; stations: unknown[] }>();
    // Past the last page the total still comes from its own count.
    expect(body.stationTotal).toBe(45);
    expect(body.total).toBe(40);
    expect(body.stations).toEqual([]);
    expect(sqlParams(state.queries[2])).toEqual(expect.arrayContaining([20, 40]));
  });

  it('refuses a page below 1 and a limit above 100', async () => {
    expect((await get('/dashboard/security-events?page=0')).statusCode).toBe(400);
    expect((await get('/dashboard/security-events?limit=101')).statusCode).toBe(400);
  });

  it('reads a site user events only inside the station windows', async () => {
    state.siteIds = ['sit_a'];
    const movedAt = new Date('2026-11-05T00:00:00Z');
    state.windows = [{ id: 'sta_moved', since: movedAt }];
    state.results = [[], [], []];
    const res = await get('/dashboard/security-events?siteId=sit_a');
    expect(res.statusCode).toBe(200);
    expect(securityEventWindows).toHaveBeenCalledWith(['sit_a'], expect.any(Date), 'sit_a');
    const text = sqlText(state.queries[0]);
    expect(text).toContain('JOIN (VALUES');
    expect(text).toContain('e.created_at >= w.since');
    expect(sqlParams(state.queries[0])).toContain(movedAt.toISOString());
  });

  it('answers empty for a site user whose stations have no open window', async () => {
    state.siteIds = ['sit_a'];
    state.windows = [];
    const res = await get('/dashboard/security-events');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ total: number }>().total).toBe(0);
    expect(state.queries).toHaveLength(0);
  });
});
