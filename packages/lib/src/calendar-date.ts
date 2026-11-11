// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Calendar day helpers for the shared date picker of the CSMS and the portal
// (`DateInput`). A day is a `YYYY-MM-DD` string with no time zone, the value a
// native date input gives, so callers keep their own time zone handling. Every
// computation runs in UTC on noon of the day, so no local offset or daylight
// saving change moves a day.

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of a year, a month (1 to 12) and a day. */
export function isoDay(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

/** The year, month (1 to 12) and day of a valid `YYYY-MM-DD`, else null. */
export function splitIsoDay(value: string): { year: number; month: number; day: number } | null {
  const m = ISO_DAY.exec(value);
  if (m == null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** Whether the value is a real calendar day in `YYYY-MM-DD`. */
export function isIsoDay(value: string): boolean {
  return splitIsoDay(value) != null;
}

/** Days in a month (1 to 12) of a year. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The day `count` days after (or before, negative) a `YYYY-MM-DD` day. */
export function addDays(value: string, count: number): string {
  const parts = splitIsoDay(value);
  if (parts == null) return value;
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + count, 12));
  return isoDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** The month `count` months after a year and month (1 to 12). */
export function addMonths(
  year: number,
  month: number,
  count: number,
): { year: number; month: number } {
  const index = year * 12 + (month - 1) + count;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/**
 * The same day `count` months later, kept inside the target month
 * (31 January plus one month is the last day of February).
 */
export function addMonthsToDay(value: string, count: number): string {
  const parts = splitIsoDay(value);
  if (parts == null) return value;
  const next = addMonths(parts.year, parts.month, count);
  return isoDay(next.year, next.month, Math.min(parts.day, daysInMonth(next.year, next.month)));
}

/** Today in the browser's time zone, `YYYY-MM-DD`. */
export function todayIsoDay(now: Date = new Date()): string {
  return isoDay(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** Day of the week of a `YYYY-MM-DD` day, 0 for Sunday to 6 for Saturday. */
export function weekdayOf(value: string): number {
  const parts = splitIsoDay(value);
  if (parts == null) return 0;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)).getUTCDay();
}

// CLDR firstDay "sun" regions that matter for the UI languages, used where the
// browser has no Intl.Locale week info (Firefox before 145). Every other region
// starts on Monday.
const SUNDAY_FIRST_REGIONS = new Set([
  'US',
  'CA',
  'MX',
  'BR',
  'JP',
  'KR',
  'CN',
  'TW',
  'HK',
  'MO',
  'IL',
  'IN',
  'PH',
  'SA',
  'ZA',
  'AU',
]);
const DEFAULT_REGION: Record<string, string> = {
  en: 'US',
  de: 'DE',
  es: 'ES',
  ko: 'KR',
  zh: 'CN',
};

interface WeekInfoLocale {
  getWeekInfo?: () => { firstDay: number };
  weekInfo?: { firstDay: number };
  maximize?: () => { region?: string };
  language?: string;
  region?: string;
}

/** The first day of the week in a locale, 0 for Sunday to 6 for Saturday. */
export function firstDayOfWeek(locale: string): number {
  try {
    const loc = new Intl.Locale(locale) as unknown as WeekInfoLocale;
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    if (info != null && Number.isInteger(info.firstDay)) return info.firstDay % 7;
    const region =
      loc.region ?? loc.maximize?.().region ?? DEFAULT_REGION[loc.language ?? ''] ?? '';
    return SUNDAY_FIRST_REGIONS.has(region) ? 0 : 1;
  } catch (err: unknown) {
    console.warn('firstDayOfWeek: unsupported locale', locale, err);
    return 1;
  }
}

/**
 * The weeks of a month (1 to 12), each seven cells starting on `firstDay`:
 * the `YYYY-MM-DD` day, or null for a cell outside the month.
 */
export function monthWeeks(year: number, month: number, firstDay: number): (string | null)[][] {
  const lead = (weekdayOf(isoDay(year, month, 1)) - firstDay + 7) % 7;
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  const count = daysInMonth(year, month);
  for (let day = 1; day <= count; day += 1) cells.push(isoDay(year, month, day));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** The order of year, month and day in a locale's numeric date ("m d y" in en-US). */
export function localeDayOrder(locale: string): ('y' | 'm' | 'd')[] {
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'UTC',
    }).formatToParts(new Date(Date.UTC(2000, 10, 22)));
    const order: ('y' | 'm' | 'd')[] = [];
    for (const p of parts) {
      if (p.type === 'year') order.push('y');
      else if (p.type === 'month') order.push('m');
      else if (p.type === 'day') order.push('d');
    }
    if (order.length === 3) return order;
  } catch (err: unknown) {
    console.warn('localeDayOrder: unsupported locale', locale, err);
  }
  return ['y', 'm', 'd'];
}

/**
 * A typed day as `YYYY-MM-DD`, or null when it is not a real day. Takes
 * `YYYY-MM-DD` (any separator) and the locale's numeric form with a four-digit
 * year ("11/22/2026" in en-US, "22.11.2026" in de).
 */
export function parseTypedDay(text: string, locale: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const numbers = trimmed.split(/[^\d]+/).filter((s) => s !== '');
  if (numbers.length !== 3) return null;
  const [a = '', b = '', c = ''] = numbers;
  let year: string;
  let month: string;
  let day: string;
  if (a.length === 4) {
    year = a;
    month = b;
    day = c;
  } else {
    const order = localeDayOrder(locale);
    const byKey: Record<string, string> = {};
    order.forEach((key, i) => {
      byKey[key] = numbers[i] ?? '';
    });
    year = byKey['y'] ?? '';
    month = byKey['m'] ?? '';
    day = byKey['d'] ?? '';
  }
  if (year.length !== 4 || month.length > 2 || day.length > 2) return null;
  const value = isoDay(Number(year), Number(month), Number(day));
  return isIsoDay(value) ? value : null;
}

/** Whether a day lies inside optional `YYYY-MM-DD` bounds. */
export function dayInRange(value: string, min?: string, max?: string): boolean {
  if (min != null && min !== '' && value < min) return false;
  if (max != null && max !== '' && value > max) return false;
  return true;
}
