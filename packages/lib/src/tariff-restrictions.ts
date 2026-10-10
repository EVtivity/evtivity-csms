// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

import { getZonedComponents, isInDateRange, isInTimeRange, timeToMinutes } from './time-window.js';

export { timeToMinutes };

export interface TariffRestrictions {
  timeRange?: { startTime: string; endTime: string };
  daysOfWeek?: number[];
  dateRange?: { startDate: string; endDate: string };
  holidays?: boolean;
  energyThresholdKwh?: number;
}

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const datePattern = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const tariffRestrictionsSchema = z
  .object({
    timeRange: z
      .object({
        startTime: z.string().regex(timePattern, 'Must be HH:MM format (00:00-23:59)'),
        endTime: z.string().regex(timePattern, 'Must be HH:MM format (00:00-23:59)'),
      })
      .refine((tr) => tr.startTime !== tr.endTime, {
        message: 'startTime and endTime must differ',
      })
      .optional(),
    daysOfWeek: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .refine((days) => new Set(days).size === days.length, {
        message: 'daysOfWeek must not contain duplicates',
      })
      .optional(),
    dateRange: z
      .object({
        startDate: z.string().regex(datePattern, 'Must be MM-DD format'),
        endDate: z.string().regex(datePattern, 'Must be MM-DD format'),
      })
      .optional(),
    holidays: z.literal(true).optional(),
    energyThresholdKwh: z.number().positive('Must be greater than 0').optional(),
  })
  .refine(
    (r) => {
      const keys = [
        r.energyThresholdKwh != null,
        r.holidays === true,
        r.dateRange != null,
        r.daysOfWeek != null || r.timeRange != null,
      ].filter(Boolean);
      if (keys.length === 0) return true;

      if (r.energyThresholdKwh != null) {
        return (
          r.holidays == null && r.dateRange == null && r.daysOfWeek == null && r.timeRange == null
        );
      }
      if (r.holidays === true) {
        // energyThresholdKwh already known to be undefined (earlier return)
        return r.dateRange == null && r.daysOfWeek == null && r.timeRange == null;
      }
      if (r.dateRange != null) {
        // energyThresholdKwh and holidays already known to be undefined (earlier returns)
        return r.daysOfWeek == null && r.timeRange == null;
      }
      // energyThresholdKwh, holidays, and dateRange all already known to be undefined
      return true;
    },
    {
      message:
        'Invalid restriction combination. energyThresholdKwh, holidays, and dateRange must stand alone. daysOfWeek can combine with timeRange (daysOfWeek without timeRange applies all day).',
    },
  );

export function derivePriority(restrictions: TariffRestrictions | null): number {
  if (restrictions == null) return 0;
  if (restrictions.energyThresholdKwh != null) return 50;
  if (restrictions.holidays === true) return 40;
  if (restrictions.dateRange != null) return 30;
  // Days of the week with a time window, or without one (the whole day).
  if (restrictions.daysOfWeek != null) return 20;
  if (restrictions.timeRange != null) return 10;
  return 0;
}

function holidayIsoDate(holiday: Date): string {
  // Holidays come from `pricing_holidays.date`, a naive DATE column. Postgres
  // returns the row to JS as midnight UTC of that date, but the value itself
  // is timezone-naive ("Dec 25" means Dec 25 in whatever zone you ask). Read
  // the UTC components to recover the original YYYY-MM-DD string -- if we
  // applied the site timezone here, "Dec 25" stored as 2025-12-25T00:00:00Z
  // would convert to "Dec 24" in any zone west of UTC and the holiday would
  // fire on the wrong day.
  const year = holiday.getUTCFullYear();
  const month = String(holiday.getUTCMonth() + 1).padStart(2, '0');
  const day = String(holiday.getUTCDate()).padStart(2, '0');
  return `${String(year)}-${month}-${day}`;
}

export function tariffMatchesNow(
  restrictions: TariffRestrictions,
  now: Date,
  holidays: Date[],
  sessionEnergyKwh: number,
  timezone?: string,
): boolean {
  if (restrictions.energyThresholdKwh != null) {
    return sessionEnergyKwh >= restrictions.energyThresholdKwh;
  }

  const zc = getZonedComponents(now, timezone);

  if (restrictions.holidays === true) {
    // Compare the zone-local YYYY-MM-DD against each holiday's date. Holidays
    // are stored as midnight UTC in pricing_holidays.date; converting both
    // sides to the site timezone produces the correct boundary regardless of
    // where the server runs.
    return holidays.some((h) => holidayIsoDate(h) === zc.isoDate);
  }

  if (restrictions.dateRange != null) {
    return isInDateRange(zc, restrictions.dateRange.startDate, restrictions.dateRange.endDate);
  }

  if (restrictions.daysOfWeek != null) {
    if (!restrictions.daysOfWeek.includes(zc.dayOfWeek)) {
      return false;
    }
    // Days without a time window apply for the whole day (00:00-24:00).
    if (restrictions.timeRange == null) return true;
  }

  if (restrictions.timeRange != null) {
    return isInTimeRange(zc, restrictions.timeRange.startTime, restrictions.timeRange.endTime);
  }

  return false;
}
