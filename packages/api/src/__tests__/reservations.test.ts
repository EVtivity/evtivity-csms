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
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([{ next_val: '6' }])),
  },
  client: {},
  reservations: {},
  chargingStations: {},
  chargingSessions: {},
  drivers: {},
  evses: {},
  connectors: {},
  sites: {},
  ocppMessageLogs: {},
  driverPaymentMethods: {},
  getReservationSettings: vi.fn().mockResolvedValue({
    enabled: true,
    bufferMinutes: 0,
    cancellationWindowMinutes: 0,
    cancellationFeeCents: 0,
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn(),
}));

// PubSub mock
let mockSubscribeCallback: ((raw: string) => void) | null = null;
const mockUnsubscribe = vi.fn().mockResolvedValue(undefined);
const mockPublish = vi.fn().mockResolvedValue(undefined);
const mockSubscribe = vi
  .fn()
  .mockImplementation(async (_channel: string, cb: (raw: string) => void) => {
    mockSubscribeCallback = cb;
    return { unsubscribe: mockUnsubscribe };
  });

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({
    publish: mockPublish,
    subscribe: mockSubscribe,
  })),
  setPubSub: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

const mockChargeReservationCancellationFee = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/reservation-fees.js', () => ({
  chargeReservationCancellationFee: (...args: unknown[]) =>
    mockChargeReservationCancellationFee(...args),
}));

vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/lib')>();
  return {
    ...actual,
    dispatchDriverNotification: vi.fn(),
  };
});

vi.mock('../lib/template-dirs.js', () => ({
  ALL_TEMPLATES_DIRS: [],
}));

import { registerAuth } from '../plugins/auth.js';
import { reservationRoutes } from '../routes/reservations.js';
import { getReservationSettings } from '@evtivity/database';

const VALID_RESERVATION_ID = 'rsv_000000000001';
const VALID_DRIVER_ID = 'drv_000000000001';
const VALID_STATION_ID = 'sta_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(reservationRoutes);
  await app.ready();
  return app;
}

function makeReservation(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_RESERVATION_ID,
    reservationId: 1,
    stationId: VALID_STATION_ID,
    stationOcppId: 'CS-001',
    siteId: null,
    siteName: null,
    evseId: null,
    evseOcppId: null,
    connectorType: null,
    connectorMaxPowerKw: null,
    driverId: null,
    driverFirstName: null,
    driverLastName: null,
    status: 'active',
    startsAt: null,
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    sessionId: null,
    sessionStatus: null,
    sessionEnergyWh: null,
    sessionCostCents: null,
    sessionStartedAt: null,
    sessionEndedAt: null,
    ...overrides,
  };
}

