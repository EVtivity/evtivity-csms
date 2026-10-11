// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';

import {
  resolveElectricityRate,
  calculateElectricityCostCents,
  deriveElectricityRatePriority,
  computeSessionElectricityCost,
  type ElectricityRatePeriod,
  type ElectricityRatePeriodRestrictions,
} from '../electricity-rate.js';

function period(
  overrides: Partial<ElectricityRatePeriod> & {
    restrictions: ElectricityRatePeriodRestrictions | null;
  },
): ElectricityRatePeriod {
  return {
    id: 1,
    siteId: 'sit_test',
    name: 'rate',
    ratePerKwh: '0.10',
    priority: deriveElectricityRatePriority(overrides.restrictions),
    isDefault: overrides.restrictions == null,
    ...overrides,
  };
}

const TZ = 'UTC';
// 2026-06-08 is a Monday.
const mondayNoon = new Date('2026-06-08T12:00:00Z');
const mondayEvening = new Date('2026-06-08T20:00:00Z');
const mondayLateNight = new Date('2026-06-08T23:00:00Z');

describe('resolveElectricityRate', () => {
  it('returns null when there are no periods', () => {
    expect(resolveElectricityRate([], mondayNoon, TZ)).toBeNull();
  });

  it('falls back to the default flat-rate period', () => {
    const def = period({ id: 1, name: 'flat', ratePerKwh: '0.11', restrictions: null });
    expect(resolveElectricityRate([def], mondayNoon, TZ)?.name).toBe('flat');
  });

  it('selects the peak period during peak hours', () => {
    const def = period({ id: 1, name: 'flat', restrictions: null });
    const peak = period({
      id: 2,
      name: 'peak',
      ratePerKwh: '0.30',
      restrictions: { timeRange: { startTime: '09:00', endTime: '17:00' } },
    });
    expect(resolveElectricityRate([def, peak], mondayNoon, TZ)?.name).toBe('peak');
  });

  it('falls back to default outside peak hours', () => {
    const def = period({ id: 1, name: 'flat', restrictions: null });
    const peak = period({
      id: 2,
      name: 'peak',
      restrictions: { timeRange: { startTime: '09:00', endTime: '17:00' } },
    });
    expect(resolveElectricityRate([def, peak], mondayEvening, TZ)?.name).toBe('flat');
  });

  it('matches a daysOfWeek + timeRange period on the right day', () => {
    const def = period({ id: 1, name: 'flat', restrictions: null });
    const weekday = period({
      id: 2,
      name: 'weekday-peak',
      restrictions: {
        timeRange: { startTime: '08:00', endTime: '18:00' },
        daysOfWeek: [1, 2, 3, 4, 5],
      },
    });
    expect(resolveElectricityRate([def, weekday], mondayNoon, TZ)?.name).toBe('weekday-peak');
  });

  it('skips a daysOfWeek period on the wrong day', () => {
    const def = period({ id: 1, name: 'flat', restrictions: null });
    const weekend = period({
      id: 2,
      name: 'weekend',
      restrictions: { timeRange: { startTime: '08:00', endTime: '18:00' }, daysOfWeek: [0, 6] },
    });
    expect(resolveElectricityRate([def, weekend], mondayNoon, TZ)?.name).toBe('flat');
  });

  it('orders by priority so the more specific period wins', () => {
    const def = period({ id: 1, name: 'flat', restrictions: null }); // priority 0
    const peak = period({
      id: 2,
      name: 'peak',
      restrictions: { timeRange: { startTime: '00:00', endTime: '23:00' } }, // priority 10
    });
    const resolved = resolveElectricityRate([peak, def], mondayNoon, TZ);
    expect(resolved?.priority).toBe(10);
    expect(resolved?.name).toBe('peak');
  });

  it('handles a midnight-crossing time range', () => {
    const night = period({
      id: 1,
      name: 'night',
      restrictions: { timeRange: { startTime: '22:00', endTime: '06:00' } },
    });
    expect(resolveElectricityRate([night], mondayLateNight, TZ)?.name).toBe('night');
    expect(resolveElectricityRate([night], mondayNoon, TZ)).toBeNull();
  });
});

describe('deriveElectricityRatePriority', () => {
  it('maps restriction shape to priority', () => {
    expect(deriveElectricityRatePriority(null)).toBe(0);
    expect(
      deriveElectricityRatePriority({ timeRange: { startTime: '09:00', endTime: '17:00' } }),
    ).toBe(10);
    expect(
      deriveElectricityRatePriority({
        timeRange: { startTime: '09:00', endTime: '17:00' },
        daysOfWeek: [1],
      }),
    ).toBe(20);
    expect(
      deriveElectricityRatePriority({ dateRange: { startDate: '06-01', endDate: '09-30' } }),
    ).toBe(30);
  });
});

