// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Rows the next db.execute calls answer, in order.
const results = vi.hoisted(() => ({ queue: [] as unknown[][], calls: [] as unknown[] }));
const siteScopes = vi.hoisted(
  () =>
    new Map<string, string[] | null>([
      ['usr_000000000001', null],
      ['usr_000000000002', ['sit_aaaaaaaaaaaa']],
      ['usr_000000000004', null],
    ]),
);

const userPermissions = vi.hoisted(
  () =>
    new Map<string, string[]>([
      ['usr_000000000001', ['stations:read']],
      ['usr_000000000002', ['stations:read']],
      ['usr_000000000003', ['sites:read']],
      ['usr_000000000004', ['stations:read', 'securityEvents:read']],
    ]),
);

vi.mock('@evtivity/database', () => ({
  db: {
    execute: vi.fn((query: unknown) => {
      results.calls.push(query);
      return Promise.resolve(results.queue.shift() ?? []);
    }),
  },
  operatorStationSql: (alias: string) => `${alias}.is_conformance = false`,
  toDate: (v: Date | string) => (v instanceof Date ? v : new Date(v)),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn((userId: string) =>
    Promise.resolve(siteScopes.has(userId) ? (siteScopes.get(userId) ?? null) : []),
  ),
}));

// The real guard reads permissions from the database; this stand-in keeps its
// decision from the permissions of each test user.
vi.mock('../middleware/rbac.js', () => ({
  authorize:
    (...required: string[]) =>
    async (
      request: { jwtVerify: () => Promise<void>; user?: { userId?: string } },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      await request.jwtVerify();
      const perms = userPermissions.get(request.user?.userId ?? '') ?? [];
      if (!required.every((p) => perms.includes(p))) {
        await reply.status(403).send({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' });
      }
    },
  requestHasPermission: (request: { user?: { userId?: string } }, permission: string) =>
    Promise.resolve((userPermissions.get(request.user?.userId ?? '') ?? []).includes(permission)),
}));

import { registerAuth } from '../plugins/auth.js';
import { siteOcppMessageRoutes } from '../routes/site-ocpp-messages.js';
import { matchCacheRule } from '../plugins/response-cache.js';

const SITE = 'sit_aaaaaaaaaaaa';
const OTHER_SITE = 'sit_bbbbbbbbbbbb';
const STATION = 'sta_aaaaaaaaaaaa';

function logRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    station_id: STATION,
    station_ocpp_id: 'CS-3050',
    direction: 'inbound',
    message_type: 2,
    message_id: 'm-1',
    action: 'Heartbeat',
    payload: {},
    error_code: null,
    error_description: null,
    created_at: '2026-11-03 14:02:11.000+00',
    ...overrides,
  };
}

