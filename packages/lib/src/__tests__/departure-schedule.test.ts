// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { MAX_SCHEDULE_DAYS, localDateInZone, scheduleOccurrences } from '../departure-schedule.js';

const iso = (ms: number): string => new Date(ms).toISOString();

describe('scheduleOccurrences', () => {
  it('expands weekdays only at the local departure time', () => {
    const list = scheduleOccurrences(
      { daysOfWeek: [1, 2, 3, 4, 5], departureTime: '05:30' },
      'America/Chicago',
      '2026-11-02',
      7,
    );
    expect(list.map((o) => o.occurrenceDate)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
    ]);
    expect(iso(list[0]!.departureAtMs)).toBe('2026-11-02T11:30:00.000Z');
  });

  it('keeps the valid from and valid to dates, both inclusive', () => {
    const list = scheduleOccurrences(
      {
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        departureTime: '06:00',
        validFrom: '2026-11-04',
        validTo: '2026-11-05',
      },
      'UTC',
      '2026-11-01',
      14,
    );
    expect(list.map((o) => o.occurrenceDate)).toEqual(['2026-11-04', '2026-11-05']);
  });

  it('moves a time inside the spring forward gap to the end of the gap', () => {
    const [occurrence] = scheduleOccurrences(
      { daysOfWeek: [7], departureTime: '02:30' },
      'America/New_York',
      '2026-03-08',
      1,
    );
    expect(occurrence?.occurrenceDate).toBe('2026-03-08');
    expect(iso(occurrence!.departureAtMs)).toBe('2026-03-08T07:00:00.000Z');
  });

  it('takes the first of the two times on the fall back day', () => {
    const [occurrence] = scheduleOccurrences(
      { daysOfWeek: [7], departureTime: '01:30' },
      'America/New_York',
      '2026-11-01',
      1,
    );
    expect(iso(occurrence!.departureAtMs)).toBe('2026-11-01T05:30:00.000Z');
  });

  it('handles a southern hemisphere spring forward', () => {
    const [occurrence] = scheduleOccurrences(
      { daysOfWeek: [7], departureTime: '02:15' },
      'Australia/Sydney',
      '2026-10-04',
      1,
    );
    expect(iso(occurrence!.departureAtMs)).toBe('2026-10-03T16:00:00.000Z');
  });

  it('keeps the same local time on the days after a change', () => {
    const list = scheduleOccurrences(
      { daysOfWeek: [6, 7, 1], departureTime: '05:30' },
      'America/New_York',
      '2026-10-31',
      3,
    );
    expect(list.map((o) => iso(o.departureAtMs))).toEqual([
      '2026-10-31T09:30:00.000Z',
      '2026-11-01T10:30:00.000Z',
      '2026-11-02T10:30:00.000Z',
    ]);
  });

  it('falls back to UTC for an unknown timezone', () => {
    const [occurrence] = scheduleOccurrences(
      { daysOfWeek: [1], departureTime: '05:30' },
      'Mars/Base',
      '2026-11-02',
      1,
    );
    expect(iso(occurrence!.departureAtMs)).toBe('2026-11-02T05:30:00.000Z');
  });

  it('returns nothing for a malformed time, date or day count', () => {
    const schedule = { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], departureTime: '05:30' };
    expect(
      scheduleOccurrences({ ...schedule, departureTime: '24:00' }, 'UTC', '2026-11-02', 7),
    ).toEqual([]);
    expect(
      scheduleOccurrences({ ...schedule, departureTime: '5:30' }, 'UTC', '2026-11-02', 7),
    ).toEqual([]);
    expect(scheduleOccurrences(schedule, 'UTC', '2026-13-02', 7)).toEqual([]);
    expect(scheduleOccurrences(schedule, 'UTC', '2026-11-02', 0)).toEqual([]);
  });

  it('crosses a month and a year end', () => {
    const list = scheduleOccurrences(
      { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], departureTime: '23:45' },
      'Asia/Tokyo',
      '2026-12-31',
      2,
    );
    expect(list.map((o) => o.occurrenceDate)).toEqual(['2026-12-31', '2027-01-01']);
    expect(iso(list[1]!.departureAtMs)).toBe('2027-01-01T14:45:00.000Z');
  });
});

describe('scheduleOccurrences day cap', () => {
  it('expands at most 400 days', () => {
    const list = scheduleOccurrences(
      { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], departureTime: '05:30' },
      'Europe/Berlin',
      '2026-11-02',
      100_000,
    );
    expect(list).toHaveLength(MAX_SCHEDULE_DAYS);
    expect(MAX_SCHEDULE_DAYS).toBe(400);
  });
});

describe('localDateInZone', () => {
  it('keeps the last millisecond of a local day on that day', () => {
    expect(localDateInZone(Date.parse('2026-11-01T04:59:59.999Z'), 'America/Chicago')).toBe(
      '2026-10-31',
    );
    expect(localDateInZone(Date.parse('2026-11-01T05:00:00.000Z'), 'America/Chicago')).toBe(
      '2026-11-01',
    );
  });

  it('gives the local calendar date of an instant', () => {
    const at = Date.parse('2026-11-02T03:00:00Z');
    expect(localDateInZone(at, 'America/Chicago')).toBe('2026-11-01');
    expect(localDateInZone(at, 'Asia/Tokyo')).toBe('2026-11-02');
    expect(localDateInZone(at, 'Mars/Base')).toBe('2026-11-02');
  });
});
