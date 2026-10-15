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

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
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
  driverTokens: {},
  users: {},
  reservationAuditLog: {},
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
  getReservationSettings: vi.fn(),
  writeReservationAudit: vi.fn().mockResolvedValue(undefined),
  reservationDiffChanged: vi.fn().mockReturnValue(false),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn((col: unknown, pattern: string) => ({ ilike: pattern })),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn((col: unknown, values: unknown) => ({ inArray: values })),
  gt: vi.fn(),
  isNull: vi.fn(),
}));

const mockPublish = vi.fn((_channel: string, _message: string) => Promise.resolve(undefined));
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({ publish: mockPublish, subscribe: vi.fn() })),
  setPubSub: vi.fn(),
}));

const mockGetUserSiteIds = vi.fn();
vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: (...args: unknown[]) => mockGetUserSiteIds(...args),
  invalidateSiteAccessCache: vi.fn(),
}));

// The mutating routes are covered in reservations.test.ts.
vi.mock('@evtivity/services/reservation.service', () => ({
  cancelReservationWithStation: vi.fn(),
  createReservation: vi.fn(),
  dispatchReservation: vi.fn(),
  reassignReservation: vi.fn(),
  updateReservation: vi.fn(),
}));
vi.mock('@evtivity/services/reservation-notify', () => ({
  notifyReservationDriver: vi.fn(),
}));

vi.mock('../lib/payments.js', () => ({
  paymentContext: vi.fn(() => ({ registry: 'registry' })),
}));

vi.mock('@evtivity/services/template-dirs', () => ({
  ALL_TEMPLATES_DIRS: [],
}));

import { registerAuth } from '../plugins/auth.js';
import { reservationRoutes } from '../routes/reservations.js';
import {
  db,
  getReservationSettings,
  writeReservationAudit,
  reservationDiffChanged,
} from '@evtivity/database';
import * as drizzleOrmModule from 'drizzle-orm';

const RSV_ID = 'rsv_000000000001';
const DRV_ID = 'drv_000000000001';
const DRV_OTHER = 'drv_000000000002';
const TOKEN_ID = 'dtk_000000000001';
const STATION_DB_ID = 'sta_000000000001';
const SITE_A = 'sit_000000000001';
const SITE_B = 'sit_000000000002';

function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: RSV_ID,
    reservationId: 1,
    stationId: STATION_DB_ID,
    stationOcppId: 'CS-001',
    siteId: SITE_A,
    siteName: 'Site A',
    evseId: null,
    evseOcppId: null,
    connectorType: null,
    connectorMaxPowerKw: null,
    driverId: null,
    driverFirstName: null,
    driverLastName: null,
    tokenId: null,
    tokenIdToken: null,
    tokenType: null,
    status: 'active',
    startsAt: null,
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    cancelledBy: null,
    cancelReason: null,
    cancelNote: null,
    cancellationFeeCents: 0,
    sessionId: null,
    sessionStatus: null,
    sessionEnergyWh: null,
    sessionCostCents: null,
    sessionStartedAt: null,
    sessionEndedAt: null,
    ...overrides,
  };
}

