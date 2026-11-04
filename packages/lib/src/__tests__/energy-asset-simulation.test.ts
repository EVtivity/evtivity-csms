// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  clearSkyGhiWm2,
  localSolarHour,
  siteHour,
  simulatedBatteryDispatch,
  simulatedBatteryMode,
  simulatedBatteryReading,
  simulatedSolarKw,
  simulatedSolarReading,
  solarElevationDeg,
} from '../energy-asset-simulation.js';

const PV_FACTOR = (1 - 0.1408) * 0.96;

describe('solarElevationDeg (NOAA solar position)', () => {
  it('matches the noon elevation at Greenwich on the June solstice', () => {
    // 90 - 51.48 + 23.44 = 61.96 degrees.
    expect(solarElevationDeg(51.4769, 0, new Date('2026-06-21T12:00:00Z'))).toBeCloseTo(62, 0);
  });

  it('matches the winter noon elevation in Denver', () => {
    // 90 - 39.74 - 23.44 = 26.82 degrees at local solar noon (about 19:00 UTC).
    expect(solarElevationDeg(39.74, -104.99, new Date('2026-12-21T19:00:00Z'))).toBeCloseTo(
      26.8,
      0,
    );
  });

  it('puts the sun near the zenith over the equator at the March equinox', () => {
    expect(solarElevationDeg(0, 0, new Date('2026-03-20T12:07:00Z'))).toBeGreaterThan(89);
  });

  it('is below the horizon at night', () => {
    expect(solarElevationDeg(51.4769, 0, new Date('2026-06-21T00:00:00Z'))).toBeLessThan(0);
  });

  it('gives the local solar hour from UTC and the longitude', () => {
    expect(localSolarHour(0, new Date('2026-06-21T12:00:00Z'))).toBeCloseTo(12, 1);
    expect(localSolarHour(-90, new Date('2026-06-21T12:00:00Z'))).toBeCloseTo(6, 1);
    expect(localSolarHour(180, new Date('2026-06-21T23:00:00Z'))).toBeCloseTo(11, 1);
  });
});

describe('simulated solar (Haurwitz clear sky, PVWatts v5)', () => {
  it('follows the Haurwitz clear-sky irradiance', () => {
    expect(clearSkyGhiWm2(90)).toBeCloseTo(1098 * Math.exp(-0.057), 6);
    expect(clearSkyGhiWm2(30)).toBeCloseTo(1098 * 0.5 * Math.exp(-0.057 / 0.5), 6);
    expect(clearSkyGhiWm2(-5)).toBe(0);
  });

  it('applies the PVWatts losses and inverter efficiency and clips at the inverter', () => {
    const ghi = clearSkyGhiWm2(90);
    expect(simulatedSolarKw(100, 90)).toBeCloseTo((100 * ghi * PV_FACTOR) / 1000, 6);
    expect(simulatedSolarKw(100, 90, 60)).toBe(60);
    expect(simulatedSolarKw(100, -10)).toBe(0);
  });

  it('rises and falls over the day and is zero at night', () => {
    const day = (h: number): number =>
      simulatedSolarReading(100, null, 51.4769, 0, new Date(Date.UTC(2026, 5, 21, h)))?.powerKw ??
      -1;
    expect(day(0)).toBe(0);
    expect(day(8)).toBeGreaterThan(0);
    expect(day(8)).toBeLessThan(day(12));
    expect(day(16)).toBeLessThan(day(12));
    expect(day(12)).toBeCloseTo((100 * clearSkyGhiWm2(62) * PV_FACTOR) / 1000, 0);
  });

  it('needs a position and a peak rating', () => {
    const at = new Date('2026-06-21T12:00:00Z');
    expect(simulatedSolarReading(100, null, null, 0, at)).toBeNull();
    expect(simulatedSolarReading(null, null, 51, 0, at)).toBeNull();
  });
});

