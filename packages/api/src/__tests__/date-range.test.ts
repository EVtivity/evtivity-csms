// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { ValidationError } from '@evtivity/lib';
import {
  addCalendarDays,
  calendarDateIn,
  calendarDayBounds,
  fillDates,
  parseDateRange,
  resolveCalendarRange,
} from '../lib/date-range.js';

describe('resolveCalendarRange', () => {
  // 2026-10-14 01:30 in Tokyo is still 2026-10-13 in UTC.
  const tokyoMorning = new Date('2026-10-13T16:30:00.000Z');

  it('takes from and to as calendar dates in the timezone, the end exclusive', () => {
    const range = resolveCalendarRange(
      { from: '2026-10-01', to: '2026-10-03' },
      'Asia/Tokyo',
      tokyoMorning,
    );
    // Midnight in Tokyo (UTC+9), not UTC midnight.
    expect(range.since.toISOString()).toBe('2026-09-30T15:00:00.000Z');
    expect(range.until.toISOString()).toBe('2026-10-03T15:00:00.000Z');
    expect(range.periodEnd).toEqual(range.until);
    expect(range.dates).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
  });

  it('counts days back from today in the timezone, through now', () => {
    const range = resolveCalendarRange({ days: '2' }, 'Asia/Tokyo', tokyoMorning);
    // Today in Tokyo is 2026-10-14 although UTC is still on the 13th.
    expect(range.dates).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
    expect(range.since.toISOString()).toBe('2026-10-11T15:00:00.000Z');
    expect(range.until.toISOString()).toBe('2026-10-14T15:00:00.000Z');
    expect(range.periodEnd).toEqual(tokyoMorning);
  });

  it('defaults to 7 days and counts above 90 as 90', () => {
    expect(resolveCalendarRange({}, 'UTC', tokyoMorning).dates).toHaveLength(8);
    expect(resolveCalendarRange({ days: '500' }, 'UTC', tokyoMorning).dates).toHaveLength(91);
  });

  it('keeps a day that crosses a daylight saving change whole', () => {
    // New York leaves daylight saving time on 2026-11-01 (25-hour day).
    const range = resolveCalendarRange(
      { from: '2026-11-01', to: '2026-11-01' },
      'America/New_York',
      new Date('2026-11-05T12:00:00.000Z'),
    );
    expect(range.since.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(range.until.toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  it('lists the dates up to today only when the range runs into the future', () => {
    const range = resolveCalendarRange(
      { from: '2026-10-13', to: '2026-10-20' },
      'Asia/Tokyo',
      tokyoMorning,
    );
    expect(range.dates).toEqual(['2026-10-13', '2026-10-14']);
    expect(range.periodEnd).toEqual(tokyoMorning);
  });

  it('accepts a datetime by its date part', () => {
    const range = resolveCalendarRange(
      { from: '2026-10-01T22:00:00Z', to: '2026-10-02T03:00:00Z' },
      'UTC',
      tokyoMorning,
    );
    expect(range.dates).toEqual(['2026-10-01', '2026-10-02']);
  });

  it.each([
    [{ days: '-3' }, '"days" must be a whole number of at least 1'],
    [{ days: '0' }, '"days" must be a whole number of at least 1'],
    [{ days: '1.5' }, '"days" must be a whole number of at least 1'],
    [{ days: 'abc' }, '"days" must be a whole number of at least 1'],
    [{ from: '2026-10-05', to: '2026-10-01' }, '"from" date must be on or before "to" date'],
    [{ from: '2026-10-20', to: '2026-10-21' }, '"from" date cannot be in the future'],
    [{ from: '2026-01-01', to: '2026-10-01' }, 'date range cannot exceed 90 days'],
    [{ from: '2026-02-30', to: '2026-03-01' }, '"from" is not a valid calendar date'],
    [{ from: '2026-10-01', to: 'later' }, '"to" is not a valid calendar date'],
  ])('refuses %j', (query, message) => {
    expect(() => resolveCalendarRange(query, 'Asia/Tokyo', tokyoMorning)).toThrow(
      new ValidationError(message),
    );
  });

  it('allows exactly 90 days', () => {
    const range = resolveCalendarRange(
      { from: '2026-07-01', to: '2026-09-28' },
      'UTC',
      tokyoMorning,
    );
    expect(range.dates).toHaveLength(90);
  });
});

describe('calendar date helpers', () => {
  it('gives the calendar date of an instant in a timezone', () => {
    const at = new Date('2026-10-13T23:30:00.000Z');
    expect(calendarDateIn(at, 'UTC')).toBe('2026-10-13');
    expect(calendarDateIn(at, 'Europe/Berlin')).toBe('2026-10-14');
    expect(calendarDateIn(at, 'America/Los_Angeles')).toBe('2026-10-13');
  });

  it('gives the bounds of a day and moves dates across months', () => {
    const day = calendarDayBounds('2026-10-14', 'Europe/Berlin');
    expect(day.since.toISOString()).toBe('2026-10-13T22:00:00.000Z');
    expect(day.until.toISOString()).toBe('2026-10-14T22:00:00.000Z');
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('fills the dates without a row', () => {
    expect(
      fillDates(
        ['2026-10-01', '2026-10-02', '2026-10-03'],
        [
          { date: '2026-10-03', n: 3 },
          { date: '2026-10-01', n: 1 },
        ],
        (date) => ({ date, n: 0 }),
      ),
    ).toEqual([
      { date: '2026-10-01', n: 1 },
      { date: '2026-10-02', n: 0 },
      { date: '2026-10-03', n: 3 },
    ]);
  });
});

describe('parseDateRange', () => {
  it('refuses a negative days value instead of a range in the future', () => {
    expect(() => parseDateRange({ days: '-7' })).toThrow(ValidationError);
  });
});
