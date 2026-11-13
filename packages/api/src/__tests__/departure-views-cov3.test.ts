// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Departure and schedule reads: the view shapes, the bus depot system part,
// the planner output hidden where the depot plan does not run, the session id
// only for sessions:read and the list rows with their vehicle and site names.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const q = vi.hoisted(() => ({
  selects: [] as unknown[],
  isFleetChargingEnabled: vi.fn(),
}));

function chain(): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'offset']) {
    b[method] = () => b;
  }
  b['then'] = (res: (v: unknown) => unknown) => Promise.resolve(q.selects.shift() ?? []).then(res);
  return b;
}

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: { select: () => chain() },
    isFleetChargingEnabled: q.isFleetChargingEnabled,
  };
});

import {
  departureView,
  depotSystemOfDeparture,
  listFleetDepartureSchedules,
  listFleetDepartures,
  planningSiteIds,
  scheduleView,
  withDepotSystem,
} from '../lib/departure-views.js';

type Departure = Parameters<typeof departureView>[0];
type Schedule = Parameters<typeof scheduleView>[0];

const AT = new Date('2026-11-12T06:00:00.000Z');

function departure(overrides: Record<string, unknown> = {}): Departure {
  return {
    id: 'vdp_1',
    vehicleId: 'veh_1',
    siteId: 'sit_1',
    scheduleId: null,
    occurrenceDate: null,
    departureAt: AT,
    adHoc: false,
    targetKind: 'energy',
    targetEnergyKwh: '40.5',
    targetSocPercent: null,
    targetSocMaxPercent: null,
    expectedArrivalAt: null,
    expectedArrivalSocPercent: null,
    requestedEvseId: null,
    priority: 5,
    source: 'manual',
    depotSystemId: null,
    externalRequestId: null,
    cancelReason: null,
    predictedMaxReadyAt: AT,
    overridden: false,
    status: 'scheduled',
    outcome: null,
    readiness: 'on_track',
    readinessReason: null,
    sessionId: 'ses_1',
    plannedKwh: '40',
    deliveredKwh: null,
    shortfallKwh: '0.5',
    predictedReadyAt: AT,
    plannedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  } as unknown as Departure;
}

function schedule(): Schedule {
  return {
    id: 'vds_1',
    vehicleId: 'veh_1',
    siteId: 'sit_1',
    daysOfWeek: [1, 2],
    departureTime: '06:00',
    targetKind: 'soc',
    targetEnergyKwh: null,
    targetSocPercent: 80,
    targetSocMaxPercent: 90,
    priority: 3,
    validFrom: null,
    validTo: null,
    isActive: true,
    notes: 'n',
    createdAt: AT,
    updatedAt: AT,
  } as unknown as Schedule;
}

const names = {
  vehicleDriverId: 'drv_1',
  vehicleMake: 'BYD',
  vehicleModel: 'K9',
  vehicleLicensePlate: 'BUS-1',
  siteName: 'Northgate',
  siteTimezone: 'America/Chicago',
};

beforeEach(() => {
  q.selects.length = 0;
  q.isFleetChargingEnabled.mockReset().mockResolvedValue(true);
});

describe('departureView', () => {
  it('turns numeric columns into numbers and adds the session id only for sessions:read', () => {
    const view = departureView(departure(), { sessionIds: true });
    expect(view).toMatchObject({
      targetEnergyKwh: 40.5,
      plannedKwh: 40,
      deliveredKwh: null,
      shortfallKwh: 0.5,
      sessionId: 'ses_1',
    });
    expect(departureView(departure(), { sessionIds: false })).not.toHaveProperty('sessionId');
  });
});

describe('withDepotSystem', () => {
  it('names the system only for a reader who may list the systems', () => {
    const row = { depotSystemName: 'Depot DMS', depotSystemEnabled: true };
    const view = departureView(departure(), { sessionIds: false });
    expect(withDepotSystem(view, row, { sessionIds: false, depotSystemNames: true })).toMatchObject(
      {
        depotSystemName: 'Depot DMS',
        managedByDepotSystem: true,
      },
    );
    expect(withDepotSystem(view, row, { sessionIds: false })).toMatchObject({
      depotSystemName: null,
      managedByDepotSystem: true,
    });
  });

  it('is not managed once ended or with the system off', () => {
    const ended = departureView(departure({ status: 'completed' }), { sessionIds: false });
    expect(
      withDepotSystem(
        ended,
        { depotSystemName: 'X', depotSystemEnabled: true },
        { sessionIds: false },
      ).managedByDepotSystem,
    ).toBe(false);
    const open = departureView(departure(), { sessionIds: false });
    expect(
      withDepotSystem(
        open,
        { depotSystemName: 'X', depotSystemEnabled: false },
        { sessionIds: false },
      ).managedByDepotSystem,
    ).toBe(false);
  });
});

