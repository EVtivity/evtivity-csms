// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// DB mock: every awaited query chain resolves to the next queued result.
let dbResults: Array<unknown[] | Error> = [];
let dbCallIndex = 0;
function setupDbResults(...results: Array<unknown[] | Error>) {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain() {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'values', 'returning', 'set']) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      if (r instanceof Error) return Promise.reject(r).then(resolve, reject);
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
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  },
  chargingSessions: {},
  chargingStations: {},
  evses: {},
  guestSessions: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));

const sendOcppCommandAndWait = vi.fn();
vi.mock('../lib/ocpp-command.js', () => ({
  sendOcppCommandAndWait: (...args: unknown[]) => sendOcppCommandAndWait(...args),
}));

const getUserSiteIds = vi.fn();
vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: (...args: unknown[]) => getUserSiteIds(...args),
}));

const getActiveMaintenanceForStation = vi.fn();
vi.mock('../services/maintenance.service.js', () => ({
  getActiveMaintenanceForStation: (...args: unknown[]) => getActiveMaintenanceForStation(...args),
}));

import { db } from '@evtivity/database';
import { registerAuth } from '../plugins/auth.js';
import { adHocPaymentRoutes } from '../routes/ad-hoc-payments.js';

const STATION = { id: 'sta_000000000001', siteId: null, isOnline: true, ocppProtocol: 'ocpp2.1' };
const BODY = {
  stationId: 'CS-001',
  evseId: 1,
  pspRef: 'PSP-4444',
  cardLast4Digits: '1234',
  maxCostCents: 5000,
  maxEnergyWh: 20000,
};

function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key'), { code: '23505' });
}

