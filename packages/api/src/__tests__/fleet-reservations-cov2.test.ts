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
  snapshotReservationFeeTerms: vi.fn().mockResolvedValue({
    feeTaxBasis: 'gross',
    feeTaxRate: '0.19',
    feePerMinute: '0.10',
    feeCancellationCents: 300,
  }),
  resolveReservationFeeTerms: vi.fn().mockResolvedValue({
    basis: 'gross',
    taxRate: '0.19',
    feePerMinute: '0.10',
    cancellationFeeCents: 300,
  }),
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

// The slot outcomes are covered in fleet-reservations.test.ts; these cases
// stop before any slot is created.
const mockCreateReservation = vi.fn();
vi.mock('@evtivity/services/reservation.service', () => ({
  cancelReservationWithStation: vi.fn(),
  createReservation: (...args: unknown[]) => mockCreateReservation(...args),
  dispatchReservation: vi.fn(),
}));
vi.mock('@evtivity/services/ocpp-command', () => ({ sendOcppCommandAndWait: vi.fn() }));
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
    mockCreateReservation.mockReset();
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

    it.each([
      ['a foreign station', 'CS-1'],
      ['an unsited station', 'CS-NOSITE'],
      ['a missing station', 'CS-GONE'],
    ])('refuses a slot at %s with the same 404 before any write', async (_label, ocppId) => {
      mockGetUserSiteIds.mockResolvedValue([SITE_B]);
      setupDbResults(
        [{ id: FLEET_ID }],
        [
          station('CS-1'),
          station('CS-NOSITE', { siteId: null }),
          station('CS-B', { siteId: SITE_B }),
        ],
      );
      const res = await post({
        slots: [{ stationOcppId: 'CS-B' }, { stationOcppId: ocppId }],
        expiresAt: EXPIRES,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(mockCreateReservation).not.toHaveBeenCalled();
    });

    it('returns 400 when the fleet reservation row is not created', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_A]);
      setupDbResults([{ id: FLEET_ID }], [station('CS-1')], []);
      const res = await post({ slots: [{ stationOcppId: 'CS-1' }], expiresAt: EXPIRES });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('FLEET_RESERVATION_CREATE_FAILED');
    });

    it('refuses an all-site user a slot at a missing station before any write', async () => {
      setupDbResults([{ id: FLEET_ID }], []);
      const res = await post({ slots: [{ stationOcppId: 'CS-GONE' }], expiresAt: EXPIRES });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
      expect(db.insert).not.toHaveBeenCalled();
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

    it('returns 404 to a site-restricted user when the booking has no reservation', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_A]);
      setupDbResults([{ id: FLEET_RES_ID, status: 'active' }], []);
      const res = await del();
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('FLEET_RESERVATION_NOT_FOUND');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('lets an all-site user cancel a booking with no reservation', async () => {
      mockGetUserSiteIds.mockResolvedValue(null);
      setupDbResults([{ id: FLEET_RES_ID, status: 'active' }], [], []);
      const res = await del();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'cancelled', cancelledCount: 0 });
    });

    it('404s a restricted user when a slot is at an unsited station', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_A]);
      setupDbResults(
        [{ id: FLEET_RES_ID, status: 'partial' }],
        [{ siteId: SITE_A }, { siteId: null }],
      );
      const res = await del();
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'FLEET_RESERVATION_NOT_FOUND' });
      expect(mockCreateReservation).not.toHaveBeenCalled();
    });
  });
});