describe('Reservation routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'test-id', roleId: 'test-role' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    mockSubscribeCallback = null;
    mockPublish.mockClear();
    mockSubscribe.mockClear();
    mockUnsubscribe.mockClear();
    mockChargeReservationCancellationFee.mockClear();
    mockChargeReservationCancellationFee.mockResolvedValue(undefined);
    vi.mocked(getReservationSettings).mockResolvedValue({
      enabled: true,
      bufferMinutes: 0,
      cancellationWindowMinutes: 0,
      cancellationFeeCents: 0,
    });
  });

  // ------------------------------------------------------------------
  // GET /v1/reservations
  // ------------------------------------------------------------------
  describe('GET /v1/reservations', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/reservations' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with no filters', async () => {
      const items = [makeReservation()];
      // First db call: data query, second db call: count query
      setupDbResults(items, [{ count: 1 }]);

      const res = await app.inject({
        method: 'GET',
        url: '/reservations',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it('returns 200 with status filter', async () => {
      setupDbResults([], [{ count: 0 }]);

      const res = await app.inject({
        method: 'GET',
        url: '/reservations?status=active',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('returns 200 with stationId filter', async () => {
      setupDbResults([], [{ count: 0 }]);

      const res = await app.inject({
        method: 'GET',
        url: `/reservations?stationId=${VALID_STATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('returns total 0 when count result is empty', async () => {
      setupDbResults([], []);

      const res = await app.inject({
        method: 'GET',
        url: '/reservations',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // GET /v1/reservations/:id
  // ------------------------------------------------------------------
  describe('GET /v1/reservations/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${VALID_RESERVATION_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 200 when found', async () => {
      const reservation = makeReservation();
      setupDbResults([reservation]);

      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(VALID_RESERVATION_ID);
    });

    it('includes evseOcppId in detail response', async () => {
      const reservation = makeReservation({ evseOcppId: 2 });
      setupDbResults([reservation]);

      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.evseOcppId).toBe(2);
    });

    it('returns evseOcppId as null when no EVSE assigned', async () => {
      const reservation = makeReservation({ evseOcppId: null });
      setupDbResults([reservation]);

      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.evseOcppId).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // POST /v1/reservations
  // ------------------------------------------------------------------
  describe('POST /v1/reservations', () => {
    const validBody = {
      stationId: 'CS-001',
      expiresAt: '2030-01-01T00:00:00Z',
    };

    function triggerAcceptedResponse() {
      // After subscribe + publish, fire the callback with an Accepted response.
      // We need to extract the commandId from the publish call.
      setTimeout(() => {
        if (mockSubscribeCallback != null) {
          const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
          if (publishCall != null) {
            const notification = JSON.parse(publishCall[1] as string);
            mockSubscribeCallback(
              JSON.stringify({
                commandId: notification.commandId,
                response: { status: 'Accepted' },
              }),
            );
          }
        }
      }, 10);
    }

    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: validBody,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when station not found', async () => {
      // station lookup returns empty
      setupDbResults([]);

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: validBody,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 400 when station is offline', async () => {
      // station lookup returns offline station
      setupDbResults([{ id: VALID_STATION_ID, isOnline: false }]);

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: validBody,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('STATION_OFFLINE');
    });

    it('returns 500 when reservation insert returns null', async () => {
      // DB call 1: station lookup (online)
      // DB call 2: conflict check (no conflicts)
      // DB call 3: insert returning empty (null reservation)
      // getNextReservationId uses db.execute (sequence)
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
        [],

        [],
      );

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: validBody,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe('RESERVATION_CREATE_FAILED');
    });

    it('returns 200 on success with Accepted station response', async () => {
      const reservation = makeReservation({ reservationId: 6 });
      // DB call 1: station lookup
      // DB call 2: conflict check (no conflicts)
      // DB call 3: getNextReservationId
      // DB call 4: insert returning reservation
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
        [],

        [reservation],
      );

      triggerAcceptedResponse();

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: validBody,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(VALID_RESERVATION_ID);
      expect(mockPublish).toHaveBeenCalled();
      expect(mockSubscribe).toHaveBeenCalled();
    });

    it('returns 200 with evseId in payload', async () => {
      const VALID_EVSE_ID = 'evs_000000000001';
      const reservation = makeReservation({ reservationId: 6 });
      // DB call 1: station lookup
      // DB call 2: evse resolution
      // DB call 3: conflict check (no conflicts)
      // DB call 4: getNextReservationId
      // DB call 5: insert returning reservation
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
        [{ id: VALID_EVSE_ID }],
        [],

        [reservation],
      );

      setTimeout(() => {
        if (mockSubscribeCallback != null) {
          const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
          if (publishCall != null) {
            const notification = JSON.parse(publishCall[1] as string);
            mockSubscribeCallback(
              JSON.stringify({
                commandId: notification.commandId,
                response: { status: 'Accepted' },
              }),
            );
          }
        }
      }, 10);

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: { ...validBody, evseId: 1 },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns 200 with driverId in payload', async () => {
      const reservation = makeReservation({ reservationId: 6, driverId: VALID_DRIVER_ID });
      // DB call 1: station lookup
      // DB call 2: conflict check (no conflicts)
      // DB call 3: getNextReservationId
      // DB call 4: insert returning reservation
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
        [],

        [reservation],
      );

      setTimeout(() => {
        if (mockSubscribeCallback != null) {
          const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
          if (publishCall != null) {
            const notification = JSON.parse(publishCall[1] as string);
            mockSubscribeCallback(
              JSON.stringify({
                commandId: notification.commandId,
                response: { status: 'Accepted' },
              }),
            );
          }
        }
      }, 10);

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: { ...validBody, driverId: VALID_DRIVER_ID },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns 504 on timeout (error contains "No response within")', async () => {
      const reservation = makeReservation({ reservationId: 6 });
      // DB call 1: station lookup
      // DB call 2: conflict check (no conflicts)
      // DB call 3: getNextReservationId
      // DB call 4: insert returning reservation
      // DB call 5: update to cancel after timeout
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
        [],

        [reservation],
        [],
      );

      // Simulate timeout by sending back an error with the timeout message via callback
      setTimeout(() => {
        if (mockSubscribeCallback != null) {
          const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
          if (publishCall != null) {
            const notification = JSON.parse(publishCall[1] as string);
            mockSubscribeCallback(
              JSON.stringify({
                commandId: notification.commandId,
                error: 'No response within 35s',
              }),
            );
          }
        }
      }, 10);

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: validBody,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(504);
      expect(res.json().code).toBe('RESERVATION_TIMEOUT');
    });

    it('returns 502 on OCPP error response', async () => {
      const reservation = makeReservation({ reservationId: 6 });
      // DB call 1: station lookup
      // DB call 2: conflict check (no conflicts)
      // DB call 3: getNextReservationId
      // DB call 4: insert returning reservation
      // DB call 5: update to cancel after error
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
        [],

        [reservation],
        [],
      );

      // Simulate an error from OCPP
      setTimeout(() => {
        if (mockSubscribeCallback != null) {
          const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
          if (publishCall != null) {
            const notification = JSON.parse(publishCall[1] as string);
            mockSubscribeCallback(
              JSON.stringify({
                commandId: notification.commandId,
                error: 'Station unreachable',
              }),
            );
          }
        }
      }, 10);

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: validBody,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe('RESERVATION_REJECTED');
    });

    it('returns 400 when station rejects reservation (non-Accepted status)', async () => {
      const reservation = makeReservation({ reservationId: 6 });
      // DB call 1: station lookup
      // DB call 2: conflict check (no conflicts)
      // DB call 3: getNextReservationId
      // DB call 4: insert returning reservation
      // DB call 5: update to cancel after rejection
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
        [],

        [reservation],
        [],
      );

      // Simulate station response with Rejected status
      setTimeout(() => {
        if (mockSubscribeCallback != null) {
          const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
          if (publishCall != null) {
            const notification = JSON.parse(publishCall[1] as string);
            mockSubscribeCallback(
              JSON.stringify({
                commandId: notification.commandId,
                response: { status: 'Rejected' },
              }),
            );
          }
        }
      }, 10);

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: validBody,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('RESERVATION_REJECTED');
      expect(res.json().error).toContain('Rejected');
    });

    it('returns 409 when conflicting active reservation exists', async () => {
      // DB call 1: station lookup
      // DB call 2: conflict check (returns existing reservation)
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
        [{ id: VALID_RESERVATION_ID }],
      );

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: validBody,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('RESERVATION_CONFLICT');
    });

    it('returns 404 when evseId not found', async () => {
      // DB call 1: station lookup
      // DB call 2: evse resolution (not found)
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
        [],
      );

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: { ...validBody, evseId: 99 },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('EVSE_NOT_FOUND');
    });

    it('uses sequence for reservation ID allocation', async () => {
      const reservation = makeReservation({ reservationId: 6 });
      // DB call 1: station lookup
      // DB call 2: conflict check (no conflicts)
      // DB call 3: insert returning reservation
      // getNextReservationId uses db.execute (sequence, returns 6)
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
        [],
        [reservation],
      );

      triggerAcceptedResponse();

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: validBody,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });

    // ------------------------------------------------------------------
    // Reservation eligibility
    // ------------------------------------------------------------------
    describe('reservation eligibility', () => {
      it('returns 403 when system-wide reservation.enabled=false', async () => {
        // DB call 1: station lookup (online, reservationsEnabled included)
        // assertReservationsAllowed: getReservationSettings returns disabled — throws immediately, no site DB query
        setupDbResults([{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true }]);
        vi.mocked(getReservationSettings).mockResolvedValue({
          enabled: false,
          bufferMinutes: 0,
          cancellationWindowMinutes: 0,
          cancellationFeeCents: 0,
        });

        const res = await app.inject({
          method: 'POST',
          url: '/reservations',
          payload: validBody,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('RESERVATIONS_DISABLED');
      });

      it('returns 403 when station.reservationsEnabled=false', async () => {
        // DB call 1: station lookup returns reservationsEnabled=false
        // assertReservationsAllowed: reads from the station object passed in, throws — no extra DB queries
        setupDbResults([
          { id: VALID_STATION_ID, isOnline: true, reservationsEnabled: false, siteId: null },
        ]);

        const res = await app.inject({
          method: 'POST',
          url: '/reservations',
          payload: validBody,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('RESERVATIONS_DISABLED');
      });

      it('returns 403 when site.reservationsEnabled=false', async () => {
        const VALID_SITE_ID = 'sit_000000000001';
        // DB call 1: station lookup (online, reservationsEnabled=true, siteId set)
        // DB call 2: assertReservationsAllowed queries the site (disabled)
        setupDbResults(
          [
            {
              id: VALID_STATION_ID,
              isOnline: true,
              reservationsEnabled: true,
              siteId: VALID_SITE_ID,
            },
          ],
          [{ reservationsEnabled: false }],
        );

        const res = await app.inject({
          method: 'POST',
          url: '/reservations',
          payload: validBody,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('RESERVATIONS_DISABLED');
      });

      it('allows reservation when all toggles are enabled', async () => {
        const reservation = makeReservation({ reservationId: 6 });
        // DB call 1: station lookup (online, reservationsEnabled=true, no siteId)
        // assertReservationsAllowed: no site DB query (siteId is null)
        // DB call 2: conflict check (no conflicts)
        // DB call 3: getNextReservationId
        // DB call 4: insert returning reservation
        setupDbResults(
          [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
          [],

          [reservation],
        );

        triggerAcceptedResponse();

        const res = await app.inject({
          method: 'POST',
          url: '/reservations',
          payload: validBody,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().id).toBe(VALID_RESERVATION_ID);
      });
    });
  });

  // ------------------------------------------------------------------
  // DELETE /v1/reservations/:id
  // ------------------------------------------------------------------
  describe('DELETE /v1/reservations/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/reservations/${VALID_RESERVATION_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'DELETE',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 400 when reservation is not active', async () => {
      setupDbResults([
        {
          id: VALID_RESERVATION_ID,
          reservationId: 1,
          status: 'cancelled',
          stationOcppId: 'CS-001',
        },
      ]);

      const res = await app.inject({
        method: 'DELETE',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('RESERVATION_NOT_ACTIVE');
    });

    it('returns 200 with status cancelled on success', async () => {
      // DB call 1: reservation lookup
      // DB call 2: update to cancelled (after sendOcppCommandAndWait)
      setupDbResults(
        [{ id: VALID_RESERVATION_ID, reservationId: 1, status: 'active', stationOcppId: 'CS-001' }],
        [],
      );

      // Simulate successful CancelReservation response
      setTimeout(() => {
        if (mockSubscribeCallback != null) {
          const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
          if (publishCall != null) {
            const notification = JSON.parse(publishCall[1] as string);
            mockSubscribeCallback(
              JSON.stringify({
                commandId: notification.commandId,
                response: { status: 'Accepted' },
              }),
            );
          }
        }
      }, 10);

      const res = await app.inject({
        method: 'DELETE',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('cancelled');
      expect(res.json().warning).toBeUndefined();
    });

    it('returns 200 with warning when OCPP error occurs', async () => {
      setupDbResults(
        [{ id: VALID_RESERVATION_ID, reservationId: 1, status: 'active', stationOcppId: 'CS-001' }],
        [],
      );

      // Simulate OCPP error during cancel
      setTimeout(() => {
        if (mockSubscribeCallback != null) {
          const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
          if (publishCall != null) {
            const notification = JSON.parse(publishCall[1] as string);
            mockSubscribeCallback(
              JSON.stringify({
                commandId: notification.commandId,
                error: 'Station did not respond',
              }),
            );
          }
        }
      }, 10);

      const res = await app.inject({
        method: 'DELETE',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('cancelled');
      expect(res.json().warning).toBe('Station did not respond');
    });

    describe('cancellation fee', () => {
      function triggerCancelAccepted() {
        setTimeout(() => {
          if (mockSubscribeCallback != null) {
            const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
            if (publishCall != null) {
              const notification = JSON.parse(publishCall[1] as string);
              mockSubscribeCallback(
                JSON.stringify({
                  commandId: notification.commandId,
                  response: { status: 'Accepted' },
                }),
              );
            }
          }
        }, 10);
      }

      it('charges fee when cancelling within the window', async () => {
        // startsAt = now + 30 minutes (within a 60-minute window)
        const startsAt = new Date(Date.now() + 30 * 60 * 1000);
        setupDbResults(
          [
            {
              id: VALID_RESERVATION_ID,
              reservationId: 1,
              status: 'active',
              stationOcppId: 'CS-001',
              siteId: null,
              driverId: VALID_DRIVER_ID,
              startsAt,
              createdAt: new Date('2024-01-01T00:00:00Z'),
            },
          ],
          [],
        );
        vi.mocked(getReservationSettings).mockResolvedValue({
          enabled: true,
          bufferMinutes: 0,
          cancellationWindowMinutes: 60,
          cancellationFeeCents: 500,
        });

        triggerCancelAccepted();

        const res = await app.inject({
          method: 'DELETE',
          url: `/reservations/${VALID_RESERVATION_ID}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        expect(mockChargeReservationCancellationFee).toHaveBeenCalledWith(
          VALID_DRIVER_ID,
          null,
          500,
          VALID_RESERVATION_ID,
        );
      });

      it('does not charge fee when outside the window', async () => {
        // startsAt = now + 120 minutes (outside a 60-minute window)
        const startsAt = new Date(Date.now() + 120 * 60 * 1000);
        setupDbResults(
          [
            {
              id: VALID_RESERVATION_ID,
              reservationId: 1,
              status: 'active',
              stationOcppId: 'CS-001',
              driverId: VALID_DRIVER_ID,
              startsAt,
              createdAt: new Date('2024-01-01T00:00:00Z'),
            },
          ],
          [],
        );
        vi.mocked(getReservationSettings).mockResolvedValue({
          enabled: true,
          bufferMinutes: 0,
          cancellationWindowMinutes: 60,
          cancellationFeeCents: 500,
        });

        triggerCancelAccepted();

        const res = await app.inject({
          method: 'DELETE',
          url: `/reservations/${VALID_RESERVATION_ID}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        expect(mockChargeReservationCancellationFee).not.toHaveBeenCalled();
      });

      it('does not charge fee when cancellationFeeCents is 0', async () => {
        const startsAt = new Date(Date.now() + 30 * 60 * 1000);
        setupDbResults(
          [
            {
              id: VALID_RESERVATION_ID,
              reservationId: 1,
              status: 'active',
              stationOcppId: 'CS-001',
              driverId: VALID_DRIVER_ID,
              startsAt,
              createdAt: new Date('2024-01-01T00:00:00Z'),
            },
          ],
          [],
        );
        vi.mocked(getReservationSettings).mockResolvedValue({
          enabled: true,
          bufferMinutes: 0,
          cancellationWindowMinutes: 60,
          cancellationFeeCents: 0,
        });

        triggerCancelAccepted();

        const res = await app.inject({
          method: 'DELETE',
          url: `/reservations/${VALID_RESERVATION_ID}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        expect(mockChargeReservationCancellationFee).not.toHaveBeenCalled();
      });

      it('proceeds with cancellation even if Stripe charge fails', async () => {
        const startsAt = new Date(Date.now() + 30 * 60 * 1000);
        setupDbResults(
          [
            {
              id: VALID_RESERVATION_ID,
              reservationId: 1,
              status: 'active',
              stationOcppId: 'CS-001',
              driverId: VALID_DRIVER_ID,
              startsAt,
              createdAt: new Date('2024-01-01T00:00:00Z'),
            },
          ],
          [],
        );
        vi.mocked(getReservationSettings).mockResolvedValue({
          enabled: true,
          bufferMinutes: 0,
          cancellationWindowMinutes: 60,
          cancellationFeeCents: 500,
        });
        mockChargeReservationCancellationFee.mockRejectedValueOnce(
          new Error('Stripe card declined'),
        );

        triggerCancelAccepted();

        const res = await app.inject({
          method: 'DELETE',
          url: `/reservations/${VALID_RESERVATION_ID}`,
          headers: { authorization: `Bearer ${token}` },
        });
        // Cancellation proceeds despite fee failure
        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe('cancelled');
      });
    });
  });

  // ------------------------------------------------------------------
  // sendOcppCommandAndWait internals
  // ------------------------------------------------------------------
  describe('sendOcppCommandAndWait edge cases', () => {
    const validBody = {
      stationId: 'CS-001',
      expiresAt: '2030-01-01T00:00:00Z',
    };

    it('handles subscribe rejection (catch block)', async () => {
      const reservation = makeReservation({ reservationId: 6 });
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
        [],

        [reservation],
        [],
      );

      // Make subscribe reject to trigger the catch block in sendOcppCommandAndWait
      mockSubscribe.mockRejectedValueOnce(new Error('PubSub connection failed'));

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: validBody,
        headers: { authorization: `Bearer ${token}` },
      });
      // The catch block returns { commandId, error: 'Internal error sending command' }
      // which has result.error set, so the route cancels the reservation and returns 502
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe('RESERVATION_REJECTED');
    });

    it('handles subscribe rejection with non-Error value', async () => {
      const reservation = makeReservation({ reservationId: 6 });
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
        [],

        [reservation],
        [],
      );

      // Reject with a non-Error value to cover the String(err) branch
      mockSubscribe.mockRejectedValueOnce('string error');

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: validBody,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(502);
    });

    it('ignores invalid JSON in subscribe callback', async () => {
      const reservation = makeReservation({ reservationId: 6 });
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
        [],

        [reservation],
        [],
      );

      // Send invalid JSON first, then a valid response
      setTimeout(() => {
        if (mockSubscribeCallback != null) {
          // This should be caught by the try/catch in the callback and ignored
          mockSubscribeCallback('not valid json {{{');

          // Then send a valid response so the test completes
          const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
          if (publishCall != null) {
            const notification = JSON.parse(publishCall[1] as string);
            mockSubscribeCallback(
              JSON.stringify({
                commandId: notification.commandId,
                response: { status: 'Accepted' },
              }),
            );
          }
        }
      }, 10);

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: validBody,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('ignores messages with non-matching commandId', async () => {
      const reservation = makeReservation({ reservationId: 6 });
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
        [],

        [reservation],
        [],
      );

      setTimeout(() => {
        if (mockSubscribeCallback != null) {
          // Send a valid JSON but with a different commandId (should be ignored)
          mockSubscribeCallback(
            JSON.stringify({
              commandId: 'wrong-command-id',
              response: { status: 'Accepted' },
            }),
          );

          // Then send the correct one
          const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
          if (publishCall != null) {
            const notification = JSON.parse(publishCall[1] as string);
            mockSubscribeCallback(
              JSON.stringify({
                commandId: notification.commandId,
                response: { status: 'Accepted' },
              }),
            );
          }
        }
      }, 10);

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: validBody,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns Accepted when response status is null (no status field)', async () => {
      const reservation = makeReservation({ reservationId: 6 });
      // DB call 1: station lookup
      // DB call 2: conflict check (no conflicts)
      // DB call 3: getNextReservationId
      // DB call 4: insert returning reservation
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, reservationsEnabled: true, siteId: null }],
        [],

        [reservation],
      );

      // Send a response with no status field -- passes the status check
      setTimeout(() => {
        if (mockSubscribeCallback != null) {
          const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
          if (publishCall != null) {
            const notification = JSON.parse(publishCall[1] as string);
            mockSubscribeCallback(
              JSON.stringify({
                commandId: notification.commandId,
                response: {},
              }),
            );
          }
        }
      }, 10);

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: validBody,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ------------------------------------------------------------------
  // PATCH /v1/reservations/:id
  // ------------------------------------------------------------------
  describe('PATCH /v1/reservations/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        payload: { expiresAt: '2031-01-01T00:00:00Z' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'PATCH',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        payload: { expiresAt: '2031-01-01T00:00:00Z' },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 400 when reservation is not active', async () => {
      setupDbResults([
        {
          id: VALID_RESERVATION_ID,
          stationId: VALID_STATION_ID,
          evseId: null,
          status: 'cancelled',
          expiresAt: new Date('2030-01-01T00:00:00Z'),
        },
      ]);

      const res = await app.inject({
        method: 'PATCH',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        payload: { expiresAt: '2031-01-01T00:00:00Z' },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('RESERVATION_NOT_ACTIVE');
    });

    it('returns 200 on success', async () => {
      const updated = makeReservation({ expiresAt: new Date('2031-01-01T00:00:00Z') });
      // DB call 1: fetch existing reservation
      // DB call 2: conflict check (expiresAt changed)
      // DB call 3: update
      // DB call 4: re-fetch with joins
      setupDbResults(
        [
          {
            id: VALID_RESERVATION_ID,
            stationId: VALID_STATION_ID,
            evseId: null,
            status: 'active',
            expiresAt: new Date('2030-01-01T00:00:00Z'),
          },
        ],
        [],
        [],
        [updated],
      );

      const res = await app.inject({
        method: 'PATCH',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        payload: { expiresAt: '2031-01-01T00:00:00Z' },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(VALID_RESERVATION_ID);
    });

    it('returns 409 on conflict', async () => {
      // DB call 1: fetch existing reservation
      // DB call 2: conflict check (returns conflict)
      setupDbResults(
        [
          {
            id: VALID_RESERVATION_ID,
            stationId: VALID_STATION_ID,
            evseId: null,
            status: 'active',
            expiresAt: new Date('2030-01-01T00:00:00Z'),
          },
        ],
        [{ id: 'rsv_000000000002' }],
      );

      const res = await app.inject({
        method: 'PATCH',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        payload: { expiresAt: '2031-01-01T00:00:00Z' },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('RESERVATION_CONFLICT');
    });

    it('returns 404 when evseId not found', async () => {
      // DB call 1: fetch existing reservation
      // DB call 2: evse resolution (not found)
      setupDbResults(
        [
          {
            id: VALID_RESERVATION_ID,
            stationId: VALID_STATION_ID,
            evseId: null,
            status: 'active',
            expiresAt: new Date('2030-01-01T00:00:00Z'),
          },
        ],
        [],
      );

      const res = await app.inject({
        method: 'PATCH',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        payload: { evseId: 99 },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('EVSE_NOT_FOUND');
    });

    it('includes evseOcppId in update response', async () => {
      const updated = makeReservation({ evseOcppId: 3 });
      // DB call 1: fetch existing reservation
      // DB call 2: conflict check (expiresAt changed)
      // DB call 3: update
      // DB call 4: re-fetch with joins
      setupDbResults(
        [
          {
            id: VALID_RESERVATION_ID,
            stationId: VALID_STATION_ID,
            evseId: null,
            status: 'active',
            expiresAt: new Date('2030-01-01T00:00:00Z'),
          },
        ],
        [],
        [],
        [updated],
      );

      const res = await app.inject({
        method: 'PATCH',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        payload: { expiresAt: '2031-01-01T00:00:00Z' },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.evseOcppId).toBe(3);
    });
  });

  // ------------------------------------------------------------------
  // POST /v1/reservations/:id/reassign
  // ------------------------------------------------------------------
  describe('POST /v1/reservations/:id/reassign', () => {
    const STATION_B_ID = 'sta_000000000002';
    const STATION_B_OCPP_ID = 'STATION-B';
    const EVSE_UUID = 'evs_000000000001';

    // Seed data helpers
    function makeActiveReservationRow(overrides: Record<string, unknown> = {}) {
      return {
        id: VALID_RESERVATION_ID,
        reservationId: 7,
        stationId: VALID_STATION_ID,
        stationOcppId: 'CS-001',
        siteId: null,
        evseId: null,
        driverId: null,
        expiresAt: new Date('2030-01-01T00:00:00Z'),
        status: 'active',
        ...overrides,
      };
    }

    function makeStationBRow(overrides: Record<string, unknown> = {}) {
      return {
        id: STATION_B_ID,
        siteId: null,
        isOnline: true,
        reservationsEnabled: true,
        ...overrides,
      };
    }

    // Trigger a response for both OCPP commands (ReserveNow first, then CancelReservation).
    // The mock captures the latest subscribe callback. Each sendOcppCommandAndWait
    // call subscribes, publishes, and then awaits the callback. We need to drive
    // each command's callback independently by matching commandIds in the
    // publish calls list.
    function triggerTwoOcppResponses(
      reserveNowStatus: string,
      cancelResponse: Record<string, unknown> | null,
    ) {
      // Drive the two commands sequentially. Each command subscribes and then
      // publishes. We respond to them one at a time as publish calls accumulate.
      let driven = 0;
      const interval = setInterval(() => {
        const commandCalls = mockPublish.mock.calls.filter((c) => c[0] === 'ocpp_commands');
        if (driven === 0 && commandCalls.length >= 1) {
          // Respond to ReserveNow (first ocpp_commands publish)
          if (mockSubscribeCallback != null) {
            const notification = JSON.parse(commandCalls[0]![1] as string);
            if (reserveNowStatus !== 'error') {
              mockSubscribeCallback(
                JSON.stringify({
                  commandId: notification.commandId,
                  response: { status: reserveNowStatus },
                }),
              );
            } else {
              // Simulate error (best-effort test)
              mockSubscribeCallback(
                JSON.stringify({
                  commandId: notification.commandId,
                  error: 'Station unreachable',
                }),
              );
            }
            driven = 1;
          }
        } else if (driven === 1 && commandCalls.length >= 2) {
          // Respond to CancelReservation (second ocpp_commands publish, best effort)
          if (mockSubscribeCallback != null) {
            const notification = JSON.parse(commandCalls[1]![1] as string);
            if (cancelResponse != null) {
              mockSubscribeCallback(
                JSON.stringify({ commandId: notification.commandId, response: cancelResponse }),
              );
            } else {
              mockSubscribeCallback(
                JSON.stringify({
                  commandId: notification.commandId,
                  error: 'Station unreachable',
                }),
              );
            }
            driven = 2;
            clearInterval(interval);
          }
        }
      }, 5);
    }

    it('moves reservation to a new station', async () => {
      // DB call 1: fetch reservation (with joined stationOcppId)
      // DB call 2: new station lookup
      // DB call 3: update reservation stationId
      setupDbResults([makeActiveReservationRow()], [makeStationBRow()], []);

      triggerTwoOcppResponses('Accepted', { status: 'Accepted' });

      const res = await app.inject({
        method: 'POST',
        url: `/reservations/${VALID_RESERVATION_ID}/reassign`,
        payload: { newStationOcppId: STATION_B_OCPP_ID },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('reassigned');
      expect(body.newStationOcppId).toBe(STATION_B_OCPP_ID);
    });

    it('moves reservation to a new station with evseId', async () => {
      // DB call 1: fetch reservation
      // DB call 2: new station lookup
      // DB call 3: evse resolution
      // DB call 4: update reservation
      setupDbResults([makeActiveReservationRow()], [makeStationBRow()], [{ id: EVSE_UUID }], []);

      triggerTwoOcppResponses('Accepted', { status: 'Accepted' });

      const res = await app.inject({
        method: 'POST',
        url: `/reservations/${VALID_RESERVATION_ID}/reassign`,
        payload: { newStationOcppId: STATION_B_OCPP_ID, newEvseId: 1 },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('reassigned');
    });

    it('returns 400 when reservation is not active', async () => {
      setupDbResults([makeActiveReservationRow({ status: 'used' })]);

      const res = await app.inject({
        method: 'POST',
        url: `/reservations/${VALID_RESERVATION_ID}/reassign`,
        payload: { newStationOcppId: STATION_B_OCPP_ID },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('RESERVATION_NOT_ACTIVE');
    });

    it('returns 404 when reservation is not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'POST',
        url: `/reservations/${VALID_RESERVATION_ID}/reassign`,
        payload: { newStationOcppId: STATION_B_OCPP_ID },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 404 when new station does not exist', async () => {
      setupDbResults([makeActiveReservationRow()], []);

      const res = await app.inject({
        method: 'POST',
        url: `/reservations/${VALID_RESERVATION_ID}/reassign`,
        payload: { newStationOcppId: 'NONEXISTENT' },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 400 when new station is offline', async () => {
      setupDbResults([makeActiveReservationRow()], [makeStationBRow({ isOnline: false })]);

      const res = await app.inject({
        method: 'POST',
        url: `/reservations/${VALID_RESERVATION_ID}/reassign`,
        payload: { newStationOcppId: STATION_B_OCPP_ID },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('STATION_OFFLINE');
    });

    it('returns 400 when new station rejects ReserveNow', async () => {
      // DB call 1: fetch reservation
      // DB call 2: new station lookup
      // No DB call 3 (update should NOT happen on rejection)
      setupDbResults([makeActiveReservationRow()], [makeStationBRow()]);

      // ReserveNow is sent first; if rejected, CancelReservation is never sent
      triggerTwoOcppResponses('Rejected', null);

      const res = await app.inject({
        method: 'POST',
        url: `/reservations/${VALID_RESERVATION_ID}/reassign`,
        payload: { newStationOcppId: STATION_B_OCPP_ID },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('RESERVATION_REJECTED');
    });

    it('proceeds with reassignment even when CancelReservation to old station fails', async () => {
      // DB call 1: fetch reservation
      // DB call 2: new station lookup
      // DB call 3: update reservation (should still happen)
      setupDbResults([makeActiveReservationRow()], [makeStationBRow()], []);

      // ReserveNow succeeds, CancelReservation fails (best effort, should not block)
      triggerTwoOcppResponses('Accepted', null);

      const res = await app.inject({
        method: 'POST',
        url: `/reservations/${VALID_RESERVATION_ID}/reassign`,
        payload: { newStationOcppId: STATION_B_OCPP_ID },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('reassigned');
    });

    it('returns 404 when newEvseId does not exist on new station', async () => {
      // DB call 1: fetch reservation
      // DB call 2: new station lookup
      // DB call 3: evse resolution (empty = not found)
      setupDbResults([makeActiveReservationRow()], [makeStationBRow()], []);

      const res = await app.inject({
        method: 'POST',
        url: `/reservations/${VALID_RESERVATION_ID}/reassign`,
        payload: { newStationOcppId: STATION_B_OCPP_ID, newEvseId: 999 },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('EVSE_NOT_FOUND');
    });

    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/reservations/${VALID_RESERVATION_ID}/reassign`,
        payload: { newStationOcppId: STATION_B_OCPP_ID },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
