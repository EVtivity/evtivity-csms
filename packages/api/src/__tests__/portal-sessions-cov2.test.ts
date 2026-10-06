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

vi.mock('../lib/session-limit.js', () => ({ sessionLimitReached: vi.fn(async () => null) }));

vi.mock('@evtivity/database', () => ({
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
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
  chargingSessions: {},
  chargingStations: {},
  sites: {},
  paymentRecords: {},
  meterValues: {},
  drivers: {},
  driverTokens: {},
  vehicles: {},
  vehicleEfficiencyLookup: {},
}));

vi.mock('drizzle-orm', () => {
  const sqlTag = (...args: unknown[]) => ({ __brand: 'SQL', args });
  return {
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    ilike: vi.fn(),
    sql: sqlTag,
    desc: vi.fn(),
    count: vi.fn(),
    asc: vi.fn(),
  };
});

import { registerAuth } from '../plugins/auth.js';
import { portalSessionRoutes } from '../routes/portal/sessions.js';
import { db } from '@evtivity/database';

const DRIVER_ID = 'drv_000000000001';
const OTHER_DRIVER = 'drv_000000000002';
const SESSION_ID = 'ses_000000000001';
const VEHICLE_ID = 'veh_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalSessionRoutes);
  await app.ready();
  return app;
}

const baseSession = {
  id: SESSION_ID,
  transactionId: 'tx-1',
  status: 'active',
  startedAt: '2024-01-01T00:00:00Z',
  endedAt: null,
  energyDeliveredWh: 5000,
  currentCostCents: 300,
  finalCostCents: null,
  costBreakdown: null,
  currency: 'USD',
  meterStart: 0,
  meterStop: null,
  stoppedReason: null,
  stationName: 'CS-001',
  siteName: 'Site A',
  siteAddress: '123 Main St',
  siteCity: 'Austin',
  siteState: 'TX',
  driverId: DRIVER_ID,
  updatedAt: '2024-01-01T00:30:00Z',
  idleStartedAt: null,
  co2AvoidedKg: null,
  reservationId: null,
};

