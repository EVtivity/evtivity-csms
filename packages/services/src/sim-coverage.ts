// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { zonedMidnight } from '@evtivity/lib';

/** A fetched time range, start inclusive, end exclusive. */
export interface SimInterval {
  from: Date;
  to: Date;
}

/** Overlapping and touching ranges merged, sorted by start. */
export function mergeIntervals(intervals: readonly SimInterval[]): SimInterval[] {
  const sorted = intervals
    .filter((i) => i.to.getTime() > i.from.getTime())
    .slice()
    .sort((a, b) => a.from.getTime() - b.from.getTime());
  const merged: SimInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last != null && interval.from.getTime() <= last.to.getTime()) {
      if (interval.to.getTime() > last.to.getTime()) last.to = new Date(interval.to.getTime());
    } else {
      merged.push({ from: new Date(interval.from.getTime()), to: new Date(interval.to.getTime()) });
    }
  }
  return merged;
}

/** Milliseconds of [from, to) the merged ranges cover. */
export function coveredMs(merged: readonly SimInterval[], from: Date, to: Date): number {
  let total = 0;
  for (const interval of merged) {
    const start = Math.max(interval.from.getTime(), from.getTime());
    const end = Math.min(interval.to.getTime(), to.getTime());
    if (end > start) total += end - start;
  }
  return total;
}

export type SimDayLabel =
  | 'has_data'
  | 'no_sessions'
  | 'partial'
  | 'pending'
  | 'not_fetched'
  | 'unavailable';

export interface SimCoveredDay {
  /** Calendar day in the station's time zone, YYYY-MM-DD. */
  date: string;
  label: SimDayLabel;
}

export interface CoveredDaysInput {
  from: Date;
  to: Date;
  timeZone: string;
  now: Date;
  coverage: readonly SimInterval[];
  /** The stored sessions (start to end) and alerts (one instant) of the range. */
  activity: readonly SimInterval[];
  /** How late the provider reports a closed session. */
  reportingDelayHours: number;
  /** The oldest time that can still be fetched: the provider history window or the retention. */
  fetchableSince: Date;
  /** The oldest time still kept: the retention. */
  keptSince: Date;
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar day of an instant in a time zone, YYYY-MM-DD. */
export function zonedDay(at: Date, timeZone: string): string {
  let formatter = dayFormatters.get(timeZone);
  if (formatter == null) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(timeZone, formatter);
  }
  return formatter.format(at);
}

/** The start of a calendar day (YYYY-MM-DD) in a time zone. */
export function zonedDayStart(date: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return zonedMidnight(year, month, day, timeZone);
}

function nextDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/**
 * One entry per calendar day of [from, to] in the station's time zone, saying
 * what the stored SIM data of that day can show: fully fetched with activity
 * (has_data) or without (no_sessions), partly fetched, still inside the
 * provider's reporting delay (pending), never fetched, or no longer fetchable.
 */
export function coveredDays(input: CoveredDaysInput): SimCoveredDay[] {
  const merged = mergeIntervals(input.coverage);
  const pendingSince = input.now.getTime() - input.reportingDelayHours * 3_600_000;
  const days: SimCoveredDay[] = [];
  const last = zonedDay(input.to, input.timeZone);
  let date = zonedDay(input.from, input.timeZone);
  // A guard against an unbounded loop for a malformed range.
  for (let i = 0; i < 400 && date <= last; i += 1, date = nextDay(date)) {
    const start = zonedDayStart(date, input.timeZone);
    const end = zonedDayStart(nextDay(date), input.timeZone);
    days.push({ date, label: dayLabel(input, merged, start, end, pendingSince) });
  }
  return days;
}

function dayLabel(
  input: CoveredDaysInput,
  merged: readonly SimInterval[],
  start: Date,
  end: Date,
  pendingSince: number,
): SimDayLabel {
  if (end.getTime() <= input.keptSince.getTime()) return 'unavailable';
  if (start.getTime() >= pendingSince) return 'pending';
  const checkedEnd = new Date(Math.min(end.getTime(), pendingSince));
  const span = checkedEnd.getTime() - start.getTime();
  const covered = coveredMs(merged, start, checkedEnd);
  if (covered >= span) {
    if (end.getTime() > pendingSince) return 'pending';
    const active = input.activity.some(
      (a) => a.from.getTime() < end.getTime() && a.to.getTime() >= start.getTime(),
    );
    return active ? 'has_data' : 'no_sessions';
  }
  if (covered > 0) return 'partial';
  return end.getTime() <= input.fetchableSince.getTime() ? 'unavailable' : 'not_fetched';
}
