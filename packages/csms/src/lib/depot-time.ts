// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Departure times are entered and shown in the depot's time zone, not the
// user's: a bus leaves at 05:30 depot time wherever the operator sits.

import { localDateInZone, scheduleOccurrences } from '@evtivity/lib/departure-schedule';
import { isValidTimezone } from '@evtivity/lib/timezone';
import { uiLocale } from './formatting';

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

function zoneOrUtc(timeZone: string | null | undefined): string {
  return timeZone != null && isValidTimezone(timeZone) ? timeZone : 'UTC';
}

/** The instant (ISO 8601) of a local date `YYYY-MM-DD` and time `HH:MM` at the depot, or null. */
export function depotLocalToIso(
  date: string,
  time: string,
  timeZone: string | null | undefined,
): string | null {
  const [occurrence] = scheduleOccurrences(
    { daysOfWeek: ALL_DAYS, departureTime: time },
    zoneOrUtc(timeZone),
    date,
    1,
  );
  return occurrence == null ? null : new Date(occurrence.departureAtMs).toISOString();
}

/** The local date `YYYY-MM-DD` and time `HH:MM` of an instant at the depot. */
export function isoToDepotLocal(
  iso: string,
  timeZone: string | null | undefined,
): { date: string; time: string } {
  const zone = zoneOrUtc(timeZone);
  const ms = new Date(iso).getTime();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ms);
  const value = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  return { date: localDateInZone(ms, zone), time: `${value('hour')}:${value('minute')}` };
}

/** "05:30" in the UI language's clock (05:30 or 5:30 AM) at the depot. */
export function formatDepotTime(iso: string, timeZone: string | null | undefined): string {
  return new Intl.DateTimeFormat(uiLocale(), {
    timeZone: zoneOrUtc(timeZone),
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** "Tue, Nov 3, 05:30" in the UI language at the depot. */
export function formatDepotDateTime(iso: string, timeZone: string | null | undefined): string {
  return new Intl.DateTimeFormat(uiLocale(), {
    timeZone: zoneOrUtc(timeZone),
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Short weekday names, ISO day 1 (Monday) to 7, in the UI language. */
export function isoWeekdayNames(): string[] {
  const format = new Intl.DateTimeFormat(uiLocale(), { weekday: 'short', timeZone: 'UTC' });
  // 2024-01-01 was a Monday.
  return ALL_DAYS.map((d) => format.format(new Date(Date.UTC(2024, 0, d))));
}

/** A schedule's time `HH:MM` (local at the depot) in the UI language's clock. */
export function formatLocalTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return new Intl.DateTimeFormat(uiLocale(), {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(Date.UTC(2024, 0, 1, h ?? 0, m ?? 0)));
}
