// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  offsetToWallClockHHMM,
  wallClockHHMMToOffset,
  midnightInTimezone,
  toDatetimeLocalInTimezone,
} from '../schedule-anchor';

describe('offsetToWallClockHHMM', () => {
  it('returns offset HH:MM when startSchedule is null', () => {
    expect(offsetToWallClockHHMM(null, 0, 'America/New_York')).toBe('00:00');
    expect(offsetToWallClockHHMM(null, 10800, 'America/New_York')).toBe('03:00');
    expect(offsetToWallClockHHMM(null, 82800, 'America/New_York')).toBe('23:00');
  });

  it('renders wall-clock time in user timezone given an anchor', () => {
    // Anchor at midnight EST (Jan 5 2026, 05:00 UTC)
    const anchor = '2026-01-05T05:00:00.000Z';
    expect(offsetToWallClockHHMM(anchor, 0, 'America/New_York')).toBe('00:00');
    expect(offsetToWallClockHHMM(anchor, 10800, 'America/New_York')).toBe('03:00');
    expect(offsetToWallClockHHMM(anchor, 82800, 'America/New_York')).toBe('23:00');
  });

  it('renders wall-clock with non-midnight anchor', () => {
    // Anchor at 23:00 EST (Jan 6 2026, 04:00 UTC)
    const anchor = '2026-01-06T04:00:00.000Z';
    expect(offsetToWallClockHHMM(anchor, 0, 'America/New_York')).toBe('23:00');
    expect(offsetToWallClockHHMM(anchor, 14400, 'America/New_York')).toBe('03:00');
  });
});

describe('wallClockHHMMToOffset', () => {
  it('returns time-of-day seconds when startSchedule is null', () => {
    expect(wallClockHHMMToOffset(null, '00:00', 'America/New_York')).toBe(0);
    expect(wallClockHHMMToOffset(null, '11:30', 'America/New_York')).toBe(11 * 3600 + 30 * 60);
  });

  it('computes correct offset for midnight-anchored schedule', () => {
    const anchor = '2026-01-05T05:00:00.000Z';
    expect(wallClockHHMMToOffset(anchor, '00:00', 'America/New_York')).toBe(0);
    expect(wallClockHHMMToOffset(anchor, '03:00', 'America/New_York')).toBe(10800);
    expect(wallClockHHMMToOffset(anchor, '23:00', 'America/New_York')).toBe(82800);
  });

  it('computes correct offset for 23:00-anchored schedule', () => {
    const anchor = '2026-01-06T04:00:00.000Z';
    expect(wallClockHHMMToOffset(anchor, '23:00', 'America/New_York')).toBe(0);
    expect(wallClockHHMMToOffset(anchor, '03:00', 'America/New_York')).toBe(14400);
  });

  it('round-trips through both helpers', () => {
    const anchor = '2026-01-06T04:00:00.000Z';
    const tz = 'America/New_York';
    const offsets = [0, 1800, 14400, 43200, 82800];
    for (const offset of offsets) {
      const hhmm = offsetToWallClockHHMM(anchor, offset, tz);
      expect(wallClockHHMMToOffset(anchor, hhmm, tz)).toBe(offset);
    }
  });
});

describe('midnightInTimezone', () => {
  it('returns a Date that formats as 00:00 in the given timezone', () => {
    const ref = new Date('2026-01-15T17:30:00.000Z');
    const midnight = midnightInTimezone('America/New_York', ref);
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    expect(fmt.format(midnight)).toBe('00:00');
  });

  it('returns the right calendar day in the timezone', () => {
    const ref = new Date('2026-01-15T17:30:00.000Z');
    const midnight = midnightInTimezone('America/New_York', ref);
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    expect(fmt.format(midnight)).toBe('2026-01-15');
  });

  it('handles UTC timezone', () => {
    const ref = new Date('2026-06-15T08:30:00.000Z');
    const midnight = midnightInTimezone('UTC', ref);
    expect(midnight.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });
});

describe('toDatetimeLocalInTimezone', () => {
  it('formats as YYYY-MM-DDTHH:MM in the given timezone', () => {
    const date = new Date('2026-01-05T05:00:00.000Z');
    expect(toDatetimeLocalInTimezone(date, 'America/New_York')).toBe('2026-01-05T00:00');
  });

  it('handles non-midnight times', () => {
    const date = new Date('2026-01-06T04:00:00.000Z');
    expect(toDatetimeLocalInTimezone(date, 'America/New_York')).toBe('2026-01-05T23:00');
  });
});
