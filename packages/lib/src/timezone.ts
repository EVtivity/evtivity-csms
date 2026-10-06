// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Locale-aware date and time formatting in a given time zone. Browser-safe (no
 * Node imports), so the CSMS and portal can import it via `@evtivity/lib/timezone`.
 */

import { resolveLocale } from './number.js';

const DEFAULT_DATE_TIME_FIELDS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
};

const DEFAULT_DATE_FIELDS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
};

/**
 * Without options the locale's own medium style is used. Options with
 * dateStyle/timeStyle are used as given (Intl rejects mixing them with single
 * fields); other options are merged into the numeric field defaults.
 */
function resolveOptions(
  options: Intl.DateTimeFormatOptions | undefined,
  styleDefaults: Intl.DateTimeFormatOptions,
  fieldDefaults: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormatOptions {
  if (options == null) return styleDefaults;
  if (options.dateStyle != null || options.timeStyle != null) return options;
  return { ...fieldDefaults, ...options };
}

/**
 * Formats date and time in the time zone and locale, by default in the locale's
 * medium style, e.g. "Mar 5, 2026, 9:04:09 AM" (en) or "05.03.2026, 09:04:09" (de).
 */
export function formatDateTime(
  timestamp: string | Date,
  timezone: string,
  options?: Intl.DateTimeFormatOptions,
  locale = 'en-US',
): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return date.toLocaleString(resolveLocale(locale), {
    timeZone: timezone,
    ...resolveOptions(
      options,
      { dateStyle: 'medium', timeStyle: 'medium' },
      DEFAULT_DATE_TIME_FIELDS,
    ),
  });
}

/**
 * Formats the date in the time zone and locale, by default in the locale's
 * medium style, e.g. "Mar 5, 2026" (en) or "05.03.2026" (de).
 */
export function formatDate(
  timestamp: string | Date,
  timezone: string,
  options?: Intl.DateTimeFormatOptions,
  locale = 'en-US',
): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return date.toLocaleDateString(resolveLocale(locale), {
    timeZone: timezone,
    ...resolveOptions(options, { dateStyle: 'medium' }, DEFAULT_DATE_FIELDS),
  });
}

/**
 * Formats a past timestamp relative to now, e.g. "5m ago" (en) or "vor 5 m" (de),
 * and as date and time once it is 24 hours or older.
 */
export function formatRelativeTime(
  timestamp: string | Date,
  timezone: string,
  locale = 'en-US',
): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const formatter = new Intl.RelativeTimeFormat(resolveLocale(locale), { style: 'narrow' });

  if (diffSec < 60) return formatter.format(-diffSec, 'second');
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return formatter.format(-diffMin, 'minute');
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return formatter.format(-diffHr, 'hour');
  return formatDateTime(timestamp, timezone, undefined, locale);
}

export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
