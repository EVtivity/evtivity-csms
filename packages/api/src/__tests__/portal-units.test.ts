// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({}));

import { driverChargers, type DriverEvse } from '../lib/portal-units.js';

// GitHub discussion 59: one OCPP 1.6 station, 8 boxes of 2 AC EVSEs.
const UNITS = Array.from({ length: 8 }, (_, i) => ({
  id: `unt_box${String(i + 1)}`,
  name: `Box ${String(i + 1)}`,
  sortOrder: i,
}));
const EVSES: DriverEvse[] = Array.from({ length: 16 }, (_, i) => ({
  evseId: i + 1,
  unitId: `unt_box${String(Math.floor(i / 2) + 1)}`,
  available: i % 3 !== 0,
}));

describe('driverChargers', () => {
  it('answers null for a station without units, so its views stay as they are', () => {
    expect(
      driverChargers(
        EVSES.map((e) => ({ ...e, unitId: null })),
        [],
      ),
    ).toBeNull();
  });

  it('gives each box of a master with extenders its own charger, in order', () => {
    const chargers = driverChargers(EVSES, [...UNITS].reverse());
    expect(chargers?.map((c) => c.unitName)).toEqual(UNITS.map((u) => u.name));
    expect(chargers?.[0]).toEqual({
      unitId: 'unt_box1',
      unitName: 'Box 1',
      evseIds: [1, 2],
      evseCount: 2,
      availableCount: 1,
    });
    expect(chargers?.reduce((n, c) => n + c.evseCount, 0)).toBe(16);
  });

  it('adds one charger for the EVSEs without a unit and leaves out a unit with none in service', () => {
    const evses: DriverEvse[] = [
      { evseId: 1, unitId: 'unt_box1', available: true },
      { evseId: 3, unitId: null, available: false },
      { evseId: 4, unitId: 'unt_gone', available: true },
    ];
    const chargers = driverChargers(evses, UNITS.slice(0, 2));
    expect(chargers).toEqual([
      { unitId: 'unt_box1', unitName: 'Box 1', evseIds: [1], evseCount: 1, availableCount: 1 },
      { unitId: null, unitName: null, evseIds: [3, 4], evseCount: 2, availableCount: 1 },
    ]);
  });

  it('counts nothing available while the station is closed to drivers (every EVSE unavailable)', () => {
    const closed = EVSES.map((e) => ({ ...e, available: false }));
    expect(driverChargers(closed, UNITS)?.every((c) => c.availableCount === 0)).toBe(true);
  });
});
