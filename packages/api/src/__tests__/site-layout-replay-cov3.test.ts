// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { execute, readSessionVehicles, readLayoutDrivers } = vi.hoisted(() => ({
  execute: vi.fn(),
  readSessionVehicles: vi.fn(),
  readLayoutDrivers: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: { execute },
  operatorStationSql: () => 'true',
}));
vi.mock('../lib/site-layout-sessions.js', () => ({ readSessionVehicles, readLayoutDrivers }));

import { readSiteLayoutReplay, readStationSiteWindows } from '../lib/site-layout-replay.js';

const day = { from: new Date('2026-10-30T00:00:00Z'), to: new Date('2026-10-31T00:00:00Z') };

beforeEach(() => {
  execute.mockReset();
  readSessionVehicles.mockResolvedValue(new Map());
  readLayoutDrivers.mockResolvedValue(new Map());
});

describe('readStationSiteWindows', () => {
  it('returns an empty map for no stations without a query', async () => {
    expect((await readStationSiteWindows('sit_1', [])).size).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps each history row through the site window rule', async () => {
    execute.mockResolvedValueOnce([
      { id: 'a', placed_at: null, move_at: null, move_site_id: null, foreign_until: null },
      {
        id: 'b',
        placed_at: '2026-10-01T00:00:00Z',
        move_at: new Date('2026-10-10T00:00:00Z'),
        move_site_id: 'sit_1',
        foreign_until: '2026-10-05T00:00:00Z',
      },
      {
        id: 'c',
        placed_at: null,
        move_at: '2026-10-10T00:00:00Z',
        move_site_id: 'sit_2',
        foreign_until: null,
      },
      { id: 'd', placed_at: null, move_at: null, move_site_id: null, foreign_until: '2026-10-07' },
    ]);
    const out = await readStationSiteWindows('sit_1', ['a', 'b', 'c', 'd']);
    expect(out.get('a')).toBeNull();
    expect(out.get('b')).toEqual(new Date('2026-10-10T00:00:00Z'));
    expect(out.get('c')).toBe('closed');
    expect(out.get('d')).toEqual(new Date('2026-10-07'));
  });
});

/** Queue the eight queries of a replay in their call order. */
function queue(rows: {
  stations: unknown[];
  history: unknown[];
  beforeOnline?: unknown[];
  duringOnline?: unknown[];
  portDuring?: unknown[];
  portBefore?: unknown[];
  sessions?: unknown[];
  power?: unknown[];
}): void {
  execute
    .mockResolvedValueOnce(rows.stations)
    .mockResolvedValueOnce(rows.history)
    .mockResolvedValueOnce(rows.beforeOnline ?? [])
    .mockResolvedValueOnce(rows.duringOnline ?? [])
    .mockResolvedValueOnce(rows.portDuring ?? [])
    .mockResolvedValueOnce(rows.portBefore ?? [])
    .mockResolvedValueOnce(rows.sessions ?? [])
    .mockResolvedValueOnce(rows.power ?? []);
}