describe('POST /v1/ad-hoc-payments', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    app.register(async (instance) => {
      adHocPaymentRoutes(instance);
    });
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setupDbResults();
    getUserSiteIds.mockResolvedValue(null);
    getActiveMaintenanceForStation.mockResolvedValue(null);
    sendOcppCommandAndWait.mockResolvedValue({
      commandId: 'cmd-1',
      response: { status: 'Accepted' },
    });
  });

  function post(body: Record<string, unknown> = BODY) {
    return app.inject({
      method: 'POST',
      url: '/ad-hoc-payments',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  it('stores the payment and sends RequestStartTransaction with a DirectPayment idToken', async () => {
    // station, evse, existing payment (none), active session (none), insert
    setupDbResults([STATION], [{ id: 'evs_000000000001' }], [], [], []);

    const response = await post();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      pspRef: 'PSP-4444',
      stationId: 'CS-001',
      evseId: 1,
      replayed: false,
    });
    const insertChain = vi.mocked(db.insert).mock.results[0]?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        stationOcppId: 'CS-001',
        evseId: 1,
        sessionToken: 'PSP-4444',
        status: 'payment_authorized',
        guestEmail: '',
        maxCostCents: 5000,
        maxEnergyWh: 20000,
        maxTimeSeconds: null,
      }),
    );
    expect(sendOcppCommandAndWait).toHaveBeenCalledWith(
      'CS-001',
      'RequestStartTransaction',
      expect.objectContaining({
        evseId: 1,
        remoteStartId: expect.any(Number) as unknown,
        idToken: {
          idToken: 'PSP-4444',
          type: 'DirectPayment',
          additionalInfo: [{ additionalIdToken: '1234', type: 'CardLast4Digits' }],
        },
      }),
    );
  });

  it('sends card BIN as additionalInfo and omits additionalInfo without card details', async () => {
    setupDbResults([STATION], [{ id: 'evs_000000000001' }], [], [], []);
    await post({ stationId: 'CS-001', evseId: 1, pspRef: 'PSP-1', cardBin: '123456' });
    expect(sendOcppCommandAndWait.mock.calls[0]?.[2]).toMatchObject({
      idToken: { additionalInfo: [{ additionalIdToken: '123456', type: 'CardBin' }] },
    });

    setupDbResults([STATION], [{ id: 'evs_000000000001' }], [], [], []);
    await post({ stationId: 'CS-001', evseId: 1, pspRef: 'PSP-2' });
    expect(sendOcppCommandAndWait.mock.calls[1]?.[2]).toMatchObject({
      idToken: { idToken: 'PSP-2', type: 'DirectPayment' },
    });
    expect(
      (sendOcppCommandAndWait.mock.calls[1]?.[2] as { idToken: Record<string, unknown> }).idToken[
        'additionalInfo'
      ],
    ).toBeUndefined();
  });

  it('replays a retried pspRef for the same EVSE without sending again', async () => {
    setupDbResults(
      [STATION],
      [{ id: 'evs_000000000001' }],
      [{ stationOcppId: 'CS-001', evseId: 1 }],
    );

    const response = await post();

    expect(response.statusCode).toBe(200);
    expect(response.json().replayed).toBe(true);
    expect(sendOcppCommandAndWait).not.toHaveBeenCalled();
  });

  it('returns 409 TOKEN_DUPLICATE for a pspRef used on another EVSE', async () => {
    setupDbResults(
      [STATION],
      [{ id: 'evs_000000000001' }],
      [{ stationOcppId: 'CS-002', evseId: 1 }],
    );

    const response = await post();

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('TOKEN_DUPLICATE');
  });

  it('treats a concurrent insert of the same pspRef as a replay', async () => {
    setupDbResults([STATION], [{ id: 'evs_000000000001' }], [], [], uniqueViolation(), [
      { stationOcppId: 'CS-001', evseId: 1 },
    ]);

    const response = await post();

    expect(response.statusCode).toBe(200);
    expect(response.json().replayed).toBe(true);
    expect(sendOcppCommandAndWait).not.toHaveBeenCalled();
  });

  it('returns 404 STATION_NOT_FOUND for an unknown station', async () => {
    setupDbResults([]);
    const response = await post();
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('STATION_NOT_FOUND');
  });

  it('returns 404 STATION_NOT_FOUND for a station outside the user sites', async () => {
    getUserSiteIds.mockResolvedValue(['sit_000000000009']);
    setupDbResults([{ ...STATION, siteId: 'sit_000000000001' }]);
    const response = await post();
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('STATION_NOT_FOUND');
  });

  it('returns 400 STATION_OFFLINE for an offline station', async () => {
    setupDbResults([{ ...STATION, isOnline: false }]);
    const response = await post();
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('STATION_OFFLINE');
  });

  it('returns 400 OCPP_VERSION_MISMATCH for an OCPP 1.6 station', async () => {
    setupDbResults([{ ...STATION, ocppProtocol: 'ocpp1.6' }]);
    const response = await post();
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('OCPP_VERSION_MISMATCH');
  });

  it('returns 409 MAINTENANCE_ACTIVE during maintenance', async () => {
    getActiveMaintenanceForStation.mockResolvedValue({ plannedEndAt: new Date() });
    setupDbResults([STATION]);
    const response = await post();
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('MAINTENANCE_ACTIVE');
  });

  it('returns 404 EVSE_NOT_FOUND for an unknown EVSE', async () => {
    setupDbResults([STATION], []);
    const response = await post();
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('EVSE_NOT_FOUND');
  });

  it('returns 409 EVSE_IN_USE when a session is active on the EVSE', async () => {
    setupDbResults([STATION], [{ id: 'evs_000000000001' }], [], [{ id: 'ses_000000000001' }]);
    const response = await post();
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('EVSE_IN_USE');
  });

  it('removes the payment and returns 502 when the station rejects the start', async () => {
    setupDbResults([STATION], [{ id: 'evs_000000000001' }], [], [], [], []);
    sendOcppCommandAndWait.mockResolvedValue({ commandId: 'c', response: { status: 'Rejected' } });

    const response = await post();

    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe('STATION_REJECTED');
    expect(db.delete).toHaveBeenCalled();
  });

  it('removes the payment and returns 504 when the station does not respond', async () => {
    setupDbResults([STATION], [{ id: 'evs_000000000001' }], [], [], [], []);
    sendOcppCommandAndWait.mockResolvedValue({ commandId: 'c', error: 'No response within 35s' });

    const response = await post();

    expect(response.statusCode).toBe(504);
    expect(response.json().code).toBe('STATION_TIMEOUT');
    expect(db.delete).toHaveBeenCalled();
  });

  it('rejects an invalid pspRef and card digits', async () => {
    expect((await post({ ...BODY, pspRef: 'has space' })).statusCode).toBe(400);
    expect((await post({ ...BODY, cardLast4Digits: '12a4' })).statusCode).toBe(400);
    expect((await post({ ...BODY, maxCostCents: 0 })).statusCode).toBe(400);
  });

  it('returns 401 without a token', async () => {
    const response = await app.inject({ method: 'POST', url: '/ad-hoc-payments', payload: BODY });
    expect(response.statusCode).toBe(401);
  });
});
