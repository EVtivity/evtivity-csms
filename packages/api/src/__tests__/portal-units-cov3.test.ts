// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

const { results } = vi.hoisted(() => ({ results: [] as unknown[][] }));

function chain(): Record<string, unknown> {
  const rows = results.shift() ?? [];
  const self: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'innerJoin']) self[m] = () => self;
  self['then'] = (resolve: (v: unknown) => unknown) => resolve(rows);
  return self;
}

vi.mock('@evtivity/database', async () => ({
  ...(await import('@evtivity/database/src/schema/assets.js')),
  db: { select: () => chain() },
  evseAvailableSql: () => 'true',
}));
vi.mock('../lib/public-station.js', () => ({ publicStationListed: () => sql`true` }));

import {
  driverChargers,
  expandToDriverChargers,
  extraUnitChargerCount,
  loadStationDriverUnits,
  locationChargers,
  type StationDriverUnits,
} from '../lib/portal-units.js';

beforeEach(() => {
  results.length = 0;
});

describe('driverChargers (cov3)', () => {
  it('orders units of one sort order by name, leaves out empty units and treats an unknown unit as none', () => {
    const out = driverChargers(
      [
        { evseId: 3, unitId: 'unt_b', available: true },
        { evseId: 1, unitId: 'unt_a', available: false },
        { evseId: 5, unitId: 'unt_gone', available: true },
        { evseId: 4, unitId: null, available: false },
      ],
      [
        { id: 'unt_b', name: 'Bravo', sortOrder: 0 },
        { id: 'unt_a', name: 'Alpha', sortOrder: 0 },
        { id: 'unt_empty', name: 'Empty', sortOrder: 1 },
      ],
    );
    expect(out).toEqual([
      { unitId: 'unt_a', unitName: 'Alpha', evseIds: [1], evseCount: 1, availableCount: 0 },
      { unitId: 'unt_b', unitName: 'Bravo', evseIds: [3], evseCount: 1, availableCount: 1 },
      { unitId: null, unitName: null, evseIds: [4, 5], evseCount: 2, availableCount: 1 },
    ]);
  });
});

describe('loadStationDriverUnits', () => {
  it('reads nothing for no stations', async () => {
    expect((await loadStationDriverUnits([])).size).toBe(0);
  });

  it('reads no EVSEs when no station has units', async () => {
    results.push([], [{ stationId: 'sta_1', evseId: 1, unitId: null, available: true }]);
    expect((await loadStationDriverUnits(['sta_1'])).size).toBe(0);
    expect(results).toHaveLength(1);
  });

  it('groups the units and EVSEs per station with units', async () => {
    results.push(
      [
        { id: 'unt_1', stationId: 'sta_1', name: 'Box 1', sortOrder: 0 },
        { id: 'unt_2', stationId: 'sta_1', name: 'Box 2', sortOrder: 1 },
      ],
      [
        { stationId: 'sta_1', evseId: 1, unitId: 'unt_1', available: true },
        { stationId: 'sta_1', evseId: 2, unitId: null, available: false },
        { stationId: 'sta_x', evseId: 9, unitId: null, available: true },
      ],
    );
    const out = await loadStationDriverUnits(['sta_1', 'sta_2']);
    expect([...out.keys()]).toEqual(['sta_1']);
    expect(out.get('sta_1')).toEqual({
      units: [
        { id: 'unt_1', name: 'Box 1', sortOrder: 0 },
        { id: 'unt_2', name: 'Box 2', sortOrder: 1 },
      ],
      evses: [
        { evseId: 1, unitId: 'unt_1', available: true },
        { evseId: 2, unitId: null, available: false },
      ],
    });
  });
});

