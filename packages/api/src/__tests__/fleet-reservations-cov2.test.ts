// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// DB mock helpers: each awaited query chain consumes the next queued result.
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
  return chain;
}

const mockExecute = vi.fn();
vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    selectDistinct: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    execute: (...args: unknown[]) => mockExecute(...args),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ insert: vi.fn(() => makeChain()) }),
    ),
  },
  reservations: {},
  chargingStations: {},
  evses: {},
  fleetReservations: {},
  fleets: {},
  writeReservationAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn((_col: unknown, values: unknown) => ({ inArray: values })),
}));

const mockSendOcpp = vi.fn();
vi.mock('@evtivity/services/ocpp-command', () => ({
  sendOcppCommandAndWait: (...args: unknown[]) => mockSendOcpp(...args),
}));

const mockApplyCancel = vi.fn();
vi.mock('@evtivity/services/reservation-cancel', () => ({
  applyReservationCancellation: (...args: unknown[]) => mockApplyCancel(...args),
}));

const mockAssertAllowed = vi.fn();
vi.mock('../lib/reservation-eligibility.js', () => ({
  assertReservationsAllowed: (...args: unknown[]) => mockAssertAllowed(...args),
}));

const mockAssertNoMaintenance = vi.fn();
vi.mock('@evtivity/services/maintenance-check', () => ({
  assertNoMaintenanceConflict: (...args: unknown[]) => mockAssertNoMaintenance(...args),
}));

const mockGetUserSiteIds = vi.fn();
vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: (...args: unknown[]) => mockGetUserSiteIds(...args),
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
import { db, writeReservationAudit } from '@evtivity/database';
import * as drizzleOrmModule from 'drizzle-orm';

const FLEET_ID = 'flt_000000000001';
const FLEET_RES_ID = 'frs_000000000001';
const SITE_A = 'sit_000000000001';
const SITE_B = 'sit_000000000002';
const EXPIRES = '2030-01-01T00:00:00.000Z';

function station(stationId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `db-${stationId}`,
    stationId,
    siteId: SITE_A,
    isOnline: true,
    reservationsEnabled: true,
    disabledReason: null,
    firmwareState: null,
    reportedStatus: null,
    ...overrides,
  };
}

function inserted(id: string, stationId: string, driverId: string | null = null) {
  return {
    id,
    stationId,
    driverId,
    evseId: null,
    status: 'active',
    startsAt: null,
    expiresAt: new Date(EXPIRES),
    createdAt: new Date('2024-01-01T00:00:00Z'),
  };
}

