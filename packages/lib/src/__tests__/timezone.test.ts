// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { formatDateTime, formatDate, formatRelativeTime, isValidTimezone } from '../timezone.js';

describe('formatDateTime', () => {
  it('converts UTC to America/New_York (winter, UTC-5)', () => {
    const result = formatDateTime('2025-01-15T17:30:00Z', 'America/New_York');
    expect(result).toContain('12:30:00');
    expect(result).toContain('Jan 15, 2025');
  });

  it('converts UTC to America/Los_Angeles (winter, UTC-8)', () => {
    const result = formatDateTime('2025-01-15T17:30:00Z', 'America/Los_Angeles');
    expect(result).toContain('9:30:00');
    expect(result).toContain('Jan 15, 2025');
  });

  it('handles DST (America/New_York summer, UTC-4)', () => {
    const result = formatDateTime('2025-07-15T17:30:00Z', 'America/New_York');
    expect(result).toContain('1:30:00');
    expect(result).toContain('Jul 15, 2025');
  });

  it('formats in UTC timezone', () => {
    const result = formatDateTime('2025-01-15T17:30:00Z', 'UTC');
    expect(result).toContain('5:30:00');
    expect(result).toContain('Jan 15, 2025');
  });

  it('accepts a Date object', () => {
    const date = new Date('2025-01-15T17:30:00Z');
    const result = formatDateTime(date, 'America/New_York');
    expect(result).toContain('12:30:00');
    expect(result).toContain('Jan 15, 2025');
  });

  it('accepts custom format options', () => {
    const result = formatDateTime('2025-01-15T17:30:00Z', 'UTC', { month: 'long' });
    expect(result).toContain('January');
    expect(result).toContain('5:30:00');
  });

  it('formats in the locale (de)', () => {
    const result = formatDateTime('2025-01-15T08:04:09Z', 'Europe/Berlin', undefined, 'de');
    expect(result).toBe('15.01.2025, 09:04:09');
  });

  it('uses dateStyle and timeStyle options as given', () => {
    const options = { dateStyle: 'medium', timeStyle: 'short' } as const;
    expect(formatDateTime('2025-01-15T08:04:09Z', 'Europe/Berlin', options, 'de')).toBe(
      '15.01.2025, 09:04',
    );
    expect(formatDateTime('2025-01-15T08:04:09Z', 'Europe/Berlin', options, 'en')).toMatch(
      /^Jan 15, 2025, 9:04\sAM$/,
    );
  });

  it('falls back to en-US for an invalid locale', () => {
    const result = formatDateTime('2025-01-15T17:30:00Z', 'UTC', undefined, 'not a locale');
    expect(result).toContain('Jan 15, 2025');
  });

  it('handles midnight boundary', () => {
    const result = formatDateTime('2025-01-16T05:00:00Z', 'America/New_York');
    expect(result).toContain('12:00:00');
    expect(result).toContain('Jan 16, 2025');
  });
});

describe('formatDate', () => {
  it('handles cross-day boundary (3 AM UTC Jan 16 = Jan 15 in New York)', () => {
    const result = formatDate('2025-01-16T03:00:00Z', 'America/New_York');
    expect(result).toBe('Jan 15, 2025');
  });

  it('shows correct day in UTC', () => {
    const result = formatDate('2025-01-16T03:00:00Z', 'UTC');
    expect(result).toBe('Jan 16, 2025');
  });

  it('accepts a Date object', () => {
    const date = new Date('2025-01-16T03:00:00Z');
    const result = formatDate(date, 'America/New_York');
    expect(result).toBe('Jan 15, 2025');
  });

  it('formats in the locale (de)', () => {
    expect(formatDate('2025-01-16T03:00:00Z', 'UTC', undefined, 'de')).toBe('16.01.2025');
  });

  it('accepts custom format options', () => {
    const result = formatDate('2025-01-15T17:30:00Z', 'UTC', { month: 'long' });
    expect(result).toContain('January');
  });
});

describe('formatRelativeTime', () => {
  it('shows seconds for less than a minute', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const thirtySecsAgo = new Date(now - 30_000);
    const result = formatRelativeTime(thirtySecsAgo, 'UTC');
    expect(result).toBe('30s ago');
    vi.restoreAllMocks();
  });

  it('shows minutes for less than an hour', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fiveMinAgo = new Date(now - 5 * 60_000);
    const result = formatRelativeTime(fiveMinAgo, 'UTC');
    expect(result).toBe('5m ago');
    vi.restoreAllMocks();
  });

  it('shows hours for less than a day', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const threeHrsAgo = new Date(now - 3 * 3600_000);
    const result = formatRelativeTime(threeHrsAgo, 'UTC');
    expect(result).toBe('3h ago');
    vi.restoreAllMocks();
  });

  it('falls back to full date/time for 24+ hours', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const twoDaysAgo = new Date(now - 48 * 3600_000);
    const result = formatRelativeTime(twoDaysAgo, 'UTC');
    expect(result).not.toContain('ago');
    expect(result).toMatch(/\d{4}/);
    vi.restoreAllMocks();
  });

  it('falls back to full date/time for exactly 24 hours', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const oneDayAgo = new Date(now - 24 * 3600_000);
    const result = formatRelativeTime(oneDayAgo, 'UTC');
    expect(result).not.toContain('ago');
    expect(result).toMatch(/\d{4}/);
    vi.restoreAllMocks();
  });

  it('falls back to full date/time for string timestamp older than 24 hours', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const threeDaysAgo = new Date(now - 72 * 3600_000).toISOString();
    const result = formatRelativeTime(threeDaysAgo, 'America/New_York');
    expect(result).not.toContain('ago');
    expect(result).toMatch(/\d{4}/);
    vi.restoreAllMocks();
  });

  it('accepts a string timestamp', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const tenSecsAgo = new Date(now - 10_000).toISOString();
    const result = formatRelativeTime(tenSecsAgo, 'UTC');
    expect(result).toBe('10s ago');
    vi.restoreAllMocks();
  });

  it('shows 0s ago for current time', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const result = formatRelativeTime(new Date(now), 'UTC');
    expect(result).toBe('0s ago');
    vi.restoreAllMocks();
  });
});

describe('formatRelativeTime with locale', () => {
  it('formats relative time in the locale (de)', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    // Narrow German labels differ between ICU versions, so compare against the runtime's own output.
    const de = new Intl.RelativeTimeFormat('de', { style: 'narrow' });
    expect(formatRelativeTime(new Date(now - 30_000), 'UTC', 'de')).toBe(de.format(-30, 'second'));
    expect(formatRelativeTime(new Date(now - 3 * 3600_000), 'UTC', 'de')).toBe(
      de.format(-3, 'hour'),
    );
    vi.restoreAllMocks();
  });

  it('falls back to date and time in the locale (de)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2025-01-17T12:00:00Z').getTime());
    expect(formatRelativeTime('2025-01-15T08:04:09Z', 'UTC', 'de')).toBe('15.01.2025, 08:04:09');
    vi.restoreAllMocks();
  });
});

describe('isValidTimezone', () => {
  it('returns true for valid IANA timezone names', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('America/Los_Angeles')).toBe(true);
    expect(isValidTimezone('America/Chicago')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
  });

  it('returns false for invalid timezone strings', () => {
    expect(isValidTimezone('Invalid/Timezone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('foobar')).toBe(false);
  });

  it('returns false for non-standard timezone strings', () => {
    expect(isValidTimezone('US/Bogus')).toBe(false);
    expect(isValidTimezone('America/Nowhere')).toBe(false);
  });
});
