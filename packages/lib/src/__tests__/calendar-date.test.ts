// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  addMonthsToDay,
  dayInRange,
  daysInMonth,
  firstDayOfWeek,
  isIsoDay,
  localeDayOrder,
  monthWeeks,
  parseTypedDay,
  todayIsoDay,
  weekdayOf,
} from '../calendar-date.js';

describe('calendar days', () => {
  it('accepts real days only', () => {
    expect(isIsoDay('2026-02-28')).toBe(true);
    expect(isIsoDay('2026-02-29')).toBe(false);
    expect(isIsoDay('2028-02-29')).toBe(true);
    expect(isIsoDay('2026-13-01')).toBe(false);
    expect(isIsoDay('2026-1-01')).toBe(false);
    expect(isIsoDay('')).toBe(false);
  });

  it('moves by days and months across year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonthsToDay('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsToDay('2026-03-15', -12)).toBe('2025-03-15');
    expect(daysInMonth(2024, 2)).toBe(29);
  });

  it('gives the weekday and today without a time zone shift', () => {
    expect(weekdayOf('2026-11-11')).toBe(3);
    expect(todayIsoDay(new Date(2026, 10, 11, 23, 59))).toBe('2026-11-11');
  });

  it('lays out weeks from the first day of the week', () => {
    // November 2026 starts on a Sunday.
    const sunday = monthWeeks(2026, 11, 0);
    expect(sunday[0]?.[0]).toBe('2026-11-01');
    const monday = monthWeeks(2026, 11, 1);
    expect(monday[0]?.slice(0, 7)).toEqual([null, null, null, null, null, null, '2026-11-01']);
    for (const week of monday) expect(week).toHaveLength(7);
    expect(monday.flat().filter((d) => d != null)).toHaveLength(30);
  });

  it('starts the week on Sunday in en and Monday in de and es', () => {
    expect(firstDayOfWeek('en')).toBe(0);
    expect(firstDayOfWeek('en-US')).toBe(0);
    expect(firstDayOfWeek('de')).toBe(1);
    expect(firstDayOfWeek('es')).toBe(1);
  });

  it('reads typed days in ISO and in the locale numeric order', () => {
    expect(localeDayOrder('en-US')).toEqual(['m', 'd', 'y']);
    expect(localeDayOrder('de')).toEqual(['d', 'm', 'y']);
    expect(parseTypedDay('2026-11-22', 'en')).toBe('2026-11-22');
    expect(parseTypedDay('2026/11/22', 'de')).toBe('2026-11-22');
    expect(parseTypedDay('11/22/2026', 'en-US')).toBe('2026-11-22');
    expect(parseTypedDay('22.11.2026', 'de')).toBe('2026-11-22');
    expect(parseTypedDay('2026-11-2', 'en')).toBe('2026-11-02');
    expect(parseTypedDay('2026-02-30', 'en')).toBeNull();
    expect(parseTypedDay('2026-11', 'en')).toBeNull();
    expect(parseTypedDay('22/11/26', 'de')).toBeNull();
    expect(parseTypedDay('', 'en')).toBeNull();
  });

  it('checks optional bounds', () => {
    expect(dayInRange('2026-11-11', '2026-11-01', '2026-11-30')).toBe(true);
    expect(dayInRange('2026-10-31', '2026-11-01')).toBe(false);
    expect(dayInRange('2026-12-01', undefined, '2026-11-30')).toBe(false);
    expect(dayInRange('2026-12-01', '', '')).toBe(true);
  });
});