describe('Reservation routes (additional coverage)', () => {
  let app: FastifyInstance;
  let token: string;
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(reservationRoutes);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.mocked(db.insert).mockClear();
    vi.mocked(db.update).mockClear();
    vi.mocked(db.select).mockClear();
    vi.mocked(db.insert).mockImplementation(() => makeChain() as never);
    mockGetUserSiteIds.mockReset().mockResolvedValue(null);
    mockPublish.mockClear();
    vi.mocked(writeReservationAudit).mockClear();
    vi.mocked(reservationDiffChanged).mockReset().mockReturnValue(false);
    vi.mocked(getReservationSettings).mockResolvedValue({
      enabled: true,
      bufferMinutes: 0,
      cancellationWindowMinutes: 0,
      cancellationFeeCents: 0,
      maxHours: 0,
      activeSessionCheckHours: 3,
    });
  });

  describe('GET /reservations', () => {
    it('applies the search pattern and siteId filter', async () => {
      const { ilike, eq } = drizzleOrmModule;
      vi.mocked(ilike).mockClear();
      vi.mocked(eq).mockClear();
      setupDbResults([], [{ count: 0 }]);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations?search=CS-0&siteId=${SITE_A}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(vi.mocked(ilike).mock.calls.map((c) => c[1])).toEqual([
        '%CS-0%',
        '%CS-0%',
        '%CS-0%',
        '%CS-0%',
      ]);
      expect(vi.mocked(eq)).toHaveBeenCalledWith(undefined, SITE_A);
    });

    it('returns an empty page without querying when the user has no sites', async () => {
      mockGetUserSiteIds.mockResolvedValue([]);
      const res = await app.inject({ method: 'GET', url: '/reservations', headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(db.select).not.toHaveBeenCalled();
    });

    it('restricts the query to the user sites', async () => {
      const { inArray } = drizzleOrmModule;
      vi.mocked(inArray).mockClear();
      mockGetUserSiteIds.mockResolvedValue([SITE_A]);
      setupDbResults([], [{ count: 0 }]);
      const res = await app.inject({ method: 'GET', url: '/reservations', headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(vi.mocked(inArray).mock.calls.some((c) => (c[1] as string[])[0] === SITE_A)).toBe(
        true,
      );
    });
  });

  describe('GET /reservations/:id', () => {
    it('returns 404 when the reservation belongs to a site the user cannot access', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_B]);
      setupDbResults([makeDetail()]);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });
  });

  describe('GET /reservations/:id/audit', () => {
    it('returns 404 when the reservation does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/audit`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 404 when the site is not accessible', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_B]);
      setupDbResults([{ id: RSV_ID, siteId: SITE_A }]);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/audit`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
    });

    it('projects before/after JSONB into the legacy columns', async () => {
      setupDbResults(
        [{ id: RSV_ID, siteId: SITE_A }],
        [
          {
            id: 10,
            reservationId: RSV_ID,
            action: 'updated',
            actor: 'operator',
            actorUserId: 'usr_000000000001',
            actorUserName: 'Ops User',
            actorDriverId: null,
            actorDriverName: null,
            before: {
              driverId: DRV_ID,
              tokenId: TOKEN_ID,
              evseId: 'evs_000000000001',
              status: 'active',
              expiresAt: '2030-01-01T00:00:00.000Z',
            },
            after: {
              driverId: DRV_OTHER,
              status: 'active',
              expiresAt: 'not-a-date',
            },
            notes: 'moved',
            createdAt: new Date('2024-02-01T00:00:00Z'),
          },
          {
            id: 9,
            reservationId: RSV_ID,
            action: 'created',
            actor: 'system',
            actorUserId: null,
            actorUserName: null,
            actorDriverId: null,
            actorDriverName: null,
            before: null,
            after: { expiresAt: new Date('2031-01-01T00:00:00Z') },
            notes: null,
            createdAt: new Date('2024-01-01T00:00:00Z'),
          },
        ],
        [{ count: 2 }],
      );
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/audit?page=1&limit=10`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      expect(body.data[0]).toMatchObject({
        id: 10,
        action: 'updated',
        actorUserName: 'Ops User',
        driverIdBefore: DRV_ID,
        driverIdAfter: DRV_OTHER,
        tokenIdBefore: TOKEN_ID,
        tokenIdAfter: null,
        evseIdBefore: 'evs_000000000001',
        evseIdAfter: null,
        statusBefore: 'active',
        statusAfter: 'active',
        expiresAtBefore: '2030-01-01T00:00:00.000Z',
        expiresAtAfter: null,
        notes: 'moved',
      });
      expect(body.data[1]).toMatchObject({
        id: 9,
        driverIdBefore: null,
        statusBefore: null,
        expiresAtBefore: null,
        expiresAtAfter: '2031-01-01T00:00:00.000Z',
      });
    });

    it('returns total 0 when the count query is empty', async () => {
      setupDbResults([{ id: RSV_ID, siteId: null }], [], []);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/audit`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });
  });

  describe('GET /reservations/:id/commands', () => {
    it('returns 404 when the reservation does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/commands`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 404 when the site is not accessible', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_B]);
      setupDbResults([{ stationId: STATION_DB_ID, reservationId: 1, siteId: SITE_A }]);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/commands`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns an empty page when no CALL logs match', async () => {
      setupDbResults([{ stationId: STATION_DB_ID, reservationId: 1, siteId: SITE_A }], []);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/commands`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });

    it('pairs CALL and RESULT messages and computes response times', async () => {
      const callAt = new Date('2024-01-01T00:00:00.000Z');
      setupDbResults(
        [{ stationId: STATION_DB_ID, reservationId: 1, siteId: SITE_A }],
        [{ messageId: 'm1' }, { messageId: 'm2' }],
        [
          {
            id: 3,
            stationId: STATION_DB_ID,
            stationOcppId: 'CS-001',
            direction: 'inbound',
            messageType: 3,
            messageId: 'm1',
            action: null,
            payload: { status: 'Accepted' },
            errorCode: null,
            errorDescription: null,
            createdAt: new Date('2024-01-01T00:00:00.250Z'),
          },
          {
            id: 2,
            stationId: STATION_DB_ID,
            stationOcppId: 'CS-001',
            direction: 'inbound',
            messageType: 4,
            messageId: 'm-unknown',
            action: null,
            payload: {},
            errorCode: 'InternalError',
            errorDescription: 'boom',
            createdAt: new Date('2024-01-01T00:00:01.000Z'),
          },
          {
            id: 1,
            stationId: STATION_DB_ID,
            stationOcppId: 'CS-001',
            direction: 'outbound',
            messageType: 2,
            messageId: 'm1',
            action: 'ReserveNow',
            payload: { id: 1 },
            errorCode: null,
            errorDescription: null,
            createdAt: callAt,
          },
        ],
        [{ count: 3 }],
      );
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/commands`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.data.map((d: { id: number; responseTimeMs: number | null }) => d)).toEqual([
        expect.objectContaining({ id: 3, responseTimeMs: 250 }),
        expect.objectContaining({ id: 2, responseTimeMs: null, errorCode: 'InternalError' }),
        expect.objectContaining({ id: 1, responseTimeMs: null, action: 'ReserveNow' }),
      ]);
    });

    it('returns total 0 when the count query is empty', async () => {
      setupDbResults(
        [{ stationId: STATION_DB_ID, reservationId: 1, siteId: null }],
        [{ messageId: 'm1' }],
        [],
        [],
      );
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/commands`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });
  });
});
