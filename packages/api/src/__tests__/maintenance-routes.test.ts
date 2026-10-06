// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@evtivity/lib';

type Chain = Record<string, ReturnType<typeof vi.fn>> & {
  then: (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => Promise<unknown>;
};

let dbResults: unknown[][] = [];
let dbCallIndex = 0;
const chains: Chain[] = [];
function setupDbResults(...results: unknown[][]): void {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain(): Chain {
  const chain = {} as Chain;
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
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain.then = (resolve, reject) => {
    if (!awaited) {
      awaited = true;
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  chains.push(chain);
  return chain;
}

// postgres-js tagged template mock: records the SQL text and interpolated
// values, and answers by matching the SQL text.
interface ClientCall {
  text: string;
  values: unknown[];
}
const clientCalls: ClientCall[] = [];
let clientResponder: (text: string, values: unknown[]) => unknown[] = () => [];

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()) },
  client: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    clientCalls.push({ text, values });
    return Promise.resolve(clientResponder(text, values));
  }),
  maintenanceEvents: {
    id: 'me.id',
    siteId: 'me.siteId',
    status: 'me.status',
    plannedStartAt: 'me.plannedStartAt',
    plannedEndAt: 'me.plannedEndAt',
  },
  maintenanceEventStations: {
    id: 'mes.id',
    eventId: 'mes.eventId',
    stationId: 'mes.stationId',
    stationIdSnapshot: 'mes.stationIdSnapshot',
    stationOcppId: 'mes.stationOcppId',
    phase: 'mes.phase',
    command: 'mes.command',
    commandStatus: 'mes.commandStatus',
    error: 'mes.error',
    statusBefore: 'mes.statusBefore',
    statusAfter: 'mes.statusAfter',
    createdAt: 'mes.createdAt',
  },
  chargingStations: {
    id: 'cs.id',
    stationId: 'cs.stationId',
    model: 'cs.model',
    siteId: 'cs.siteId',
    isOnline: 'cs.isOnline',
  },
  chargingSessions: {
    id: 'sess.id',
    stationId: 'sess.stationId',
    transactionId: 'sess.tx',
    driverId: 'sess.driverId',
    status: 'sess.status',
  },
  reservations: {
    id: 'res.id',
    stationId: 'res.stationId',
    startsAt: 'res.startsAt',
    expiresAt: 'res.expiresAt',
    driverId: 'res.driverId',
    status: 'res.status',
  },
  drivers: { id: 'drv.id', firstName: 'drv.first', lastName: 'drv.last' },
  sites: { id: 'site.id' },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  desc: vi.fn((c: unknown) => ({ desc: c })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
  gt: vi.fn((a: unknown, b: unknown) => ({ gt: [a, b] })),
  gte: vi.fn((a: unknown, b: unknown) => ({ gte: [a, b] })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  lt: vi.fn((a: unknown, b: unknown) => ({ lt: [a, b] })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  sql: Object.assign(
    vi.fn(() => 'SQL'),
    { raw: vi.fn(), join: vi.fn() },
  ),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn(),
}));

vi.mock('@evtivity/services/station-derived-status', () => ({
  buildDerivedStatusSubquery: vi.fn(() => 'DERIVED_STATUS_SQL'),
}));

vi.mock('@evtivity/services/maintenance.service', () => ({
  createEvent: vi.fn(),
  cancelEvent: vi.fn(),
  updateEvent: vi.fn(),
  addStationsToMaintenance: vi.fn(),
  removeStationsFromMaintenance: vi.fn(),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize: vi.fn(
    () =>
      async (
        request: { jwtVerify: () => Promise<void> },
        reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
      ) => {
        try {
          await request.jwtVerify();
        } catch {
          await reply.status(401).send({ error: 'Unauthorized' });
        }
      },
  ),
}));

import { eq, gt, gte, inArray, lt } from 'drizzle-orm';
import { registerAuth } from '../plugins/auth.js';
import { maintenanceRoutes, maintenancePreviewRoutes } from '../routes/maintenance.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';
import {
  createEvent,
  cancelEvent,
  updateEvent,
  addStationsToMaintenance,
  removeStationsFromMaintenance,
} from '@evtivity/services/maintenance.service';

const SITE_ID = 'sit_000000000001';
const OTHER_SITE_ID = 'sit_000000000002';
const EVENT_ID = 'mnt_000000000001';
const STATION_A = 'sta_00000000000a';
const STATION_B = 'sta_00000000000b';
const USER_ID = 'usr_000000000001';
const ROLE_ID = 'rol_000000000001';

function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EVENT_ID,
    siteId: SITE_ID,
    eventType: 'one_off',
    status: 'scheduled',
    plannedStartAt: '2026-11-01T10:00:00.000Z',
    plannedEndAt: '2026-11-01T12:00:00.000Z',
    startedAt: null,
    endedAt: null,
    affectedStationIds: null,
    activeSessionPolicy: 'ignore',
    customMessage: null,
    reason: null,
    reservationsCancelledCount: 0,
    sessionsStoppedCount: 0,
    createdByUserId: USER_ID,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const mockGetUserSiteIds = vi.mocked(getUserSiteIds);
