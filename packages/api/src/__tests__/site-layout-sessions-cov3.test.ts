// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { results, fleetCharging } = vi.hoisted(() => ({
  results: [] as unknown[][],
  fleetCharging: { on: true },
}));

function chain(): Record<string, unknown> {
  const rows = results.shift() ?? [];
  const self: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'innerJoin', 'leftJoin']) {
    self[m] = () => self;
  }
  self['then'] = (resolve: (v: unknown) => unknown) => resolve(rows);
  return self;
}

vi.mock('@evtivity/database', async () => ({
  ...(await import('@evtivity/database/src/schema/departures.js')),
  ...(await import('@evtivity/database/src/schema/assets.js')),
  ...(await import('@evtivity/database/src/schema/load-management.js')),
  ...(await import('@evtivity/database/src/schema/charging.js')),
  ...(await import('@evtivity/database/src/schema/drivers.js')),
  db: { select: () => chain(), selectDistinctOn: () => chain() },
  isFleetChargingEnabled: async () => fleetCharging.on,
}));
vi.mock('../services/account-avatar.js', () => ({
  withAvatars: async (rows: Array<Record<string, unknown>>) =>
    rows.map((r) => ({ ...r, avatar: { kind: 'generated', seed: String(r['id']) } })),
}));

import {
  layoutDriverName,
  readLayoutDrivers,
  readLayoutEvseSessions,
  readLayoutSessionDepartures,
  readLayoutStationSessions,
  readSessionVehicles,
} from '../lib/site-layout-sessions.js';

beforeEach(() => {
  results.length = 0;
  fleetCharging.on = true;
});

const veh = (id: string, driverId: string, color = 'red') => ({
  id,
  driverId,
  color,
  bodyType: 'sedan',
});

describe('readSessionVehicles', () => {
  it('returns an empty map without rows', async () => {
    expect((await readSessionVehicles([])).size).toBe(0);
  });

  it('uses the own vehicle, the only vehicle and the last used one of a driver', async () => {
    results.push(
      // own vehicles
      [veh('veh_own', 'drv_x', 'blue')],
      // vehicles of drivers without a session vehicle
      [veh('veh_solo', 'drv_1', 'white'), veh('veh_a', 'drv_2'), veh('veh_b', 'drv_2', 'black')],
      // last used per driver with several vehicles
      [
        { driverId: 'drv_2', vehicleId: 'veh_b' },
        { driverId: null, vehicleId: 'veh_z' },
      ],
    );
    const out = await readSessionVehicles([
      { id: 's_own', vehicleId: 'veh_own', driverId: 'drv_x' },
      { id: 's_solo', vehicleId: null, driverId: 'drv_1' },
      { id: 's_multi', vehicleId: null, driverId: 'drv_2' },
      { id: 's_none', vehicleId: null, driverId: null },
    ]);
    expect(out.get('s_own')).toEqual({ color: 'blue', bodyType: 'sedan' });
    expect(out.get('s_solo')).toEqual({ color: 'white', bodyType: 'sedan' });
    expect(out.get('s_multi')).toEqual({ color: 'black', bodyType: 'sedan' });
    expect(out.get('s_none')).toBeNull();
    expect(results).toHaveLength(0);
  });
});

describe('layoutDriverName', () => {
  it('joins the names and returns null for blank ones', () => {
    expect(layoutDriverName('Ada', 'Lovelace')).toBe('Ada Lovelace');
    expect(layoutDriverName('', 'Lovelace')).toBe('Lovelace');
    expect(layoutDriverName(' ', '')).toBeNull();
  });
});

describe('readLayoutDrivers', () => {
  it('reads nothing for no ids', async () => {
    expect((await readLayoutDrivers([])).size).toBe(0);
  });

  it('leaves out erased drivers and adds the avatar', async () => {
    results.push([
      { id: 'drv_1', firstName: 'Ada', lastName: 'L', erasedAt: null },
      { id: 'drv_2', firstName: '', lastName: '', erasedAt: new Date() },
      { id: 'drv_3', firstName: '', lastName: '', erasedAt: null },
    ]);
    const out = await readLayoutDrivers(['drv_1', 'drv_2', 'drv_3', 'drv_1']);
    expect([...out.keys()]).toEqual(['drv_1', 'drv_3']);
    expect(out.get('drv_1')).toEqual({
      id: 'drv_1',
      name: 'Ada L',
      avatar: { kind: 'generated', seed: 'drv_1' },
    });
    expect(out.get('drv_3')?.name).toBeNull();
  });
});

describe('readLayoutSessionDepartures', () => {
  it('reads nothing for no sessions', async () => {
    expect((await readLayoutSessionDepartures('sit_1', [])).size).toBe(0);
  });

  it('hides the readiness while the depot plan does not run and keeps a soc target', async () => {
    fleetCharging.on = false;
    results.push(
      [
        {
          id: 'vdp_1',
          sessionId: 'ses_1',
          departureAt: null,
          targetKind: 'soc',
          targetEnergyKwh: null,
          targetSocPercent: 80,
          readiness: 'on_track',
          readinessReason: null,
          deliveredKwh: null,
          shortfallKwh: '3.5',
          predictedReadyAt: new Date('2026-11-03T10:00:00Z'),
        },
        { id: 'vdp_x', sessionId: null },
      ],
      [],
      [{ strategy: 'departure_aware' }],
    );
    const out = await readLayoutSessionDepartures('sit_1', ['ses_1']);
    expect(out.get('ses_1')).toEqual({
      id: 'vdp_1',
      departureAt: null,
      timezone: 'UTC',
      readiness: null,
      reason: null,
      targetKwh: null,
      targetSocPercent: 80,
      deliveredKwh: null,
      shortfallKwh: null,
      predictedReadyAt: null,
    });
    expect(out.size).toBe(1);
  });
});