describe('simulated battery (time-of-use dispatch)', () => {
  const battery = {
    capacityKwh: 200,
    maxDischargeKw: 50,
    maxChargeKw: 50,
    inverterKw: 60,
    reservePercent: 10,
    gridCharging: 'possible' as const,
    dispatch: 'peak_shaving' as const,
    deficitKw: 30,
  };
  const depot = { ...battery, dispatch: 'depot' as const };
  const at = (h: number, m = 0): Date => new Date(Date.UTC(2026, 5, 21, h, m));
  const oneWay = Math.sqrt(0.85);
  // The usable 160 kWh (10 to 90 percent of 200) delivered evenly over the window.
  const peakRateKw = (160 * oneWay) / 5;
  const depotRateKw = (160 * oneWay) / 9;

  it('picks the depot dispatch for a depot site only', () => {
    expect(simulatedBatteryDispatch('depot')).toBe('depot');
    expect(simulatedBatteryDispatch('parking_lot')).toBe('peak_shaving');
    expect(simulatedBatteryDispatch('office_retail')).toBe('peak_shaving');
    expect(simulatedBatteryDispatch(null)).toBe('peak_shaving');
  });

  it('peak-shaves the evening and charges overnight and at midday at other sites', () => {
    expect(simulatedBatteryMode(17, 'possible', 'peak_shaving')).toBe('discharge');
    expect(simulatedBatteryMode(2, 'possible', 'peak_shaving')).toBe('charge');
    expect(simulatedBatteryMode(12, 'possible', 'peak_shaving')).toBe('charge');
    expect(simulatedBatteryMode(8, 'possible', 'peak_shaving')).toBe('idle');
    expect(simulatedBatteryMode(2, 'never', 'peak_shaving')).toBe('idle');
    expect(simulatedBatteryMode(12, 'never', 'peak_shaving')).toBe('charge');
  });

  it('charges at midday and discharges through the night at a depot', () => {
    expect(simulatedBatteryMode(22, 'possible', 'depot')).toBe('discharge');
    expect(simulatedBatteryMode(3, 'possible', 'depot')).toBe('discharge');
    expect(simulatedBatteryMode(9, 'possible', 'depot')).toBe('charge');
    expect(simulatedBatteryMode(10, 'never', 'depot')).toBe('charge');
    expect(simulatedBatteryMode(14, 'possible', 'depot')).toBe('idle');
    expect(simulatedBatteryMode(17, 'possible', 'depot')).toBe('idle');
    expect(simulatedBatteryMode(7, 'possible', 'depot')).toBe('idle');
  });

  it('is full by midday and offers its rating', () => {
    expect(simulatedBatteryReading(battery, 'UTC', at(12))).toEqual({
      powerKw: 0,
      availableKw: 50,
      socPercent: 90,
    });
  });

  it('spreads its usable energy over the evening peak and covers the deficit', () => {
    const reading = simulatedBatteryReading({ ...battery, deficitKw: 20 }, 'UTC', at(17));
    expect(reading?.powerKw).toBe(20);
    expect(reading?.availableKw).toBeCloseTo(peakRateKw, 6);
    // One hour of five: 32 kWh of the 160 kWh window.
    expect(reading?.socPercent).toBeCloseTo(74, 6);
    expect(simulatedBatteryReading(battery, 'UTC', at(17))?.powerKw).toBeCloseTo(peakRateKw, 6);
  });

  it('gives nothing once the peak has used its window', () => {
    const reading = simulatedBatteryReading(battery, 'UTC', at(21, 30));
    expect(reading).toMatchObject({ powerKw: 0, availableKw: 0 });
    expect(reading?.socPercent).toBeCloseTo(10, 6);
  });

  it('charges overnight at its rating, never past its window', () => {
    const reading = simulatedBatteryReading(battery, 'UTC', at(2));
    expect(reading?.powerKw).toBe(-50);
    expect(reading?.socPercent).toBeCloseTo(10 + ((2 * 50 * oneWay) / 200) * 100, 6);
    const never = simulatedBatteryReading({ ...battery, gridCharging: 'never' }, 'UTC', at(2));
    expect(never).toMatchObject({ powerKw: 0, availableKw: 0 });
  });

  it('discharges at a depot while the buses charge overnight, never charging then', () => {
    const night = simulatedBatteryReading(depot, 'UTC', at(2));
    expect(night?.powerKw).toBeCloseTo(depotRateKw, 6);
    expect(night?.availableKw).toBeCloseTo(depotRateKw, 6);
    // Five hours of nine since 21:00.
    expect(night?.socPercent).toBeCloseTo(90 - (80 * 5) / 9, 6);
    // Still above its minimum at the morning pull-out.
    expect(simulatedBatteryReading(depot, 'UTC', at(5, 30))?.socPercent).toBeGreaterThan(10);
  });

  it('charges at a depot at midday and holds its charge through the evening', () => {
    const midday = simulatedBatteryReading(depot, 'UTC', at(12));
    expect(midday?.powerKw).toBe(-50);
    expect(midday?.socPercent).toBeCloseTo(10 + ((3 * 50 * oneWay) / 200) * 100, 6);
    expect(simulatedBatteryReading(depot, 'UTC', at(17))).toEqual({
      powerKw: 0,
      availableKw: 50,
      socPercent: 90,
    });
  });

  it('keeps the asset reserve as its minimum', () => {
    const reading = simulatedBatteryReading({ ...battery, reservePercent: 40 }, 'UTC', at(21, 30));
    expect(reading?.socPercent).toBeCloseTo(40, 6);
  });

  it('follows the site time zone', () => {
    // 17:00 UTC is 10:00 in Los Angeles (PDT): a charge window there.
    expect(siteHour('America/Los_Angeles', at(17))).toBe(10);
    expect(
      simulatedBatteryReading(battery, 'America/Los_Angeles', at(17))?.powerKw,
    ).toBeLessThanOrEqual(0);
  });

  it('needs a capacity and a known time zone', () => {
    expect(simulatedBatteryReading({ ...battery, capacityKwh: null }, 'UTC', at(12))).toBeNull();
    expect(simulatedBatteryReading(battery, 'Mars/Base', at(12))).toBeNull();
    expect(simulatedBatteryReading(battery, null, at(12))).toBeNull();
  });
});
