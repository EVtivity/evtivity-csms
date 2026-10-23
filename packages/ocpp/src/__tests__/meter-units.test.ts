// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  applyMultiplier,
  energyRegisterWh,
  energyToWh,
  isFlatEnergyReading,
  overallValue,
  powerToW,
  readingSummary,
  socPercent,
} from '../server/meter-units.js';

describe('energyRegisterWh', () => {
  const mv = (sampledValue: Array<Record<string, unknown>>) => ({
    timestamp: '2026-01-01T00:00:00Z',
    sampledValue,
  });

  it('reads a sample without measurand as the energy register', () => {
    expect(energyRegisterWh([mv([{ value: 15000, context: 'Transaction.End' }])])).toBe(15000);
  });

  it('applies the multiplier and converts kWh', () => {
    expect(
      energyRegisterWh([
        mv([
          {
            value: 15,
            measurand: 'Energy.Active.Import.Register',
            unitOfMeasure: { unit: 'kWh', multiplier: 0 },
          },
        ]),
      ]),
    ).toBe(15000);
    expect(
      energyRegisterWh([mv([{ value: 15, unitOfMeasure: { unit: 'Wh', multiplier: 3 } }])]),
    ).toBe(15000);
  });

  it('ignores other measurands, Inlet samples, and unsupported units', () => {
    expect(
      energyRegisterWh([
        mv([
          { value: 7000, measurand: 'Power.Active.Import' },
          { value: 9000, location: 'Inlet' },
          { value: 9000, unitOfMeasure: { unit: 'varh' } },
        ]),
      ]),
    ).toBeNull();
  });

  it('sums per-phase samples and returns the highest reading', () => {
    expect(
      energyRegisterWh([
        mv([{ value: 1000 }]),
        mv([
          { value: 2000, phase: 'L1' },
          { value: 2500, phase: 'L2' },
        ]),
      ]),
    ).toBe(4500);
  });

  it('returns null without meter values', () => {
    expect(energyRegisterWh(undefined)).toBeNull();
    expect(energyRegisterWh([])).toBeNull();
  });
});

describe('applyMultiplier', () => {
  it('scales by a power of ten', () => {
    expect(applyMultiplier(12, 0)).toBe(12);
    expect(applyMultiplier(12, 3)).toBe(12000);
    expect(applyMultiplier(1234, -3)).toBe(1.234);
  });
});

describe('energyToWh', () => {
  it('treats a missing unit and Wh as Wh', () => {
    expect(energyToWh(2908247, null)).toBe(2908247);
    expect(energyToWh(2908247, 'Wh')).toBe(2908247);
  });

  it('converts kWh to Wh without float noise', () => {
    expect(energyToWh(2908.247, 'kWh')).toBe(2908247);
    expect(energyToWh(0.1, 'kWh')).toBe(100);
  });

  it('rejects non-energy units and non-numeric values', () => {
    expect(energyToWh(11, 'kW')).toBeNull();
    expect(energyToWh(Number('abc'), 'Wh')).toBeNull();
  });
});

describe('overallValue', () => {
  it('uses the sample without a phase when there is one', () => {
    expect(
      overallValue([
        { value: 100, phase: 'L1' },
        { value: 300, phase: null },
        { value: 100, phase: 'L2' },
      ]),
    ).toBe(300);
  });

  it('sums the lines when only per-phase samples exist', () => {
    expect(
      overallValue([
        { value: 100.1, phase: 'L1' },
        { value: 100.2, phase: 'L2-N' },
        { value: 100.3, phase: 'L3' },
      ]),
    ).toBe(300.6);
  });

  it('uses a single line as the total for a single-phase station', () => {
    expect(overallValue([{ value: 42, phase: 'L1' }])).toBe(42);
  });

  it('ignores line-to-line and neutral samples', () => {
    expect(
      overallValue([
        { value: 400, phase: 'L1-L2' },
        { value: 1, phase: 'N' },
      ]),
    ).toBeNull();
  });

  it('returns null when a line appears twice', () => {
    expect(
      overallValue([
        { value: 1, phase: 'L1' },
        { value: 1, phase: 'L1-N' },
      ]),
    ).toBeNull();
  });

  it('returns null for no samples', () => {
    expect(overallValue([])).toBeNull();
  });
});

