// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Relative report periods. A period resolves to whole local days
// (`YYYY-MM-DD`, inclusive) from the company date of an anchor instant, so
// daylight saving changes never move a day.

import {
  addDays,
  addMonths,
  daysInMonth,
  isoDay,
  splitIsoDay,
  weekdayOf,
} from './calendar-date.js';
import { localDateInZone } from './departure-schedule.js';

export const REPORT_PERIODS = [
  'previousDay',
  'previousWeek',
  'previousMonth',
  'previousQuarter',
  'previousYear',
  'currentWeekToDate',
  'currentMonthToDate',
  'currentYearToDate',
  'last7Days',
  'last30Days',
  'custom',
] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];
export type RelativeReportPeriod = Exclude<ReportPeriod, 'custom'>;
export const DEFAULT_REPORT_PERIOD: ReportPeriod = 'custom';

export function isReportPeriod(value: unknown): value is ReportPeriod {
  return typeof value === 'string' && (REPORT_PERIODS as readonly string[]).includes(value);
}

/** Settings > Company: the first day of a report week. */
export const COMPANY_WEEK_START_KEY = 'company.weekStart';
export const WEEK_STARTS = ['monday', 'sunday'] as const;
export type WeekStart = (typeof WEEK_STARTS)[number];
export const DEFAULT_WEEK_START: WeekStart = 'monday';

export function isWeekStart(value: unknown): value is WeekStart {
  return typeof value === 'string' && (WEEK_STARTS as readonly string[]).includes(value);
}

export interface ReportDateRange {
  dateFrom: string;
  dateTo: string;
}

function monthRange(year: number, month: number): ReportDateRange {
  return {
    dateFrom: isoDay(year, month, 1),
    dateTo: isoDay(year, month, daysInMonth(year, month)),
  };
}

/** How a period resolves: a scheduled run covers whole days only. */
export interface ReportPeriodOptions {
  /**
   * A scheduled run ends a to-date period yesterday: it covers the period that
   * holds yesterday, up to yesterday. A run by hand ends it today.
   */
  scheduled?: boolean;
}

const TO_DATE_PERIODS: ReadonlySet<RelativeReportPeriod> = new Set([
  'currentWeekToDate',
  'currentMonthToDate',
  'currentYearToDate',
]);

export function isToDatePeriod(period: ReportPeriod): boolean {
  return period !== 'custom' && TO_DATE_PERIODS.has(period);
}

function rangeOn(
  period: RelativeReportPeriod,
  today: string,
  weekStart: WeekStart,
): ReportDateRange {
  const parts = splitIsoDay(today);
  if (parts == null) throw new Error(`Invalid local date ${today}`);
  const { year, month } = parts;
  const yesterday = addDays(today, -1);
  const firstWeekday = weekStart === 'sunday' ? 0 : 1;
  const weekStartDay = addDays(today, -((weekdayOf(today) - firstWeekday + 7) % 7));
  switch (period) {
    case 'previousDay':
      return { dateFrom: yesterday, dateTo: yesterday };
    case 'previousWeek':
      return { dateFrom: addDays(weekStartDay, -7), dateTo: addDays(weekStartDay, -1) };
    case 'previousMonth': {
      const prev = addMonths(year, month, -1);
      return monthRange(prev.year, prev.month);
    }
    case 'previousQuarter': {
      const quarterStart = month - ((month - 1) % 3);
      const first = addMonths(year, quarterStart, -3);
      const last = addMonths(year, quarterStart, -1);
      return {
        dateFrom: monthRange(first.year, first.month).dateFrom,
        dateTo: monthRange(last.year, last.month).dateTo,
      };
    }
    case 'previousYear':
      return { dateFrom: isoDay(year - 1, 1, 1), dateTo: isoDay(year - 1, 12, 31) };
    case 'currentWeekToDate':
      return { dateFrom: weekStartDay, dateTo: today };
    case 'currentMonthToDate':
      return { dateFrom: isoDay(year, month, 1), dateTo: today };
    case 'currentYearToDate':
      return { dateFrom: isoDay(year, 1, 1), dateTo: today };
    case 'last7Days':
      return { dateFrom: addDays(today, -7), dateTo: yesterday };
    case 'last30Days':
      return { dateFrom: addDays(today, -30), dateTo: yesterday };
  }
}

export function resolveReportPeriod(
  period: RelativeReportPeriod,
  anchor: Date,
  timeZone: string,
  weekStart: WeekStart,
  options: ReportPeriodOptions = {},
): ReportDateRange {
  const today = localDateInZone(anchor.getTime(), timeZone);
  const day = options.scheduled === true && isToDatePeriod(period) ? addDays(today, -1) : today;
  return rangeOn(period, day, weekStart);
}

/** The filters a report runs with: custom keeps them, a relative period sets its dates. */
export function applyReportPeriod(
  filters: Record<string, unknown>,
  period: ReportPeriod,
  anchor: Date,
  timeZone: string,
  weekStart: WeekStart,
  options: ReportPeriodOptions = {},
): Record<string, unknown> {
  if (period === 'custom') return filters;
  return { ...filters, ...resolveReportPeriod(period, anchor, timeZone, weekStart, options) };
}
