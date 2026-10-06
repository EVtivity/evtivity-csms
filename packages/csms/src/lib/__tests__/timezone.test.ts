// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));
vi.mock('../../i18n', () => ({ loadLanguage: vi.fn(() => Promise.resolve()) }));
vi.mock('../theme', () => ({ applyTheme: vi.fn(), resolveInitialTheme: () => 'light' }));

import { useAuth } from '../auth';
import {
  formatChartTime,
  formatDate,
  formatDateTime,
  formatRelativeTime,
  TIMEZONE_OPTIONS,
  useUserTimezone,
} from '../timezone';

describe('formatDateTime', () => {
  it('formats in the given time zone', () => {
    expect(formatDateTime('2026-03-01T15:04:05Z', 'UTC')).toBe('Mar 1, 2026, 3:04:05 PM');
    expect(formatDateTime('2026-03-01T15:04:05Z', 'Asia/Tokyo')).toBe('Mar 2, 2026, 12:04:05 AM');
  });

  it('accepts a Date and lets options override defaults', () => {
    const out = formatDateTime(new Date('2026-03-01T15:04:05Z'), 'UTC', {
      second: undefined,
      hour12: false,
    });
    expect(out).toBe('3/1/2026, 15:04');
  });
});

describe('formatChartTime', () => {
  it('formats epoch ms in the given time zone without year and seconds', () => {
    const ms = Date.UTC(2026, 9, 6, 4, 30, 15);
    expect(formatChartTime(ms, 'America/New_York')).toBe('Oct 6, 12:30 AM');
    expect(formatChartTime(ms, 'UTC')).toBe('Oct 6, 4:30 AM');
  });
});

describe('formatDate', () => {
  it('formats the calendar date in the given time zone', () => {
    expect(formatDate('2026-03-01T23:30:00Z', 'UTC')).toBe('Mar 1, 2026');
    expect(formatDate('2026-03-01T23:30:00Z', 'Asia/Tokyo')).toBe('Mar 2, 2026');
  });

  it('accepts a Date and options', () => {
    expect(formatDate(new Date('2026-03-01T12:00:00Z'), 'UTC', { month: 'long' })).toBe(
      'March 1, 2026',
    );
  });
});

describe('formatRelativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function at(now: string): void {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
  }

  it('uses seconds under a minute', () => {
    at('2026-03-01T12:00:59Z');
    expect(formatRelativeTime('2026-03-01T12:00:00Z', 'UTC')).toBe('59s ago');
  });

  it('uses minutes under an hour', () => {
    at('2026-03-01T12:59:59Z');
    expect(formatRelativeTime(new Date('2026-03-01T12:00:00Z'), 'UTC')).toBe('59m ago');
  });

  it('uses hours under a day', () => {
    at('2026-03-02T11:59:00Z');
    expect(formatRelativeTime('2026-03-01T12:00:00Z', 'UTC')).toBe('23h ago');
  });

  it('falls back to the full date and time after a day', () => {
    at('2026-03-02T12:00:00Z');
    expect(formatRelativeTime('2026-03-01T12:00:00Z', 'UTC')).toBe('Mar 1, 2026, 12:00:00 PM');
  });
});

describe('TIMEZONE_OPTIONS', () => {
  it('lists only time zones Intl accepts, without duplicates', () => {
    const values = TIMEZONE_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    for (const tz of values) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow();
    }
    expect(values[0]).toBe('UTC');
  });
});

describe('useUserTimezone', () => {
  afterEach(() => {
    useAuth.setState({ user: null });
  });

  it('defaults to America/New_York without a user', () => {
    useAuth.setState({ user: null });
    expect(renderHook(() => useUserTimezone()).result.current).toBe('America/New_York');
  });

  it("returns the user's time zone", () => {
    useAuth.setState({
      user: {
        id: 'u',
        email: 'e',
        firstName: null,
        lastName: null,
        language: 'en',
        timezone: 'Europe/Berlin',
        themePreference: 'light',
      },
    });
    expect(renderHook(() => useUserTimezone()).result.current).toBe('Europe/Berlin');
  });
});