describe('GET /sites/:id/ocpp-messages', () => {
  let app: FastifyInstance;
  let allSites: string;
  let restricted: string;
  let noPermission: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    siteOcppMessageRoutes(app);
    await app.ready();
    allSites = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
    restricted = app.jwt.sign({ userId: 'usr_000000000002', roleId: 'rol_000000000001' });
    noPermission = app.jwt.sign({ userId: 'usr_000000000003', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    results.queue = [];
    results.calls = [];
  });

  const get = (token: string, url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('needs the station OCPP log permission', async () => {
    const res = await get(noPermission, `/sites/${SITE}/ocpp-messages`);
    expect(res.statusCode).toBe(403);
    expect(results.calls).toHaveLength(0);
  });

  it('answers 404 for a site outside the caller scope without reading anything', async () => {
    const res = await get(restricted, `/sites/${OTHER_SITE}/ocpp-messages`);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('SITE_NOT_FOUND');
    expect(results.calls).toHaveLength(0);
  });

  it('answers 404 for an unknown site', async () => {
    results.queue = [[]];
    const res = await get(allSites, `/sites/${SITE}/ocpp-messages`);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('SITE_NOT_FOUND');
    expect(results.calls).toHaveLength(1);
  });

  it('answers 404 for a station that is not at the site', async () => {
    results.queue = [[{ id: SITE }], []];
    const res = await get(allSites, `/sites/${SITE}/ocpp-messages?stationId=${STATION}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('STATION_NOT_FOUND');
  });

  it('refuses a limit above the maximum and a time without an offset', async () => {
    for (const q of ['limit=201', 'after=2026-11-03T14:00:00']) {
      const res = await get(allSites, `/sites/${SITE}/ocpp-messages?${q}`);
      expect(res.statusCode, q).toBe(400);
    }
  });

  it('returns the rows of an in-scope site with credentials and URL passwords masked', async () => {
    results.queue = [
      [{ id: SITE }],
      [{ id: STATION, station_id: 'CS-3050' }],
      [{ id: STATION, placed_at: null, move_at: null, move_site_id: null, foreign_until: null }],
      [
        logRow({
          id: 7,
          direction: 'outbound',
          action: 'SetVariables',
          payload: {
            setVariableData: [
              {
                component: { name: 'SecurityCtrlr' },
                variable: { name: 'BasicAuthPassword' },
                attributeValue: 'TopSecretPassword1',
              },
            ],
          },
        }),
        logRow({
          id: 8,
          direction: 'outbound',
          action: 'GetLog',
          payload: { log: { remoteLocation: 'ftp://user:hunter22@files.example/logs/' } },
        }),
        logRow({
          id: 9,
          message_type: 4,
          action: null,
          error_code: 'InternalError',
          error_description: 'upload to ftp://u:pw123@h/x failed',
        }),
      ],
    ];
    const res = await get(restricted, `/sites/${SITE}/ocpp-messages`);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.stringify(res.json());
    expect(body).not.toContain('TopSecretPassword1');
    expect(body).not.toContain('hunter22');
    expect(body).not.toContain('pw123');
    const data = res.json().data as Array<Record<string, unknown>>;
    expect(data.map((d) => d['id'])).toEqual([7, 8, 9]);
    expect(data[0]?.['stationOcppId']).toBe('CS-3050');
    expect(data[0]?.['createdAt']).toBe('2026-11-03T14:02:11.000Z');
  });

  // A drizzle sql template's bound values, for checking what a query was given.
  const params = (query: unknown): unknown[] => {
    const chunks = (query as { queryChunks?: unknown[] } | null)?.queryChunks;
    if (chunks == null) return typeof query === 'string' ? [query] : [];
    return chunks.flatMap((c) => params(c));
  };

  it('reads a moved station only from its move to the site, initial history and polling alike', async () => {
    const movedAt = '2026-11-03 12:00:00.000+00';
    for (const query of ['', '?after=2026-11-03T13:00:00Z', `?stationId=${STATION}`]) {
      results.calls = [];
      results.queue = [
        [{ id: SITE }],
        ...(query.includes('stationId') ? [[{ id: STATION }]] : []),
        [{ id: STATION, station_id: 'CS-3050' }],
        [
          {
            id: STATION,
            placed_at: null,
            move_at: movedAt,
            move_site_id: SITE,
            foreign_until: null,
          },
        ],
        [logRow()],
      ];
      const res = await get(allSites, `/sites/${SITE}/ocpp-messages${query}`);
      expect(res.statusCode, `${query} ${res.body}`).toBe(200);
      expect(res.json().data).toHaveLength(1);
      const messagesQuery = results.calls.at(-1);
      expect(params(messagesQuery), query).toContain('2026-11-03T12:00:00.000Z');
    }
  });

  it('leaves security event messages out without securityEvents:read, and keeps them with it', async () => {
    const securityReader = app.jwt.sign({
      userId: 'usr_000000000004',
      roleId: 'rol_000000000001',
    });
    for (const [token, hidden] of [
      [allSites, true],
      [securityReader, false],
    ] as const) {
      results.calls = [];
      results.queue = [
        [{ id: SITE }],
        [{ id: STATION, station_id: 'CS-3050' }],
        [{ id: STATION, placed_at: null, move_at: null, move_site_id: null, foreign_until: null }],
        [logRow()],
      ];
      const res = await get(token, `/sites/${SITE}/ocpp-messages`);
      expect(res.statusCode, res.body).toBe(200);
      const messagesQuery = results.calls.at(-1);
      expect(params(messagesQuery).includes('SecurityEventNotification')).toBe(hidden);
    }
  });

  it('returns nothing for a station whose newest move went to another site', async () => {
    results.queue = [
      [{ id: SITE }],
      [{ id: STATION, station_id: 'CS-3050' }],
      [
        {
          id: STATION,
          placed_at: null,
          move_at: '2026-11-03 12:00:00.000+00',
          move_site_id: OTHER_SITE,
          foreign_until: null,
        },
      ],
    ];
    const res = await get(allSites, `/sites/${SITE}/ocpp-messages`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([]);
    // Site, stations, windows: the message log is never read.
    expect(results.calls).toHaveLength(3);
  });

  it('is never served from the response cache', () => {
    expect(matchCacheRule(`/v1/sites/${SITE}/ocpp-messages`)).toBeNull();
    expect(matchCacheRule(`/v1/sites/${SITE}`)).not.toBeNull();
  });
});
