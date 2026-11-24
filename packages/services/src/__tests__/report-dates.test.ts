// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { reportDay, reportDayBounds, reportFileName } from '../report-generators/report-dates.js';

describe('reportDayBounds', () => {
  it('starts and ends days at company midnight', () => {
    expect(reportDayBounds('2026-11-01', '2026-11-30', 'America/New_York')).toEqual({
      from: new Date('2026-11-01T04:00:00Z'), // EDT until Nov 1 02:00
      until: new Date('2026-12-01T05:00:00Z'), // EST
    });
  });
  it('spans a 23 hour spring-forward day', () => {
    const { from, until } = reportDayBounds('2026-03-08', '2026-03-08', 'America/New_York');
    expect((until!.getTime() - from!.getTime()) / 3_600_000).toBe(23);
  });
  it('spans a 25 hour fall-back day', () => {
    const { from, until } = reportDayBounds('2026-10-25', '2026-10-25', 'Europe/Berlin');
    expect((until!.getTime() - from!.getTime()) / 3_600_000).toBe(25);
  });
  it('leaves an open side null', () => {
    expect(reportDayBounds(undefined, undefined, 'UTC')).toEqual({ from: null, until: null });
  });
});

describe('reportDay', () => {
  it('accepts only real YYYY-MM-DD days', () => {
    expect(reportDay('2026-02-28')).toBe('2026-02-28');
    expect(reportDay('2026-02-30')).toBeUndefined();
    expect(reportDay('2026-02-28T00:00:00Z')).toBeUndefined();
    expect(reportDay(7)).toBeUndefined();
  });
});

describe('reportFileName', () => {
  it('names the covered days', () => {
    expect(reportFileName('energy-report', '2026-11-01', '2026-11-30', 'csv')).toBe(
      'energy-report-2026-11-01-to-2026-11-30.csv',
    );
    expect(reportFileName('energy-report', '2026-11-01', undefined, 'pdf')).toBe(
      'energy-report-from-2026-11-01.pdf',
    );
    expect(reportFileName('energy-report', undefined, '2026-11-30', 'pdf')).toBe(
      'energy-report-until-2026-11-30.pdf',
    );
    expect(reportFileName('energy-report', undefined, undefined, 'xlsx')).toMatch(
      /^energy-report-\d+\.xlsx$/,
    );
  });
});
