// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

import { priceEnergyCents } from './pricing-engine.js';
import { getZonedComponents, isInDateRange, isInTimeRange } from './time-window.js';

export interface ElectricityRatePeriodRestrictions {
  timeRange?: { startTime: string; endTime: string };
  daysOfWeek?: number[];
  dateRange?: { startDate: string; endDate: string };
}

export interface ElectricityRatePeriod {
  id: number;
  siteId: string;
  name: string;
  ratePerKwh: string;
  restrictions: ElectricityRatePeriodRestrictions | null;
  priority: number;
  isDefault: boolean;
}

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const datePattern = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const electricityRateRestrictionsSchema = z
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
  })
  .refine((r) => !(r.daysOfWeek != null && r.timeRange == null), {
    message: 'daysOfWeek requires timeRange.',
  })
  .refine((r) => !(r.dateRange != null && (r.timeRange != null || r.daysOfWeek != null)), {
    message: 'dateRange must stand alone.',
  });

/**
 * Derive a resolution priority from the restriction shape. Higher wins. Mirrors
 * the tariff priority ladder so flat rate (no restrictions) is the fallback.
 */
export function deriveElectricityRatePriority(
  restrictions: ElectricityRatePeriodRestrictions | null,
): number {
  if (restrictions == null) return 0;
  if (restrictions.dateRange != null) return 30;
  if (restrictions.daysOfWeek != null && restrictions.timeRange != null) return 20;
  if (restrictions.timeRange != null) return 10;
  return 0;
}

function periodMatchesNow(
  restrictions: ElectricityRatePeriodRestrictions | null,
  now: Date,
  timezone?: string,
): boolean {
  // No restrictions = the default flat-rate period, matched only as the fallback
  // (priority 0) after every restricted period has been checked.
  if (restrictions == null) return true;

  const zc = getZonedComponents(now, timezone);

  if (restrictions.dateRange != null) {
    return isInDateRange(zc, restrictions.dateRange.startDate, restrictions.dateRange.endDate);
  }

  if (restrictions.daysOfWeek != null && !restrictions.daysOfWeek.includes(zc.dayOfWeek)) {
    return false;
  }

  if (restrictions.timeRange != null) {
    return isInTimeRange(zc, restrictions.timeRange.startTime, restrictions.timeRange.endTime);
  }

  return false;
}

/**
 * Resolve the active electricity rate period for a moment in time. Periods are
 * sorted by priority descending so a matching restricted period (peak/off-peak)
 * wins over the flat-rate default. Returns null when no period matches.
 */
export function resolveElectricityRate(
  periods: ElectricityRatePeriod[],
  at: Date,
  timezone?: string,
): ElectricityRatePeriod | null {
  const sorted = [...periods].sort((a, b) => b.priority - a.priority);
  for (const period of sorted) {
    if (periodMatchesNow(period.restrictions, at, timezone)) {
      return period;
    }
  }
  return null;
}

/**
 * Wholesale electricity cost in integer cents. Energy is watt-hours (the unit
 * stored on charging_sessions.energy_delivered_wh); rate is dollars per kWh.
 */
export function calculateElectricityCostCents(energyWh: number, ratePerKwh: string): number {
  return priceEnergyCents(energyWh, ratePerKwh);
}
