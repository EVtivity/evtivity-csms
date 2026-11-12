// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { groupEvsesByUnit, unitStatus, type StationUnit } from '../station-units';

// GitHub discussion 59: one OCPP 1.6 station, 8 boxes of 2 AC EVSEs.
const UNITS: StationUnit[] = Array.from({ length: 8 }, (_, i) => ({
  id: `unt_box${String(i + 1)}`,
  stationId: 'sta_1',
  name: `Box ${String(i + 1)}`,
  sortOrder: i,
  evseIds: [],
  evseNumbers: [i * 2 + 1, i * 2 + 2],
}));
const EVSES = Array.from({ length: 16 }, (_, i) => ({
  evseId: i + 1,
  unitId: `unt_box${String(Math.floor(i / 2) + 1)}`,
}));

describe('groupEvsesByUnit', () => {
  it('keeps every EVSE of a station without units in the plain list', () => {
    const plain = EVSES.map((e) => ({ evseId: e.evseId, unitId: null }));
    expect(groupEvsesByUnit(plain, [])).toEqual({ units: [], unassigned: plain });
  });

  it('groups the 16 EVSEs into the 8 boxes in order', () => {
    const grouped = groupEvsesByUnit(EVSES, [...UNITS].reverse());
    expect(grouped.units.map((g) => g.unit.name)).toEqual(UNITS.map((u) => u.name));
    expect(grouped.units[0]?.evses.map((e) => e.evseId)).toEqual([1, 2]);
    expect(grouped.unassigned).toEqual([]);
  });

  it('lists EVSEs without a unit, or of a unit no longer listed, last', () => {
    const evses = [
      { evseId: 1, unitId: 'unt_box1' },
      { evseId: 2, unitId: null },
      { evseId: 3, unitId: 'unt_gone' },
    ];
    const grouped = groupEvsesByUnit(evses, UNITS.slice(0, 1));
    expect(grouped.unassigned.map((e) => e.evseId)).toEqual([2, 3]);
  });
});

describe('unitStatus', () => {
  const ok = { status: 'available', statusReason: null };

  it('shows the station state on every unit while a station-level state holds', () => {
    const disabled = { status: 'unavailable', statusReason: 'operator_disabled' };
    expect(unitStatus(['available', 'available'], disabled)).toBe('unavailable');
    const installing = { status: 'unavailable', statusReason: 'firmware_installing' };
    expect(unitStatus(['charging'], installing)).toBe('unavailable');
  });

  it('summarises the plugs of the unit with the station rule', () => {
    expect(unitStatus(['available', 'charging'], ok)).toBe('charging');
    expect(unitStatus(['available', 'reserved'], ok)).toBe('reserved');
    expect(unitStatus(['available', 'faulted'], ok)).toBe('faulted');
    expect(unitStatus([], ok)).toBe('unknown');
    expect(unitStatus(['available', 'available'], ok)).toBe('available');
    expect(unitStatus(['available', 'unavailable'], ok)).toBe('unavailable');
  });

  it('keeps a connector fault of another unit out of this unit', () => {
    const otherFaulted = { status: 'faulted', statusReason: 'connector_faulted' };
    expect(unitStatus(['available', 'available'], otherFaulted)).toBe('available');
  });
});
