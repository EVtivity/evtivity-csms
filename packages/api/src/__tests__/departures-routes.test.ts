// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Departure and departure schedule routes: permissions, the body to service
// mapping (targets, the site scope of the caller), the fleet check, the list
// window, and the service errors as codes.

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@evtivity/lib';

const m = vi.hoisted(() => ({
  fleetRows: [] as unknown[][],
  authorizeCalls: [] as string[],
  getUserSiteIds: vi.fn(),
  createDepartureSchedule: vi.fn(),
  updateDepartureSchedule: vi.fn(),
  deleteDepartureSchedule: vi.fn(),
  createDeparture: vi.fn(),
  updateDeparture: vi.fn(),
  cancelDeparture: vi.fn(),
  importDepartures: vi.fn(),
  listFleetDepartureSchedules: vi.fn(),
  listFleetDepartures: vi.fn(),
  publishDepartureChanged: vi.fn(),
}));

function chain(): Record<string, unknown> {
  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'where']) builder[method] = () => builder;
  builder['then'] = (resolve: (rows: unknown[]) => unknown) => resolve(m.fleetRows.shift() ?? []);
  return builder;
}

vi.mock('@evtivity/database', () => ({
  db: { select: () => chain() },
  fleets: { id: 'fleets.id' },
  vehicles: {},
  sites: {},
  fleetDrivers: {},
  vehicleDepartures: {},
  vehicleDepartureSchedules: {},
  DEPARTURE_STATUSES: ['scheduled', 'cancelled', 'completed'],
  DEPARTURE_TARGET_KINDS: ['energy', 'soc'],
  DEPARTURE_SOURCES: ['manual', 'schedule', 'import', 'vehicle', 'depot_system'],
  DEPARTURE_CANCEL_REASONS: [
    'removed_by_depot_system',
    'terminated_by_depot_system',
    'superseded_by_depot_system',
  ],
  DEPARTURE_OUTCOMES: ['met', 'short', 'no_vehicle'],
  DEPARTURE_READINESS_STATES: [
    'ready',
    'on_track',
    'at_risk',
    'cannot_meet',
    'waiting_for_vehicle',
  ],
  DEPARTURE_READINESS_REASONS: ['site_capacity', 'not_plugged_in'],
}));
vi.mock('@evtivity/services/departure.service', () => ({
  createDepartureSchedule: m.createDepartureSchedule,
  updateDepartureSchedule: m.updateDepartureSchedule,
  deleteDepartureSchedule: m.deleteDepartureSchedule,
  createDeparture: m.createDeparture,
  updateDeparture: m.updateDeparture,
  cancelDeparture: m.cancelDeparture,
}));
vi.mock('@evtivity/services/departure-notice.service', () => ({
  publishDepartureChanged: m.publishDepartureChanged,
}));
vi.mock('@evtivity/services/departure-import', () => ({
  DEPARTURE_IMPORT_MAX_BYTES: 512 * 1024,
  importDepartures: m.importDepartures,
}));
vi.mock('../lib/departure-views.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/departure-views.js')>()),
  listFleetDepartureSchedules: m.listFleetDepartureSchedules,
  listFleetDepartures: m.listFleetDepartures,
}));
vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: m.getUserSiteIds,
  isAllSiteUser: vi.fn(() => Promise.resolve(true)),
  invalidateSiteAccessCache: vi.fn(),
}));
vi.mock('../middleware/rbac.js', () => ({
  requestHasPermission: vi.fn(() => true),
  authorize: (permission: string) => {
    m.authorizeCalls.push(permission);
    return async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }
    };
  },
}));

import { registerAuth } from '../plugins/auth.js';
import { departureRoutes } from '../routes/departures.js';

const FLEET = 'flt_000000000001';
const VEHICLE = 'veh_000000000001';
const SITE = 'sit_000000000001';
const NOW = new Date('2026-11-02T10:00:00.000Z');

function schedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'vds_000000000001',
    vehicleId: VEHICLE,
    siteId: SITE,
    daysOfWeek: [1, 2, 3, 4, 5],
    departureTime: '05:30',
    targetKind: 'energy',
    targetEnergyKwh: '120.00',
    targetSocPercent: null,
    targetSocMaxPercent: null,
    priority: 5,
    validFrom: null,
    validTo: null,
    isActive: true,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function departure(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'vdp_000000000001',
    vehicleId: VEHICLE,
    siteId: SITE,
    scheduleId: null,
    occurrenceDate: null,
    departureAt: new Date('2026-11-03T05:30:00.000Z'),
    adHoc: false,
    targetSocMaxPercent: null,
    expectedArrivalAt: null,
    expectedArrivalSocPercent: null,
    requestedEvseId: null,
    depotSystemId: null,
    externalRequestId: null,
    externalPriority: null,
    cancelReason: null,
    predictedMaxReadyAt: null,
    targetKind: 'soc',
    targetEnergyKwh: null,
    targetSocPercent: 80,
    priority: 7,
    source: 'manual',
    overridden: false,
    status: 'scheduled',
    outcome: null,
    readiness: null,
    readinessReason: null,
    sessionId: null,
    plannedKwh: '42.50',
    deliveredKwh: null,
    shortfallKwh: null,
    predictedReadyAt: null,
    plannedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const counts = {
  occurrencesCreated: 6,
  occurrencesUpdated: 0,
  occurrencesRemoved: 0,
  occurrencesCancelled: 0,
};

describe('departure routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    app.setErrorHandler(async (error, _request, reply) => {
      if (error instanceof AppError) {
        await reply.status(error.statusCode).send({ error: error.message, code: error.code });
        return;
      }
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      await reply.status(status).send({ error: String(error), code: 'X' });
    });
    await registerAuth(app);
    departureRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    m.fleetRows.length = 0;
    m.fleetRows.push([{ id: FLEET }]);
    m.getUserSiteIds.mockReset().mockResolvedValue([SITE]);
  });

  const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  it('reads with fleets:read and writes with fleets:write', () => {
    expect(m.authorizeCalls.filter((p) => p === 'fleets:read')).toHaveLength(2);
    expect(m.authorizeCalls.filter((p) => p === 'fleets:write')).toHaveLength(7);
  });

  it('creates a schedule through the service with the caller scope and returns numbers', async () => {
    m.createDepartureSchedule.mockResolvedValueOnce({ schedule: schedule(), ...counts });
    const res = await send('POST', `/fleets/${FLEET}/departure-schedules`, {
      vehicleId: VEHICLE,
      siteId: SITE,
      daysOfWeek: [1, 2, 3, 4, 5],
      departureTime: '05:30',
      targetKind: 'energy',
      targetEnergyKwh: 120,
      priority: 8,
      notes: 'Route 12',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: 'vds_000000000001',
      targetEnergyKwh: 120,
      occurrencesCreated: 6,
    });
    expect(m.createDepartureSchedule).toHaveBeenCalledWith(
      {
        fleetId: FLEET,
        vehicleId: VEHICLE,
        siteId: SITE,
        daysOfWeek: [1, 2, 3, 4, 5],
        departureTime: '05:30',
        target: { kind: 'energy', targetKwh: 120 },
        priority: 8,
        notes: 'Route 12',
      },
      expect.objectContaining({
        siteScope: [SITE],
        actor: expect.objectContaining({ actor: 'operator', actorUserId: 'usr_000000000001' }),
      }),
    );
  });

  it('answers 404 FLEET_NOT_FOUND for an unknown fleet without calling the service', async () => {
    m.fleetRows.length = 0;
    m.fleetRows.push([]);
    const res = await send('POST', `/fleets/${FLEET}/departures`, {
      vehicleId: VEHICLE,
      siteId: SITE,
      departureAt: '2026-11-03T05:30:00Z',
      targetKind: 'soc',
      targetSocPercent: 80,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('FLEET_NOT_FOUND');
    expect(m.createDeparture).not.toHaveBeenCalled();
  });

  it('refuses a target that does not match its kind and a body without a target', async () => {
    for (const payload of [
      { targetKind: 'energy', targetSocPercent: 80 },
      { targetKind: 'soc', targetSocPercent: 80, targetEnergyKwh: 10 },
      {},
    ]) {
      const res = await send('POST', `/fleets/${FLEET}/departures`, {
        vehicleId: VEHICLE,
        siteId: SITE,
        departureAt: '2026-11-03T05:30:00Z',
        ...payload,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(m.createDeparture).not.toHaveBeenCalled();
  });

  it('creates a manual departure', async () => {
    m.createDeparture.mockResolvedValueOnce(departure());
    const res = await send('POST', `/fleets/${FLEET}/departures`, {
      vehicleId: VEHICLE,
      siteId: SITE,
      departureAt: '2026-11-03T05:30:00Z',
      targetKind: 'soc',
      targetSocPercent: 80,
      priority: 7,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 'vdp_000000000001', plannedKwh: 42.5 });
    expect(m.createDeparture).toHaveBeenCalledWith(
      {
        fleetId: FLEET,
        vehicleId: VEHICLE,
        siteId: SITE,
        departureAt: new Date('2026-11-03T05:30:00Z'),
        target: { kind: 'soc', targetSoc: 80, maxSoc: null },
        source: 'manual',
        priority: 7,
      },
      expect.anything(),
    );
  });

  it('passes the expected arrival of a departure on create and update, and refuses a bad one', async () => {
    m.createDeparture.mockResolvedValueOnce(departure());
    const created = await send('POST', `/fleets/${FLEET}/departures`, {
      vehicleId: VEHICLE,
      siteId: SITE,
      departureAt: '2026-11-03T05:30:00Z',
      targetKind: 'soc',
      targetSocPercent: 80,
      expectedArrivalAt: '2026-11-03T01:00:00Z',
      expectedArrivalSocPercent: 30,
    });
    expect(created.statusCode).toBe(201);
    expect(m.createDeparture).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedArrivalAt: new Date('2026-11-03T01:00:00Z'),
        expectedArrivalSocPercent: 30,
      }),
      expect.anything(),
    );
    m.updateDeparture.mockResolvedValueOnce(departure());
    const updated = await send('PATCH', '/departures/vdp_000000000001', {
      expectedArrivalAt: null,
      expectedArrivalSocPercent: 45,
    });
    expect(updated.statusCode).toBe(200);
    expect(m.updateDeparture).toHaveBeenCalledWith(
      'vdp_000000000001',
      { expectedArrivalAt: null, expectedArrivalSocPercent: 45 },
      expect.anything(),
    );
    for (const bad of [{ expectedArrivalSocPercent: 101 }, { expectedArrivalAt: 'tomorrow' }]) {
      const res = await send('PATCH', '/departures/vdp_000000000001', bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('publishes departure.changed for the sites a write changed', async () => {
    m.createDeparture.mockResolvedValueOnce(departure());
    await send('POST', `/fleets/${FLEET}/departures`, {
      vehicleId: VEHICLE,
      siteId: SITE,
      departureAt: '2026-11-03T05:30:00Z',
      targetKind: 'energy',
      targetEnergyKwh: 40,
    });
    const ctx = m.createDeparture.mock.calls[0]?.[1] as {
      onChange?: (change: { kind: string; id: string; siteIds: string[] }) => unknown;
    };
    expect(ctx.onChange).toBeTypeOf('function');
    await ctx.onChange?.({ kind: 'departure', id: 'vdp_000000000001', siteIds: [SITE] });
    expect(m.publishDepartureChanged).toHaveBeenCalledWith([SITE], expect.anything());
  });

  it('answers the service errors with their codes', async () => {
    const cases: [unknown, number, string][] = [
      [new AppError('x', 400, 'VEHICLE_NOT_IN_FLEET'), 400, 'VEHICLE_NOT_IN_FLEET'],
      [new AppError('x', 404, 'SITE_NOT_FOUND'), 404, 'SITE_NOT_FOUND'],
    ];
    for (const [err, status, code] of cases) {
      m.fleetRows.push([{ id: FLEET }]);
      m.createDeparture.mockRejectedValueOnce(err);
      const res = await send('POST', `/fleets/${FLEET}/departures`, {
        vehicleId: VEHICLE,
        siteId: SITE,
        departureAt: '2026-11-03T05:30:00Z',
        targetKind: 'energy',
        targetEnergyKwh: 50,
      });
      expect(res.statusCode).toBe(status);
      expect(res.json().code).toBe(code);
    }
    m.updateDeparture.mockRejectedValueOnce(new AppError('x', 409, 'DEPARTURE_NOT_SCHEDULED'));
    const patched = await send('PATCH', '/departures/vdp_000000000001', { priority: 3 });
    expect(patched.statusCode).toBe(409);
    expect(patched.json().code).toBe('DEPARTURE_NOT_SCHEDULED');
    m.deleteDepartureSchedule.mockRejectedValueOnce(
      new AppError('x', 404, 'DEPARTURE_SCHEDULE_NOT_FOUND'),
    );
    const deleted = await send('DELETE', '/departure-schedules/vds_000000000001');
    expect(deleted.statusCode).toBe(404);
    expect(deleted.json().code).toBe('DEPARTURE_SCHEDULE_NOT_FOUND');
  });

  it('updates a schedule with only the fields sent', async () => {
    m.updateDepartureSchedule.mockResolvedValueOnce({
      schedule: schedule({ departureTime: '06:00' }),
      ...counts,
      occurrencesCreated: 0,
      occurrencesUpdated: 4,
    });
    const res = await send('PATCH', '/departure-schedules/vds_000000000001', {
      departureTime: '06:00',
      validTo: null,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ departureTime: '06:00', occurrencesUpdated: 4 });
    expect(m.updateDepartureSchedule).toHaveBeenCalledWith(
      'vds_000000000001',
      { departureTime: '06:00', validTo: null },
      expect.anything(),
    );
  });

  it('refuses an id of another kind in the path', async () => {
    const res = await send('PATCH', '/departure-schedules/vdp_000000000001', { priority: 2 });
    expect(res.statusCode).toBe(400);
    expect(m.updateDepartureSchedule).not.toHaveBeenCalled();
  });

  it('deletes a schedule and cancels a departure', async () => {
    m.deleteDepartureSchedule.mockResolvedValueOnce({
      schedule: schedule(),
      occurrencesCancelled: 3,
    });
    const deleted = await send('DELETE', '/departure-schedules/vds_000000000001');
    expect(deleted.json()).toEqual({ success: true, occurrencesCancelled: 3 });
    m.cancelDeparture.mockResolvedValueOnce({
      departure: departure({ status: 'cancelled' }),
      changed: false,
    });
    const cancelled = await send('POST', '/departures/vdp_000000000001/cancel');
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', changed: false });
  });

  it('lists departures over the next 7 days by default, in the caller scope', async () => {
    m.listFleetDepartures.mockResolvedValueOnce({ data: [], total: 0 });
    const before = Date.now();
    const res = await send('GET', `/fleets/${FLEET}/departures?status=scheduled`);
    expect(res.statusCode).toBe(200);
    const [fleetId, filters, scope] = m.listFleetDepartures.mock.calls[0] as [
      string,
      { from: Date; to: Date; status: string; page: number; limit: number },
      string[],
    ];
    expect(fleetId).toBe(FLEET);
    expect(scope).toEqual([SITE]);
    expect(filters.status).toBe('scheduled');
    expect(filters.from.getTime()).toBeGreaterThanOrEqual(before);
    expect(filters.to.getTime() - filters.from.getTime()).toBe(7 * 86_400_000);
    expect(filters).toMatchObject({ page: 1, limit: 10 });
  });

  it('refuses a list window whose end is not after its start', async () => {
    const res = await send(
      'GET',
      `/fleets/${FLEET}/departures?from=2026-11-03T00:00:00Z&to=2026-11-02T00:00:00Z`,
    );
    expect(res.statusCode).toBe(400);
    expect(m.listFleetDepartures).not.toHaveBeenCalled();
  });

  it('lists schedules with the filters', async () => {
    m.listFleetDepartureSchedules.mockResolvedValueOnce({ data: [], total: 0 });
    const res = await send(
      'GET',
      `/fleets/${FLEET}/departure-schedules?siteId=${SITE}&search=bus&page=2`,
    );
    expect(res.statusCode).toBe(200);
    expect(m.listFleetDepartureSchedules).toHaveBeenCalledWith(
      FLEET,
      expect.objectContaining({ siteId: SITE, search: 'bus', page: 2 }),
      [SITE],
    );
  });

  it('imports CSV text through the import service', async () => {
    m.importDepartures.mockResolvedValueOnce({
      created: 1,
      updated: 0,
      unchanged: 0,
      refused: [{ row: 3, field: 'site', reason: 'not_found' }],
    });
    const csv = 'vehicle,site,departure,energy_kwh\nBUS 1,North,2026-11-03 05:30,10\n';
    const res = await send('POST', `/fleets/${FLEET}/departures/import`, { csv });
    expect(res.statusCode).toBe(200);
    expect(res.json().refused).toEqual([{ row: 3, field: 'site', reason: 'not_found' }]);
    expect(m.importDepartures).toHaveBeenCalledWith(
      FLEET,
      csv,
      expect.objectContaining({ siteScope: [SITE] }),
    );
  });
});

describe('departure import rate limit', () => {
  it('takes 5 imports a minute per user', async () => {
    const app = Fastify();
    await app.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute' });
    await registerAuth(app);
    departureRoutes(app);
    await app.ready();
    try {
      const token = app.jwt.sign({ userId: 'usr_000000000002', roleId: 'rol_000000000001' });
      m.getUserSiteIds.mockReset().mockResolvedValue([SITE]);
      m.importDepartures.mockResolvedValue({ created: 0, updated: 0, unchanged: 0, refused: [] });
      const codes: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        m.fleetRows.length = 0;
        m.fleetRows.push([{ id: FLEET }]);
        const res = await app.inject({
          method: 'POST',
          url: `/fleets/${FLEET}/departures/import`,
          headers: { authorization: `Bearer ${token}` },
          payload: { csv: 'vehicle,site,departure,energy_kwh\n' },
        });
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    } finally {
      await app.close();
    }
  });
});
