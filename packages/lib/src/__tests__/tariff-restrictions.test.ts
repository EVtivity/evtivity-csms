// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  derivePriority,
  tariffMatchesNow,
  tariffRestrictionsSchema,
} from '../tariff-restrictions.js';
import type { TariffRestrictions } from '../tariff-restrictions.js';

describe('derivePriority', () => {
  it('returns 0 for null restrictions', () => {
    expect(derivePriority(null)).toBe(0);
  });

  it('returns 0 for empty restrictions', () => {
    expect(derivePriority({})).toBe(0);
  });

  it('returns 10 for time-only restriction', () => {
    expect(derivePriority({ timeRange: { startTime: '09:00', endTime: '17:00' } })).toBe(10);
  });

  it('returns 20 for day+time restriction', () => {
    expect(
      derivePriority({
        daysOfWeek: [1, 2, 3, 4, 5],
        timeRange: { startTime: '09:00', endTime: '17:00' },
      }),
    ).toBe(20);
  });

  it('returns 30 for date range restriction', () => {
    expect(derivePriority({ dateRange: { startDate: '06-01', endDate: '09-30' } })).toBe(30);
  });

  it('returns 40 for holiday restriction', () => {
    expect(derivePriority({ holidays: true })).toBe(40);
  });

  it('returns 50 for energy threshold restriction', () => {
    expect(derivePriority({ energyThresholdKwh: 50 })).toBe(50);
  });
});

