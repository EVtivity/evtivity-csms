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

vi.mock('../lib/charging-profile-id.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/charging-profile-id.js')>(
    '../lib/charging-profile-id.js',
  );
  return {
    ...actual,
    maxExternalConstraintsIds: vi.fn(async () => new Map<string, number>()),
    maxExternalConstraintsIdByIdentity: vi.fn(async () => null),
  };
});

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  },
  reservations: {},
  chargingStations: {},
  evses: {},
  driverTokens: {},
  fleetReservations: {},
  fleets: {},
  writeReservationAudit: vi.fn().mockResolvedValue(undefined),
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
  gt: vi.fn(),
  isNull: vi.fn(),
  ne: vi.fn(),
}));

const mockPublish = vi.fn((_channel: string, _message: string) => Promise.resolve(undefined));
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({ publish: mockPublish, subscribe: vi.fn() })),
  setPubSub: vi.fn(),
}));

// The station side of the reservation service runs for real (dispatch and
// cancel order, rollback reasons); its database-heavy create, the OCPP round
// trip, the guarded cancel and the driver notices are mocked.
const mockSendCommand = vi.fn();
vi.mock('@evtivity/services/ocpp-command', () => ({
  sendOcppCommandAndWait: (...args: unknown[]) => mockSendCommand(...args),
}));
const mockSyncFleetStatus = vi.fn().mockResolvedValue('cancelled');
const mockRefreshFleetStatuses = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/services/fleet-reservation-status', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@evtivity/services/fleet-reservation-status')>();
  return {
    ...actual,
    syncFleetReservationStatus: (...args: unknown[]) => mockSyncFleetStatus(...args),
    refreshFleetReservationStatuses: (...args: unknown[]) => mockRefreshFleetStatuses(...args),
  };
});
const mockApplyCancellation = vi.fn();
vi.mock('@evtivity/services/reservation-cancel', () => ({
  applyReservationCancellation: (...args: unknown[]) => mockApplyCancellation(...args),
}));
const mockNotify = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/services/reservation-notify', () => ({
  notifyReservationDriver: (...args: unknown[]) => mockNotify(...args),
  cancelReasonNoticeFlags: () => ({}),
}));
const mockCreateReservation = vi.fn();
vi.mock('@evtivity/services/reservation.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/services/reservation.service')>();
  return {
    ...actual,
    createReservation: (...args: unknown[]) => mockCreateReservation(...args),
  };
});

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
import { AppError } from '@evtivity/lib';

const VALID_FLEET_ID = 'flt_000000000001';
const VALID_FLEET_RES_ID = 'frs_000000000001';
const EXPIRES = '2030-01-01T00:00:00Z';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(fleetReservationRoutes);
  await app.ready();
  return app;
}

function station(stationId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `sta-${stationId}`,
    stationId,
    siteId: null,
    isOnline: true,
    reservationsEnabled: true,
    disabledReason: null,
    firmwareState: null,
    reportedStatus: null,
    ...overrides,
  };
}

