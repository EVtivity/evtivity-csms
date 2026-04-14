// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// DB mock helpers
let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'delete',
    'insert',
    'update',
  ];
  for (const m of methods) {
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
  chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => {
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(r);
    }),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeChain()),
        insert: vi.fn(() => makeChain()),
        update: vi.fn(() => makeChain()),
        delete: vi.fn(() => makeChain()),
      };
      return fn(tx);
    }),
  },
  client: { end: vi.fn() },
  chargingStations: {},
  evses: {},
  connectors: {},
  sites: {},
  chargingSessions: {},
  driverPaymentMethods: {},
  paymentRecords: {},
  reservations: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn((...args: unknown[]) => args),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
}));

const mockPgEnd = vi.fn().mockResolvedValue(undefined);
const mockPgTagged = vi.fn().mockResolvedValue([]);
vi.mock('postgres', () => ({
  default: vi.fn(() => {
    const fn = mockPgTagged as unknown as Record<string, unknown>;
    fn.end = mockPgEnd;
    return fn;
  }),
}));

vi.mock('../services/stripe.service.js', () => ({
  getStripeConfig: vi.fn().mockResolvedValue(null),
  createPreAuthorization: vi.fn().mockResolvedValue({ id: 'pi_test_123' }),
}));

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  setPubSub: vi.fn(),
}));

vi.mock('../services/tariff.service.js', () => ({
  resolveTariff: vi.fn().mockResolvedValue(null),
  isTariffFree: vi.fn().mockReturnValue(true),
}));

const mockTriggerAndWaitForStatus = vi.fn().mockResolvedValue({
  status: 'available',
  error: undefined,
});

vi.mock('../lib/ocpp-command.js', () => ({
  sendOcppCommandAndWait: vi.fn().mockResolvedValue({
    response: { status: 'Accepted' },
    error: null,
  }),
  triggerAndWaitForStatus: (...args: unknown[]) => mockTriggerAndWaitForStatus(...args),
}));

// Rate limiter: use the real implementation but reset between tests
const rateLimiterModule = await import('../lib/rate-limiters.js');

import { registerAuth } from '../plugins/auth.js';
import { portalChargerRoutes } from '../routes/portal/charger.js';

const DRIVER_ID = 'drv_000000000001';
const VALID_STATION_ID = 'sta_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalChargerRoutes);
  await app.ready();
  return app;
}

describe('Check-status endpoint', () => {
  let app: FastifyInstance;
  let driverToken: string;

  beforeAll(async () => {
    app = await buildApp();
    driverToken = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    mockTriggerAndWaitForStatus.mockReset();
    mockTriggerAndWaitForStatus.mockResolvedValue({ status: 'available', error: undefined });
  });

  it('returns 401 without token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/portal/chargers/CS-001/evse/1/check-status',
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 404 for unknown station', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'POST',
      url: '/portal/chargers/CS-UNKNOWN/evse/1/check-status',
      headers: { authorization: `Bearer ${driverToken}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('STATION_NOT_FOUND');
  });

  it('returns offline error when station is not online', async () => {
    setupDbResults([
      {
        id: VALID_STATION_ID,
        stationId: 'CS-001',
        isOnline: false,
        ocppProtocol: 'ocpp2.1',
      },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/portal/chargers/CS-001/evse/1/check-status',
      headers: { authorization: `Bearer ${driverToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.connectorStatus).toBeNull();
    expect(body.error).toBe('Station is offline');
  });

  it('returns 404 when connector not found', async () => {
    setupDbResults(
      [
        {
          id: VALID_STATION_ID,
          stationId: 'CS-CONN-MISS',
          isOnline: true,
          ocppProtocol: 'ocpp2.1',
        },
      ],
      [], // db.execute for connector query returns empty
    );
    const response = await app.inject({
      method: 'POST',
      url: '/portal/chargers/CS-CONN-MISS/evse/1/check-status',
      headers: { authorization: `Bearer ${driverToken}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('CONNECTOR_NOT_FOUND');
  });

  it('returns connector status on success', async () => {
    mockTriggerAndWaitForStatus.mockResolvedValue({ status: 'preparing', error: undefined });
    setupDbResults(
      [
        {
          id: VALID_STATION_ID,
          stationId: 'CS-OK',
          isOnline: true,
          ocppProtocol: 'ocpp2.1',
        },
      ],
      [{ connector_id: 1 }], // db.execute for connector query
    );
    const response = await app.inject({
      method: 'POST',
      url: '/portal/chargers/CS-OK/evse/1/check-status',
      headers: { authorization: `Bearer ${driverToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.connectorStatus).toBe('preparing');
    expect(body.error).toBeUndefined();
  });

  it('passes station version to triggerAndWaitForStatus', async () => {
    mockTriggerAndWaitForStatus.mockResolvedValue({ status: 'available', error: undefined });
    setupDbResults(
      [
        {
          id: VALID_STATION_ID,
          stationId: 'CS-16',
          isOnline: true,
          ocppProtocol: 'ocpp1.6',
        },
      ],
      [{ connector_id: 2 }],
    );
    await app.inject({
      method: 'POST',
      url: '/portal/chargers/CS-16/evse/1/check-status',
      headers: { authorization: `Bearer ${driverToken}` },
    });
    expect(mockTriggerAndWaitForStatus).toHaveBeenCalledWith(
      'CS-16',
      1,
      2,
      VALID_STATION_ID,
      'ocpp1.6',
    );
  });
});

describe('isStationCheckRateLimited', () => {
  it('allows up to 5 requests within the rate window', () => {
    const stationId = `RL-TEST-${String(Date.now())}`;
    for (let i = 0; i < 5; i++) {
      expect(rateLimiterModule.isStationCheckRateLimited(stationId)).toBe(false);
    }
  });

  it('blocks the 6th request within the same window', () => {
    const stationId = `RL-BLOCK-${String(Date.now())}`;
    for (let i = 0; i < 5; i++) {
      rateLimiterModule.isStationCheckRateLimited(stationId);
    }
    expect(rateLimiterModule.isStationCheckRateLimited(stationId)).toBe(true);
  });

  it('tracks per-station independently', () => {
    const now = String(Date.now());
    const stationA = `RL-A-${now}`;
    const stationB = `RL-B-${now}`;
    for (let i = 0; i < 5; i++) {
      rateLimiterModule.isStationCheckRateLimited(stationA);
    }
    // Station A is now rate limited
    expect(rateLimiterModule.isStationCheckRateLimited(stationA)).toBe(true);
    // Station B should still be allowed
    expect(rateLimiterModule.isStationCheckRateLimited(stationB)).toBe(false);
  });
});