describe('tariffMatchesNow', () => {
  describe('time range matching', () => {
    it('matches when current time is within range', () => {
      const restrictions: TariffRestrictions = {
        timeRange: { startTime: '09:00', endTime: '17:00' },
      };
      // 12:00 noon
      const now = new Date(2026, 0, 15, 12, 0, 0);
      expect(tariffMatchesNow(restrictions, now, [], 0)).toBe(true);
    });

    it('does not match when current time is outside range', () => {
      const restrictions: TariffRestrictions = {
        timeRange: { startTime: '09:00', endTime: '17:00' },
      };
      // 20:00 evening
      const now = new Date(2026, 0, 15, 20, 0, 0);
      expect(tariffMatchesNow(restrictions, now, [], 0)).toBe(false);
    });

    it('handles midnight-crossing range (22:00-06:00)', () => {
      const restrictions: TariffRestrictions = {
        timeRange: { startTime: '22:00', endTime: '06:00' },
      };
      // 23:00 - should match
      expect(tariffMatchesNow(restrictions, new Date(2026, 0, 15, 23, 0, 0), [], 0)).toBe(true);
      // 02:00 - should match
      expect(tariffMatchesNow(restrictions, new Date(2026, 0, 15, 2, 0, 0), [], 0)).toBe(true);
      // 12:00 - should not match
      expect(tariffMatchesNow(restrictions, new Date(2026, 0, 15, 12, 0, 0), [], 0)).toBe(false);
    });

    it('matches at exact start time', () => {
      const restrictions: TariffRestrictions = {
        timeRange: { startTime: '09:00', endTime: '17:00' },
      };
      const now = new Date(2026, 0, 15, 9, 0, 0);
      expect(tariffMatchesNow(restrictions, now, [], 0)).toBe(true);
    });

    it('does not match at exact end time', () => {
      const restrictions: TariffRestrictions = {
        timeRange: { startTime: '09:00', endTime: '17:00' },
      };
      const now = new Date(2026, 0, 15, 17, 0, 0);
      expect(tariffMatchesNow(restrictions, now, [], 0)).toBe(false);
    });
  });

  describe('day of week matching', () => {
    it('matches when day is in the list', () => {
      const restrictions: TariffRestrictions = {
        daysOfWeek: [1, 2, 3, 4, 5], // Mon-Fri
        timeRange: { startTime: '00:00', endTime: '23:59' },
      };
      // Wednesday (3)
      const now = new Date(2026, 0, 14, 12, 0, 0);
      expect(tariffMatchesNow(restrictions, now, [], 0)).toBe(true);
    });

    it('does not match when day is not in the list', () => {
      const restrictions: TariffRestrictions = {
        daysOfWeek: [1, 2, 3, 4, 5], // Mon-Fri
        timeRange: { startTime: '00:00', endTime: '23:59' },
      };
      // Sunday (0) - not in list
      const sun = new Date(2026, 0, 18, 12, 0, 0);
      expect(tariffMatchesNow(restrictions, sun, [], 0)).toBe(false);

      // Saturday (6) - not in list
      const sat = new Date(2026, 0, 17, 12, 0, 0);
      expect(tariffMatchesNow(restrictions, sat, [], 0)).toBe(false);
    });
  });

  describe('holiday matching', () => {
    it('matches on a holiday date', () => {
      const restrictions: TariffRestrictions = { holidays: true };
      const now = new Date(2026, 0, 1, 12, 0, 0); // Jan 1
      const holidays = [new Date(2026, 0, 1)];
      expect(tariffMatchesNow(restrictions, now, holidays, 0)).toBe(true);
    });

    it('does not match on a non-holiday date', () => {
      const restrictions: TariffRestrictions = { holidays: true };
      const now = new Date(2026, 0, 2, 12, 0, 0); // Jan 2
      const holidays = [new Date(2026, 0, 1)];
      expect(tariffMatchesNow(restrictions, now, holidays, 0)).toBe(false);
    });
  });

  describe('date range matching', () => {
    it('matches within date range', () => {
      const restrictions: TariffRestrictions = {
        dateRange: { startDate: '06-01', endDate: '09-30' },
      };
      const now = new Date(2026, 6, 15, 12, 0, 0); // July 15
      expect(tariffMatchesNow(restrictions, now, [], 0)).toBe(true);
    });

    it('does not match outside date range', () => {
      const restrictions: TariffRestrictions = {
        dateRange: { startDate: '06-01', endDate: '09-30' },
      };
      const now = new Date(2026, 0, 15, 12, 0, 0); // Jan 15
      expect(tariffMatchesNow(restrictions, now, [], 0)).toBe(false);
    });

    it('handles wrapping date range (Nov-Mar)', () => {
      const restrictions: TariffRestrictions = {
        dateRange: { startDate: '11-01', endDate: '03-31' },
      };
      // December - should match
      expect(tariffMatchesNow(restrictions, new Date(2026, 11, 15, 12, 0, 0), [], 0)).toBe(true);
      // February - should match
      expect(tariffMatchesNow(restrictions, new Date(2026, 1, 15, 12, 0, 0), [], 0)).toBe(true);
      // June - should not match
      expect(tariffMatchesNow(restrictions, new Date(2026, 5, 15, 12, 0, 0), [], 0)).toBe(false);
    });
  });

  describe('timezone-aware matching', () => {
    it('evaluates the time range in the supplied timezone, not server local', () => {
      const restrictions: TariffRestrictions = {
        timeRange: { startTime: '09:00', endTime: '17:00' },
      };
      // 2026-01-15T20:00:00Z is 12:00 in America/Los_Angeles (UTC-8) -> inside
      // the 09:00-17:00 window, but 20:00 UTC -> outside without the zone.
      const utcInstant = new Date('2026-01-15T20:00:00Z');
      expect(tariffMatchesNow(restrictions, utcInstant, [], 0, 'America/Los_Angeles')).toBe(true);
    });

    it('does not match when the zoned local time is outside the range', () => {
      const restrictions: TariffRestrictions = {
        timeRange: { startTime: '09:00', endTime: '17:00' },
      };
      // 2026-01-15T06:00:00Z is 22:00 the previous day in America/Los_Angeles
      // (UTC-8) -> outside the 09:00-17:00 window.
      const utcInstant = new Date('2026-01-15T06:00:00Z');
      expect(tariffMatchesNow(restrictions, utcInstant, [], 0, 'America/Los_Angeles')).toBe(false);
    });

    it('matches day-of-week computed in the supplied timezone', () => {
      const restrictions: TariffRestrictions = {
        daysOfWeek: [3], // Wednesday only
        timeRange: { startTime: '00:00', endTime: '23:59' },
      };
      // 2026-01-15 is a Thursday in UTC, but at 01:00 UTC it is still Wednesday
      // 17:00 in America/Los_Angeles (UTC-8).
      const utcInstant = new Date('2026-01-15T01:00:00Z');
      expect(tariffMatchesNow(restrictions, utcInstant, [], 0, 'America/Los_Angeles')).toBe(true);
    });

    it('matches a holiday using the zoned calendar date', () => {
      const restrictions: TariffRestrictions = { holidays: true };
      // 2026-12-26T03:00:00Z is Dec 25 19:00 in America/Los_Angeles.
      const utcInstant = new Date('2026-12-26T03:00:00Z');
      // Holiday stored as midnight UTC of Dec 25.
      const holidays = [new Date('2026-12-25T00:00:00Z')];
      expect(tariffMatchesNow(restrictions, utcInstant, holidays, 0, 'America/Los_Angeles')).toBe(
        true,
      );
    });
  });

  describe('falls through to false', () => {
    it('returns false when daysOfWeek matches the day but no timeRange is set', () => {
      // daysOfWeek present and the current day is in the list, but with no
      // timeRange the function falls through past every branch to `return false`.
      const restrictions: TariffRestrictions = {
        daysOfWeek: [3], // Wednesday
      };
      const wednesday = new Date(2026, 0, 14, 12, 0, 0); // 2026-01-14 is a Wednesday
      expect(tariffMatchesNow(restrictions, wednesday, [], 0)).toBe(false);
    });

    it('returns false for an empty restriction object', () => {
      expect(tariffMatchesNow({}, new Date(2026, 0, 15, 12, 0, 0), [], 0)).toBe(false);
    });
  });

  describe('energy threshold matching', () => {
    it('matches when energy exceeds threshold', () => {
      const restrictions: TariffRestrictions = { energyThresholdKwh: 50 };
      expect(tariffMatchesNow(restrictions, new Date(), [], 55)).toBe(true);
    });

    it('matches at exact threshold', () => {
      const restrictions: TariffRestrictions = { energyThresholdKwh: 50 };
      expect(tariffMatchesNow(restrictions, new Date(), [], 50)).toBe(true);
    });

    it('does not match below threshold', () => {
      const restrictions: TariffRestrictions = { energyThresholdKwh: 50 };
      expect(tariffMatchesNow(restrictions, new Date(), [], 30)).toBe(false);
    });
  });
});

