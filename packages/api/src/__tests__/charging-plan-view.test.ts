// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The depot plan view: what each departure and session without a vehicle
// carries, and the driver ids it leaves out without the read permissions.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ results: [] as unknown[][] }));

function chain(result: unknown[]): unknown {
  const target: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return new Proxy(target, {
    get: (t, key: string) => (key in t ? t[key] : () => chain(result)),
  });
}

vi.mock('@evtivity/database', () => ({
  db: { select: () => chain(m.results.shift() ?? []) },
  chargingSessions: {},
  chargingStations: {},
  evses: {},
  siteChargingPlans: {},
  siteLoadManagement: {},
  sites: {},
  vehicleDepartures: {},
  vehicles: {},
  isFleetChargingEnabled: () => Promise.resolve(true),
  isOperatorStation: vi.fn(() => 'operator-station'),
  DEPARTURE_OUTCOMES: ['ready'],
  DEPARTURE_READINESS_REASONS: ['none'],
  DEPARTURE_READINESS_STATES: ['on_track'],
  DEPARTURE_SOURCES: ['manual'],
  DEPARTURE_CANCEL_REASONS: ['removed_by_depot_system'],
  DEPARTURE_STATUSES: ['scheduled'],
  DEPARTURE_TARGET_KINDS: ['energy', 'soc'],
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  asc: vi.fn(),
  count: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  exists: vi.fn(),
  gte: vi.fn(),
  ilike: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  lt: vi.fn(),
  or: vi.fn(),
  sql: vi.fn(),
}));

import { siteChargingPlanView } from '../lib/charging-plan-view.js';

const departure = {
  id: 'vdp_000000000001',
  vehicleId: 'veh_000000000001',
  siteId: 'sit_000000000001',
  scheduleId: null,
  occurrenceDate: null,
  departureAt: new Date('2026-11-01T06:00:00Z'),
  targetKind: 'energy',
  targetEnergyKwh: '120.00',
  targetSocPercent: null,
  priority: 5,
  status: 'scheduled',
  source: 'manual',
  overridden: false,
  readiness: 'at_risk',
  readinessReason: 'site_capacity',
  shortfallKwh: '32.00',
  predictedReadyAt: new Date('2026-11-01T06:10:00Z'),
  sessionId: 'ses_000000000001',
  createdAt: new Date('2026-10-31T00:00:00Z'),
  updatedAt: new Date('2026-10-31T00:00:00Z'),
};

const departureRow = (bound: boolean) => ({
  departure,
  vehicleDriverId: 'drv_000000000001',
  vehicleMake: 'Blue Bird',
  vehicleModel: 'Vision',
  vehicleLicensePlate: 'BUS-1',
  vehicleBodyType: 'bus',
  siteName: 'Depot A',
  siteTimezone: 'America/Los_Angeles',
  boundStationId: bound ? 'sta_000000000001' : null,
  boundStationOcppId: bound ? 'CS-0001' : null,
  boundEvseId: bound ? 2 : null,
});

const sessionRow = {
  sessionId: 'ses_000000000002',
  stationId: 'sta_000000000001',
  stationOcppId: 'CS-0001',
  evseId: 1,
  driverId: 'drv_000000000002',
  startedAt: new Date('2026-10-31T20:00:00Z'),
};

function queue(bound = true): void {
  // config, stored plan, departures, sessions without a vehicle
  m.results = [
    [{ strategy: 'departure_aware', bufferMinutes: 30 }],
    [],
    [departureRow(bound)],
    [sessionRow],
  ];
}