describe('readLayoutStationSessions', () => {
  it('reads nothing for no stations', async () => {
    expect((await readLayoutStationSessions([], true)).size).toBe(0);
  });

  it('maps the newest session per station with its driver and departure', async () => {
    results.push(
      [
        {
          id: 'ses_1',
          stationId: 'sta_1',
          startedAt: '2026-11-03T08:00:00Z',
          energyDeliveredWh: '1234.5',
          currentCostCents: 250,
          currency: 'eur',
          driverId: 'drv_1',
          vehicleId: null,
          evseNumber: 2,
        },
        {
          id: 'ses_2',
          stationId: 'sta_2',
          startedAt: new Date('2026-11-03T09:00:00Z'),
          energyDeliveredWh: null,
          currentCostCents: null,
          currency: 'usd',
          driverId: null,
          vehicleId: null,
          evseNumber: null,
        },
      ],
      // readSessionVehicles: drivers' vehicles (drv_1 has none)
      [],
      // departures, site, config
      [],
      [{ timezone: 'Europe/Berlin' }],
      [],
      // drivers
      [{ id: 'drv_1', firstName: 'Ada', lastName: 'L', erasedAt: null }],
    );
    const out = await readLayoutStationSessions(['sta_1', 'sta_2'], true, 'sit_1');
    expect(out.get('sta_1')).toEqual({
      id: 'ses_1',
      startedAt: '2026-11-03T08:00:00.000Z',
      energyDeliveredWh: 1234.5,
      currentCostCents: 250,
      currency: 'EUR',
      evseId: 2,
      driver: { id: 'drv_1', name: 'Ada L', avatar: { kind: 'generated', seed: 'drv_1' } },
      vehicle: null,
      departure: null,
    });
    expect(out.get('sta_2')).toMatchObject({
      energyDeliveredWh: 0,
      currency: 'USD',
      evseId: null,
      driver: null,
      departure: null,
    });
  });

  it('leaves out the driver and the departure field when not asked', async () => {
    results.push([
      {
        id: 'ses_1',
        stationId: 'sta_1',
        startedAt: '2026-11-03T08:00:00Z',
        energyDeliveredWh: '1',
        currentCostCents: 0,
        currency: 'eur',
        driverId: null,
        vehicleId: null,
        evseNumber: 1,
      },
    ]);
    const out = await readLayoutStationSessions(['sta_1'], false);
    const s = out.get('sta_1');
    expect(s?.driver).toBeNull();
    expect(s != null && 'departure' in s).toBe(false);
  });
});

describe('readLayoutEvseSessions', () => {
  it('reads nothing for no stations', async () => {
    expect((await readLayoutEvseSessions([], true)).size).toBe(0);
  });

  it('keys the sessions by EVSE row id', async () => {
    results.push(
      [
        {
          id: 'ses_1',
          evseId: 'evs_1',
          startedAt: new Date('2026-11-03T08:00:00Z'),
          energyDeliveredWh: '500',
          currentCostCents: 10,
          currency: 'gbp',
          driverId: 'drv_1',
          vehicleId: null,
        },
        {
          id: 'ses_2',
          evseId: 'evs_2',
          startedAt: '2026-11-03T09:00:00Z',
          energyDeliveredWh: null,
          currentCostCents: null,
          currency: 'gbp',
          driverId: 'drv_gone',
          vehicleId: null,
        },
      ],
      [], // drivers' vehicles
      [{ id: 'drv_1', firstName: 'Ada', lastName: '', erasedAt: null }],
    );
    const out = await readLayoutEvseSessions(['sta_1'], true);
    expect(out.get('evs_1')).toEqual({
      id: 'ses_1',
      startedAt: '2026-11-03T08:00:00.000Z',
      energyDeliveredWh: 500,
      currentCostCents: 10,
      currency: 'GBP',
      driver: { id: 'drv_1', name: 'Ada', avatar: { kind: 'generated', seed: 'drv_1' } },
      vehicle: null,
    });
    expect(out.get('evs_2')).toMatchObject({ energyDeliveredWh: 0, driver: null });
  });

  it('reads no driver rows without includeDriver', async () => {
    results.push([
      {
        id: 'ses_1',
        evseId: 'evs_1',
        startedAt: '2026-11-03T08:00:00Z',
        energyDeliveredWh: '1',
        currentCostCents: 1,
        currency: 'usd',
        driverId: null,
        vehicleId: null,
      },
    ]);
    const out = await readLayoutEvseSessions(['sta_1'], false);
    expect(out.get('evs_1')?.driver).toBeNull();
  });
});
