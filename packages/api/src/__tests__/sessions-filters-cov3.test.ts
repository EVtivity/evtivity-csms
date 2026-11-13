// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

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
      desc: vi.fn((col: unknown) => ({ desc: col })),
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
    '$dynamic',
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

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  db: { select: vi.fn(() => makeChain()) },
  chargingSessions: {
    id: 'cs.id',
    stationId: 'cs.stationId',
    siteId: 'cs.siteId',
    status: 'cs.status',
    idleStartedAt: 'cs.idleStartedAt',
    rebillStatus: 'cs.rebillStatus',
    transactionId: 'cs.transactionId',
  },
  chargingStations: { id: 'st.id', siteId: 'st.siteId', stationId: 'st.stationId' },
  sites: {},
  drivers: { firstName: 'd.firstName', lastName: 'd.lastName' },
  driverTokens: {},
  transactionEvents: {
    id: 'te.id',
    sessionId: 'te.sessionId',
    timestamp: 'te.timestamp',
    seqNo: 'te.seqNo',
  },
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
  meterValues: {
    id: 'mv.id',
    sessionId: 'mv.sessionId',
    measurand: 'mv.measurand',
    timestamp: 'mv.timestamp',
  },
  guestSessions: {},
  vehicles: {},
  sessionStatusEnum: {
    enumValues: ['active', 'completed', 'invalid', 'faulted', 'failed'] as const,
  },
  SESSION_REBILL_STATUSES: ['in_progress', 'billed', 'manual'] as const,
}));

vi.mock('drizzle-orm', () => drizzle);
vi.mock('../lib/site-access.js', () => ({ getUserSiteIds }));
// The cost condition has its own test; here only that the list asks for it.
vi.mock('@evtivity/services/electricity-cost.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/services/electricity-cost.service')>()),
  sessionCostMissing: vi.fn(() => ({ costMissing: true })),
}));
import { sessionCostMissing } from '@evtivity/services/electricity-cost.service';

import { registerAuth } from '../plugins/auth.js';
import { sessionRoutes } from '../routes/sessions.js';
import { getCompanyCurrency } from '@evtivity/database';

describe('session list filters - cov3', () => {
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

  it('lists sessions waiting for manual billing by their rebill status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sessions?status=manual_billing',
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(drizzle.eq).toHaveBeenCalledWith('cs.rebillStatus', 'manual');
    expect(drizzle.eq).not.toHaveBeenCalledWith('cs.status', 'manual_billing');
  });

  it('lists idling sessions as active ones with an idle start', async () => {
    const res = await app.inject({ method: 'GET', url: '/sessions?status=idling', headers });
    expect(res.statusCode).toBe(200);
    expect(drizzle.eq).toHaveBeenCalledWith('cs.status', 'active');
    expect(drizzle.isNotNull).toHaveBeenCalledWith('cs.idleStartedAt');
  });

  it('filters sessions without a cost in the company currency', async () => {
    const res = await app.inject({ method: 'GET', url: '/sessions?costMissing=true', headers });
    expect(res.statusCode).toBe(200);
    expect(sessionCostMissing).toHaveBeenCalledWith('EUR');
    expect(drizzle.and.mock.calls[0]).toContainEqual({ costMissing: true });
  });

  it('reads no currency when the cost filter is off', async () => {
    const res = await app.inject({ method: 'GET', url: '/sessions?costMissing=false', headers });
    expect(res.statusCode).toBe(200);
    expect(getCompanyCurrency).not.toHaveBeenCalled();
  });
});
