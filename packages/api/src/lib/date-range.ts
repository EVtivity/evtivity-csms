// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { ValidationError, zonedMidnight } from '@evtivity/lib';

export const dateRangeQuery = z.object({
  days: z
    .string()
    .optional()
    .describe(
      'Number of trailing days to include (1-90, defaults to 7; a value above 90 counts as 90, below 1 is refused). Ignored when both `from` and `to` are provided.',
    ),
  from: z
    .string()
    .optional()
    .describe(
      'Range start as a calendar date (YYYY-MM-DD; a datetime counts by its date part). Must be combined with `to`.',
    ),
  to: z
    .string()
    .optional()
    .describe(
      'Range end as a calendar date (YYYY-MM-DD), included. Must be combined with `from`. Range cannot exceed 90 days.',
    ),
});

export interface DateRange {
  since: Date;
  until: Date | null;
  daysNum: number;
}

/** Strictly parse a YYYY-MM-DD string into an epoch ms (UTC midnight).
 * Returns null when the input doesn't round-trip — catches inputs like
 * "2024-02-30" that pass the regex shape check but represent dates the
 * calendar doesn't have. */
export function parseCalendarDate(s: string): number | null {
  const parts = s.split('-');
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date.getTime();
}

export function parseDateRange(query: { days?: string; from?: string; to?: string }): DateRange {
  const { days = '7', from, to } = query;

  if (from && to) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return { since: new Date(Date.now() - 7 * 86400000), until: null, daysNum: 7 };
    }
    toDate.setHours(23, 59, 59, 999);
    const diffMs = toDate.getTime() - fromDate.getTime();
    const diffDays = Math.ceil(diffMs / 86400000);
    if (diffDays < 1) {
      throw new ValidationError('"from" date must be on or before "to" date');
    }
    if (diffDays > 90) {
      throw new ValidationError('date range cannot exceed 90 days');
    }
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    if (fromDate.getTime() > todayEnd.getTime()) {
      throw new ValidationError('"from" date cannot be in the future');
    }
    return { since: fromDate, until: toDate, daysNum: diffDays };
  }

  const daysNum = parseDays(days);
  const since = new Date();
  since.setDate(since.getDate() - daysNum);
  return { since, until: null, daysNum };
}

/** `days` as a whole number of days: at most 90, a value below 1 refused. */
function parseDays(days: string): number {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('"days" must be a whole number of at least 1');
  }
  return Math.min(n, 90);
}

const MAX_RANGE_DAYS = 90;
const DAY_MS = 86_400_000;

/** A range of whole calendar days in a timezone, as the dashboard charts group them. */
export interface CalendarDayRange {
  /** Midnight at the start of the first day, in the timezone. */
  since: Date;
  /** Midnight after the last day (exclusive end). */
  until: Date;
  /** The end of the period so far: `until`, or now when the range runs through today. */
  periodEnd: Date;
  /** Every calendar date of the range up to today (YYYY-MM-DD), oldest first. */
  dates: string[];
}

/** The calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function calendarDateIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function addDays(date: string, days: number): string {
  const ms = parseCalendarDate(date);
  if (ms == null) throw new ValidationError(`"${date}" is not a valid calendar date`);
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

function midnightOf(date: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return zonedMidnight(y ?? 0, m ?? 1, d ?? 1, timeZone);
}

/** Midnight at the start of a calendar date in a timezone and the midnight after it. */
export function calendarDayBounds(date: string, timeZone: string): { since: Date; until: Date } {
  return { since: midnightOf(date, timeZone), until: midnightOf(addDays(date, 1), timeZone) };
}

/** The calendar date `days` days after `date` (before it when negative). */
export function addCalendarDays(date: string, days: number): string {
  return addDays(date, days);
}

function calendarDateParam(value: string, name: string): string {
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || parseCalendarDate(date) == null) {
    throw new ValidationError(`"${name}" is not a valid calendar date`);
  }
  return date;
}

/**
 * The dashboard date range as whole calendar days in the timezone the charts
 * group by: `from` and `to` are dates (to included, so the end is the
 * midnight after it), and `days=N` is today and the N days before it.
 */
export function resolveCalendarRange(
  query: { days?: string; from?: string; to?: string },
  timeZone: string,
  now: Date = new Date(),
): CalendarDayRange {
  const today = calendarDateIn(now, timeZone);
  let first: string;
  let last: string;
  if (query.from && query.to) {
    first = calendarDateParam(query.from, 'from');
    last = calendarDateParam(query.to, 'to');
    if (first > last) throw new ValidationError('"from" date must be on or before "to" date');
    if (first > today) throw new ValidationError('"from" date cannot be in the future');
    const spanDays =
      ((parseCalendarDate(last) ?? 0) - (parseCalendarDate(first) ?? 0)) / DAY_MS + 1;
    if (spanDays > MAX_RANGE_DAYS) {
      throw new ValidationError('date range cannot exceed 90 days');
    }
  } else {
    const daysNum = parseDays(query.days ?? '7');
    first = addDays(today, -daysNum);
    last = today;
  }
  const since = midnightOf(first, timeZone);
  const until = midnightOf(addDays(last, 1), timeZone);
  const dates: string[] = [];
  const lastShown = last < today ? last : today;
  for (let d = first; d <= lastShown; d = addDays(d, 1)) dates.push(d);
  return {
    since,
    until,
    periodEnd: until.getTime() < now.getTime() ? until : now,
    dates,
  };
}

/** One row per date of the range, a missing date filled with `empty`. */
export function fillDates<T extends { date: string }>(
  dates: readonly string[],
  rows: readonly T[],
  empty: (date: string) => T,
): T[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return dates.map((date) => byDate.get(date) ?? empty(date));
}
