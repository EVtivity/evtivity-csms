// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

const SESSION_ID = 'ses_000000000001';
const SITE_ID = 'sit_000000000001';
const STATION_ID = 'sta_000000000001';

const { results, getUserSiteIds, drizzle } = vi.hoisted(() => {
  const sqlTag = (..._args: unknown[]) => ({ as: () => 'sqlAs' });
  return {
    results: [] as unknown[][],
    getUserSiteIds: vi.fn(),
    drizzle: {
      eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
      and: vi.fn((...c: unknown[]) => ({ and: c })),
      or: vi.fn((...c: unknown[]) => ({ or: c })),
      ilike: vi.fn((col: unknown, val: unknown) => ({ ilike: [col, val] })),
      isNotNull: vi.fn((col: unknown) => ({ isNotNull: col })),
      inArray: vi.fn((col: unknown, val: unknown) => ({ inArray: [col, val] })),
      sql: Object.assign(sqlTag, { raw: () => ({ as: () => 'raw' }) }),
      desc: vi.fn(),
      count: vi.fn(),
      asc: vi.fn(),
    },
  };
});

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  let p: Promise<unknown> | null = null;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    p ??= Promise.resolve(results.shift() ?? []);
    return p.then(resolve, reject);
  };
  return chain;
}

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
}));

vi.mock('@evtivity/database', () => ({
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  db: { select: vi.fn(() => makeChain()) },
  chargingSessions: {
    id: 'cs.id',
    stationId: 'cs.stationId',
    status: 'cs.status',
    idleStartedAt: 'cs.idleStartedAt',
    transactionId: 'cs.transactionId',
  },
  chargingStations: { id: 'st.id', siteId: 'st.siteId', stationId: 'st.stationId' },
  sites: {},
  drivers: { firstName: 'd.firstName', lastName: 'd.lastName' },
  driverTokens: {},
  transactionEvents: { sessionId: 'te.sessionId', timestamp: 'te.timestamp' },
  transactionEventTypeEnum: { enumValues: ['Started', 'Updated', 'Ended'] as const },
  paymentRecords: {},
  paymentStatusEnum: {
    enumValues: [
      'pending',
      'pre_authorized',
      'captured',
      'partially_refunded',
      'refunded',
      'failed',
      'cancelled',
    ] as const,
  },
  meterValues: { sessionId: 'mv.sessionId', measurand: 'mv.measurand' },
  guestSessions: {},
  vehicles: {},
  sessionStatusEnum: {
    enumValues: ['active', 'completed', 'invalid', 'faulted', 'failed'] as const,
  },
  SESSION_REBILL_STATUSES: ['in_progress', 'billed', 'manual'] as const,
}));

vi.mock('drizzle-orm', () => drizzle);
vi.mock('../lib/site-access.js', () => ({ getUserSiteIds }));

import { registerAuth } from '../plugins/auth.js';
import { sessionRoutes } from '../routes/sessions.js';

describe('session routes - filters, site scope, transaction events', () => {
  let app: FastifyInstance;
  let headers: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(rateLimit, { global: false });
    await app.register(async (instance) => {
      sessionRoutes(instance);
    });
    await app.ready();
    headers = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    results.length = 0;
    getUserSiteIds.mockResolvedValue(null);
  });

  describe('GET /sessions', () => {
    it('returns an empty page without querying when the user has no sites', async () => {
      getUserSiteIds.mockResolvedValue([]);
      const res = await app.inject({ method: 'GET', url: '/sessions', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(drizzle.inArray).not.toHaveBeenCalled();
    });

    it('restricts to the user sites and applies site, station and status filters', async () => {
      getUserSiteIds.mockResolvedValue([SITE_ID]);
      const res = await app.inject({
        method: 'GET',
        url: `/sessions?siteId=${SITE_ID}&stationId=${STATION_ID}&status=completed`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(drizzle.inArray).toHaveBeenCalledWith('st.siteId', [SITE_ID]);
      expect(drizzle.eq).toHaveBeenCalledWith('st.siteId', SITE_ID);
      expect(drizzle.eq).toHaveBeenCalledWith('cs.stationId', STATION_ID);
      expect(drizzle.eq).toHaveBeenCalledWith('cs.status', 'completed');
      expect(drizzle.isNotNull).not.toHaveBeenCalled();
    });

    it('rate-limits per user at 60 requests a minute', async () => {
      const limited = {
        authorization: `Bearer ${app.jwt.sign({ userId: 'usr_rl', roleId: 'r' })}`,
      };
      const other = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_ok', roleId: 'r' })}` };
      let last = 0;
      for (let i = 0; i < 61; i++) {
        const res = await app.inject({ method: 'GET', url: '/sessions', headers: limited });
        last = res.statusCode;
        if (i === 0) expect(res.headers['x-ratelimit-limit']).toBe('60');
      }
      expect(last).toBe(429);
      const res = await app.inject({ method: 'GET', url: '/sessions', headers: other });
      expect(res.statusCode).toBe(200);
    });
  });

  it('GET /sessions/:id returns 404 for a session on a site the user cannot see', async () => {
    getUserSiteIds.mockResolvedValue(['sit_other']);
    results.push([{ id: SESSION_ID, siteId: SITE_ID }]);
    const res = await app.inject({ method: 'GET', url: `/sessions/${SESSION_ID}`, headers });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
  });

  describe('GET /sessions/:id/transaction-events', () => {
    it('returns 404 when the session does not exist', async () => {
      results.push([]);
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${SESSION_ID}/transaction-events`,
        headers,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SESSION_NOT_FOUND');
    });

    it('returns 404 when the session is on another site', async () => {
      getUserSiteIds.mockResolvedValue(['sit_other']);
      results.push([{ id: SESSION_ID, siteId: SITE_ID }]);
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${SESSION_ID}/transaction-events`,
        headers,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SESSION_NOT_FOUND');
    });

    it('returns the page of events with the total', async () => {
      const event = {
        id: 'tev_1',
        eventType: 'Started',
        seqNo: 0,
        timestamp: '2026-01-01T00:00:00.000Z',
        triggerReason: 'Authorized',
        offline: false,
      };
      results.push([{ id: SESSION_ID, siteId: SITE_ID }], [event], [{ count: 7 }]);
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${SESSION_ID}/transaction-events?page=2&limit=5`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [event], total: 7 });
      expect(drizzle.eq).toHaveBeenCalledWith('te.sessionId', SESSION_ID);
    });

    it('returns total 0 when the count query has no row', async () => {
      results.push([{ id: SESSION_ID, siteId: null }], [], []);
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${SESSION_ID}/transaction-events`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });
  });

  it('GET /sessions/:id/meter-values returns 404 when the session is on another site', async () => {
    getUserSiteIds.mockResolvedValue(['sit_other']);
    results.push([{ id: SESSION_ID, siteId: SITE_ID }]);
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${SESSION_ID}/meter-values`,
      headers,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('SESSION_NOT_FOUND');
  });
});