describe('depotSystemOfDeparture', () => {
  it('reads nothing for a departure without a system', async () => {
    expect(await depotSystemOfDeparture({ depotSystemId: null })).toEqual({
      depotSystemName: null,
      depotSystemEnabled: null,
    });
    expect(q.selects).toHaveLength(0);
  });

  it('reads the name and switch, null for a deleted system', async () => {
    q.selects.push([{ name: 'DMS', enabled: true }], []);
    expect(await depotSystemOfDeparture({ depotSystemId: 'dps_1' })).toEqual({
      depotSystemName: 'DMS',
      depotSystemEnabled: true,
    });
    expect(await depotSystemOfDeparture({ depotSystemId: 'dps_2' })).toEqual({
      depotSystemName: null,
      depotSystemEnabled: null,
    });
  });
});

describe('planningSiteIds', () => {
  it('reads nothing for no site or with Fleet Charging off', async () => {
    expect(await planningSiteIds([])).toEqual(new Set());
    q.isFleetChargingEnabled.mockResolvedValue(false);
    expect(await planningSiteIds(['sit_1'])).toEqual(new Set());
    expect(q.isFleetChargingEnabled).toHaveBeenCalledTimes(1);
  });

  it('returns the Departure Aware sites', async () => {
    q.selects.push([{ siteId: 'sit_1' }]);
    expect(await planningSiteIds(['sit_1', 'sit_1', 'sit_2'])).toEqual(new Set(['sit_1']));
  });
});

describe('listFleetDepartureSchedules', () => {
  it('returns the schedules with vehicle and site names and the total', async () => {
    q.selects.push([{ schedule: schedule(), ...names }], [{ total: 4 }]);
    const result = await listFleetDepartureSchedules(
      'flt_1',
      { page: 2, limit: 10, search: ' bus ', siteId: 'sit_1', vehicleId: 'veh_1' },
      ['sit_1'],
    );
    expect(result.total).toBe(4);
    expect(result.data[0]).toMatchObject({
      id: 'vds_1',
      targetEnergyKwh: null,
      targetSocPercent: 80,
      siteName: 'Northgate',
      siteTimezone: 'America/Chicago',
      vehicle: { id: 'veh_1', driverId: 'drv_1', make: 'BYD', model: 'K9', licensePlate: 'BUS-1' },
    });
    expect(result.data[0]).not.toHaveProperty('requestedChargingPointId');
  });

  it('answers total 0 without a count row, for a caller with no site', async () => {
    q.selects.push([], []);
    expect(await listFleetDepartureSchedules('flt_1', { page: 1, limit: 10 }, [])).toEqual({
      data: [],
      total: 0,
    });
  });
});

describe('listFleetDepartures', () => {
  const filters = {
    page: 1,
    limit: 20,
    from: new Date('2026-11-12T00:00:00.000Z'),
    to: new Date('2026-11-13T00:00:00.000Z'),
  };

  it('keeps the planner output only where the depot plan runs', async () => {
    q.selects.push(
      [
        {
          departure: departure(),
          requestedChargingPointId: 'CS-1/1',
          depotSystemName: null,
          depotSystemEnabled: null,
          ...names,
        },
        {
          departure: departure({ id: 'vdp_2', siteId: 'sit_2' }),
          requestedChargingPointId: null,
          depotSystemName: 'DMS',
          depotSystemEnabled: true,
          ...names,
        },
      ],
      [{ total: 2 }],
      [{ siteId: 'sit_1' }],
    );
    const result = await listFleetDepartures(
      'flt_1',
      { ...filters, status: 'scheduled', siteId: 'sit_1', vehicleId: 'veh_1' },
      null,
      { sessionIds: true, depotSystemNames: true },
    );
    expect(result.total).toBe(2);
    expect(result.data[0]).toMatchObject({
      id: 'vdp_1',
      readiness: 'on_track',
      shortfallKwh: 0.5,
      requestedChargingPointId: 'CS-1/1',
      managedByDepotSystem: false,
      sessionId: 'ses_1',
      siteName: 'Northgate',
    });
    expect(result.data[1]).toMatchObject({
      id: 'vdp_2',
      readiness: null,
      readinessReason: null,
      predictedReadyAt: null,
      predictedMaxReadyAt: null,
      shortfallKwh: null,
      requestedChargingPointId: null,
      depotSystemName: 'DMS',
      managedByDepotSystem: true,
    });
  });

  it('answers total 0 without a count row', async () => {
    q.selects.push([], []);
    expect(await listFleetDepartures('flt_1', filters, ['sit_1'], { sessionIds: false })).toEqual({
      data: [],
      total: 0,
    });
  });
});