describe('expandToDriverChargers', () => {
  const connectors = [
    {
      evseId: 1,
      connectorType: 'Type2',
      maxPowerKw: '22',
      maxCurrentAmps: 32,
      status: 'Available',
    },
    {
      evseId: 2,
      connectorType: 'CCS2',
      maxPowerKw: '50',
      maxCurrentAmps: null,
      status: 'Charging',
    },
  ];

  it('keeps a station without units as one row and splits one with units per charger', () => {
    const rows = [
      { stationUuid: 'sta_plain', evseCount: 2, availableCount: 1, connectors, name: 'Plain' },
      { stationUuid: 'sta_units', evseCount: 2, availableCount: 1, connectors, name: 'Units' },
    ];
    const unitData = new Map([
      [
        'sta_units',
        {
          units: [{ id: 'unt_1', name: 'Box 1', sortOrder: 0 }],
          evses: [
            { evseId: 1, unitId: 'unt_1', available: true },
            { evseId: 2, unitId: null, available: false },
          ],
        },
      ],
    ]);
    const out = expandToDriverChargers(rows, unitData, (r) => ({ name: r.name }));
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      name: 'Plain',
      evseCount: 2,
      availableCount: 1,
      connectors: connectors.map(({ evseId: _e, ...c }) => c),
      unitId: null,
      unitName: null,
    });
    expect(out[1]).toMatchObject({
      name: 'Units',
      unitId: 'unt_1',
      unitName: 'Box 1',
      evseCount: 1,
      availableCount: 1,
      connectors: [{ connectorType: 'Type2' }],
    });
    expect(out[2]).toMatchObject({
      unitId: null,
      evseCount: 1,
      availableCount: 0,
      connectors: [{ connectorType: 'CCS2' }],
    });
  });

  // Three stations of 8 boxes each (GitHub discussion 59) in a page of 20 rows.
  const boxStation = (uuid: string): [string, StationDriverUnits] => [
    uuid,
    {
      units: Array.from({ length: 8 }, (_, i) => ({
        id: `${uuid}_u${String(i)}`,
        name: `Box ${String(i + 1)}`,
        sortOrder: i,
      })),
      evses: Array.from({ length: 16 }, (_, i) => ({
        evseId: i + 1,
        unitId: `${uuid}_u${String(Math.floor(i / 2))}`,
        available: true,
      })),
    },
  ];
  const stationRow = (uuid: string): StationRow => ({
    stationUuid: uuid,
    evseCount: 16,
    availableCount: 16,
    connectors: [],
    name: uuid,
  });
  type StationRow = {
    stationUuid: string;
    evseCount: number;
    availableCount: number;
    connectors: typeof connectors;
    name: string;
  };

  it('returns only whole stations within the row limit, never part of a station', () => {
    const unitData = new Map([boxStation('sta_a'), boxStation('sta_b'), boxStation('sta_c')]);
    const rows = ['sta_a', 'sta_b', 'sta_c', 'sta_plain'].map(stationRow);
    const out = expandToDriverChargers(rows, unitData, (r) => ({ name: r.name }), 20);
    expect(out).toHaveLength(16);
    expect(out.filter((r) => r.name === 'sta_a')).toHaveLength(8);
    expect(out.filter((r) => r.name === 'sta_b')).toHaveLength(8);
    expect(out.some((r) => r.name === 'sta_c' || r.name === 'sta_plain')).toBe(false);
  });

  it('keeps the first station whole even when it alone passes the limit', () => {
    const unitData = new Map([boxStation('sta_a')]);
    const out = expandToDriverChargers(
      [stationRow('sta_a')],
      unitData,
      (r) => ({ name: r.name }),
      3,
    );
    expect(out).toHaveLength(8);
  });

  it('keeps a station with units but no EVSE in service as one row, like a station without units', () => {
    const unitData = new Map<string, StationDriverUnits>([
      ['sta_empty', { units: [{ id: 'unt_1', name: 'Box 1', sortOrder: 0 }], evses: [] }],
    ]);
    const out = expandToDriverChargers(
      [{ ...stationRow('sta_empty'), evseCount: 0, availableCount: 0 }],
      unitData,
      (r) => ({ name: r.name }),
    );
    expect(out).toEqual([
      {
        name: 'sta_empty',
        evseCount: 0,
        availableCount: 0,
        connectors: [],
        unitId: null,
        unitName: null,
      },
    ]);
  });
});

