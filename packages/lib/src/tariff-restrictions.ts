// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

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
      // daysOfWeek requires timeRange (daysOfWeek alone produces priority 0 which
      // conflicts with the default tariff and is never matched by tariffMatchesNow)
      if (r.daysOfWeek != null && r.timeRange == null) {
        return false;
      }
      return true;
    },
    {
      message:
        'daysOfWeek requires timeRange. Use daysOfWeek with a timeRange to define when this tariff applies.',
    },
  )
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
        'Invalid restriction combination. energyThresholdKwh, holidays, and dateRange must stand alone. daysOfWeek can combine with timeRange.',
    },
  );

export function derivePriority(restrictions: TariffRestrictions | null): number {
  if (restrictions == null) return 0;
  if (restrictions.energyThresholdKwh != null) return 50;
  if (restrictions.holidays === true) return 40;
  if (restrictions.dateRange != null) return 30;
  if (restrictions.daysOfWeek != null && restrictions.timeRange != null) return 20;
  if (restrictions.timeRange != null) return 10;
  return 0;
}

export function timeToMinutes(time: string): number {
  const [hoursStr, minutesStr] = time.split(':');
  return Number(hoursStr) * 60 + Number(minutesStr);
}

interface ZonedComponents {
  hour: number;
  minute: number;
  dayOfWeek: number;
  monthDay: string;
  isoDate: string;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Extract calendar components in the given timezone. Without a timezone the
 * server's local time is used (the historic behaviour). Pass the site's
 * timezone -- typically `sites.timezone`, e.g. 'America/Los_Angeles' -- so
 * tariff windows and holiday boundaries are evaluated where the driver
 * actually plugs in, not where the server happens to live.
 */
function getZonedComponents(now: Date, timezone?: string): ZonedComponents {
  if (timezone == null) {
    return {
      hour: now.getHours(),
      minute: now.getMinutes(),
      dayOfWeek: now.getDay(),
      monthDay: `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      isoDate: `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    };
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  // Intl returns "24" for midnight in some locales when hour12 is false; clamp.
  const hour = Number(get('hour')) % 24;
  return {
    hour,
    minute: Number(get('minute')),
    dayOfWeek: WEEKDAY_INDEX[get('weekday')] ?? 0,
    monthDay: `${get('month')}-${get('day')}`,
    isoDate: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

function isInTimeRange(zc: ZonedComponents, startTime: string, endTime: string): boolean {
  const currentMinutes = zc.hour * 60 + zc.minute;
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);

  if (startMinutes < endMinutes) {
    // Normal range (e.g., 09:00-17:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Midnight-crossing range (e.g., 22:00-06:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function isInDateRange(zc: ZonedComponents, startDate: string, endDate: string): boolean {
  const currentMD = zc.monthDay;

  if (startDate <= endDate) {
    // Normal range (e.g., 06-01 to 09-30)
    return currentMD >= startDate && currentMD <= endDate;
  }
  // Wrapping range (e.g., 11-01 to 03-31)
  return currentMD >= startDate || currentMD <= endDate;
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
  }

  if (restrictions.timeRange != null) {
    return isInTimeRange(zc, restrictions.timeRange.startTime, restrictions.timeRange.endTime);
  }

  return false;
}