describe('Portal sessions routes: vehicle and meter history', () => {
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
    vi.clearAllMocks();
    setupDbResults();
  });

  function call(method: 'GET' | 'PATCH', url: string, payload?: Record<string, unknown>) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${driverToken}` },
      ...(payload != null ? { payload } : {}),
    });
  }

  describe('GET /portal/sessions/:id with live data and a vehicle', () => {
    it('returns power, SoC, token and the looked-up vehicle efficiency', async () => {
      setupDbResults(
        [
          {
            ...baseSession,
            tokenIdToken: 'RFID-1',
            tokenType: null,
            vehicleId: VEHICLE_ID,
            vehicleMake: 'Tesla',
            vehicleModel: 'Model 3',
            vehicleYear: '2022',
          },
        ],
        [],
        [{ value: '7200.5' }],
        [{ value: '64' }],
        [{ efficiencyMiPerKwh: '4.1' }],
      );
      const res = await call('GET', `/portal/sessions/${SESSION_ID}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.currentPowerW).toBe(7200.5);
      expect(body.batteryPercent).toBe(64);
      expect(body.payment).toBeNull();
      expect(body.token).toEqual({ idToken: 'RFID-1', tokenType: '' });
      expect(body.vehicle).toEqual({
        id: VEHICLE_ID,
        make: 'Tesla',
        model: 'Model 3',
        year: '2022',
        efficiencyMiPerKwh: 4.1,
      });
    });

    it('falls back to the default efficiency when the vehicle is not in the lookup', async () => {
      setupDbResults(
        [
          {
            ...baseSession,
            tokenIdToken: null,
            tokenType: null,
            vehicleId: VEHICLE_ID,
            vehicleMake: 'Rare',
            vehicleModel: 'EV',
            vehicleYear: null,
          },
        ],
        [],
        [],
        [],
        [],
      );
      const res = await call('GET', `/portal/sessions/${SESSION_ID}`);
      const body = res.json();
      expect(body.currentPowerW).toBeNull();
      expect(body.batteryPercent).toBeNull();
      expect(body.token).toBeNull();
      expect(body.vehicle.efficiencyMiPerKwh).toBe(3.5);
    });
  });

  describe('PATCH /portal/sessions/:id/vehicle', () => {
    it('returns 404 when the session does not exist', async () => {
      setupDbResults([]);
      const res = await call('PATCH', `/portal/sessions/${SESSION_ID}/vehicle`, {
        vehicleId: VEHICLE_ID,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('returns 403 when the session belongs to another driver', async () => {
      setupDbResults([{ driverId: OTHER_DRIVER }]);
      const res = await call('PATCH', `/portal/sessions/${SESSION_ID}/vehicle`, {
        vehicleId: null,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('FORBIDDEN');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('returns 404 when the vehicle does not exist', async () => {
      setupDbResults([{ driverId: DRIVER_ID }], []);
      const res = await call('PATCH', `/portal/sessions/${SESSION_ID}/vehicle`, {
        vehicleId: VEHICLE_ID,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Vehicle not found', code: 'VEHICLE_NOT_FOUND' });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('returns 403 when the vehicle belongs to another driver', async () => {
      setupDbResults([{ driverId: DRIVER_ID }], [{ driverId: OTHER_DRIVER }]);
      const res = await call('PATCH', `/portal/sessions/${SESSION_ID}/vehicle`, {
        vehicleId: VEHICLE_ID,
      });
      expect(res.statusCode).toBe(403);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('links an own vehicle to the session', async () => {
      setupDbResults([{ driverId: DRIVER_ID }], [{ driverId: DRIVER_ID }], []);
      const res = await call('PATCH', `/portal/sessions/${SESSION_ID}/vehicle`, {
        vehicleId: VEHICLE_ID,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ vehicleId: VEHICLE_ID });
      const updateChain = vi.mocked(db.update).mock.results[0]?.value as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(updateChain['set']).toHaveBeenCalledWith({
        vehicleId: VEHICLE_ID,
        updatedAt: expect.any(Date),
      });
    });

    it('unlinks the vehicle without looking one up', async () => {
      setupDbResults([{ driverId: DRIVER_ID }], []);
      const res = await call('PATCH', `/portal/sessions/${SESSION_ID}/vehicle`, {
        vehicleId: null,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ vehicleId: null });
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe.each([
    ['power-history', 'powerW'],
    ['energy-history', 'energyWh'],
  ])('GET /portal/sessions/:id/%s', (path, field) => {
    it('returns 404 when the session does not exist', async () => {
      setupDbResults([]);
      const res = await call('GET', `/portal/sessions/${SESSION_ID}/${path}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SESSION_NOT_FOUND');
    });

    it('returns 403 for another driver session', async () => {
      setupDbResults([{ driverId: OTHER_DRIVER, startedAt: null, meterStart: 0 }]);
      const res = await call('GET', `/portal/sessions/${SESSION_ID}/${path}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('FORBIDDEN');
    });

    it('prepends a zero point at the session start', async () => {
      setupDbResults(
        [{ driverId: DRIVER_ID, startedAt: '2024-01-01T00:00:00.000Z', meterStart: 1000 }],
        [{ timestamp: '2024-01-01T00:00:30.000Z', [field]: 1500 }],
      );
      const res = await call('GET', `/portal/sessions/${SESSION_ID}/${path}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        data: [
          { timestamp: '2024-01-01T00:00:00.000Z', [field]: 0 },
          { timestamp: '2024-01-01T00:00:30.000Z', [field]: 1500 },
        ],
      });
    });

    it('returns only the samples when the session has no start time', async () => {
      setupDbResults(
        [{ driverId: DRIVER_ID, startedAt: null, meterStart: null }],
        [{ timestamp: '2024-01-01T00:00:30.000Z', [field]: 200 }],
      );
      const res = await call('GET', `/portal/sessions/${SESSION_ID}/${path}`);
      expect(res.json()).toEqual({
        data: [{ timestamp: '2024-01-01T00:00:30.000Z', [field]: 200 }],
      });
    });
  });
});