describe('tariffRestrictionsSchema', () => {
  it('validates a valid time range restriction', () => {
    const result = tariffRestrictionsSchema.safeParse({
      timeRange: { startTime: '09:00', endTime: '17:00' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid time format', () => {
    const result = tariffRestrictionsSchema.safeParse({
      timeRange: { startTime: '25:00', endTime: '17:00' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects same start and end time', () => {
    const result = tariffRestrictionsSchema.safeParse({
      timeRange: { startTime: '09:00', endTime: '09:00' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects daysOfWeek with duplicates', () => {
    const result = tariffRestrictionsSchema.safeParse({
      daysOfWeek: [1, 1, 2],
      timeRange: { startTime: '09:00', endTime: '17:00' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects daysOfWeek values out of range', () => {
    const result = tariffRestrictionsSchema.safeParse({
      daysOfWeek: [7],
      timeRange: { startTime: '09:00', endTime: '17:00' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects combining energyThreshold with timeRange', () => {
    const result = tariffRestrictionsSchema.safeParse({
      energyThresholdKwh: 50,
      timeRange: { startTime: '09:00', endTime: '17:00' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects combining holidays with dateRange', () => {
    const result = tariffRestrictionsSchema.safeParse({
      holidays: true,
      dateRange: { startDate: '06-01', endDate: '09-30' },
    });
    expect(result.success).toBe(false);
  });

  it('allows daysOfWeek with timeRange', () => {
    const result = tariffRestrictionsSchema.safeParse({
      daysOfWeek: [1, 2, 3, 4, 5],
      timeRange: { startTime: '09:00', endTime: '17:00' },
    });
    expect(result.success).toBe(true);
  });

  it('validates date range format', () => {
    const result = tariffRestrictionsSchema.safeParse({
      dateRange: { startDate: '13-01', endDate: '09-30' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative energy threshold', () => {
    const result = tariffRestrictionsSchema.safeParse({
      energyThresholdKwh: -5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects daysOfWeek without timeRange', () => {
    const result = tariffRestrictionsSchema.safeParse({
      daysOfWeek: [1, 2, 3, 4, 5],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('daysOfWeek requires timeRange');
    }
  });

  it('accepts an empty restriction object (the default/no-restriction tariff)', () => {
    // Exercises the `keys.length === 0` early-return in the combination refine.
    const result = tariffRestrictionsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts holidays standalone', () => {
    // Exercises the true branch of the holidays-standalone refine.
    const result = tariffRestrictionsSchema.safeParse({ holidays: true });
    expect(result.success).toBe(true);
  });

  it('accepts a standalone energy threshold', () => {
    const result = tariffRestrictionsSchema.safeParse({ energyThresholdKwh: 50 });
    expect(result.success).toBe(true);
  });

  it('accepts a standalone date range', () => {
    const result = tariffRestrictionsSchema.safeParse({
      dateRange: { startDate: '06-01', endDate: '09-30' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects combining holidays with daysOfWeek+timeRange', () => {
    const result = tariffRestrictionsSchema.safeParse({
      holidays: true,
      daysOfWeek: [1, 2, 3],
      timeRange: { startTime: '09:00', endTime: '17:00' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects combining dateRange with timeRange', () => {
    const result = tariffRestrictionsSchema.safeParse({
      dateRange: { startDate: '06-01', endDate: '09-30' },
      timeRange: { startTime: '09:00', endTime: '17:00' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects combining energyThreshold with dateRange', () => {
    const result = tariffRestrictionsSchema.safeParse({
      energyThresholdKwh: 50,
      dateRange: { startDate: '06-01', endDate: '09-30' },
    });
    expect(result.success).toBe(false);
  });
});