const mockCreateEvent = vi.mocked(createEvent);
const mockCancelEvent = vi.mocked(cancelEvent);
const mockUpdateEvent = vi.mocked(updateEvent);
const mockAddStations = vi.mocked(addStationsToMaintenance);
const mockRemoveStations = vi.mocked(removeStationsFromMaintenance);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  maintenanceRoutes(app);
  maintenancePreviewRoutes(app);
  await app.ready();
  return app;
}

describe('Maintenance routes', () => {
  let app: FastifyInstance;
  let token: string;
  let registeredPermissions: unknown[] = [];

  function auth(): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  beforeAll(async () => {
    app = await buildApp();
    registeredPermissions = vi.mocked(authorize).mock.calls.map((c) => c[0]);
    token = app.jwt.sign({ userId: USER_ID, roleId: ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setupDbResults();
    chains.length = 0;
    clientCalls.length = 0;
    clientResponder = () => [];
    mockGetUserSiteIds.mockResolvedValue(null);
  });

  describe('route permissions', () => {
    it('guards reads with maintenance:read and writes with maintenance:write', () => {
      const perms = registeredPermissions;
      // 5 read routes (list, stations, get, status, station-preview) + preview-message.
      expect(perms.filter((p) => p === 'maintenance:read')).toHaveLength(6);
      // create, patch, cancel, add-stations, remove-stations.
      expect(perms.filter((p) => p === 'maintenance:write')).toHaveLength(5);
    });

    it('returns 401 without a token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/maintenance/events`,
      });
      expect(res.statusCode).toBe(401);
      expect(mockGetUserSiteIds).not.toHaveBeenCalled();
    });
  });

  describe('GET /sites/:siteId/maintenance/events', () => {
    it('returns 404 SITE_NOT_FOUND when the user lacks access to the site', async () => {
      mockGetUserSiteIds.mockResolvedValue([OTHER_SITE_ID]);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/maintenance/events`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
      expect(mockGetUserSiteIds).toHaveBeenCalledWith(USER_ID);
      expect(chains).toHaveLength(0);
    });

    it('allows access when the site is in the user site list', async () => {
      mockGetUserSiteIds.mockResolvedValue([OTHER_SITE_ID, SITE_ID]);
      setupDbResults([], [{ c: 0 }]);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/maintenance/events`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      // No events: the rollout aggregate query is skipped.
      expect(clientCalls).toHaveLength(0);
    });

    it('lists events with rollout summaries aggregated per bucket', async () => {
      const second = makeEvent({ id: 'mnt_000000000002', status: 'completed' });
      setupDbResults([makeEvent({ status: 'active' }), second], [{ c: 7 }]);
      clientResponder = (text) =>
        text.includes('maintenance_event_stations')
          ? [
              { event_id: EVENT_ID, bucket: 'offline', total: 3, accepted: 2 },
              { event_id: EVENT_ID, bucket: 'reasserted', total: 1, accepted: 1 },
              { event_id: 'mnt_000000000002', bucket: 'restored', total: 4, accepted: 4 },
            ]
          : [];
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/maintenance/events?page=3&limit=5&status=active`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<Record<string, unknown>>; total: number }>();
      expect(body.total).toBe(7);
      expect(body.data).toHaveLength(2);
      expect(body.data[0]?.['rollout']).toEqual({
        offline: { accepted: 2, total: 3 },
        reasserted: { accepted: 1, total: 1 },
        restored: null,
      });
      expect(body.data[1]?.['rollout']).toEqual({
        offline: null,
        reasserted: null,
        restored: { accepted: 4, total: 4 },
      });
      // Pagination: page 3, limit 5 -> offset 10.
      expect(chains[0]?.['limit']).toHaveBeenCalledWith(5);
      expect(chains[0]?.['offset']).toHaveBeenCalledWith(10);
      // Status filter applied.
      expect(eq).toHaveBeenCalledWith('me.siteId', SITE_ID);
      expect(eq).toHaveBeenCalledWith('me.status', 'active');
      // Event ids travel as one array param to the aggregate query.
      expect(clientCalls).toHaveLength(1);
      expect(clientCalls[0]?.values).toEqual([[EVENT_ID, 'mnt_000000000002']]);
    });

    it('defaults to page 1 limit 10, no status filter, and empty rollout when none recorded', async () => {
      setupDbResults([makeEvent()], []);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/maintenance/events`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<Record<string, unknown>>; total: number }>();
      // Missing count row falls back to 0.
      expect(body.total).toBe(0);
      expect(body.data[0]?.['rollout']).toEqual({
        offline: null,
        reasserted: null,
        restored: null,
      });
      expect(chains[0]?.['limit']).toHaveBeenCalledWith(10);
      expect(chains[0]?.['offset']).toHaveBeenCalledWith(0);
      expect(eq).not.toHaveBeenCalledWith('me.status', expect.anything());
    });

    it('rejects an invalid status filter with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/maintenance/events?status=bogus`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
      expect(chains).toHaveLength(0);
    });
  });

  describe('GET /sites/:siteId/maintenance/events/:id/stations', () => {
    const url = `/sites/${SITE_ID}/maintenance/events/${EVENT_ID}/stations`;

    it('returns 404 SITE_NOT_FOUND without site access', async () => {
      mockGetUserSiteIds.mockResolvedValue([]);
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
    });

    it('returns 404 MAINTENANCE_NOT_FOUND when the event belongs to another site', async () => {
      setupDbResults([{ siteId: OTHER_SITE_ID }]);
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'Maintenance event not found',
        code: 'MAINTENANCE_NOT_FOUND',
      });
      expect(eq).toHaveBeenCalledWith('me.id', EVENT_ID);
      expect(chains).toHaveLength(1);
    });

    it('returns 404 MAINTENANCE_NOT_FOUND when the event does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'MAINTENANCE_NOT_FOUND' });
    });

    it('lists fan-out rows with phase filter and pagination', async () => {
      const row = {
        id: 11,
        eventId: EVENT_ID,
        stationId: null,
        stationIdSnapshot: STATION_A,
        stationOcppId: 'CS-0001',
        phase: 'enter',
        command: 'ChangeAvailability(Inoperative)',
        commandStatus: 'accepted',
        error: null,
        statusBefore: 'available',
        statusAfter: 'unavailable',
        currentStatus: null,
        createdAt: '2026-11-01T10:00:05.000Z',
      };
      setupDbResults([{ siteId: SITE_ID }], [row], [{ c: 21 }]);
      const res = await app.inject({
        method: 'GET',
        url: `${url}?phase=enter&page=2&limit=20`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<Record<string, unknown>>; total: number }>();
      expect(body.total).toBe(21);
      expect(body.data).toEqual([row]);
      expect(eq).toHaveBeenCalledWith('mes.eventId', EVENT_ID);
      expect(eq).toHaveBeenCalledWith('mes.phase', 'enter');
      // chains[0] is the ownership lookup; chains[1] the data query.
      expect(chains[1]?.['leftJoin']).toHaveBeenCalledTimes(1);
      expect(chains[1]?.['limit']).toHaveBeenCalledWith(20);
      expect(chains[1]?.['offset']).toHaveBeenCalledWith(20);
    });

    it('omits the phase filter when not provided and defaults total to 0', async () => {
      setupDbResults([{ siteId: SITE_ID }], [], []);
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(eq).not.toHaveBeenCalledWith('mes.phase', expect.anything());
    });

    it('rejects a phase longer than 20 characters', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${url}?phase=${'x'.repeat(21)}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /sites/:siteId/maintenance/events', () => {
    const url = `/sites/${SITE_ID}/maintenance/events`;
    const baseBody = {
      eventType: 'one_off',
      plannedStartAt: '2026-11-01T10:00:00.000Z',
      plannedEndAt: '2026-11-01T12:00:00.000Z',
    };

    it('returns 404 SITE_NOT_FOUND without site access', async () => {
      mockGetUserSiteIds.mockResolvedValue([OTHER_SITE_ID]);
      const res = await app.inject({ method: 'POST', url, headers: auth(), payload: baseBody });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
      expect(mockCreateEvent).not.toHaveBeenCalled();
    });

    it('returns 404 SITE_NOT_FOUND when the site row does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({ method: 'POST', url, headers: auth(), payload: baseBody });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
      expect(eq).toHaveBeenCalledWith('site.id', SITE_ID);
      expect(mockCreateEvent).not.toHaveBeenCalled();
    });

    it('returns 400 STATION_NOT_FOUND when a station is not owned by the site', async () => {
      setupDbResults([{ id: SITE_ID }], [{ id: STATION_A }]);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { ...baseBody, affectedStationIds: [STATION_A, STATION_B] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'One or more affectedStationIds do not belong to this site',
        code: 'STATION_NOT_FOUND',
      });
      expect(eq).toHaveBeenCalledWith('cs.siteId', SITE_ID);
      expect(inArray).toHaveBeenCalledWith('cs.id', [STATION_A, STATION_B]);
      expect(mockCreateEvent).not.toHaveBeenCalled();
    });

    it('creates a one-off event with owned stations and detached side effects', async () => {
      setupDbResults([{ id: SITE_ID }], [{ id: STATION_A }, { id: STATION_B }]);
      const created = makeEvent({ affectedStationIds: [STATION_A, STATION_B], reason: 'Repair' });
      mockCreateEvent.mockResolvedValue(created as never);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: {
          ...baseBody,
          affectedStationIds: [STATION_A, STATION_B],
          activeSessionPolicy: 'stop_graceful',
          customMessage: 'Back soon',
          reason: 'Repair',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: EVENT_ID,
        affectedStationIds: [STATION_A, STATION_B],
        reason: 'Repair',
      });
      expect(mockCreateEvent).toHaveBeenCalledTimes(1);
      const [input, opts] = mockCreateEvent.mock.calls[0] ?? [];
      expect(opts).toEqual({ detachSideEffects: true });
      expect(input).toMatchObject({
        siteId: SITE_ID,
        eventType: 'one_off',
        affectedStationIds: [STATION_A, STATION_B],
        activeSessionPolicy: 'stop_graceful',
        customMessage: 'Back soon',
        reason: 'Repair',
        actor: { type: 'operator', userId: USER_ID },
      });
      expect(input?.plannedStartAt).toBeInstanceOf(Date);
      expect(input?.plannedStartAt.toISOString()).toBe('2026-11-01T10:00:00.000Z');
      expect(input?.plannedEndAt.toISOString()).toBe('2026-11-01T12:00:00.000Z');
    });

    it('creates an immediate event starting now, with site-wide defaults', async () => {
      setupDbResults([{ id: SITE_ID }]);
      mockCreateEvent.mockResolvedValue(makeEvent({ eventType: 'immediate' }) as never);
      const before = Date.now();
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: {
          eventType: 'immediate',
          plannedStartAt: '2020-01-01T00:00:00.000Z',
          plannedEndAt: '2030-01-01T00:00:00.000Z',
          affectedStationIds: [],
        },
      });
      const after = Date.now();
      expect(res.statusCode).toBe(200);
      const [input] = mockCreateEvent.mock.calls[0] ?? [];
      // The provided start is ignored for immediate events.
      const start = input?.plannedStartAt.getTime() ?? 0;
      expect(start).toBeGreaterThanOrEqual(before);
      expect(start).toBeLessThanOrEqual(after);
      expect(input).toMatchObject({
        affectedStationIds: [],
        activeSessionPolicy: 'ignore',
        customMessage: null,
        reason: null,
      });
      // Empty station list skips the ownership query (only the site lookup ran).
      expect(chains).toHaveLength(1);
    });

    it('maps null affectedStationIds to null (entire site)', async () => {
      setupDbResults([{ id: SITE_ID }]);
      mockCreateEvent.mockResolvedValue(makeEvent() as never);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { ...baseBody, affectedStationIds: null },
      });
      expect(res.statusCode).toBe(200);
      expect(mockCreateEvent.mock.calls[0]?.[0].affectedStationIds).toBeNull();
    });

    it.each([
      [400, 'MAINTENANCE_INVALID_RANGE', 'End must be after start'],
      [404, 'SITE_NOT_FOUND', 'Site gone'],
      [409, 'MAINTENANCE_OVERLAPS_EXISTING', 'Overlaps existing event'],
    ])('maps a service AppError %i %s to the response', async (status, code, message) => {
      setupDbResults([{ id: SITE_ID }]);
      mockCreateEvent.mockRejectedValue(new AppError(message, status, code));
      const res = await app.inject({ method: 'POST', url, headers: auth(), payload: baseBody });
      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error: message, code });
    });

    it('rethrows unexpected errors as 500', async () => {
      setupDbResults([{ id: SITE_ID }]);
      mockCreateEvent.mockRejectedValue(new Error('db down'));
      const res = await app.inject({ method: 'POST', url, headers: auth(), payload: baseBody });
      expect(res.statusCode).toBe(500);
    });

    it('rejects an invalid eventType with 400 before touching the database', async () => {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { ...baseBody, eventType: 'recurring' },
      });
      expect(res.statusCode).toBe(400);
      expect(chains).toHaveLength(0);
      expect(mockCreateEvent).not.toHaveBeenCalled();
    });

    it('rejects a reason longer than 500 characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { ...baseBody, reason: 'r'.repeat(501) },
      });
      expect(res.statusCode).toBe(400);
      expect(mockCreateEvent).not.toHaveBeenCalled();
    });
  });

  describe('GET /sites/:siteId/maintenance/events/:id', () => {
    const url = `/sites/${SITE_ID}/maintenance/events/${EVENT_ID}`;

    it('returns 404 SITE_NOT_FOUND without site access', async () => {
      mockGetUserSiteIds.mockResolvedValue([]);
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
    });

    it('returns 404 MAINTENANCE_NOT_FOUND when no row matches id and site', async () => {
      setupDbResults([]);
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'Maintenance event not found',
        code: 'MAINTENANCE_NOT_FOUND',
      });
      expect(eq).toHaveBeenCalledWith('me.id', EVENT_ID);
      expect(eq).toHaveBeenCalledWith('me.siteId', SITE_ID);
    });

    it('returns the event', async () => {
      setupDbResults([makeEvent({ reason: 'Inspection', customMessage: 'Closed' })]);
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: EVENT_ID,
        siteId: SITE_ID,
        status: 'scheduled',
        reason: 'Inspection',
        customMessage: 'Closed',
      });
    });
  });

  describe('PATCH /sites/:siteId/maintenance/events/:id', () => {
    const url = `/sites/${SITE_ID}/maintenance/events/${EVENT_ID}`;

    it('returns 404 SITE_NOT_FOUND without site access', async () => {
      mockGetUserSiteIds.mockResolvedValue([OTHER_SITE_ID]);
      const res = await app.inject({
        method: 'PATCH',
        url,
        headers: auth(),
        payload: { reason: 'x' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
      expect(mockUpdateEvent).not.toHaveBeenCalled();
    });

    it('returns 404 MAINTENANCE_NOT_FOUND for an event of another site', async () => {
      setupDbResults([{ siteId: OTHER_SITE_ID }]);
      const res = await app.inject({
        method: 'PATCH',
        url,
        headers: auth(),
        payload: { reason: 'x' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'MAINTENANCE_NOT_FOUND' });
      expect(mockUpdateEvent).not.toHaveBeenCalled();
    });

    it('returns 400 STATION_NOT_FOUND when a station is not owned by the site', async () => {
      setupDbResults([{ siteId: SITE_ID }], []);
      const res = await app.inject({
        method: 'PATCH',
        url,
        headers: auth(),
        payload: { affectedStationIds: [STATION_A] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'STATION_NOT_FOUND' });
      expect(inArray).toHaveBeenCalledWith('cs.id', [STATION_A]);
      expect(mockUpdateEvent).not.toHaveBeenCalled();
    });

    it('passes every provided field to the service with dates coerced', async () => {
      setupDbResults([{ siteId: SITE_ID }], [{ id: STATION_A }]);
      mockUpdateEvent.mockResolvedValue(makeEvent({ reason: 'Moved' }) as never);
      const res = await app.inject({
        method: 'PATCH',
        url,
        headers: auth(),
        payload: {
          plannedStartAt: '2026-11-02T10:00:00.000Z',
          plannedEndAt: '2026-11-02T14:00:00.000Z',
          affectedStationIds: [STATION_A],
          activeSessionPolicy: 'stop_graceful',
          customMessage: null,
          reason: 'Moved',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: EVENT_ID, reason: 'Moved' });
      const [id, patch, actor] = mockUpdateEvent.mock.calls[0] ?? [];
      expect(id).toBe(EVENT_ID);
      expect(actor).toEqual({ type: 'operator', userId: USER_ID });
      expect(patch).toEqual({
        plannedStartAt: new Date('2026-11-02T10:00:00.000Z'),
        plannedEndAt: new Date('2026-11-02T14:00:00.000Z'),
        affectedStationIds: [STATION_A],
        activeSessionPolicy: 'stop_graceful',
        customMessage: null,
        reason: 'Moved',
      });
      expect(patch?.plannedStartAt).toBeInstanceOf(Date);
    });

    it('omits fields that were not provided', async () => {
      setupDbResults([{ siteId: SITE_ID }]);
      mockUpdateEvent.mockResolvedValue(makeEvent() as never);
      const res = await app.inject({
        method: 'PATCH',
        url,
        headers: auth(),
        payload: { affectedStationIds: null },
      });
      expect(res.statusCode).toBe(200);
      expect(mockUpdateEvent.mock.calls[0]?.[1]).toEqual({ affectedStationIds: null });
      // null station list skips the ownership query.
      expect(chains).toHaveLength(1);
    });

    it.each([
      [400, 'MAINTENANCE_INVALID_RANGE'],
      [404, 'MAINTENANCE_NOT_FOUND'],
      [409, 'MAINTENANCE_ALREADY_ACTIVE'],
    ])('maps a service AppError %i %s to the response', async (status, code) => {
      setupDbResults([{ siteId: SITE_ID }]);
      mockUpdateEvent.mockRejectedValue(new AppError('service said no', status, code));
      const res = await app.inject({
        method: 'PATCH',
        url,
        headers: auth(),
        payload: { reason: 'x' },
      });
      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error: 'service said no', code });
    });

    it('rethrows unexpected errors as 500', async () => {
      setupDbResults([{ siteId: SITE_ID }]);
      mockUpdateEvent.mockRejectedValue(new Error('boom'));
      const res = await app.inject({
        method: 'PATCH',
        url,
        headers: auth(),
        payload: { reason: 'x' },
      });
      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /sites/:siteId/maintenance/events/:id/cancel', () => {
    const url = `/sites/${SITE_ID}/maintenance/events/${EVENT_ID}/cancel`;

    it('returns 404 SITE_NOT_FOUND without site access', async () => {
      mockGetUserSiteIds.mockResolvedValue([]);
      const res = await app.inject({ method: 'POST', url, headers: auth() });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
      expect(mockCancelEvent).not.toHaveBeenCalled();
    });

    it('returns 404 MAINTENANCE_NOT_FOUND for an event of another site', async () => {
      setupDbResults([{ siteId: OTHER_SITE_ID }]);
      const res = await app.inject({ method: 'POST', url, headers: auth() });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'MAINTENANCE_NOT_FOUND' });
      expect(mockCancelEvent).not.toHaveBeenCalled();
    });

    it('cancels the event with detached side effects', async () => {
      setupDbResults([{ siteId: SITE_ID }]);
      mockCancelEvent.mockResolvedValue(makeEvent({ status: 'cancelled' }) as never);
      const res = await app.inject({ method: 'POST', url, headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: EVENT_ID, status: 'cancelled' });
      const call = mockCancelEvent.mock.calls[0];
      expect(call?.[0]).toBe(EVENT_ID);
      expect(call?.[1]).toEqual({ type: 'operator', userId: USER_ID });
      expect(call?.[3]).toEqual({ detachSideEffects: true });
    });

    it('maps a service 404 to MAINTENANCE_NOT_FOUND', async () => {
      setupDbResults([{ siteId: SITE_ID }]);
      mockCancelEvent.mockRejectedValue(
        new AppError('Maintenance event not found', 404, 'MAINTENANCE_NOT_FOUND'),
      );
      const res = await app.inject({ method: 'POST', url, headers: auth() });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'Maintenance event not found',
        code: 'MAINTENANCE_NOT_FOUND',
      });
    });

    it('rethrows non-404 errors', async () => {
      setupDbResults([{ siteId: SITE_ID }]);
      mockCancelEvent.mockRejectedValue(new Error('boom'));
      const res = await app.inject({ method: 'POST', url, headers: auth() });
      expect(res.statusCode).toBe(500);
    });
  });

  describe.each([
    ['add-stations', mockAddStations, [400, 404, 409]],
    ['remove-stations', mockRemoveStations, [400, 404, 409]],
  ] as const)('POST /sites/:siteId/maintenance/events/:id/%s', (path, serviceMock, statuses) => {
    const url = `/sites/${SITE_ID}/maintenance/events/${EVENT_ID}/${path}`;
    const codeFor: Record<number, string> = {
      400: path === 'add-stations' ? 'STATION_NOT_FOUND' : 'MAINTENANCE_INVALID_RANGE',
      404: 'MAINTENANCE_NOT_FOUND',
      409: 'MAINTENANCE_ALREADY_ACTIVE',
    };

    it('returns 404 SITE_NOT_FOUND without site access', async () => {
      mockGetUserSiteIds.mockResolvedValue([OTHER_SITE_ID]);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { stationIds: [STATION_A] },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
      expect(serviceMock).not.toHaveBeenCalled();
    });

    it('returns 404 MAINTENANCE_NOT_FOUND for an event of another site', async () => {
      setupDbResults([{ siteId: OTHER_SITE_ID }]);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { stationIds: [STATION_A] },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'MAINTENANCE_NOT_FOUND' });
      expect(serviceMock).not.toHaveBeenCalled();
    });

    it('rejects an empty stationIds list with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { stationIds: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock).not.toHaveBeenCalled();
    });

    it('calls the service with the event, stations, actor and detached side effects', async () => {
      setupDbResults([{ siteId: SITE_ID }]);
      serviceMock.mockResolvedValue(makeEvent({ affectedStationIds: [STATION_A] }) as never);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { stationIds: [STATION_A, STATION_B] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: EVENT_ID, affectedStationIds: [STATION_A] });
      const call = serviceMock.mock.calls[0];
      expect(call?.[0]).toBe(EVENT_ID);
      expect(call?.[1]).toEqual([STATION_A, STATION_B]);
      expect(call?.[2]).toEqual({ type: 'operator', userId: USER_ID });
      expect(call?.[4]).toEqual({ detachSideEffects: true });
    });

    it.each(statuses)('maps a service AppError %i to the response', async (status) => {
      setupDbResults([{ siteId: SITE_ID }]);
      const code = codeFor[status] ?? '';
      serviceMock.mockRejectedValue(new AppError('nope', status, code));
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { stationIds: [STATION_A] },
      });
      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error: 'nope', code });
    });

    it('rethrows unexpected errors as 500', async () => {
      setupDbResults([{ siteId: SITE_ID }]);
      serviceMock.mockRejectedValue(new Error('boom'));
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { stationIds: [STATION_A] },
      });
      expect(res.statusCode).toBe(500);
    });
  });

  describe('GET /sites/:siteId/maintenance/status', () => {
    const url = `/sites/${SITE_ID}/maintenance/status`;

    it('returns 404 SITE_NOT_FOUND without site access', async () => {
      mockGetUserSiteIds.mockResolvedValue([]);
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
    });

    it('returns null current and empty upcoming without querying rollout', async () => {
      setupDbResults([], []);
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ current: null, upcoming: [] });
      expect(clientCalls).toHaveLength(0);
      expect(eq).toHaveBeenCalledWith('me.status', 'active');
      expect(eq).toHaveBeenCalledWith('me.status', 'scheduled');
      expect(lt).toHaveBeenCalledWith('me.plannedStartAt', expect.any(Date));
      expect(gt).toHaveBeenCalledWith('me.plannedEndAt', expect.any(Date));
      expect(gte).toHaveBeenCalledWith('me.plannedStartAt', expect.any(Date));
      expect(chains[0]?.['limit']).toHaveBeenCalledWith(1);
      expect(chains[1]?.['limit']).toHaveBeenCalledWith(20);
    });

    it('returns the active event with its rollout and upcoming events', async () => {
      const upcoming = makeEvent({ id: 'mnt_000000000009' });
      setupDbResults([makeEvent({ status: 'active' })], [upcoming]);
      clientResponder = () => [{ event_id: EVENT_ID, bucket: 'offline', total: 2, accepted: 1 }];
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        current: Record<string, unknown> | null;
        upcoming: Array<Record<string, unknown>>;
      }>();
      expect(body.current?.['id']).toBe(EVENT_ID);
      expect(body.current?.['rollout']).toEqual({
        offline: { accepted: 1, total: 2 },
        reasserted: null,
        restored: null,
      });
      expect(body.upcoming.map((e) => e['id'])).toEqual(['mnt_000000000009']);
      expect(clientCalls[0]?.values).toEqual([[EVENT_ID]]);
    });

    it('returns an all-null rollout while the fan-out has recorded nothing', async () => {
      setupDbResults([makeEvent({ status: 'active' })], []);
      clientResponder = () => [];
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ current: Record<string, unknown> }>().current['rollout']).toEqual({
        offline: null,
        reasserted: null,
        restored: null,
      });
    });
  });

  describe('GET /sites/:siteId/maintenance/station-preview', () => {
    const base = `/sites/${SITE_ID}/maintenance/station-preview`;
    const query = '?startAt=2026-11-01T10:00:00Z&endAt=2026-11-01T12:00:00Z';

    it('returns 404 SITE_NOT_FOUND without site access', async () => {
      mockGetUserSiteIds.mockResolvedValue([]);
      const res = await app.inject({ method: 'GET', url: base + query, headers: auth() });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
    });

    it('returns 400 MAINTENANCE_INVALID_RANGE when end equals start', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${base}?startAt=2026-11-01T10:00:00Z&endAt=2026-11-01T10:00:00Z`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'End must be after start',
        code: 'MAINTENANCE_INVALID_RANGE',
      });
      expect(chains).toHaveLength(0);
    });

    it('returns 400 MAINTENANCE_INVALID_RANGE when end is before start', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${base}?startAt=2026-11-01T10:00:00Z&endAt=2026-11-01T09:00:00Z`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'MAINTENANCE_INVALID_RANGE' });
    });

    it('returns an empty list for a site without stations', async () => {
      setupDbResults([]);
      const res = await app.inject({ method: 'GET', url: base + query, headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      expect(chains).toHaveLength(1);
    });

    it('attaches active sessions, overlapping reservations and driver names per station', async () => {
      setupDbResults(
        [
          { id: STATION_A, stationId: 'CS-A', model: 'M1', status: 'charging', isOnline: true },
          { id: STATION_B, stationId: 'CS-B', model: null, status: 'available', isOnline: false },
        ],
        [
          { id: 'ses_1', stationDbId: STATION_A, transactionId: 'tx-1', driverId: 'drv_1' },
          { id: 'ses_2', stationDbId: 'sta_unrelated', transactionId: null, driverId: null },
        ],
        [
          {
            id: 'rsv_1',
            stationDbId: STATION_B,
            startsAt: '2026-11-01T11:00:00.000Z',
            expiresAt: '2026-11-01T11:30:00.000Z',
            driverId: 'drv_2',
          },
          {
            id: 'rsv_2',
            stationDbId: STATION_B,
            startsAt: null,
            expiresAt: '2026-11-01T13:00:00.000Z',
            driverId: null,
          },
          {
            id: 'rsv_3',
            stationDbId: STATION_B,
            startsAt: null,
            expiresAt: '2026-11-01T13:00:00.000Z',
            driverId: 'drv_missing',
          },
        ],
        [
          { id: 'drv_1', firstName: 'Ada', lastName: 'Lovelace' },
          { id: 'drv_2', firstName: 'Mono', lastName: '' },
        ],
      );
      const res = await app.inject({ method: 'GET', url: base + query, headers: auth() });
      expect(res.statusCode).toBe(200);
      const body = res.json<Array<Record<string, unknown>>>();
      expect(body).toHaveLength(2);
      expect(body[0]).toMatchObject({
        id: STATION_A,
        stationId: 'CS-A',
        model: 'M1',
        status: 'charging',
        isOnline: true,
        hasActiveSession: true,
        activeSession: { id: 'ses_1', transactionId: 'tx-1', driverName: 'Ada Lovelace' },
        upcomingReservationCount: 0,
        upcomingReservations: [],
      });
      expect(body[1]).toMatchObject({
        id: STATION_B,
        model: null,
        isOnline: false,
        hasActiveSession: false,
        activeSession: null,
        upcomingReservationCount: 3,
      });
      expect(body[1]?.['upcomingReservations']).toEqual([
        {
          id: 'rsv_1',
          startsAt: '2026-11-01T11:00:00.000Z',
          endsAt: '2026-11-01T11:30:00.000Z',
          // Trailing space from an empty last name is trimmed.
          driverName: 'Mono',
        },
        { id: 'rsv_2', startsAt: null, endsAt: '2026-11-01T13:00:00.000Z', driverName: null },
        { id: 'rsv_3', startsAt: null, endsAt: '2026-11-01T13:00:00.000Z', driverName: null },
      ]);
      // Driver lookup covers every referenced driver exactly once.
      const driverLookup = vi.mocked(inArray).mock.calls.find((c) => c[0] === ('drv.id' as never));
      expect(new Set(driverLookup?.[1] as string[])).toEqual(
        new Set(['drv_1', 'drv_2', 'drv_missing']),
      );
      // Sessions and reservations are scoped to the site's stations.
      expect(inArray).toHaveBeenCalledWith('sess.stationId', [STATION_A, STATION_B]);
      expect(inArray).toHaveBeenCalledWith('res.stationId', [STATION_A, STATION_B]);
      expect(inArray).toHaveBeenCalledWith('res.status', ['scheduled', 'active', 'in_use']);
      expect(eq).toHaveBeenCalledWith('sess.status', 'active');
      // Reservation overlap uses the requested window.
      expect(lt).toHaveBeenCalledWith('res.startsAt', new Date('2026-11-01T12:00:00Z'));
      expect(gt).toHaveBeenCalledWith('res.expiresAt', new Date('2026-11-01T10:00:00Z'));
    });

    it('reports a null driver name for a session whose driver is unknown', async () => {
      setupDbResults(
        [{ id: STATION_A, stationId: 'CS-A', model: null, status: 'charging', isOnline: true }],
        [{ id: 'ses_1', stationDbId: STATION_A, transactionId: 'tx-1', driverId: null }],
        [],
      );
      const res = await app.inject({ method: 'GET', url: base + query, headers: auth() });
      expect(res.statusCode).toBe(200);
      const body = res.json<Array<Record<string, unknown>>>();
      expect(body[0]?.['activeSession']).toEqual({
        id: 'ses_1',
        transactionId: 'tx-1',
        driverName: null,
      });
      // No driver ids: the driver query never runs (stations, sessions, reservations).
      expect(chains).toHaveLength(3);
    });
  });

  describe('POST /maintenance/preview-message', () => {
    const url = '/maintenance/preview-message';

    it('renders a provided template with the given variables', async () => {
      clientResponder = (text) =>
        text.includes("'company.name'") ? [{ value: 'Acme Charging' }] : [];
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: {
          template:
            '{{companyName}} / {{siteName}} until {{endTime}} ({{durationMinutes}}m) {{reason}} <b>',
          siteName: 'Depot',
          endTime: '2026-11-01T12:00:00.000Z',
          durationMinutes: 45,
          reason: 'Upgrade',
        },
      });
      expect(res.statusCode).toBe(200);
      // noEscape: HTML is left as typed.
      expect(res.json()).toEqual({
        rendered: 'Acme Charging / Depot until 2026-11-01T12:00:00.000Z (45m) Upgrade <b>',
      });
      // A provided template skips the default template lookup.
      expect(clientCalls.some((c) => c.text.includes('defaultMessageTemplate'))).toBe(false);
    });

    it('falls back to the stored default template, site name, and company default', async () => {
      clientResponder = (text) =>
        text.includes('defaultMessageTemplate')
          ? [{ value: 'Closed at {{siteName}} by {{companyName}}: [{{reason}}]' }]
          : [];
      const res = await app.inject({ method: 'POST', url, headers: auth(), payload: {} });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ rendered: 'Closed at My Site by EVtivity: []' });
    });

    it('uses the built-in template when none is stored and derives duration from endTime', async () => {
      clientResponder = () => [{ value: 42 }];
      const end = new Date(Date.now() + 90 * 60_000);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { endTime: end.toISOString() },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        rendered: `Site under maintenance until ${end.toISOString()}.`,
      });
    });

    it('defaults endTime to one hour from now and computes duration', async () => {
      const before = Date.now();
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { template: '{{durationMinutes}}|{{endTime}}' },
      });
      const after = Date.now();
      expect(res.statusCode).toBe(200);
      const [duration, endIso] = res.json<{ rendered: string }>().rendered.split('|');
      expect(duration).toBe('60');
      const endMs = new Date(endIso ?? '').getTime();
      expect(endMs).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(endMs).toBeLessThanOrEqual(after + 3_600_000);
    });

    it('rejects a template longer than 2000 characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { template: 'x'.repeat(2001) },
      });
      expect(res.statusCode).toBe(400);
      expect(clientCalls).toHaveLength(0);
    });

    it('returns 401 without a token', async () => {
      const res = await app.inject({ method: 'POST', url, payload: {} });
      expect(res.statusCode).toBe(401);
    });
  });
});
