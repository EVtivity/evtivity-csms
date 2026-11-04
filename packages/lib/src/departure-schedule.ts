// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { isValidTimezone, zoneOffsetMs } from './timezone.js';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The most days one call expands; a larger request is cut to this. */
export const MAX_SCHEDULE_DAYS = 400;

export interface WeeklyDepartureSchedule {
  /** ISO days, 1 (Monday) to 7 (Sunday). */
  daysOfWeek: readonly number[];
  /** `HH:MM` local time of the site. */
  departureTime: string;
  /** Inclusive local dates, `YYYY-MM-DD`. */
  validFrom?: string | null;
  validTo?: string | null;
}

export interface DepartureOccurrence {
  /** The local date of the occurrence, `YYYY-MM-DD`. */
  occurrenceDate: string;
  departureAtMs: number;
}

function zoneOrUtc(timeZone: string): string {
  return isValidTimezone(timeZone) ? timeZone : 'UTC';
}

function offsetAt(ms: number, timeZone: string): number {
  return zoneOffsetMs(new Date(ms), timeZone);
}

/**
 * The instant of a local wall-clock time. On the fall back day the first of the
 * two instants wins; a time inside the spring forward gap moves to the gap end.
 */
function localTimeToMs(localMs: number, timeZone: string): number {
  const before = offsetAt(localMs - DAY_MS, timeZone);
  const after = offsetAt(localMs + DAY_MS, timeZone);
  const valid = [localMs - before, localMs - after].filter(
    (t) => offsetAt(t, timeZone) === localMs - t,
  );
  if (valid.length > 0) return Math.min(...valid);
  let lo = Math.min(localMs - before, localMs - after);
  let hi = Math.max(localMs - before, localMs - after);
  while (hi - lo > MINUTE_MS) {
    const mid = Math.floor((lo + hi) / 2 / MINUTE_MS) * MINUTE_MS;
    if (mid <= lo) break;
    if (offsetAt(mid, timeZone) === after) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The local calendar date of an instant, `YYYY-MM-DD` (UTC for an unknown timezone). */
export function localDateInZone(atMs: number, timeZone: string): string {
  const zone = zoneOrUtc(timeZone);
  return new Date(atMs + offsetAt(atMs, zone)).toISOString().slice(0, 10);
}

/**
 * Departures of a weekly schedule on `days` local dates from `fromDate`, in the
 * site timezone (UTC when the timezone is unknown).
 */
export function scheduleOccurrences(
  schedule: WeeklyDepartureSchedule,
  timeZone: string,
  fromDate: string,
  days: number,
): DepartureOccurrence[] {
  const date = DATE_PATTERN.exec(fromDate);
  const time = TIME_PATTERN.exec(schedule.departureTime);
  if (date == null || time == null) return [];
  const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
  const start = Date.UTC(year, month - 1, day);
  if (new Date(start).toISOString().slice(0, 10) !== fromDate) return [];
  const minutes = Number(time[1]) * 60 + Number(time[2]);
  const zone = zoneOrUtc(timeZone);
  const weekdays = new Set(schedule.daysOfWeek);
  const occurrences: DepartureOccurrence[] = [];
  const count = Number.isFinite(days) ? Math.min(MAX_SCHEDULE_DAYS, Math.floor(days)) : 0;
  for (let i = 0; i < count; i += 1) {
    const midnight = start + i * DAY_MS;
    const occurrenceDate = new Date(midnight).toISOString().slice(0, 10);
    const isoDay = new Date(midnight).getUTCDay() || 7;
    if (!weekdays.has(isoDay)) continue;
    if (schedule.validFrom != null && occurrenceDate < schedule.validFrom) continue;
    if (schedule.validTo != null && occurrenceDate > schedule.validTo) continue;
    occurrences.push({
      occurrenceDate,
      departureAtMs: localTimeToMs(midnight + minutes * MINUTE_MS, zone),
    });
  }
  return occurrences;
}