function updateSetArgs(): Record<string, unknown> {
  const chain = vi.mocked(db.update).mock.results[0]?.value as {
    set: { mock: { calls: unknown[][] } };
  };
  return chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('Fleet reservation routes (additional coverage)', () => {
  let app: FastifyInstance;
  let token: string;
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(fleetReservationRoutes);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.mocked(db.update).mockClear();
    vi.mocked(db.transaction).mockClear();
    vi.mocked(db.selectDistinct).mockClear();
    vi.mocked(writeReservationAudit).mockClear();
    mockExecute.mockReset().mockResolvedValue([{ next_val: '11' }, { next_val: '12' }]);
    mockSendOcpp.mockReset().mockResolvedValue({ response: { status: 'Accepted' } });
    mockApplyCancel.mockReset().mockResolvedValue({ cancelled: true });
    mockAssertAllowed.mockReset().mockResolvedValue(undefined);
    mockAssertNoMaintenance.mockReset().mockResolvedValue(undefined);
    mockGetUserSiteIds.mockReset().mockResolvedValue(null);
  });

  describe('POST /fleets/:fleetId/reservations', () => {
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/fleets/${FLEET_ID}/reservations`,
        headers: auth(),
        payload,
      });

    it('returns 404 when a slot station is on a site the user cannot access', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_B]);
      setupDbResults([{ id: FLEET_ID }], [{ stationId: 'CS-1', siteId: SITE_A }]);
      const res = await post({ slots: [{ stationOcppId: 'CS-1' }], expiresAt: EXPIRES });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Station CS-1 not found', code: 'STATION_NOT_FOUND' });
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('returns 400 when the fleet reservation row is not created', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_A]);
      setupDbResults([{ id: FLEET_ID }], [{ stationId: 'CS-1', siteId: SITE_A }], []);
      const res = await post({ slots: [{ stationOcppId: 'CS-1' }], expiresAt: EXPIRES });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('FLEET_RESERVATION_CREATE_FAILED');
    });

    it('rejects every slot that fails validation and cancels the aggregate', async () => {
      mockExecute.mockResolvedValue([
        { next_val: '1' },
        { next_val: '2' },
        { next_val: '3' },
        { next_val: '4' },
        { next_val: '5' },
        { next_val: '6' },
      ]);
      // Called in slot order for online stations: CS-DIS, CS-ODD, then the rest.
      mockAssertAllowed
        .mockRejectedValueOnce(new Error('Reservations are disabled for this station'))
        .mockRejectedValueOnce('nope');
      // Called for CS-MNT, CS-MNT2, CS-EVSE.
      mockAssertNoMaintenance
        .mockRejectedValueOnce(new Error('Reservation falls within maintenance'))
        .mockRejectedValueOnce(42);
      setupDbResults(
        [{ id: FLEET_ID }],
        [{ id: FLEET_RES_ID }],
        [
          station('CS-OFF', { isOnline: false }),
          station('CS-DIS'),
          station('CS-ODD'),
          station('CS-MNT'),
          station('CS-MNT2'),
          station('CS-EVSE'),
        ],
        [{ id: 'evs_1', stationId: 'db-CS-EVSE', evseId: 1 }],
        [],
      );
      const res = await post({
        slots: [
          { stationOcppId: 'CS-GONE' },
          { stationOcppId: 'CS-OFF' },
          { stationOcppId: 'CS-DIS' },
          { stationOcppId: 'CS-ODD' },
          { stationOcppId: 'CS-MNT' },
          { stationOcppId: 'CS-MNT2' },
          { stationOcppId: 'CS-EVSE', evseId: 9 },
        ],
        expiresAt: EXPIRES,
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ id: FLEET_RES_ID, confirmed: 0, failed: 7, total: 7 });
      expect(body.status).toBe('cancelled');
      expect(body.results.map((r: { error: string }) => r.error)).toEqual([
        'Station CS-GONE not found',
        'Station CS-OFF is offline',
        'Reservations are disabled for this station',
        'Reservations not allowed',
        'Reservation falls within maintenance',
        'Maintenance window blocks this slot',
        'EVSE 9 not found on station CS-EVSE',
      ]);
      expect(body.results[6]).toMatchObject({ evseId: 9, reservationId: null, status: 'rejected' });
      expect(db.transaction).not.toHaveBeenCalled();
      expect(mockSendOcpp).not.toHaveBeenCalled();
      expect(updateSetArgs()).toMatchObject({ status: 'cancelled' });
    });

    it('skips the EVSE query when no slot station exists', async () => {
      setupDbResults([{ id: FLEET_ID }], [{ id: FLEET_RES_ID }], [], []);
      const res = await post({ slots: [{ stationOcppId: 'CS-GONE' }], expiresAt: EXPIRES });
      expect(res.statusCode).toBe(201);
      expect(res.json().results[0].error).toBe('Station CS-GONE not found');
      expect(updateSetArgs()).toMatchObject({ status: 'cancelled' });
    });

    it('rolls back failed slots, keeps confirmed ones, and reports partial', async () => {
      mockExecute.mockResolvedValue([
        { next_val: '21' },
        { next_val: '22' },
        { next_val: '23' },
        { next_val: '24' },
      ]);
      mockSendOcpp.mockImplementation(async (stationId: string, action: string) => {
        if (action === 'SetChargingProfile') throw new Error('profile push failed');
        if (stationId === 'CS-ERR') return { error: 'Station not connected' };
        if (stationId === 'CS-OCC') return { response: { status: 'Occupied' } };
        if (stationId === 'CS-REJ') return { response: { status: 'Rejected' } };
        return { response: { status: 'Accepted' } };
      });
      const profile = { id: 1, chargingProfilePurpose: 'TxProfile' };
      setupDbResults(
        [{ id: FLEET_ID }],
        [{ id: FLEET_RES_ID }],
        [station('CS-ERR'), station('CS-OCC'), station('CS-REJ'), station('CS-OK')],
        [{ id: 'evs_ok', stationId: 'db-CS-OK', evseId: 2 }],
        [
          inserted('rsv_1', 'db-CS-ERR', 'drv_000000000001'),
          inserted('rsv_2', 'db-CS-OCC'),
          inserted('rsv_3', 'db-CS-REJ'),
          inserted('rsv_4', 'db-CS-OK'),
        ],
        [],
      );
      const res = await post({
        name: 'Morning shift',
        slots: [
          { stationOcppId: 'CS-ERR', driverId: 'drv_000000000001' },
          { stationOcppId: 'CS-OCC' },
          { stationOcppId: 'CS-REJ' },
          { stationOcppId: 'CS-OK', evseId: 2 },
        ],
        expiresAt: EXPIRES,
        chargingProfile: profile,
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ status: 'partial', confirmed: 1, failed: 3, total: 4 });
      expect(body.results).toEqual([
        {
          stationOcppId: 'CS-ERR',
          evseId: null,
          reservationId: null,
          status: 'rejected',
          error: 'Station not connected',
        },
        {
          stationOcppId: 'CS-OCC',
          evseId: null,
          reservationId: null,
          status: 'rejected',
          error: 'Station rejected reservation: Occupied',
        },
        {
          stationOcppId: 'CS-REJ',
          evseId: null,
          reservationId: null,
          status: 'rejected',
          error: 'Station rejected reservation: Rejected',
        },
        {
          stationOcppId: 'CS-OK',
          evseId: 2,
          reservationId: 'rsv_4',
          status: 'confirmed',
          error: null,
        },
      ]);
      expect(mockSendOcpp).toHaveBeenCalledWith('CS-ERR', 'ReserveNow', {
        id: 21,
        expiryDateTime: EXPIRES,
        idToken: { idToken: 'drv_000000000001', type: 'Central' },
      });
      expect(mockSendOcpp).toHaveBeenCalledWith('CS-OK', 'ReserveNow', {
        id: 24,
        expiryDateTime: EXPIRES,
        idToken: { idToken: 'operator', type: 'Central' },
        evseId: 2,
      });
      expect(mockSendOcpp).toHaveBeenCalledWith('CS-OK', 'SetChargingProfile', {
        evseId: 2,
        chargingProfile: profile,
      });
      const reasons = mockApplyCancel.mock.calls.map((c) => {
        const arg = c[0] as { reservationDbId: string; reason: string; actor: string };
        return [arg.reservationDbId, arg.reason, arg.actor];
      });
      expect(reasons).toEqual([
        ['rsv_1', 'station_rejected_other', 'system'],
        ['rsv_2', 'station_rejected_occupied', 'system'],
        ['rsv_3', 'station_rejected_other', 'system'],
      ]);
      expect(writeReservationAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationId: 'rsv_4',
          action: 'created',
          notes: `fleet reservation ${FLEET_RES_ID}`,
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(updateSetArgs()).toMatchObject({ status: 'partial' });
    });

    it('rejects a slot whose reservation row was not returned by the insert', async () => {
      setupDbResults(
        [{ id: FLEET_ID }],
        [{ id: FLEET_RES_ID }],
        [station('CS-A'), station('CS-B')],
        [],
        [inserted('rsv_1', 'db-CS-A')],
        [],
      );
      const res = await post({
        slots: [{ stationOcppId: 'CS-A' }, { stationOcppId: 'CS-B' }],
        expiresAt: EXPIRES,
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ status: 'partial', confirmed: 1, failed: 1 });
      expect(body.results[1]).toMatchObject({
        stationOcppId: 'CS-B',
        status: 'rejected',
        error: 'Failed to insert reservation for station CS-B',
      });
      expect(mockSendOcpp).toHaveBeenCalledTimes(1);
    });

    it('reports active when every slot is confirmed, with startsAt on the rows', async () => {
      setupDbResults(
        [{ id: FLEET_ID }],
        [{ id: FLEET_RES_ID }],
        [station('CS-A')],
        [],
        [inserted('rsv_1', 'db-CS-A')],
        [],
      );
      const startsAt = '2029-12-31T20:00:00.000Z';
      const res = await post({ slots: [{ stationOcppId: 'CS-A' }], startsAt, expiresAt: EXPIRES });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ status: 'active', confirmed: 1, failed: 0 });
      expect(mockAssertNoMaintenance).toHaveBeenCalledWith(
        'db-CS-A',
        new Date(startsAt),
        new Date(EXPIRES),
      );
    });
  });

  describe('GET /fleets/:fleetId/reservations', () => {
    it('returns an empty page when the user has no sites', async () => {
      mockGetUserSiteIds.mockResolvedValue([]);
      const res = await app.inject({
        method: 'GET',
        url: `/fleets/${FLEET_ID}/reservations`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });

    it('limits the list to fleet reservations with a slot at an allowed site', async () => {
      const { inArray } = drizzleOrmModule;
      vi.mocked(inArray).mockClear();
      mockGetUserSiteIds.mockResolvedValue([SITE_A]);
      setupDbResults(
        [
          {
            id: FLEET_RES_ID,
            fleetId: FLEET_ID,
            name: null,
            status: 'active',
            startsAt: null,
            expiresAt: new Date(EXPIRES),
            createdAt: new Date('2024-01-01T00:00:00Z'),
            updatedAt: new Date('2024-01-01T00:00:00Z'),
            reservationCount: 2,
          },
        ],
        [],
      );
      const res = await app.inject({
        method: 'GET',
        url: `/fleets/${FLEET_ID}/reservations`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(0);
      expect(body.data[0]).toMatchObject({ id: FLEET_RES_ID, reservationCount: 2 });
      expect(vi.mocked(inArray).mock.calls[0]?.[1]).toEqual([SITE_A]);
      const subquery = vi.mocked(db.selectDistinct).mock.results[0]?.value;
      expect(vi.mocked(inArray).mock.calls[1]?.[1]).toBe(subquery);
    });
  });

  describe('DELETE /fleet-reservations/:id', () => {
    const del = () =>
      app.inject({ method: 'DELETE', url: `/fleet-reservations/${FLEET_RES_ID}`, headers: auth() });

    it('returns 404 when a slot is at a site the user cannot access', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_B]);
      setupDbResults([{ id: FLEET_RES_ID, status: 'active' }], [{ siteId: SITE_A }]);
      const res = await del();
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('FLEET_RESERVATION_NOT_FOUND');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('cancels every active slot even when a CancelReservation throws', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_A]);
      mockSendOcpp
        .mockRejectedValueOnce(new Error('pubsub down'))
        .mockResolvedValueOnce({ response: { status: 'Accepted' } });
      const createdAt = new Date('2024-01-01T00:00:00Z');
      const startsAt = new Date('2024-01-02T00:00:00Z');
      setupDbResults(
        [{ id: FLEET_RES_ID, status: 'partial' }],
        [{ siteId: SITE_A }, { siteId: null }],
        [
          {
            id: 'rsv_1',
            reservationId: 31,
            stationOcppId: 'CS-1',
            siteId: SITE_A,
            driverId: null,
            startsAt: null,
            createdAt,
          },
          {
            id: 'rsv_2',
            reservationId: 32,
            stationOcppId: 'CS-2',
            siteId: SITE_A,
            driverId: 'drv_000000000001',
            startsAt,
            createdAt,
          },
        ],
        [],
      );
      const res = await del();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'cancelled', cancelledCount: 2 });
      expect(mockSendOcpp).toHaveBeenCalledWith('CS-1', 'CancelReservation', { reservationId: 31 });
      expect(mockSendOcpp).toHaveBeenCalledWith('CS-2', 'CancelReservation', { reservationId: 32 });
      expect(mockApplyCancel).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationDbId: 'rsv_1',
          startsAt: createdAt,
          actor: 'operator',
          reason: 'operator_manual',
          chargeFee: false,
        }),
      );
      expect(mockApplyCancel).toHaveBeenCalledWith(
        expect.objectContaining({ reservationDbId: 'rsv_2', startsAt, chargeFee: false }),
      );
      expect(updateSetArgs()).toMatchObject({ status: 'cancelled' });
    });
  });
});
