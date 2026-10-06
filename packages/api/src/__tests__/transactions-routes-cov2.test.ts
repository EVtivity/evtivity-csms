// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { state, svc, getUserSiteIdsMock, eqMock } = vi.hoisted(() => ({
  state: { results: [] as unknown[][], index: 0 },
  svc: {
    listTransactionEvents: vi.fn(),
    getTransactionEventsBySession: vi.fn(),
    getSessionByTransactionId: vi.fn(),
  },
  getUserSiteIdsMock: vi.fn(),
  eqMock: vi.fn((col: unknown, value: unknown) => ({ eq: [col, value] })),
}));

function setupDbResults(...results: unknown[][]): void {
  state.results = results;
  state.index = 0;
}

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'innerJoin']) {
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

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()) },
  transactionEvents: {},
  transactionEventTypeEnum: { enumValues: ['Started', 'Updated', 'Ended'] as const },
  chargingSessions: { id: 'cs.id', stationId: 'cs.station_id' },
  chargingStations: { id: 'st.id', siteId: 'st.site_id' },
  sessionStatusEnum: {
    enumValues: ['active', 'completed', 'invalid', 'faulted', 'failed'] as const,
  },
}));

vi.mock('drizzle-orm', () => ({ eq: eqMock }));

vi.mock('../services/transaction.service.js', () => svc);

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: getUserSiteIdsMock,
  invalidateSiteAccessCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { transactionRoutes } from '../routes/transactions.js';

const SESSION_ID = 'ses_000000000001';

function makeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_ID,
    stationId: 'sta_1',
    evseId: null,
    connectorId: null,
    driverId: null,
    transactionId: 'txn-001',
    status: 'completed',
    startedAt: '2024-01-01T00:00:00Z',
    endedAt: '2024-01-01T01:00:00Z',
    meterStart: 0,
    meterStop: 1000,
    energyDeliveredWh: '1000',
    stoppedReason: null,
    isRoaming: false,
    remoteStartId: null,
    reservationId: null,
    currentCostCents: null,
    finalCostCents: 100,
    currency: 'eur',
    tariffId: null,
    tariffPricePerKwh: null,
    tariffPricePerMinute: null,
    tariffPricePerSession: null,
    tariffIdleFeePricePerMinute: null,
    tariffTaxRate: null,
    idleStartedAt: null,
    idleMinutes: '0',
    lastUpdateNotifiedAt: null,
    metadata: null,
    freeVend: false,
    co2AvoidedKg: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T01:00:00Z',
    ...overrides,
  };
}

describe('transaction routes site access (cov2)', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(transactionRoutes);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    getUserSiteIdsMock.mockReset().mockResolvedValue(['sit_a']);
    svc.listTransactionEvents.mockReset().mockResolvedValue({ data: [], total: 0 });
    svc.getTransactionEventsBySession.mockReset().mockResolvedValue([]);
    svc.getSessionByTransactionId.mockReset();
  });

  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('lists nothing without querying for an operator with no sites', async () => {
    getUserSiteIdsMock.mockResolvedValue([]);
    const res = await get('/transactions');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], total: 0 });
    expect(svc.listTransactionEvents).not.toHaveBeenCalled();
  });

  it('passes the operator site ids to the list query', async () => {
    const res = await get('/transactions?page=2&limit=5');
    expect(res.statusCode).toBe(200);
    expect(svc.listTransactionEvents).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, limit: 5 }),
      ['sit_a'],
    );
  });

  describe('GET /transactions/by-session/:sessionId', () => {
    it('404s a session at a site the operator cannot see', async () => {
      setupDbResults([{ siteId: 'sit_other' }]);
      const res = await get(`/transactions/by-session/${SESSION_ID}`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      expect(svc.getTransactionEventsBySession).not.toHaveBeenCalled();
      expect(eqMock).toHaveBeenCalledWith('cs.id', SESSION_ID);
    });

    it('returns events for a session at an allowed site', async () => {
      setupDbResults([{ siteId: 'sit_a' }]);
      const res = await get(`/transactions/by-session/${SESSION_ID}`);
      expect(res.statusCode).toBe(200);
      expect(svc.getTransactionEventsBySession).toHaveBeenCalledWith(SESSION_ID);
    });

    it('allows a session whose station has no site', async () => {
      setupDbResults([{ siteId: null }]);
      const res = await get(`/transactions/by-session/${SESSION_ID}`);
      expect(res.statusCode).toBe(200);
      expect(svc.getTransactionEventsBySession).toHaveBeenCalledWith(SESSION_ID);
    });

    it('lets the service answer an unknown session', async () => {
      setupDbResults([]);
      const res = await get(`/transactions/by-session/${SESSION_ID}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });
  });

  describe('GET /transactions/by-transaction-id/:transactionId', () => {
    it('404s a transaction at a site the operator cannot see', async () => {
      svc.getSessionByTransactionId.mockResolvedValue(makeSession());
      setupDbResults([{ siteId: 'sit_other' }]);
      const res = await get('/transactions/by-transaction-id/txn-001?stationId=CS-1');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Transaction not found', code: 'TRANSACTION_NOT_FOUND' });
      expect(eqMock).toHaveBeenCalledWith('st.id', 'sta_1');
    });

    it('returns a transaction at an allowed site with an uppercase currency', async () => {
      svc.getSessionByTransactionId.mockResolvedValue(makeSession());
      setupDbResults([{ siteId: 'sit_a' }]);
      const res = await get('/transactions/by-transaction-id/txn-001?stationId=CS-1');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: SESSION_ID, currency: 'EUR' });
      expect(svc.getSessionByTransactionId).toHaveBeenCalledWith('CS-1', 'txn-001');
    });

    it('returns a transaction whose station has no site', async () => {
      svc.getSessionByTransactionId.mockResolvedValue(makeSession());
      setupDbResults([{ siteId: null }]);
      const res = await get('/transactions/by-transaction-id/txn-001?stationId=CS-1');
      expect(res.statusCode).toBe(200);
    });
  });
});
