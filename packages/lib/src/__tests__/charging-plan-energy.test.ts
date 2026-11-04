// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { SOC_FRESH_MINUTES, neededEnergyKwh } from '../charging-plan.js';

const READ_AT = Date.parse('2026-11-02T01:00:00Z');
const FRESH = { socMeasuredAtMs: READ_AT, nowMs: READ_AT + 60_000 };

describe('neededEnergyKwh', () => {
  it('counts a SoC without a reading time as unknown', () => {
    expect(
      neededEnergyKwh({ kind: 'soc', targetSoc: 90, soc: 40, capacityKwh: 400, deliveredKwh: 100 }),
    ).toEqual({ kwh: 260, reason: 'unknown_soc' });
    expect(
      neededEnergyKwh({
        kind: 'soc',
        targetSoc: 90,
        soc: 40,
        socMeasuredAtMs: READ_AT,
        capacityKwh: 400,
        deliveredKwh: 100,
      }),
    ).toEqual({ kwh: 260, reason: 'unknown_soc' });
  });
  it('subtracts what the session delivered from an energy target', () => {
    expect(neededEnergyKwh({ kind: 'energy', targetKwh: 200, deliveredKwh: 50 })).toEqual({
      kwh: 150,
      reason: null,
    });
  });

  it('never needs less than nothing', () => {
    expect(neededEnergyKwh({ kind: 'energy', targetKwh: 200, deliveredKwh: 250 })).toEqual({
      kwh: 0,
      reason: null,
    });
    expect(
      neededEnergyKwh({
        kind: 'soc',
        targetSoc: 80,
        soc: 95,
        ...FRESH,
        capacityKwh: 400,
        deliveredKwh: 0,
      }),
    ).toEqual({ kwh: 0, reason: null });
  });

  it('works out a SoC target from a known SoC and the battery capacity', () => {
    expect(
      neededEnergyKwh({
        kind: 'soc',
        targetSoc: 90,
        soc: 40,
        ...FRESH,
        capacityKwh: 400,
        deliveredKwh: 0,
      }),
    ).toEqual({ kwh: 200, reason: null });
  });

  it('assumes an empty battery for a SoC target without a reading', () => {
    expect(
      neededEnergyKwh({
        kind: 'soc',
        targetSoc: 90,
        soc: null,
        capacityKwh: 400,
        deliveredKwh: 100,
      }),
    ).toEqual({ kwh: 260, reason: 'unknown_soc' });
  });

  it('caps an energy target at the battery headroom when the SoC is known', () => {
    expect(
      neededEnergyKwh({
        kind: 'energy',
        targetKwh: 300,
        deliveredKwh: 0,
        soc: 80,
        ...FRESH,
        capacityKwh: 400,
      }),
    ).toEqual({ kwh: 80, reason: null });
  });

  it('counts a SoC reading older than ten minutes as unknown', () => {
    const nowMs = Date.parse('2026-11-02T02:00:00Z');
    const fresh = nowMs - SOC_FRESH_MINUTES * 60_000;
    const stale = fresh - 1;
    expect(
      neededEnergyKwh({
        kind: 'soc',
        targetSoc: 90,
        soc: 40,
        ...FRESH,
        socMeasuredAtMs: fresh,
        nowMs,
        capacityKwh: 400,
        deliveredKwh: 100,
      }),
    ).toEqual({ kwh: 200, reason: null });
    expect(
      neededEnergyKwh({
        kind: 'soc',
        targetSoc: 90,
        soc: 40,
        ...FRESH,
        socMeasuredAtMs: stale,
        nowMs,
        capacityKwh: 400,
        deliveredKwh: 100,
      }),
    ).toEqual({ kwh: 260, reason: 'unknown_soc' });
    expect(
      neededEnergyKwh({
        kind: 'energy',
        targetKwh: 300,
        deliveredKwh: 0,
        soc: 80,
        ...FRESH,
        socMeasuredAtMs: stale,
        nowMs,
        capacityKwh: 400,
      }),
    ).toEqual({ kwh: 300, reason: null });
  });

  it('does not use the battery headroom without a capacity', () => {
    expect(neededEnergyKwh({ kind: 'energy', targetKwh: 300, deliveredKwh: 0, soc: 80 })).toEqual({
      kwh: 300,
      reason: null,
    });
  });

  it('cannot work out a SoC target without the battery capacity', () => {
    expect(
      neededEnergyKwh({
        kind: 'soc',
        targetSoc: 90,
        soc: 40,
        ...FRESH,
        capacityKwh: null,
        deliveredKwh: 0,
      }),
    ).toEqual({ kwh: null, reason: 'unknown_capacity' });
    expect(
      neededEnergyKwh({
        kind: 'soc',
        targetSoc: 90,
        soc: 40,
        ...FRESH,
        capacityKwh: 0,
        deliveredKwh: 0,
      }),
    ).toEqual({ kwh: null, reason: 'unknown_capacity' });
  });

  it('keeps the result free of floating point noise', () => {
    expect(
      neededEnergyKwh({
        kind: 'soc',
        targetSoc: 90,
        soc: 70,
        ...FRESH,
        capacityKwh: 75.3,
        deliveredKwh: 0,
      }),
    ).toEqual({ kwh: 15.06, reason: null });
  });
});
