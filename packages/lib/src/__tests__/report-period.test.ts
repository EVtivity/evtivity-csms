// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  REPORT_PERIODS,
  applyReportPeriod,
  isReportPeriod,
  isWeekStart,
  resolveReportPeriod,
} from '../report-period.js';

const NY = 'America/New_York';
// 06:00 in New York (EST, UTC-5) on a given day.
const nyMorning = (day: string): Date => new Date(`${day}T11:00:00Z`);

describe('resolveReportPeriod', () => {
  it.each([
    ['previousDay', '2026-11-25', { dateFrom: '2026-11-24', dateTo: '2026-11-24' }],
    ['previousWeek', '2026-11-25', { dateFrom: '2026-11-16', dateTo: '2026-11-22' }],
    ['previousMonth', '2026-12-01', { dateFrom: '2026-11-01', dateTo: '2026-11-30' }],
    ['previousQuarter', '2026-01-15', { dateFrom: '2025-10-01', dateTo: '2025-12-31' }],
    ['previousQuarter', '2026-04-01', { dateFrom: '2026-01-01', dateTo: '2026-03-31' }],
    ['previousQuarter', '2026-03-31', { dateFrom: '2025-10-01', dateTo: '2025-12-31' }],
    ['previousYear', '2027-01-01', { dateFrom: '2026-01-01', dateTo: '2026-12-31' }],
    ['currentWeekToDate', '2026-11-25', { dateFrom: '2026-11-23', dateTo: '2026-11-25' }],
    ['currentMonthToDate', '2026-12-01', { dateFrom: '2026-12-01', dateTo: '2026-12-01' }],
    ['currentYearToDate', '2026-11-25', { dateFrom: '2026-01-01', dateTo: '2026-11-25' }],
    ['last7Days', '2026-11-25', { dateFrom: '2026-11-18', dateTo: '2026-11-24' }],
    ['last30Days', '2026-11-25', { dateFrom: '2026-10-26', dateTo: '2026-11-24' }],
  ] as const)('%s on %s (Monday weeks)', (period, day, expected) => {
    expect(resolveReportPeriod(period, nyMorning(day), NY, 'monday')).toEqual(expected);
  });

  it('starts weeks on Sunday when the company says so', () => {
    expect(resolveReportPeriod('previousWeek', nyMorning('2026-11-25'), NY, 'sunday')).toEqual({
      dateFrom: '2026-11-15',
      dateTo: '2026-11-21',
    });
    expect(resolveReportPeriod('currentWeekToDate', nyMorning('2026-11-25'), NY, 'sunday')).toEqual(
      { dateFrom: '2026-11-22', dateTo: '2026-11-25' },
    );
  });

  it('covers the full week before when the run falls on the week start', () => {
    // 2026-11-23 is a Monday.
    expect(resolveReportPeriod('previousWeek', nyMorning('2026-11-23'), NY, 'monday')).toEqual({
      dateFrom: '2026-11-16',
      dateTo: '2026-11-22',
    });
    expect(resolveReportPeriod('currentWeekToDate', nyMorning('2026-11-23'), NY, 'monday')).toEqual(
      { dateFrom: '2026-11-23', dateTo: '2026-11-23' },
    );
  });

  it('uses the local date of the anchor, not the UTC date', () => {
    // 22:00 on Nov 30 in New York is Dec 1 in UTC.
    const anchor = new Date('2026-12-01T03:00:00Z');
    expect(resolveReportPeriod('previousDay', anchor, NY, 'monday')).toEqual({
      dateFrom: '2026-11-29',
      dateTo: '2026-11-29',
    });
  });

  it('resolves a zone ahead of UTC (Auckland)', () => {
    // 01:00 on Jul 1 NZST is Jun 30 13:00 UTC.
    const anchor = new Date('2026-06-30T13:00:00Z');
    expect(resolveReportPeriod('previousMonth', anchor, 'Pacific/Auckland', 'monday')).toEqual({
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
    });
  });

  it('keeps whole days across DST changes', () => {
    // US spring forward 2026-03-08, EU fall back 2026-10-25.
    expect(
      resolveReportPeriod('previousDay', new Date('2026-03-09T10:00:00Z'), NY, 'monday'),
    ).toEqual({ dateFrom: '2026-03-08', dateTo: '2026-03-08' });
    expect(
      resolveReportPeriod(
        'previousDay',
        new Date('2026-10-26T05:00:00Z'),
        'Europe/Berlin',
        'monday',
      ),
    ).toEqual({ dateFrom: '2026-10-25', dateTo: '2026-10-25' });
  });

  it('clamps to the month end, leap years included', () => {
    expect(resolveReportPeriod('previousMonth', nyMorning('2026-03-31'), NY, 'monday')).toEqual({
      dateFrom: '2026-02-01',
      dateTo: '2026-02-28',
    });
    expect(resolveReportPeriod('previousMonth', nyMorning('2028-03-01'), NY, 'monday')).toEqual({
      dateFrom: '2028-02-01',
      dateTo: '2028-02-29',
    });
  });

  it('crosses the year for a week that spans January 1', () => {
    // 2027-01-06 is a Wednesday.
    expect(resolveReportPeriod('previousWeek', nyMorning('2027-01-06'), NY, 'monday')).toEqual({
      dateFrom: '2026-12-28',
      dateTo: '2027-01-03',
    });
  });

  it('falls back to UTC for an unknown time zone', () => {
    expect(
      resolveReportPeriod('previousDay', new Date('2026-11-25T01:00:00Z'), 'Not/AZone', 'monday'),
    ).toEqual({ dateFrom: '2026-11-24', dateTo: '2026-11-24' });
  });
});

