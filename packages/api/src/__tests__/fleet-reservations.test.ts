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
    execute: vi.fn(() => Promise.resolve([{ next_val: '1' }, { next_val: '2' }])),
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
  reservations: {},
  chargingStations: {},
  evses: {},
  fleetReservations: {},
  fleets: {},
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

const mockSendOcppCommandAndWait = vi.fn();
vi.mock('../lib/ocpp-command.js', () => ({
  sendOcppCommandAndWait: (...args: unknown[]) => mockSendOcppCommandAndWait(...args),
}));

vi.mock('../lib/reservation-eligibility.js', () => ({
  assertReservationsAllowed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

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

import { registerAuth } from '../plugins/auth.js';
import { fleetReservationRoutes } from '../routes/fleet-reservations.js';

const VALID_FLEET_ID = 'flt_000000000001';
const VALID_FLEET_RES_ID = 'frs_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(fleetReservationRoutes);
  await app.ready();
  return app;
}

describe('Fleet reservation routes', () => {
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
    mockSendOcppCommandAndWait.mockReset();
  });

  // ------------------------------------------------------------------
  // POST /fleets/:fleetId/reservations
  // ------------------------------------------------------------------
  describe('POST /fleets/:fleetId/reservations', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/fleets/${VALID_FLEET_ID}/reservations`,
        payload: {
          slots: [{ stationOcppId: 'CS-001' }],
          expiresAt: '2030-01-01T00:00:00Z',
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when fleet not found', async () => {
      // 1st db call: fleet lookup returns empty
      setupDbResults([]);

      const res = await app.inject({
        method: 'POST',
        url: `/fleets/${VALID_FLEET_ID}/reservations`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          slots: [{ stationOcppId: 'CS-001' }],
          expiresAt: '2030-01-01T00:00:00Z',
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('FLEET_NOT_FOUND');
    });

    it('creates reservations for all stations in bulk', async () => {
      const fleetResId = VALID_FLEET_RES_ID;
      const stationDbId = 'sta_000000000001';
      const reservationDbId = 'rsv_000000000001';

      // Mock OCPP response: accepted
      mockSendOcppCommandAndWait.mockResolvedValue({
        commandId: 'cmd-1',
        response: { status: 'Accepted' },
      });

      // DB calls:
      // 1. fleet lookup
      // 2. insert fleet_reservations
      // 3. db.execute: nextval('reservation_id_seq') for each slot
      // 4. batch station lookup
      // 5. batch EVSE lookup (skipped when stationUuids empty - but actually not empty)
      // 6. db.transaction -> tx.insert(reservations).returning()
      // 7. OCPP commands (mocked)
      // 8. update fleet_reservations status
      setupDbResults(
        [{ id: VALID_FLEET_ID }], // fleet exists
        [{ id: fleetResId, fleetId: VALID_FLEET_ID, status: 'active' }], // insert fleet_reservation
        // db.execute returns sequence IDs (mocked above)
        [
          {
            id: stationDbId,
            stationId: 'CS-001',
            siteId: null,
            isOnline: true,
            reservationsEnabled: true,
          },
        ], // batch station lookup
        [], // batch EVSE lookup
        [{ id: reservationDbId, reservationId: 1, stationId: stationDbId, status: 'active' }], // tx.insert reservation
        [], // update fleet_reservations (final status)
      );

      const res = await app.inject({
        method: 'POST',
        url: `/fleets/${VALID_FLEET_ID}/reservations`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          slots: [{ stationOcppId: 'CS-001' }],
          expiresAt: '2030-01-01T00:00:00Z',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.status).toBe('active');
      expect(body.confirmed).toBe(1);
      expect(body.failed).toBe(0);
      expect(body.total).toBe(1);
      expect(body.results).toHaveLength(1);
      expect(body.results[0].status).toBe('confirmed');
    });

    it('returns partial status when some stations reject', async () => {
      const fleetResId = VALID_FLEET_RES_ID;
      const stationDbId1 = 'sta_000000000001';
      const stationDbId2 = 'sta_000000000002';
      const reservationDbId1 = 'rsv_000000000001';
      const reservationDbId2 = 'rsv_000000000002';

      // First station accepts, second rejects
      mockSendOcppCommandAndWait
        .mockResolvedValueOnce({ commandId: 'cmd-1', response: { status: 'Accepted' } })
        .mockResolvedValueOnce({ commandId: 'cmd-2', response: { status: 'Rejected' } });

      // DB calls: fleet, insert fleet_res, batch stations, EVSE lookup, tx.insert, updates
      setupDbResults(
        [{ id: VALID_FLEET_ID }], // fleet exists
        [{ id: fleetResId, fleetId: VALID_FLEET_ID, status: 'active' }], // insert fleet_reservation
        // Batch station lookup (both stations)
        [
          {
            id: stationDbId1,
            stationId: 'CS-001',
            siteId: null,
            isOnline: true,
            reservationsEnabled: true,
          },
          {
            id: stationDbId2,
            stationId: 'CS-002',
            siteId: null,
            isOnline: true,
            reservationsEnabled: true,
          },
        ],
        [], // batch EVSE lookup
        // tx.insert reservations (both)
        [
          { id: reservationDbId1, reservationId: 1, stationId: stationDbId1, status: 'active' },
          { id: reservationDbId2, reservationId: 2, stationId: stationDbId2, status: 'active' },
        ],
        [], // cancel rejected reservation
        [], // update fleet_reservations
      );

      const res = await app.inject({
        method: 'POST',
        url: `/fleets/${VALID_FLEET_ID}/reservations`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          slots: [{ stationOcppId: 'CS-001' }, { stationOcppId: 'CS-002' }],
          expiresAt: '2030-01-01T00:00:00Z',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.total).toBe(2);
      // At least one confirmed and one failed (order may vary in parallel execution)
      expect((body.confirmed as number) + (body.failed as number)).toBe(2);
    });

    it('sends SetChargingProfile when chargingProfile provided', async () => {
      const fleetResId = VALID_FLEET_RES_ID;
      const stationDbId = 'sta_000000000001';
      const reservationDbId = 'rsv_000000000001';

      // Both ReserveNow and SetChargingProfile succeed
      mockSendOcppCommandAndWait.mockResolvedValue({
        commandId: 'cmd-1',
        response: { status: 'Accepted' },
      });

      // reservation IDs allocated via db.execute (sequence)
      setupDbResults(
        [{ id: VALID_FLEET_ID }],
        [{ id: fleetResId, fleetId: VALID_FLEET_ID, status: 'active' }],
        [
          {
            id: stationDbId,
            stationId: 'CS-001',
            siteId: null,
            isOnline: true,
            reservationsEnabled: true,
          },
        ],
        [], // EVSE lookup
        [{ id: reservationDbId, reservationId: 1, stationId: stationDbId, status: 'active' }], // tx.insert
        [], // final update
      );

      const chargingProfile = { chargingProfileId: 1, stackLevel: 0 };

      const res = await app.inject({
        method: 'POST',
        url: `/fleets/${VALID_FLEET_ID}/reservations`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          slots: [{ stationOcppId: 'CS-001' }],
          expiresAt: '2030-01-01T00:00:00Z',
          chargingProfile,
        },
      });

      expect(res.statusCode).toBe(201);
      // ReserveNow + SetChargingProfile = 2 calls
      expect(mockSendOcppCommandAndWait).toHaveBeenCalledTimes(2);
      expect(mockSendOcppCommandAndWait).toHaveBeenCalledWith(
        'CS-001',
        'SetChargingProfile',
        expect.objectContaining({ chargingProfile }),
      );
    });
  });

  // ------------------------------------------------------------------
  // GET /fleets/:fleetId/reservations
  // ------------------------------------------------------------------
  describe('GET /fleets/:fleetId/reservations', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/reservations`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('lists fleet reservations', async () => {
      const item = {
        id: VALID_FLEET_RES_ID,
        fleetId: VALID_FLEET_ID,
        name: 'Morning charge',
        status: 'active',
        startsAt: null,
        expiresAt: new Date('2030-01-01T00:00:00Z'),
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        reservationCount: 3,
      };

      setupDbResults([item], [{ count: 1 }]);

      const res = await app.inject({
        method: 'GET',
        url: `/fleets/${VALID_FLEET_ID}/reservations`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.data[0].name).toBe('Morning charge');
    });
  });

  // ------------------------------------------------------------------
  // DELETE /fleet-reservations/:id
  // ------------------------------------------------------------------
  describe('DELETE /fleet-reservations/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/fleet-reservations/${VALID_FLEET_RES_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when fleet reservation not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'DELETE',
        url: `/fleet-reservations/${VALID_FLEET_RES_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('FLEET_RESERVATION_NOT_FOUND');
    });

    it('returns 400 when already cancelled', async () => {
      setupDbResults([{ id: VALID_FLEET_RES_ID, status: 'cancelled' }]);

      const res = await app.inject({
        method: 'DELETE',
        url: `/fleet-reservations/${VALID_FLEET_RES_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('FLEET_RESERVATION_ALREADY_CANCELLED');
    });

    it('cancels all active reservations in fleet reservation', async () => {
      mockSendOcppCommandAndWait.mockResolvedValue({
        commandId: 'cmd-1',
        response: { status: 'Accepted' },
      });

      // DB calls:
      // 1. fleet reservation lookup
      // 2. active reservations query
      // 3. update reservation status (per reservation)
      // 4. update fleet reservation status
      setupDbResults(
        [{ id: VALID_FLEET_RES_ID, status: 'active' }],
        [
          {
            id: 'rsv_000000000001',
            reservationId: 1,
            stationOcppId: 'CS-001',
          },
          {
            id: 'rsv_000000000002',
            reservationId: 2,
            stationOcppId: 'CS-002',
          },
        ],
        [], // update reservation 1
        [], // update reservation 2
        [], // update fleet reservation
      );

      const res = await app.inject({
        method: 'DELETE',
        url: `/fleet-reservations/${VALID_FLEET_RES_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('cancelled');
      expect(body.cancelledCount).toBe(2);
      expect(mockSendOcppCommandAndWait).toHaveBeenCalledTimes(2);
    });
  });
});
