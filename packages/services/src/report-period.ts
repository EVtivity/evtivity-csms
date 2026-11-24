// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { getCompanyWeekStart, getSystemTimezone } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import {
  applyReportPeriod,
  type ReportPeriod,
  type ReportPeriodOptions,
} from '@evtivity/lib/report-period';
import { reportLocale } from './report-generators/report-locale.js';
import { reportDay } from './report-generators/report-dates.js';

const log = createLogger('report-period');

/** The filters a report runs with for a period, resolved from `anchor` in the company time zone. */
export async function reportFiltersForPeriod(
  period: ReportPeriod,
  filters: Record<string, unknown>,
  anchor: Date,
  options: ReportPeriodOptions = {},
): Promise<Record<string, unknown>> {
  if (period === 'custom') return filters;
  const [timeZone, weekStart] = await Promise.all([getSystemTimezone(), getCompanyWeekStart()]);
  return applyReportPeriod(filters, period, anchor, timeZone, weekStart, options);
}

/** Why a request's period and filters cannot run together, else null. */
export function reportPeriodError(
  reportType: string,
  period: ReportPeriod,
  filters: Record<string, unknown>,
): string | null {
  if (period === 'custom') return null;
  if (reportType === 'nevi') return 'NEVI reports take quarter and year, not a report period';
  if (filters['dateFrom'] !== undefined || filters['dateTo'] !== undefined) {
    return 'dateFrom and dateTo apply only to the custom report period';
  }
  return null;
}

/**
 * The covered period in a recipient's language: "Previous month (Nov 1, 2026
 * to Nov 30, 2026)" for a relative period, the dates alone for custom, or
 * "All time". Falls back to the plain dates when the label cannot be built.
 */
export function reportPeriodText(
  language: string,
  period: ReportPeriod,
  filters: Record<string, unknown>,
): string {
  const dateFrom = reportDay(filters['dateFrom']);
  const dateTo = reportDay(filters['dateTo']);
  try {
    const rl = reportLocale(language, 'pdf');
    const range = rl.range(dateFrom, dateTo, rl.labels.common.allTime);
    if (period === 'custom') return range;
    return `${rl.labels.common.periods[period]} (${range})`;
  } catch (err: unknown) {
    log.warn({ err, language, period }, 'Report period label failed, sending the plain dates');
    if (dateFrom != null && dateTo != null) return `${dateFrom} - ${dateTo}`;
    return dateFrom ?? dateTo ?? '';
  }
}