describe('calculateElectricityCostCents', () => {
  it('computes 10 kWh at $0.12/kWh as 120 cents', () => {
    expect(calculateElectricityCostCents(10000, '0.12')).toBe(120);
  });

  it('rounds to the nearest cent', () => {
    // 1234 Wh = 1.234 kWh * $0.10 = $0.1234 -> 12.34 cents -> 12
    expect(calculateElectricityCostCents(1234, '0.10')).toBe(12);
    // 1.5 kWh * $0.077 = $0.1155 -> 11.55 cents -> 12
    expect(calculateElectricityCostCents(1500, '0.077')).toBe(12);
  });

  it('returns 0 for zero energy', () => {
    expect(calculateElectricityCostCents(0, '0.30')).toBe(0);
  });

  it('handles fractional kWh and sub-dollar rates', () => {
    expect(calculateElectricityCostCents(500, '0.20')).toBe(10);
  });
});

describe('computeSessionElectricityCost', () => {
  // The seeded shape: a flat Standard default and a weekday evening peak.
  const standard = period({ id: 1, name: 'Standard', ratePerKwh: '0.12', restrictions: null });
  const peak = period({
    id: 2,
    name: 'Weekday Peak',
    ratePerKwh: '0.22',
    restrictions: {
      timeRange: { startTime: '16:00', endTime: '21:00' },
      daysOfWeek: [1, 2, 3, 4, 5],
    },
  });
  const periods = [standard, peak];

  it('prices the session at the period in force at its end', () => {
    const result = computeSessionElectricityCost({
      periods,
      endedAt: mondayEvening,
      energyWh: 10_000,
      timezone: TZ,
    });
    expect(result).toEqual({ costCents: 220, period: peak });
  });

  it('uses the end, not the start, for a session that crosses a peak boundary', () => {
    // Started Monday 15:30 at the standard rate, ended 16:30 in the peak.
    const peakEnd = computeSessionElectricityCost({
      periods,
      endedAt: new Date('2026-06-08T16:30:00Z'),
      energyWh: 10_000,
      timezone: TZ,
    });
    expect(peakEnd.costCents).toBe(220);
    // Started 20:30 in the peak, ended 21:30 at the standard rate.
    const standardEnd = computeSessionElectricityCost({
      periods,
      endedAt: new Date('2026-06-08T21:30:00Z'),
      energyWh: 10_000,
      timezone: TZ,
    });
    expect(standardEnd.costCents).toBe(120);
  });

  it('resolves the period in the site timezone', () => {
    // 22:00 UTC on a Monday is 17:00 in America/Chicago (CDT), inside the peak.
    const at = new Date('2026-06-08T22:00:00Z');
    expect(
      computeSessionElectricityCost({ periods, endedAt: at, energyWh: 10_000, timezone: 'UTC' })
        .costCents,
    ).toBe(120);
    expect(
      computeSessionElectricityCost({
        periods,
        endedAt: at,
        energyWh: 10_000,
        timezone: 'America/Chicago',
      }).costCents,
    ).toBe(220);
  });

  it('matches resolveElectricityRate and calculateElectricityCostCents', () => {
    const at = new Date('2026-06-10T18:45:00Z');
    const rate = resolveElectricityRate(periods, at, TZ);
    expect(rate).not.toBeNull();
    expect(
      computeSessionElectricityCost({ periods, endedAt: at, energyWh: 1234, timezone: TZ })
        .costCents,
    ).toBe(calculateElectricityCostCents(1234, rate?.ratePerKwh ?? '0'));
  });

  it('returns the reason when no cost applies', () => {
    expect(
      computeSessionElectricityCost({ periods: [], endedAt: mondayNoon, energyWh: 10_000 }),
    ).toEqual({ costCents: null, reason: 'no_periods' });
    expect(
      computeSessionElectricityCost({
        periods: [peak],
        endedAt: mondayNoon,
        energyWh: 10_000,
        timezone: TZ,
      }),
    ).toEqual({ costCents: null, reason: 'no_matching_period' });
    expect(
      computeSessionElectricityCost({ periods, endedAt: mondayNoon, energyWh: 0, timezone: TZ }),
    ).toEqual({ costCents: null, reason: 'zero_energy' });
  });
});
