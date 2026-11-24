// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { addDays, isIsoDay, splitIsoDay } from '@evtivity/lib/calendar-date';
import { zonedMidnight } from '@evtivity/lib/timezone';

/** A report filter day (`YYYY-MM-DD`), else undefined. */
export function reportDay(value: unknown): string | undefined {
  return typeof value === 'string' && isIsoDay(value) ? value : undefined;
}

function dayStart(day: string, timeZone: string): Date {
  const parts = splitIsoDay(day);
  if (parts == null) throw new Error(`Invalid report day ${day}`);
  return zonedMidnight(parts.year, parts.month, parts.day, timeZone);
}

/** Instants of an inclusive day range in the company time zone; `until` is exclusive. */
export function reportDayBounds(
  dateFrom: string | undefined,
  dateTo: string | undefined,
  timeZone: string,
): { from: Date | null; until: Date | null } {
  return {
    from: dateFrom != null ? dayStart(dateFrom, timeZone) : null,
    until: dateTo != null ? dayStart(addDays(dateTo, 1), timeZone) : null,
  };
}

export function reportFileName(
  base: string,
  dateFrom: string | undefined,
  dateTo: string | undefined,
  ext: string,
): string {
  if (dateFrom != null && dateTo != null) return `${base}-${dateFrom}-to-${dateTo}.${ext}`;
  if (dateFrom != null) return `${base}-from-${dateFrom}.${ext}`;
  if (dateTo != null) return `${base}-until-${dateTo}.${ext}`;
  return `${base}-${String(Date.now())}.${ext}`;
}