describe('scheduled runs of a to-date period', () => {
  it.each([
    ['currentWeekToDate', '2026-11-25', { dateFrom: '2026-11-23', dateTo: '2026-11-24' }],
    ['currentMonthToDate', '2026-11-25', { dateFrom: '2026-11-01', dateTo: '2026-11-24' }],
    ['currentYearToDate', '2026-11-25', { dateFrom: '2026-01-01', dateTo: '2026-11-24' }],
    // On the first day of the period it covers the whole period before.
    ['currentWeekToDate', '2026-11-23', { dateFrom: '2026-11-16', dateTo: '2026-11-22' }],
    ['currentMonthToDate', '2026-12-01', { dateFrom: '2026-11-01', dateTo: '2026-11-30' }],
    ['currentYearToDate', '2027-01-01', { dateFrom: '2026-01-01', dateTo: '2026-12-31' }],
  ] as const)('%s on %s ends yesterday', (period, day, expected) => {
    expect(resolveReportPeriod(period, nyMorning(day), NY, 'monday', { scheduled: true })).toEqual(
      expected,
    );
  });

  it('leaves the other periods as a run by hand resolves them', () => {
    for (const period of ['previousDay', 'previousMonth', 'last7Days'] as const) {
      expect(
        resolveReportPeriod(period, nyMorning('2026-12-01'), NY, 'monday', { scheduled: true }),
      ).toEqual(resolveReportPeriod(period, nyMorning('2026-12-01'), NY, 'monday'));
    }
  });

  it('applies the flag through applyReportPeriod', () => {
    expect(
      applyReportPeriod({}, 'currentMonthToDate', nyMorning('2026-11-25'), NY, 'monday', {
        scheduled: true,
      }),
    ).toEqual({ dateFrom: '2026-11-01', dateTo: '2026-11-24' });
  });
});

describe('applyReportPeriod', () => {
  it('keeps the stored filters for custom', () => {
    const filters = { dateFrom: '2026-01-01', dateTo: '2026-01-31', siteId: 'site_1' };
    expect(applyReportPeriod(filters, 'custom', nyMorning('2026-11-25'), NY, 'monday')).toBe(
      filters,
    );
  });

  it('replaces the dates and keeps the other filters', () => {
    expect(
      applyReportPeriod(
        { siteId: 'site_1' },
        'previousMonth',
        nyMorning('2026-12-01'),
        NY,
        'monday',
      ),
    ).toEqual({ siteId: 'site_1', dateFrom: '2026-11-01', dateTo: '2026-11-30' });
  });
});

describe('guards', () => {
  it('lists eleven periods with custom last', () => {
    expect(REPORT_PERIODS).toHaveLength(11);
    expect(REPORT_PERIODS.at(-1)).toBe('custom');
  });

  it('accepts only known values', () => {
    expect(isReportPeriod('previousMonth')).toBe(true);
    expect(isReportPeriod('lastMonth')).toBe(false);
    expect(isWeekStart('sunday')).toBe(true);
    expect(isWeekStart('saturday')).toBe(false);
  });
});
