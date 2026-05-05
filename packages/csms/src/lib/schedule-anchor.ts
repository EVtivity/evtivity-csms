// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Helpers to translate between OCPP charging schedule offsets (seconds-from-startSchedule)
// and wall-clock time-of-day in the user's timezone. Targets Daily Recurring schedules,
// where the schedule cycles every 86400 seconds.

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function getTzHourMinute(date: Date, timezone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minuteStr = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const hour = parseInt(hourStr, 10) % 24;
  const minute = parseInt(minuteStr, 10);
  return { hour, minute };
}

function tzSecondsOfDay(date: Date, timezone: string): number {
  const { hour, minute } = getTzHourMinute(date, timezone);
  return hour * 3600 + minute * 60;
}

// Convert an OCPP offset (seconds-from-startSchedule) to an HH:MM string in the user's TZ.
// When startSchedule is null, treats the offset as a raw time-of-day fallback.
export function offsetToWallClockHHMM(
  startScheduleIso: string | null,
  offsetSec: number,
  timezone: string,
): string {
  if (startScheduleIso == null) {
    const h = Math.floor(offsetSec / 3600) % 24;
    const m = Math.floor((offsetSec % 3600) / 60);
    return `${pad2(h)}:${pad2(m)}`;
  }
  const ms = new Date(startScheduleIso).getTime() + offsetSec * 1000;
  const { hour, minute } = getTzHourMinute(new Date(ms), timezone);
  return `${pad2(hour)}:${pad2(minute)}`;
}

// Convert an HH:MM wall-clock pick (in the user's TZ) to an OCPP offset
// from startSchedule. Modulo-86400, so this is valid for Daily Recurring schedules.
export function wallClockHHMMToOffset(
  startScheduleIso: string | null,
  hhmm: string,
  timezone: string,
): number {
  const parts = hhmm.split(':');
  const targetSec =
    (parseInt(parts[0] ?? '0', 10) * 3600 + parseInt(parts[1] ?? '0', 10) * 60) % 86400;
  if (startScheduleIso == null) return targetSec;
  const anchorSec = tzSecondsOfDay(new Date(startScheduleIso), timezone);
  return (targetSec - anchorSec + 86400) % 86400;
}

// Returns a Date for midnight in the given timezone on the same calendar day as refDate.
// Iterative refinement converges within two passes even across DST boundaries.
export function midnightInTimezone(timezone: string, refDate: Date = new Date()): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const ymd = fmt.format(refDate);
  const target = Date.UTC(
    parseInt(ymd.slice(0, 4), 10),
    parseInt(ymd.slice(5, 7), 10) - 1,
    parseInt(ymd.slice(8, 10), 10),
    0,
    0,
    0,
  );
  let candidate = new Date(target);
  for (let i = 0; i < 3; i++) {
    const sec = tzSecondsOfDay(candidate, timezone);
    if (sec === 0) return candidate;
    const adjust = sec > 43200 ? 86400 - sec : -sec;
    candidate = new Date(candidate.getTime() + adjust * 1000);
  }
  return candidate;
}

// Format a Date as a value usable by an <input type="datetime-local"> control,
// reflecting the user's timezone (YYYY-MM-DDTHH:MM).
export function toDatetimeLocalInTimezone(date: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const year = parts['year'] ?? '1970';
  const month = parts['month'] ?? '01';
  const day = parts['day'] ?? '01';
  const hourRaw = parts['hour'] ?? '00';
  const hour = hourRaw === '24' ? '00' : hourRaw;
  const minute = parts['minute'] ?? '00';
  return `${year}-${month}-${day}T${hour}:${minute}`;
}
