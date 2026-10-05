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

vi.mock('@evtivity/payments', () => ({
  authorizeSessionHold: vi.fn(),
}));

vi.mock('../lib/payments.js', () => ({
  activePaymentProvider: vi.fn().mockResolvedValue(null),
  paymentContext: vi.fn(() => ({})),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  setPubSub: vi.fn(),
}));

const mockTriggerAndWaitForStatus = vi.fn().mockResolvedValue({ status: 'available' });

vi.mock('@evtivity/services/ocpp-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/services/ocpp-command')>()),
  sendOcppCommandAndWait: vi.fn().mockResolvedValue({
    response: { status: 'Accepted' },
    error: null,
  }),
}));

vi.mock('../lib/station-status-check.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/station-status-check.js')>()),
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
    mockTriggerAndWaitForStatus.mockResolvedValue({ status: 'available' });
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
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Station is offline', code: 'STATION_OFFLINE' });
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
    mockTriggerAndWaitForStatus.mockResolvedValue({ status: 'preparing' });
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

  it.each([
    ['STATUS_CHECK_REJECTED', 502, 'Station rejected the status check'],
    ['STATION_TIMEOUT', 504, 'Station did not respond'],
    ['STATUS_CHECK_TIMEOUT', 504, 'Status check timed out. Replug the connector and try again.'],
  ])('returns %s as an error response, not a 200', async (code, httpStatus, message) => {
    mockTriggerAndWaitForStatus.mockResolvedValue({ status: null, errorCode: code });
    setupDbResults(
      [{ id: VALID_STATION_ID, stationId: `CS-${code}`, isOnline: true, ocppProtocol: 'ocpp2.1' }],
      [{ connector_id: 1 }],
    );
    const response = await app.inject({
      method: 'POST',
      url: `/portal/chargers/CS-${code}/evse/1/check-status`,
      headers: { authorization: `Bearer ${driverToken}` },
    });
    expect(response.statusCode).toBe(httpStatus);
    expect(response.json()).toEqual({ error: message, code });
  });

  it('replays a cached failed check as the same error response', async () => {
    mockTriggerAndWaitForStatus.mockResolvedValue({
      status: null,
      errorCode: 'STATUS_CHECK_TIMEOUT',
    });
    const station = {
      id: VALID_STATION_ID,
      stationId: 'CS-CACHED',
      isOnline: true,
      ocppProtocol: 'ocpp2.1',
    };
    const request = {
      method: 'POST' as const,
      url: '/portal/chargers/CS-CACHED/evse/1/check-status',
      headers: { authorization: `Bearer ${driverToken}` },
    };
    setupDbResults([station], [{ connector_id: 1 }]);
    await app.inject(request);
    setupDbResults([station]);
    const cached = await app.inject(request);
    expect(mockTriggerAndWaitForStatus).toHaveBeenCalledTimes(1);
    expect(cached.statusCode).toBe(504);
    expect(cached.json().code).toBe('STATUS_CHECK_TIMEOUT');
  });

  it('passes station version to triggerAndWaitForStatus', async () => {
    mockTriggerAndWaitForStatus.mockResolvedValue({ status: 'available' });
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
