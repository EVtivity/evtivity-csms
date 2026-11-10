// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  formatDate as formatLocaleDate,
  formatDateTime as formatLocaleDateTime,
  formatRelativeTime as formatLocaleRelativeTime,
} from '@evtivity/lib/timezone';
import { useAuth } from './auth';
import { uiLocale } from './formatting';

/**
 * Format date and time in the time zone and the UI language, e.g.
 * "Mar 5, 2026, 9:04:09 AM" (en) or "05.03.2026, 09:04:09" (de).
 */
export function formatDateTime(
  timestamp: string | Date,
  timezone: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return formatLocaleDateTime(timestamp, timezone, options, uiLocale());
}

/** Format the date in the time zone and the UI language, e.g. "Mar 5, 2026" or "05.03.2026". */
export function formatDate(
  timestamp: string | Date,
  timezone: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return formatLocaleDate(timestamp, timezone, options, uiLocale());
}

/** Chart axis and tooltip time (epoch ms) without year and seconds, in the time zone and UI language. */
export function formatChartTime(timestamp: number, timezone: string): string {
  return formatDateTime(new Date(timestamp), timezone, {
    year: undefined,
    second: undefined,
    month: 'short',
    day: 'numeric',
  });
}

/** Format a past timestamp relative to now in the UI language, e.g. "5m ago" or "vor 5 m". */
export function formatRelativeTime(timestamp: string | Date, timezone: string): string {
  return formatLocaleRelativeTime(timestamp, timezone, uiLocale());
}

// The zone list lives in its own module so pickers import it without the auth store.
export { TIMEZONE_OPTIONS } from './timezone-options';

export function useUserTimezone(): string {
  const user = useAuth((s) => s.user);
  return user?.timezone ?? 'America/New_York';
}