function reservationRow(
  id: string,
  reservationId: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    reservationId,
    stationId: 'sta-CS-001',
    evseId: null,
    driverId: null,
    tokenId: null,
    status: 'active',
    startsAt: null,
    expiresAt: new Date(EXPIRES),
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

function cancelledResult(statusBefore: 'active' | 'scheduled' | null = 'active') {
  return {
    feeChargedCents: 0,
    cancelled: statusBefore != null,
    feeChargeFailed: false,
    feeCurrency: null,
    statusBefore,
  };
}

function commandsPublished(): Array<{ stationId: string; action: string; payload: unknown }> {
  return mockPublish.mock.calls
    .filter((c) => c[0] === 'ocpp_commands')
    .map((c) => JSON.parse(c[1]) as { stationId: string; action: string; payload: unknown });
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
    mockPublish.mockReset();
    mockPublish.mockResolvedValue(undefined);
    mockSendCommand.mockReset();
    mockSendCommand.mockResolvedValue({ commandId: 'c1', response: { status: 'Accepted' } });
    mockApplyCancellation.mockReset();
    mockApplyCancellation.mockResolvedValue(cancelledResult());
    mockNotify.mockClear();
    mockCreateReservation.mockReset();
  });

  // ------------------------------------------------------------------
  // POST /fleets/:fleetId/reservations
  // ------------------------------------------------------------------
  describe('POST /fleets/:fleetId/reservations', () => {
    function post(payload: Record<string, unknown>) {
      return app.inject({
        method: 'POST',
        url: `/fleets/${VALID_FLEET_ID}/reservations`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    }

    // DB calls: fleet lookup, station batch, fleet_reservations insert, then
    // the station acks and the final aggregate update (all empty).
    function seed(stations: Array<ReturnType<typeof station>>) {
      setupDbResults([{ id: VALID_FLEET_ID }], stations, [
        { id: VALID_FLEET_RES_ID, fleetId: VALID_FLEET_ID, status: 'active' },
      ]);
    }

    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/fleets/${VALID_FLEET_ID}/reservations`,
        payload: { slots: [{ stationOcppId: 'CS-001' }], expiresAt: EXPIRES },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when fleet not found', async () => {
      setupDbResults([]);
      const res = await post({ slots: [{ stationOcppId: 'CS-001' }], expiresAt: EXPIRES });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('FLEET_NOT_FOUND');
    });

    it('TC-RES-20: creates every slot through the service with the fleet link', async () => {
      seed([station('CS-001'), station('CS-002')]);
      mockCreateReservation
        .mockResolvedValueOnce(reservationRow('rsv_1', 11))
        .mockResolvedValueOnce(reservationRow('rsv_2', 12, { stationId: 'sta-CS-002' }));

      const res = await post({
        slots: [
          { stationOcppId: 'CS-001', evseId: 1, driverId: 'drv_000000000001' },
          { stationOcppId: 'CS-002' },
        ],
        expiresAt: EXPIRES,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        id: VALID_FLEET_RES_ID,
        status: 'active',
        confirmed: 2,
        failed: 0,
        total: 2,
        results: [
          { stationOcppId: 'CS-001', evseId: 1, reservationId: 'rsv_1', status: 'confirmed' },
          { stationOcppId: 'CS-002', evseId: null, reservationId: 'rsv_2', status: 'confirmed' },
        ],
      });
      expect(mockCreateReservation).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          station: station('CS-001'),
          evseOcppId: 1,
          driverId: 'drv_000000000001',
          startsAt: null,
          expiresAt: new Date(EXPIRES),
          actor: { kind: 'operator', userId: 'test-id' },
          fleet: { fleetId: VALID_FLEET_ID, fleetReservationId: VALID_FLEET_RES_ID },
          auditNotes: `fleet reservation ${VALID_FLEET_RES_ID}`,
        }),
      );
      expect(mockSendCommand).toHaveBeenCalledWith(
        'CS-001',
        'ReserveNow',
        expect.objectContaining({ id: 11 }),
      );
      // A fleet create does not send the driver a reservation.Created notice.
      expect(mockNotify).not.toHaveBeenCalled();
      // The stored booking status follows the slots (one writer, P3).
      expect(mockRefreshFleetStatuses).toHaveBeenCalledWith(
        [VALID_FLEET_RES_ID],
        expect.anything(),
      );
    });

    it('TC-RES-20: rejects a slot the service refuses with its message', async () => {
      seed([station('CS-001')]);
      mockCreateReservation
        .mockResolvedValueOnce(reservationRow('rsv_1', 11))
        .mockRejectedValueOnce(
          new AppError(
            'A reservation already exists for this connector during the requested window',
            409,
            'RESERVATION_CONFLICT',
          ),
        )
        .mockRejectedValueOnce(
          new AppError('Driver is not a member of this fleet', 400, 'VALIDATION_ERROR'),
        );

      const res = await post({
        slots: [
          { stationOcppId: 'CS-001', evseId: 1 },
          { stationOcppId: 'CS-001', evseId: 1 },
          { stationOcppId: 'CS-001', driverId: 'drv_000000000009' },
        ],
        expiresAt: EXPIRES,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        status: 'partial',
        confirmed: 1,
        failed: 2,
        results: [
          { status: 'confirmed', reservationId: 'rsv_1' },
          {
            status: 'rejected',
            reservationId: null,
            error: 'A reservation already exists for this connector during the requested window',
          },
          { status: 'rejected', error: 'Driver is not a member of this fleet' },
        ],
      });
      // Only the created slot reaches its station.
      expect(mockSendCommand).toHaveBeenCalledTimes(1);
    });

    it('TC-RES-20: a future start is scheduled and confirmed without ReserveNow', async () => {
      seed([station('CS-001')]);
      const startsAt = new Date(Date.now() + 3_600_000);
      mockCreateReservation.mockResolvedValueOnce(
        reservationRow('rsv_1', 11, { status: 'scheduled', startsAt }),
      );

      const res = await post({
        slots: [{ stationOcppId: 'CS-001' }],
        startsAt: startsAt.toISOString(),
        expiresAt: EXPIRES,
        chargingProfile: { id: 1 },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ status: 'active', confirmed: 1 });
      expect(mockCreateReservation).toHaveBeenCalledWith(expect.objectContaining({ startsAt }));
      expect(mockPublish).toHaveBeenCalledWith('reservation_schedule', expect.any(String));
      // Neither ReserveNow nor the charging profile go out before the start.
      expect(mockSendCommand).not.toHaveBeenCalled();
    });

    it('TC-RES-04: a ReserveNow timeout cancels the slot in the database, then publishes CancelReservation', async () => {
      seed([station('CS-001'), station('CS-002')]);
      mockCreateReservation
        .mockResolvedValueOnce(reservationRow('rsv_1', 11))
        .mockResolvedValueOnce(reservationRow('rsv_2', 12));
      mockSendCommand.mockImplementation((stationId: string) =>
        Promise.resolve(
          stationId === 'CS-002'
            ? { commandId: 'c2', error: 'No response within 35s' }
            : { commandId: 'c1', response: { status: 'Accepted' } },
        ),
      );
      const order: string[] = [];
      mockApplyCancellation.mockImplementation(() => {
        order.push('cancel');
        return Promise.resolve(cancelledResult());
      });
      mockPublish.mockImplementation((channel: string) => {
        if (channel === 'ocpp_commands') order.push('publish');
        return Promise.resolve(undefined);
      });

      const res = await post({
        slots: [{ stationOcppId: 'CS-001' }, { stationOcppId: 'CS-002' }],
        expiresAt: EXPIRES,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        status: 'partial',
        confirmed: 1,
        failed: 1,
        results: [
          { stationOcppId: 'CS-001', status: 'confirmed' },
          { stationOcppId: 'CS-002', status: 'rejected', error: 'No response within 35s' },
        ],
      });
      expect(mockApplyCancellation).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationDbId: 'rsv_2',
          actor: 'system',
          reason: 'station_no_response',
          auditAction: 'station_rejected',
          chargeFee: false,
        }),
      );
      expect(commandsPublished()).toEqual([
        expect.objectContaining({
          stationId: 'CS-002',
          action: 'CancelReservation',
          payload: { reservationId: 12 },
        }),
      ]);
      expect(order).toEqual(['cancel', 'publish']);
    });

    it('sends SetChargingProfile only to accepted slots', async () => {
      seed([station('CS-001'), station('CS-002')]);
      mockCreateReservation
        .mockResolvedValueOnce(reservationRow('rsv_1', 11))
        .mockResolvedValueOnce(reservationRow('rsv_2', 12));
      mockSendCommand.mockImplementation((stationId: string, action: string) =>
        Promise.resolve(
          stationId === 'CS-002' && action === 'ReserveNow'
            ? { commandId: 'c2', response: { status: 'Occupied' } }
            : { commandId: 'c1', response: { status: 'Accepted' } },
        ),
      );
      const chargingProfile = { id: 1, chargingProfilePurpose: 'TxDefaultProfile' };

      const res = await post({
        slots: [
          { stationOcppId: 'CS-001', evseId: 2 },
          { stationOcppId: 'CS-002', evseId: 1 },
        ],
        expiresAt: EXPIRES,
        chargingProfile,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().results[1]).toMatchObject({
        status: 'rejected',
        error: 'Station rejected reservation: Occupied',
      });
      expect(mockApplyCancellation).toHaveBeenCalledWith(
        expect.objectContaining({ reservationDbId: 'rsv_2', reason: 'station_rejected_occupied' }),
      );
      const profiles = mockSendCommand.mock.calls.filter((c) => c[1] === 'SetChargingProfile');
      expect(profiles).toEqual([['CS-001', 'SetChargingProfile', { evseId: 2, chargingProfile }]]);
    });

    it('keeps an accepted slot when SetChargingProfile fails', async () => {
      seed([station('CS-001')]);
      mockCreateReservation.mockResolvedValueOnce(reservationRow('rsv_1', 11));
      mockSendCommand
        .mockResolvedValueOnce({ commandId: 'c1', response: { status: 'Accepted' } })
        .mockResolvedValueOnce({ commandId: 'c2', error: 'No response within 35s' });

      const res = await post({
        slots: [{ stationOcppId: 'CS-001' }],
        expiresAt: EXPIRES,
        chargingProfile: { id: 1 },
      });

      expect(res.json()).toMatchObject({ status: 'active', confirmed: 1 });
    });

    it('rejects only the slot whose create fails on an unexpected error and still sends the others', async () => {
      seed([station('CS-001'), station('CS-002')]);
      mockCreateReservation
        .mockResolvedValueOnce(reservationRow('rsv_1', 11))
        .mockRejectedValueOnce(new Error('connection terminated'));

      const res = await post({
        slots: [{ stationOcppId: 'CS-001' }, { stationOcppId: 'CS-002' }],
        expiresAt: EXPIRES,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        status: 'partial',
        confirmed: 1,
        failed: 1,
        results: [
          { stationOcppId: 'CS-001', reservationId: 'rsv_1', status: 'confirmed' },
          {
            stationOcppId: 'CS-002',
            reservationId: null,
            status: 'rejected',
            error: 'Reservation could not be created',
          },
        ],
      });
      // The slot created before the error still reached its station.
      expect(mockSendCommand).toHaveBeenCalledWith(
        'CS-001',
        'ReserveNow',
        expect.objectContaining({ id: 11 }),
      );
      expect(mockRefreshFleetStatuses).toHaveBeenCalledWith(
        [VALID_FLEET_RES_ID],
        expect.anything(),
      );
    });

    it('cancels a slot whose dispatch throws as system and keeps the other slots', async () => {
      seed([station('CS-001'), station('CS-002')]);
      mockCreateReservation
        .mockResolvedValueOnce(reservationRow('rsv_1', 11))
        .mockResolvedValueOnce(reservationRow('rsv_2', 12, { stationId: 'sta-CS-002' }));
      mockSendCommand.mockImplementation((stationId: string) =>
        stationId === 'CS-002'
          ? Promise.reject(new Error('redis down'))
          : Promise.resolve({ commandId: 'c1', response: { status: 'Accepted' } }),
      );

      const res = await post({
        slots: [{ stationOcppId: 'CS-001' }, { stationOcppId: 'CS-002' }],
        expiresAt: EXPIRES,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        status: 'partial',
        confirmed: 1,
        failed: 1,
        results: [
          { stationOcppId: 'CS-001', status: 'confirmed' },
          {
            stationOcppId: 'CS-002',
            status: 'rejected',
            error: 'Reservation could not be sent to the station and was cancelled',
          },
        ],
      });
      expect(mockApplyCancellation).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationDbId: 'rsv_2',
          actor: 'system',
          reason: 'system_cleanup',
          auditAction: 'station_rejected',
          chargeFee: false,
        }),
      );
      // The active hold may have reached the station: CancelReservation goes out.
      expect(commandsPublished()).toEqual([
        expect.objectContaining({
          stationId: 'CS-002',
          action: 'CancelReservation',
          payload: { reservationId: 12 },
        }),
      ]);
      expect(mockRefreshFleetStatuses).toHaveBeenCalledWith(
        [VALID_FLEET_RES_ID],
        expect.anything(),
      );
    });

    it('keeps an accepted slot when sending the charging profile throws', async () => {
      seed([station('CS-001')]);
      mockCreateReservation.mockResolvedValueOnce(reservationRow('rsv_1', 11));
      mockSendCommand
        .mockResolvedValueOnce({ commandId: 'c1', response: { status: 'Accepted' } })
        .mockRejectedValueOnce(new Error('redis down'));

      const res = await post({
        slots: [{ stationOcppId: 'CS-001' }],
        expiresAt: EXPIRES,
        chargingProfile: { id: 1 },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        status: 'active',
        confirmed: 1,
        results: [{ reservationId: 'rsv_1', status: 'confirmed' }],
      });
      expect(mockApplyCancellation).not.toHaveBeenCalled();
    });

    it('refuses more than 100 slots with 400 before anything is written', async () => {
      const slots = Array.from({ length: 101 }, (_, i) => ({ stationOcppId: `CS-${String(i)}` }));
      const res = await post({ slots, expiresAt: EXPIRES });
      expect(res.statusCode).toBe(400);
      expect(mockCreateReservation).not.toHaveBeenCalled();
    });

    it('reports cancelled when no slot is confirmed', async () => {
      seed([station('CS-001')]);
      mockCreateReservation.mockRejectedValueOnce(
        new AppError('Station is offline', 400, 'STATION_OFFLINE'),
      );
      const res = await post({ slots: [{ stationOcppId: 'CS-001' }], expiresAt: EXPIRES });
      expect(res.json()).toMatchObject({
        status: 'cancelled',
        confirmed: 0,
        failed: 1,
        results: [{ status: 'rejected', error: 'Station is offline' }],
      });
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
        expiresAt: new Date(EXPIRES),
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
    function del() {
      return app.inject({
        method: 'DELETE',
        url: `/fleet-reservations/${VALID_FLEET_RES_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
    }

    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/fleet-reservations/${VALID_FLEET_RES_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when fleet reservation not found', async () => {
      setupDbResults([]);
      const res = await del();
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('FLEET_RESERVATION_NOT_FOUND');
    });

    it('returns 400 when already cancelled', async () => {
      setupDbResults([{ id: VALID_FLEET_RES_ID, status: 'cancelled' }]);
      const res = await del();
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('FLEET_RESERVATION_ALREADY_CANCELLED');
    });

    it('cancels every live slot in the database first, then tells the station of active holds', async () => {
      const createdAt = new Date('2024-01-01T00:00:00Z');
      const startsAt = new Date('2030-01-01T00:00:00Z');
      setupDbResults(
        [{ id: VALID_FLEET_RES_ID, status: 'active' }],
        [
          {
            id: 'rsv_1',
            reservationId: 31,
            stationOcppId: 'CS-001',
            siteId: null,
            driverId: null,
            startsAt: null,
            createdAt,
          },
          {
            id: 'rsv_2',
            reservationId: 32,
            stationOcppId: 'CS-002',
            siteId: null,
            driverId: 'drv_000000000001',
            startsAt,
            createdAt,
          },
        ],
      );
      const order: string[] = [];
      mockApplyCancellation.mockImplementation((input: { reservationDbId: string }) => {
        order.push(`cancel ${input.reservationDbId}`);
        return Promise.resolve(
          cancelledResult(input.reservationDbId === 'rsv_2' ? 'scheduled' : 'active'),
        );
      });
      mockPublish.mockImplementation((channel: string, message: string) => {
        if (channel === 'ocpp_commands') {
          order.push(`publish ${(JSON.parse(message) as { stationId: string }).stationId}`);
        }
        return Promise.resolve(undefined);
      });

      const res = await del();

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'cancelled', cancelledCount: 2 });
      expect(mockSyncFleetStatus).toHaveBeenCalledWith(VALID_FLEET_RES_ID);
      expect(mockApplyCancellation).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationDbId: 'rsv_1',
          startsAt: createdAt,
          actor: 'operator',
          actorUserId: 'test-id',
          reason: 'operator_manual',
          chargeFee: false,
        }),
      );
      expect(mockApplyCancellation).toHaveBeenCalledWith(
        expect.objectContaining({ reservationDbId: 'rsv_2', startsAt, chargeFee: false }),
      );
      // Only the active hold reached its station; the scheduled one never did.
      expect(commandsPublished()).toEqual([
        expect.objectContaining({
          stationId: 'CS-001',
          action: 'CancelReservation',
          payload: { reservationId: 31 },
        }),
      ]);
      expect(order.indexOf('cancel rsv_1')).toBeLessThan(order.indexOf('publish CS-001'));
      // Fleet cancel never waits for the station.
      expect(mockSendCommand).not.toHaveBeenCalled();
    });

    it('cancels the other slots when one cancel fails', async () => {
      setupDbResults(
        [{ id: VALID_FLEET_RES_ID, status: 'partial' }],
        [
          {
            id: 'rsv_1',
            reservationId: 31,
            stationOcppId: 'CS-001',
            siteId: null,
            driverId: null,
            startsAt: null,
            createdAt: new Date('2024-01-01T00:00:00Z'),
          },
          {
            id: 'rsv_2',
            reservationId: 32,
            stationOcppId: 'CS-002',
            siteId: null,
            driverId: null,
            startsAt: null,
            createdAt: new Date('2024-01-01T00:00:00Z'),
          },
        ],
      );
      mockApplyCancellation
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce(cancelledResult());

      const res = await del();

      expect(res.statusCode).toBe(200);
      expect(mockApplyCancellation).toHaveBeenCalledTimes(2);
      expect(commandsPublished()).toHaveLength(1);
      // The failed slot was not cancelled by this request.
      expect(res.json().cancelledCount).toBe(1);
    });

    it('counts only the slots this request cancelled, not one a concurrent change ended first', async () => {
      const createdAt = new Date('2024-01-01T00:00:00Z');
      setupDbResults(
        [{ id: VALID_FLEET_RES_ID, status: 'active' }],
        [
          {
            id: 'rsv_1',
            reservationId: 31,
            stationOcppId: 'CS-001',
            siteId: null,
            driverId: null,
            startsAt: null,
            createdAt,
          },
          {
            id: 'rsv_2',
            reservationId: 32,
            stationOcppId: 'CS-002',
            siteId: null,
            driverId: null,
            startsAt: null,
            createdAt,
          },
        ],
      );
      mockSyncFleetStatus.mockResolvedValueOnce('partial');
      // rsv_2 moved to in_use between the read and the cancel: the guarded
      // UPDATE does not match it.
      mockApplyCancellation
        .mockResolvedValueOnce(cancelledResult('active'))
        .mockResolvedValueOnce(cancelledResult(null));

      const res = await del();

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'partial', cancelledCount: 1 });
      expect(commandsPublished()).toEqual([
        expect.objectContaining({ stationId: 'CS-001', action: 'CancelReservation' }),
      ]);
    });
  });
});