describe('readSiteLayoutReplay', () => {
  it('returns nothing for a site without operator stations', async () => {
    execute.mockResolvedValueOnce([]);
    expect(await readSiteLayoutReplay('sit_1', day)).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('builds the online timeline, connectors, sessions and power of each station', async () => {
    queue({
      stations: [
        { id: 'sta_a', is_online: true },
        { id: 'sta_b', is_online: true },
      ],
      history: [
        { id: 'sta_a', placed_at: null, move_at: null, move_site_id: null, foreign_until: null },
        // sta_b moved here during the day: its current state does not stand in.
        {
          id: 'sta_b',
          placed_at: '2026-10-30T12:00:00Z',
          move_at: null,
          move_site_id: null,
          foreign_until: null,
        },
      ],
      beforeOnline: [
        { station_id: 'sta_a', event: 'disconnected', created_at: '2026-10-29T20:00:00Z' },
      ],
      duringOnline: [
        { station_id: 'sta_a', event: 'connected', created_at: '2026-10-30T08:00:00Z' },
      ],
      portBefore: [
        { station_id: 'sta_a', evse_id: 2, connector_id: 1, new_status: 'Available' },
        { station_id: 'sta_a', evse_id: 1, connector_id: null, new_status: 'Faulted' },
      ],
      portDuring: [
        {
          station_id: 'sta_a',
          evse_id: 2,
          connector_id: 1,
          new_status: 'Charging',
          timestamp: '2026-10-30T09:00:00Z',
        },
        {
          station_id: 'sta_a',
          evse_id: 3,
          connector_id: 1,
          new_status: 'Occupied',
          timestamp: new Date('2026-10-30T10:00:00Z'),
        },
      ],
      sessions: [
        {
          id: 'ses_1',
          station_id: 'sta_a',
          started_at: '2026-10-30T09:00:00Z',
          ended_at: null,
          energy_wh: '1500',
          evse_number: 2,
          driver_id: 'drv_1',
          vehicle_id: null,
          currency: 'eur',
        },
      ],
      power: [{ station_id: 'sta_a', evse_id: 'e1', bucket: '2026-10-30T09:00:00Z', kw: '7.4' }],
    });
    const out = await readSiteLayoutReplay('sit_1', day);
    expect(out).toHaveLength(2);
    const [a, b] = out;
    expect(a?.initialOnline).toBe(false);
    expect(a?.onlineChanges).toEqual([{ at: '2026-10-30T08:00:00.000Z', online: true }]);
    expect(a?.connectors.map((c) => [c.evseId, c.connectorId, c.initialStatus])).toEqual([
      [1, null, 'Faulted'],
      [2, 1, 'Available'],
      [3, 1, null],
    ]);
    expect(a?.connectors[1]?.changes).toEqual([
      { at: '2026-10-30T09:00:00.000Z', status: 'Charging' },
    ]);
    // Without sessions:read the session carries no id, currency, car or driver.
    expect(a?.sessions).toEqual([
      {
        startedAt: '2026-10-30T09:00:00.000Z',
        endedAt: null,
        energyWh: 1500,
        evseId: 2,
        id: null,
        currency: null,
        vehicle: null,
        driver: null,
      },
    ]);
    expect(a?.power).toEqual([{ at: '2026-10-30T09:00:00.000Z', kw: 7.4 }]);
    expect(readSessionVehicles).not.toHaveBeenCalled();
    expect(readLayoutDrivers).not.toHaveBeenCalled();
    // sta_b: no events, and it came to the site after the day began: offline.
    expect(b).toEqual({
      id: 'sta_b',
      initialOnline: false,
      onlineChanges: [],
      connectors: [],
      sessions: [],
      power: [],
    });
  });

  it('counts a station missing from the windows as closed and uses the current state when it stood here', async () => {
    queue({
      stations: [
        { id: 'sta_a', is_online: true },
        { id: 'sta_gone', is_online: true },
      ],
      history: [
        { id: 'sta_a', placed_at: null, move_at: null, move_site_id: null, foreign_until: null },
      ],
    });
    const out = await readSiteLayoutReplay('sit_1', day);
    expect(out[0]?.initialOnline).toBe(true);
    expect(out[1]?.initialOnline).toBe(false);
    // The window VALUES list (third query) holds infinity for the missing station.
    const windowsQuery = JSON.stringify(execute.mock.calls[2]?.[0]);
    expect(windowsQuery).toContain('infinity');
  });

  it('adds the session id, currency, car and driver with sessions:read and drivers:read', async () => {
    const vehicle = { color: 'red', bodyType: 'sedan' };
    const driver = { id: 'drv_1', firstName: 'A', lastName: 'B', avatar: null };
    readSessionVehicles.mockResolvedValue(new Map([['ses_1', vehicle]]));
    readLayoutDrivers.mockResolvedValue(new Map([['drv_1', driver]]));
    queue({
      stations: [{ id: 'sta_a', is_online: false }],
      history: [
        { id: 'sta_a', placed_at: null, move_at: null, move_site_id: null, foreign_until: null },
      ],
      sessions: [
        {
          id: 'ses_1',
          station_id: 'sta_a',
          started_at: '2026-10-30T09:00:00Z',
          ended_at: '2026-10-30T10:00:00Z',
          energy_wh: 2000,
          evse_number: 1,
          driver_id: 'drv_1',
          vehicle_id: 'veh_1',
          currency: 'usd',
        },
        {
          id: 'ses_2',
          station_id: 'sta_a',
          started_at: '2026-10-30T11:00:00Z',
          ended_at: null,
          energy_wh: 0,
          evse_number: null,
          driver_id: null,
          vehicle_id: null,
          currency: null,
        },
      ],
    });
    const [station] = await readSiteLayoutReplay('sit_1', day, { sessions: true, drivers: true });
    expect(readSessionVehicles).toHaveBeenCalledWith([
      { id: 'ses_1', vehicleId: 'veh_1', driverId: 'drv_1' },
      { id: 'ses_2', vehicleId: null, driverId: null },
    ]);
    expect(readLayoutDrivers).toHaveBeenCalledWith(['drv_1']);
    expect(station?.sessions[0]).toMatchObject({
      id: 'ses_1',
      currency: 'USD',
      vehicle,
      driver,
      endedAt: '2026-10-30T10:00:00.000Z',
    });
    expect(station?.sessions[1]).toMatchObject({
      id: 'ses_2',
      currency: null,
      vehicle: null,
      driver: null,
    });
  });

  it('reads cars but no drivers with sessions:read alone', async () => {
    queue({
      stations: [{ id: 'sta_a', is_online: false }],
      history: [
        { id: 'sta_a', placed_at: null, move_at: null, move_site_id: null, foreign_until: null },
      ],
      sessions: [
        {
          id: 'ses_1',
          station_id: 'sta_a',
          started_at: '2026-10-30T09:00:00Z',
          ended_at: null,
          energy_wh: 1,
          evse_number: 1,
          driver_id: 'drv_1',
          vehicle_id: null,
          currency: 'usd',
        },
      ],
    });
    const [station] = await readSiteLayoutReplay('sit_1', day, { sessions: true, drivers: false });
    expect(readSessionVehicles).toHaveBeenCalledTimes(1);
    expect(readLayoutDrivers).not.toHaveBeenCalled();
    expect(station?.sessions[0]?.driver).toBeNull();
    expect(station?.sessions[0]?.id).toBe('ses_1');
  });
});