describe('siteChargingPlanView', () => {
  beforeEach(() => queue());

  it("names the bound session's station and EVSE and the vehicle body type", async () => {
    const view = await siteChargingPlanView('sit_000000000001', {
      departures: true,
      driverIds: true,
      sessionIds: true,
      sessionDriverIds: true,
    });
    const [item] = view['departures'] as Record<string, unknown>[];
    expect(item?.['station']).toEqual({ id: 'sta_000000000001', stationId: 'CS-0001', evseId: 2 });
    expect(item?.['vehicle']).toEqual({
      id: 'veh_000000000001',
      driverId: 'drv_000000000001',
      make: 'Blue Bird',
      model: 'Vision',
      licensePlate: 'BUS-1',
      bodyType: 'bus',
    });
    expect(view['unidentifiedSessions']).toEqual([sessionRow]);
  });

  it('keeps the planner output and the site time zone while the plan runs', async () => {
    const view = await siteChargingPlanView('sit_000000000001', {
      departures: true,
      driverIds: false,
      sessionIds: false,
      sessionDriverIds: false,
    });
    const [item] = view['departures'] as Record<string, unknown>[];
    expect(item).toMatchObject({
      siteTimezone: 'America/Los_Angeles',
      readiness: 'at_risk',
      readinessReason: 'site_capacity',
      shortfallKwh: 32,
    });
  });

  it('leaves the planner output out while the site uses another strategy', async () => {
    m.results[0] = [{ strategy: 'equal_share', bufferMinutes: 30 }];
    const view = await siteChargingPlanView('sit_000000000001', {
      departures: true,
      driverIds: false,
      sessionIds: false,
      sessionDriverIds: false,
    });
    expect(view['planning']).toBe(false);
    const [item] = view['departures'] as Record<string, unknown>[];
    expect(item).toMatchObject({
      readiness: null,
      readinessReason: null,
      predictedReadyAt: null,
      shortfallKwh: null,
    });
  });

  it('lists sessions without a vehicle only at operator stations, never conformance ones', async () => {
    const { and } = await import('drizzle-orm');
    await siteChargingPlanView('sit_000000000001', {
      departures: true,
      driverIds: true,
      sessionIds: true,
      sessionDriverIds: true,
    });
    expect(
      vi.mocked(and).mock.calls.some((args) => (args as unknown[]).includes('operator-station')),
    ).toBe(true);
  });

  it('gives a departure without a bound session station null', async () => {
    queue(false);
    const view = await siteChargingPlanView('sit_000000000001', {
      departures: true,
      driverIds: true,
      sessionIds: true,
      sessionDriverIds: true,
    });
    expect((view['departures'] as Record<string, unknown>[])[0]?.['station']).toBeNull();
  });

  it('leaves out session driver ids without sessions:read and drivers:read', async () => {
    const view = await siteChargingPlanView('sit_000000000001', {
      departures: true,
      driverIds: true,
      sessionIds: false,
      sessionDriverIds: false,
    });
    const [session] = view['unidentifiedSessions'] as Record<string, unknown>[];
    expect(session).not.toHaveProperty('driverId');
    // The vehicle driver id follows drivers:read alone.
    const [item] = view['departures'] as Record<string, { driverId?: string }>[];
    expect(item?.['vehicle']?.driverId).toBe('drv_000000000001');
  });

  it('leaves out every session id without sessions:read (security case 316)', async () => {
    const view = await siteChargingPlanView('sit_000000000001', {
      departures: true,
      driverIds: true,
      sessionIds: false,
      sessionDriverIds: false,
    });
    const [session] = view['unidentifiedSessions'] as Record<string, unknown>[];
    expect(session).not.toHaveProperty('sessionId');
    expect(session).toHaveProperty('stationOcppId');
    for (const departure of view['departures'] as Record<string, unknown>[]) {
      expect(departure).not.toHaveProperty('sessionId');
    }
  });

  it('leaves out every driver id and the departures with the plan permission alone', async () => {
    const view = await siteChargingPlanView('sit_000000000001', {
      departures: false,
      driverIds: false,
      sessionIds: false,
      sessionDriverIds: false,
    });
    expect(view).not.toHaveProperty('departures');
    expect(JSON.stringify(view)).not.toContain('drv_');
  });
});
