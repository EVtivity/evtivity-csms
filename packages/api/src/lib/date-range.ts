// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { ValidationError } from '@evtivity/lib';

export const dateRangeQuery = z.object({
  days: z
    .string()
    .optional()
    .describe(
      'Number of trailing days to include (1-90, defaults to 7). Ignored when both `from` and `to` are provided.',
    ),
  from: z
    .string()
    .optional()
    .describe('Range start as ISO date/datetime. Must be combined with `to`.'),
  to: z
    .string()
    .optional()
    .describe(
      'Range end as ISO date/datetime. Must be combined with `from`. Range cannot exceed 90 days.',
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

  const daysNum = Math.min(Number(days) || 7, 90);
  const since = new Date();
  since.setDate(since.getDate() - daysNum);
  return { since, until: null, daysNum };
}
