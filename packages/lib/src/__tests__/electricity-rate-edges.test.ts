// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  deriveElectricityRatePriority,
  electricityRateRestrictionsSchema,
  resolveElectricityRate,
  type ElectricityRatePeriod,
} from '../electricity-rate.js';
import { zonedMidnight } from '../timezone.js';

function period(
  id: number,
  restrictions: ElectricityRatePeriod['restrictions'],
): ElectricityRatePeriod {
  return {
    id,
    siteId: 'sit_1',
    name: `p${String(id)}`,
    ratePerKwh: '0.20',
    restrictions,
    priority: deriveElectricityRatePriority(restrictions),
    isDefault: restrictions == null,
  };
}

describe('electricity rate restrictions', () => {
  it('refuses equal times, duplicate days, days without a time range and a combined date range', () => {
    const problems = (value: unknown) =>
      electricityRateRestrictionsSchema.safeParse(value).error?.issues.map((i) => i.message) ?? [];
    expect(problems({ timeRange: { startTime: '08:00', endTime: '08:00' } })).toContain(
      'startTime and endTime must differ',
    );
    expect(
      problems({ timeRange: { startTime: '08:00', endTime: '09:00' }, daysOfWeek: [1, 1] }),
    ).toContain('daysOfWeek must not contain duplicates');
    expect(problems({ daysOfWeek: [1] })).toContain('daysOfWeek requires timeRange.');
    expect(
      problems({
        dateRange: { startDate: '06-01', endDate: '08-31' },
        timeRange: { startTime: '08:00', endTime: '09:00' },
      }),
    ).toContain('dateRange must stand alone.');
    expect(problems({ dateRange: { startDate: '06-01', endDate: '08-31' } })).toEqual([]);
  });

  it('ranks date ranges over day and time, time over the flat rate', () => {
    expect(deriveElectricityRatePriority({ daysOfWeek: [1] })).toBe(0);
    expect(deriveElectricityRatePriority({})).toBe(0);
  });
});

describe('resolveElectricityRate', () => {
  // Wednesday 2026-07-15, 10:00 UTC.
  const at = new Date('2026-07-15T10:00:00Z');

  it('takes a matching date range first, then day and time, then the flat rate', () => {
    const summer = period(1, { dateRange: { startDate: '06-01', endDate: '08-31' } });
    const weekdayPeak = period(2, {
      daysOfWeek: [3],
      timeRange: { startTime: '09:00', endTime: '11:00' },
    });
    const flat = period(3, null);
    expect(resolveElectricityRate([flat, weekdayPeak, summer], at, 'UTC')?.id).toBe(1);
    expect(resolveElectricityRate([flat, weekdayPeak], at, 'UTC')?.id).toBe(2);
    const weekendPeak = period(4, {
      daysOfWeek: [0, 6],
      timeRange: { startTime: '09:00', endTime: '11:00' },
    });
    expect(resolveElectricityRate([flat, weekendPeak], at, 'UTC')?.id).toBe(3);
  });

  it('matches no period of an empty restriction object', () => {
    expect(resolveElectricityRate([period(5, {})], at, 'UTC')).toBeNull();
  });
});

describe('zonedMidnight', () => {
  it('lands on local midnight, also on a day that starts after a DST change', () => {
    expect(zonedMidnight(2026, 7, 15, 'Europe/Berlin').toISOString()).toBe(
      '2026-07-14T22:00:00.000Z',
    );
    expect(zonedMidnight(2026, 3, 30, 'Europe/Berlin').toISOString()).toBe(
      '2026-03-29T22:00:00.000Z',
    );
  });
});
