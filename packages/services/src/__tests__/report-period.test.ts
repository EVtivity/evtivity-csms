// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTz = vi.fn<() => Promise<string>>();
const mockWeekStart = vi.fn<() => Promise<'monday' | 'sunday'>>();
vi.mock('@evtivity/database', () => ({
  getSystemTimezone: () => mockTz(),
  getCompanyWeekStart: () => mockWeekStart(),
}));

import { reportFiltersForPeriod, reportPeriodError, reportPeriodText } from '../report-period.js';
import { reportLocale } from '../report-generators/report-locale.js';

describe('reportFiltersForPeriod', () => {
  beforeEach(() => {
    mockTz.mockResolvedValue('America/New_York');
    mockWeekStart.mockResolvedValue('sunday');
  });
  it('resolves with the company time zone and week start', async () => {
    expect(
      await reportFiltersForPeriod(
        'previousWeek',
        { siteId: 's' },
        new Date('2026-11-25T11:00:00Z'),
      ),
    ).toEqual({ siteId: 's', dateFrom: '2026-11-15', dateTo: '2026-11-21' });
  });
  it('ends a scheduled to-date period yesterday', async () => {
    expect(
      await reportFiltersForPeriod('currentMonthToDate', {}, new Date('2026-11-25T11:00:00Z'), {
        scheduled: true,
      }),
    ).toEqual({ dateFrom: '2026-11-01', dateTo: '2026-11-24' });
    expect(
      await reportFiltersForPeriod('currentMonthToDate', {}, new Date('2026-11-25T11:00:00Z')),
    ).toEqual({ dateFrom: '2026-11-01', dateTo: '2026-11-25' });
  });
  it('reads no setting for custom', async () => {
    await reportFiltersForPeriod('custom', {}, new Date());
    expect(mockTz).not.toHaveBeenCalled();
  });
});

describe('reportPeriodError', () => {
  it('refuses fixed dates with a relative period', () => {
    expect(reportPeriodError('energy', 'previousMonth', { dateFrom: '2026-01-01' })).toBe(
      'dateFrom and dateTo apply only to the custom report period',
    );
  });
  it('refuses a relative period for NEVI', () => {
    expect(reportPeriodError('nevi', 'previousQuarter', { quarter: 1, year: 2026 })).toBe(
      'NEVI reports take quarter and year, not a report period',
    );
  });
  it('accepts custom with dates and relative without', () => {
    expect(reportPeriodError('energy', 'custom', { dateFrom: '2026-01-01' })).toBeNull();
    expect(reportPeriodError('energy', 'last7Days', { siteId: 's' })).toBeNull();
  });
});

describe('reportPeriodText', () => {
  const nov = { dateFrom: '2026-11-01', dateTo: '2026-11-30' };
  it('names a relative period with its dates in the recipient language', () => {
    const en = reportLocale('en', 'pdf');
    const de = reportLocale('de', 'pdf');
    expect(reportPeriodText('en', 'previousMonth', nov)).toBe(
      `Previous month (${en.date('2026-11-01')} to ${en.date('2026-11-30')})`,
    );
    expect(reportPeriodText('de', 'previousMonth', nov)).toBe(
      `Vormonat (${de.range('2026-11-01', '2026-11-30', '')})`,
    );
  });
  it('names a custom range and all time', () => {
    const en = reportLocale('en', 'pdf');
    expect(reportPeriodText('en', 'custom', nov)).toBe(en.range('2026-11-01', '2026-11-30', ''));
    expect(reportPeriodText('en', 'custom', {})).toBe('All time');
  });
});
