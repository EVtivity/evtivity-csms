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

function timeToMinutes(time: string): number {
  const [hoursStr, minutesStr] = time.split(':');
  return Number(hoursStr) * 60 + Number(minutesStr);
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function getMonthDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day}`;
}

function isInTimeRange(now: Date, startTime: string, endTime: string): boolean {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);

  if (startMinutes < endMinutes) {
    // Normal range (e.g., 09:00-17:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Midnight-crossing range (e.g., 22:00-06:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function isInDateRange(now: Date, startDate: string, endDate: string): boolean {
  const currentMD = getMonthDay(now);

  if (startDate <= endDate) {
    // Normal range (e.g., 06-01 to 09-30)
    return currentMD >= startDate && currentMD <= endDate;
  }
  // Wrapping range (e.g., 11-01 to 03-31)
  return currentMD >= startDate || currentMD <= endDate;
}

export function tariffMatchesNow(
  restrictions: TariffRestrictions,
  now: Date,
  holidays: Date[],
  sessionEnergyKwh: number,
): boolean {
  if (restrictions.energyThresholdKwh != null) {
    return sessionEnergyKwh >= restrictions.energyThresholdKwh;
  }

  if (restrictions.holidays === true) {
    return holidays.some((h) => isSameDay(now, h));
  }

  if (restrictions.dateRange != null) {
    return isInDateRange(now, restrictions.dateRange.startDate, restrictions.dateRange.endDate);
  }

  if (restrictions.daysOfWeek != null) {
    const dayOfWeek = now.getDay();
    if (!restrictions.daysOfWeek.includes(dayOfWeek)) {
      return false;
    }
  }

  if (restrictions.timeRange != null) {
    return isInTimeRange(now, restrictions.timeRange.startTime, restrictions.timeRange.endTime);
  }

  return false;
}