// Finding J3: a clock-aligned or TxEnded sample sent 0.3 to 1.4 s after a
// periodic one shows almost no new energy. That is no proof the EV stopped
// drawing power, so it must not open an idle period.
describe('isFlatEnergyReading', () => {
  const lastRise = new Date('2026-10-08T10:00:00.000Z');

  it('is not flat for a reading moments after the last rise', () => {
    expect(
      isFlatEnergyReading({
        previousEnergyWh: 5000,
        energyWh: 5000.4,
        lastRiseAt: lastRise,
        readingAt: new Date('2026-10-08T10:00:00.400Z'),
      }),
    ).toBe(false);
    expect(
      isFlatEnergyReading({
        previousEnergyWh: 5000,
        energyWh: 5000,
        lastRiseAt: lastRise,
        readingAt: new Date('2026-10-08T10:00:01.400Z'),
      }),
    ).toBe(false);
  });

  it('is flat when the energy did not rise for a full sample interval', () => {
    expect(
      isFlatEnergyReading({
        previousEnergyWh: 5000,
        energyWh: 5000,
        lastRiseAt: lastRise,
        readingAt: new Date('2026-10-08T10:01:00.000Z'),
      }),
    ).toBe(true);
    expect(
      isFlatEnergyReading({
        previousEnergyWh: 5000,
        energyWh: 5000.5,
        lastRiseAt: lastRise,
        readingAt: new Date('2026-10-08T10:00:30.000Z'),
      }),
    ).toBe(true);
  });

  it('is not flat when the energy rose', () => {
    expect(
      isFlatEnergyReading({
        previousEnergyWh: 5000,
        energyWh: 5001,
        lastRiseAt: lastRise,
        readingAt: new Date('2026-10-08T10:05:00.000Z'),
      }),
    ).toBe(false);
  });

  it('is not flat for an unparsable reading time', () => {
    expect(
      isFlatEnergyReading({
        previousEnergyWh: 5000,
        energyWh: 5000,
        lastRiseAt: lastRise,
        readingAt: new Date('not a date'),
      }),
    ).toBe(false);
  });
});

describe('powerToW', () => {
  it('reads W and a missing unit as W', () => {
    expect(powerToW(7400, 'W')).toBe(7400);
    expect(powerToW(7400, null)).toBe(7400);
  });

  it('converts kW to W', () => {
    expect(powerToW(7.4, 'kW')).toBe(7400);
  });

  it('refuses another unit and a non-number', () => {
    expect(powerToW(7400, 'A')).toBeNull();
    expect(powerToW(Number.NaN, 'W')).toBeNull();
  });
});

describe('socPercent', () => {
  it('reads Percent and a missing unit', () => {
    expect(socPercent(80, 'Percent')).toBe(80);
    expect(socPercent(55.5, null)).toBe(55.5);
  });

  it('refuses a value out of range, a non-number or another unit', () => {
    expect(socPercent(101, 'Percent')).toBeNull();
    expect(socPercent(-1, null)).toBeNull();
    expect(socPercent(Number.NaN, null)).toBeNull();
    expect(socPercent(80, 'Wh')).toBeNull();
  });
});

describe('readingSummary', () => {
  it('reads OCPP 2.1 power with unitOfMeasure and multiplier', () => {
    expect(
      readingSummary([
        { measurand: 'Power.Active.Import', value: 11, unitOfMeasure: { unit: 'kW' } },
      ]),
    ).toEqual({ powerW: 11000, socPercent: null });
    expect(
      readingSummary([
        {
          measurand: 'Power.Active.Import',
          value: 22,
          unitOfMeasure: { unit: 'W', multiplier: 3 },
        },
      ]),
    ).toEqual({ powerW: 22000, socPercent: null });
  });

  it('reads OCPP 1.6 power with the unit field and a string value', () => {
    expect(
      readingSummary([{ measurand: 'Power.Active.Import', value: '7.2', unit: 'kW' }]),
    ).toEqual({ powerW: 7200, socPercent: null });
  });

  it('sums the lines when there is no overall value, and ignores Inlet', () => {
    expect(
      readingSummary([
        { measurand: 'Power.Active.Import', value: 3000, phase: 'L1', unit: 'W' },
        { measurand: 'Power.Active.Import', value: 3, phase: 'L2-N', unit: 'kW' },
        { measurand: 'Power.Active.Import', value: 3000, phase: 'L3', unit: 'W' },
        { measurand: 'Power.Active.Import', value: 50000, location: 'Inlet', unit: 'W' },
      ]),
    ).toEqual({ powerW: 9000, socPercent: null });
  });

  it('prefers the overall value over the lines', () => {
    expect(
      readingSummary([
        { measurand: 'Power.Active.Import', value: 3000, phase: 'L1', unit: 'W' },
        { measurand: 'Power.Active.Import', value: 6500, unit: 'W' },
      ]),
    ).toEqual({ powerW: 6500, socPercent: null });
  });

  it('skips power in an unsupported unit and a reading without samples', () => {
    expect(readingSummary([{ measurand: 'Power.Active.Import', value: 32, unit: 'A' }])).toEqual({
      powerW: null,
      socPercent: null,
    });
    expect(readingSummary(undefined)).toEqual({ powerW: null, socPercent: null });
  });

  it('reads SoC at the EV location', () => {
    expect(
      readingSummary([
        { measurand: 'SoC', value: 64, location: 'EV', unitOfMeasure: { unit: 'Percent' } },
        { measurand: 'Energy.Active.Import.Register', value: 1000 },
      ]),
    ).toEqual({ powerW: null, socPercent: 64 });
  });
});