describe('extraUnitChargerCount', () => {
  it('counts the chargers beyond one per listed station with units', async () => {
    results.push(
      [{ id: 'sta_1' }, { id: 'sta_2' }],
      [
        { id: 'unt_1', stationId: 'sta_1', name: 'Box 1', sortOrder: 0 },
        { id: 'unt_2', stationId: 'sta_1', name: 'Box 2', sortOrder: 1 },
        { id: 'unt_3', stationId: 'sta_2', name: 'Box 1', sortOrder: 0 },
      ],
      [
        { stationId: 'sta_1', evseId: 1, unitId: 'unt_1', available: true },
        { stationId: 'sta_1', evseId: 2, unitId: 'unt_2', available: true },
        { stationId: 'sta_1', evseId: 3, unitId: null, available: true },
      ],
    );
    // sta_1: three chargers (two units and the EVSEs without one); sta_2: no EVSE, no charger.
    expect(await extraUnitChargerCount('sit_1')).toBe(2);
  });

  it('is 0 for a site without listed stations', async () => {
    results.push([]);
    expect(await extraUnitChargerCount('sit_1')).toBe(0);
  });
});

describe('locationChargers', () => {
  it('gives a station without units one charger and a station with units one per unit', async () => {
    results.push(
      [
        { id: 'unt_1', stationId: 'sta_u', name: 'Box 1', sortOrder: 0 },
        { id: 'unt_2', stationId: 'sta_u', name: 'Box 2', sortOrder: 1 },
        { id: 'unt_3', stationId: 'sta_u', name: 'Box 3', sortOrder: 2 },
      ],
      [
        { stationId: 'sta_u', evseId: 1, unitId: 'unt_1', available: true },
        { stationId: 'sta_u', evseId: 2, unitId: 'unt_1', available: true },
        { stationId: 'sta_u', evseId: 3, unitId: 'unt_2', available: true },
        // Box 3's EVSE has no connector, so the page lists no row for it.
        { stationId: 'sta_u', evseId: 4, unitId: 'unt_3', available: true },
        { stationId: 'sta_u', evseId: 5, unitId: null, available: true },
      ],
    );
    const out = await locationChargers([
      { stationUuid: 'sta_p', stationId: 'PLAIN', evseId: 1, available: true },
      { stationUuid: 'sta_u', stationId: 'EM4', evseId: 1, available: true },
      { stationUuid: 'sta_u', stationId: 'EM4', evseId: 1, available: false },
      { stationUuid: 'sta_u', stationId: 'EM4', evseId: 2, available: false },
      { stationUuid: 'sta_u', stationId: 'EM4', evseId: 3, available: false },
      { stationUuid: 'sta_u', stationId: 'EM4', evseId: 5, available: true },
    ]);
    expect(out).toEqual([
      {
        stationId: 'PLAIN',
        unitId: null,
        unitName: null,
        evseIds: [1],
        evseCount: 1,
        availableCount: 1,
      },
      {
        stationId: 'EM4',
        unitId: 'unt_1',
        unitName: 'Box 1',
        evseIds: [1, 2],
        evseCount: 2,
        availableCount: 1,
      },
      {
        stationId: 'EM4',
        unitId: 'unt_2',
        unitName: 'Box 2',
        evseIds: [3],
        evseCount: 1,
        availableCount: 0,
      },
      {
        stationId: 'EM4',
        unitId: null,
        unitName: null,
        evseIds: [5],
        evseCount: 1,
        availableCount: 1,
      },
    ]);
  });

  it('gives each station of a site without units one charger', async () => {
    results.push([]);
    expect(
      await locationChargers([
        { stationUuid: 'sta_p', stationId: 'PLAIN', evseId: 2, available: false },
        { stationUuid: 'sta_p', stationId: 'PLAIN', evseId: 1, available: true },
        { stationUuid: 'sta_q', stationId: 'OTHER', evseId: 1, available: true },
      ]),
    ).toEqual([
      {
        stationId: 'PLAIN',
        unitId: null,
        unitName: null,
        evseIds: [1, 2],
        evseCount: 2,
        availableCount: 1,
      },
      {
        stationId: 'OTHER',
        unitId: null,
        unitName: null,
        evseIds: [1],
        evseCount: 1,
        availableCount: 1,
      },
    ]);
  });
});
