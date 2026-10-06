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

/** Format a past timestamp relative to now in the UI language, e.g. "5m ago" or "vor 5 m". */
export function formatRelativeTime(timestamp: string | Date, timezone: string): string {
  return formatLocaleRelativeTime(timestamp, timezone, uiLocale());
}

export const TIMEZONE_OPTIONS = [
  // UTC
  { value: 'UTC', label: 'UTC' },

  // Americas
  { value: 'America/St_Johns', label: 'Newfoundland (St. Johns)' },
  { value: 'America/Halifax', label: 'Atlantic (Halifax)' },
  { value: 'America/New_York', label: 'Eastern (New York)' },
  { value: 'America/Chicago', label: 'Central (Chicago)' },
  { value: 'America/Denver', label: 'Mountain (Denver)' },
  { value: 'America/Phoenix', label: 'Arizona (Phoenix)' },
  { value: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { value: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
  { value: 'America/Mexico_City', label: 'Mexico City' },
  { value: 'America/Bogota', label: 'Bogota' },
  { value: 'America/Lima', label: 'Lima' },
  { value: 'America/Caracas', label: 'Caracas' },
  { value: 'America/Santiago', label: 'Santiago' },
  { value: 'America/Buenos_Aires', label: 'Buenos Aires' },
  { value: 'America/Sao_Paulo', label: 'Sao Paulo' },

  // Europe
  { value: 'Atlantic/Reykjavik', label: 'Reykjavik' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Dublin', label: 'Dublin' },
  { value: 'Europe/Lisbon', label: 'Lisbon' },
  { value: 'Europe/Paris', label: 'Paris' },
  { value: 'Europe/Berlin', label: 'Berlin' },
  { value: 'Europe/Brussels', label: 'Brussels' },
  { value: 'Europe/Amsterdam', label: 'Amsterdam' },
  { value: 'Europe/Zurich', label: 'Zurich' },
  { value: 'Europe/Rome', label: 'Rome' },
  { value: 'Europe/Madrid', label: 'Madrid' },
  { value: 'Europe/Vienna', label: 'Vienna' },
  { value: 'Europe/Warsaw', label: 'Warsaw' },
  { value: 'Europe/Prague', label: 'Prague' },
  { value: 'Europe/Stockholm', label: 'Stockholm' },
  { value: 'Europe/Oslo', label: 'Oslo' },
  { value: 'Europe/Copenhagen', label: 'Copenhagen' },
  { value: 'Europe/Helsinki', label: 'Helsinki' },
  { value: 'Europe/Bucharest', label: 'Bucharest' },
  { value: 'Europe/Athens', label: 'Athens' },
  { value: 'Europe/Istanbul', label: 'Istanbul' },
  { value: 'Europe/Moscow', label: 'Moscow' },
  { value: 'Europe/Kyiv', label: 'Kyiv' },

  // Africa
  { value: 'Africa/Cairo', label: 'Cairo' },
  { value: 'Africa/Lagos', label: 'Lagos' },
  { value: 'Africa/Nairobi', label: 'Nairobi' },
  { value: 'Africa/Johannesburg', label: 'Johannesburg' },
  { value: 'Africa/Casablanca', label: 'Casablanca' },

  // Middle East
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Asia/Riyadh', label: 'Riyadh' },
  { value: 'Asia/Tehran', label: 'Tehran' },
  { value: 'Asia/Jerusalem', label: 'Jerusalem' },

  // Asia
  { value: 'Asia/Karachi', label: 'Karachi' },
  { value: 'Asia/Kolkata', label: 'Kolkata' },
  { value: 'Asia/Dhaka', label: 'Dhaka' },
  { value: 'Asia/Bangkok', label: 'Bangkok' },
  { value: 'Asia/Jakarta', label: 'Jakarta' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Kuala_Lumpur', label: 'Kuala Lumpur' },
  { value: 'Asia/Hong_Kong', label: 'Hong Kong' },
  { value: 'Asia/Shanghai', label: 'Shanghai' },
  { value: 'Asia/Taipei', label: 'Taipei' },
  { value: 'Asia/Seoul', label: 'Seoul' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },

  // Oceania
  { value: 'Australia/Perth', label: 'Perth' },
  { value: 'Australia/Adelaide', label: 'Adelaide' },
  { value: 'Australia/Sydney', label: 'Sydney' },
  { value: 'Australia/Brisbane', label: 'Brisbane' },
  { value: 'Pacific/Auckland', label: 'Auckland' },
  { value: 'Pacific/Fiji', label: 'Fiji' },
] as const;

export function useUserTimezone(): string {
  const user = useAuth((s) => s.user);
  return user?.timezone ?? 'America/New_York';
}
