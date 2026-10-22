// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  coveredDays,
  coveredMs,
  mergeIntervals,
  zonedDay,
  zonedDayStart,
  type CoveredDaysInput,
} from '../sim-coverage.js';

const at = (iso: string): Date => new Date(iso);
const HOUR = 3_600_000;

describe('mergeIntervals', () => {
  it('merges overlapping and touching ranges and sorts them', () => {
    const merged = mergeIntervals([
      { from: at('2026-10-05T00:00:00Z'), to: at('2026-10-06T00:00:00Z') },
      { from: at('2026-10-01T00:00:00Z'), to: at('2026-10-02T00:00:00Z') },
      { from: at('2026-10-02T00:00:00Z'), to: at('2026-10-03T00:00:00Z') },
      { from: at('2026-10-05T12:00:00Z'), to: at('2026-10-05T18:00:00Z') },
    ]);
    expect(merged).toEqual([
      { from: at('2026-10-01T00:00:00Z'), to: at('2026-10-03T00:00:00Z') },
      { from: at('2026-10-05T00:00:00Z'), to: at('2026-10-06T00:00:00Z') },
    ]);
  });

  it('drops empty ranges and counts covered time', () => {
    const merged = mergeIntervals([
      { from: at('2026-10-01T00:00:00Z'), to: at('2026-10-01T00:00:00Z') },
      { from: at('2026-10-01T06:00:00Z'), to: at('2026-10-01T12:00:00Z') },
    ]);
    expect(merged).toHaveLength(1);
    expect(coveredMs(merged, at('2026-10-01T00:00:00Z'), at('2026-10-02T00:00:00Z'))).toBe(
      6 * HOUR,
    );
  });
});

describe('zoned days', () => {
  it('follows the station time zone, also across a DST change', () => {
    expect(zonedDay(at('2026-10-21T03:00:00Z'), 'America/New_York')).toBe('2026-10-20');
    expect(zonedDayStart('2026-10-21', 'America/New_York').toISOString()).toBe(
      '2026-10-21T04:00:00.000Z',
    );
    expect(zonedDayStart('2026-11-02', 'America/New_York').toISOString()).toBe(
      '2026-11-02T05:00:00.000Z',
    );
  });
});

describe('coveredDays', () => {
  const now = at('2026-10-21T18:00:00Z');
  const base: CoveredDaysInput = {
    from: at('2026-10-14T00:00:00Z'),
    to: now,
    timeZone: 'UTC',
    now,
    coverage: [],
    activity: [],
    reportingDelayHours: 6,
    fetchableSince: at('2026-07-23T18:00:00Z'),
    keptSince: at('2026-07-23T18:00:00Z'),
  };

  it('labels each day of the range', () => {
    const days = coveredDays({
      ...base,
      coverage: [
        { from: at('2026-10-14T00:00:00Z'), to: at('2026-10-16T00:00:00Z') },
        { from: at('2026-10-17T12:00:00Z'), to: at('2026-10-18T00:00:00Z') },
        { from: at('2026-10-20T00:00:00Z'), to: at('2026-10-21T12:00:00Z') },
      ],
      activity: [
        { from: at('2026-10-14T10:00:00Z'), to: at('2026-10-14T12:00:00Z') },
        { from: at('2026-10-20T08:00:00Z'), to: at('2026-10-20T08:00:00Z') },
      ],
    });
    expect(days).toEqual([
      { date: '2026-10-14', label: 'has_data' },
      { date: '2026-10-15', label: 'no_sessions' },
      { date: '2026-10-16', label: 'not_fetched' },
      { date: '2026-10-17', label: 'partial' },
      { date: '2026-10-18', label: 'not_fetched' },
      { date: '2026-10-19', label: 'not_fetched' },
      { date: '2026-10-20', label: 'has_data' },
      { date: '2026-10-21', label: 'pending' },
    ]);
  });

  it('counts a session spanning a whole day as data for that day', () => {
    const days = coveredDays({
      ...base,
      from: at('2026-10-15T00:00:00Z'),
      to: at('2026-10-15T23:00:00Z'),
      coverage: [{ from: at('2026-10-14T00:00:00Z'), to: at('2026-10-17T00:00:00Z') }],
      activity: [{ from: at('2026-10-14T22:00:00Z'), to: at('2026-10-16T02:00:00Z') }],
    });
    expect(days).toEqual([{ date: '2026-10-15', label: 'has_data' }]);
  });

  it('marks days no longer fetchable or kept as unavailable', () => {
    const days = coveredDays({
      ...base,
      from: at('2026-07-20T00:00:00Z'),
      to: at('2026-07-26T00:00:00Z'),
      fetchableSince: at('2026-07-25T00:00:00Z'),
      keptSince: at('2026-07-22T00:00:00Z'),
      coverage: [{ from: at('2026-07-23T00:00:00Z'), to: at('2026-07-24T00:00:00Z') }],
    });
    expect(days.map((d) => d.label)).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
      'no_sessions',
      'unavailable',
      'not_fetched',
      'not_fetched',
    ]);
  });

  it('cuts the days in the station time zone', () => {
    const days = coveredDays({
      ...base,
      timeZone: 'Asia/Tokyo',
      from: at('2026-10-14T15:00:00Z'),
      to: at('2026-10-15T14:00:00Z'),
      coverage: [{ from: at('2026-10-14T15:00:00Z'), to: at('2026-10-15T15:00:00Z') }],
    });
    expect(days).toEqual([{ date: '2026-10-15', label: 'no_sessions' }]);
  });
});
