// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { formatCurrencyAmount } from '@evtivity/lib';
import { isUiLanguage, type UiLanguage } from '@evtivity/lib/languages';
import { fillReportLabel, getReportLabels, type ReportLabels } from '@evtivity/lib/report-labels';
import { pdfCanRender } from '../cjk-fonts.js';

/**
 * The language of one report file: its labels (`@evtivity/lib/report-labels`)
 * and the formatting of numbers, money and dates for the PDF. CSV and XLSX
 * values stay machine-readable (report-cells.ts); only their labels change.
 */
export interface ReportLocale {
  language: UiLanguage;
  labels: ReportLabels;
  /** BCP 47 locale for Intl formatting. */
  locale: string;
  fill: (template: string, values: Record<string, string>) => string;
  /** A number; with `fractionDigits`, exactly that many decimals, else up to 2. */
  number: (value: number, fractionDigits?: number) => string;
  /** A value in percent units: 12.5 -> "12.5%" (en), "12,5 %" (de). */
  percent: (value: number) => string;
  money: (cents: number, currency: string) => string;
  /** A calendar date (YYYY-MM-DD) or a wall-clock date and time (YYYY-MM-DD HH:MM[:SS]). */
  date: (value: string) => string;
  /** ISO weekday name: 1 Monday ... 7 Sunday. */
  weekday: (isoDay: number) => string;
  /** "Period: ..." for the date filters, or the fallback when none is set. */
  period: (from: string | undefined, to: string | undefined, fallback: string) => string;
  /** A summary line label: "Total Sessions:". */
  summary: (label: string) => string;
  /** A money column header with the currency code: "Revenue (incl. tax, EUR)". */
  moneyHeader: (label: string, currency: string, qualifier?: string) => string;
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/**
 * The locale of a report file. Any value that is not a UI language gets
 * English. A Korean or Chinese PDF without the CJK fonts falls back to English
 * so it never draws missing glyphs.
 */
export function reportLocale(language: string | null | undefined, format: string): ReportLocale {
  let lang: UiLanguage = isUiLanguage(language) ? language : 'en';
  if (format === 'pdf' && !pdfCanRender(lang)) lang = 'en';
  const labels = getReportLabels(lang);
  const locale = labels.locale;

  const dateFormat = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  });
  const dateTimeFormat = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });

  const number = (value: number, fractionDigits?: number): string =>
    new Intl.NumberFormat(
      locale,
      fractionDigits != null
        ? { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }
        : { maximumFractionDigits: 2 },
    ).format(value);

  // Wall-clock values (already in the system timezone) are formatted as UTC so
  // Intl does not shift them again.
  const date = (value: string): string => {
    const m = DATE_TIME.exec(value);
    if (m == null) return value;
    const [, y, mo, d, h, mi, s] = m;
    const utc = Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h ?? 0),
      Number(mi ?? 0),
      Number(s ?? 0),
    );
    return (h != null ? dateTimeFormat : dateFormat).format(new Date(utc));
  };

  const fill = fillReportLabel;

  return {
    language: lang,
    labels,
    locale,
    fill,
    number,
    percent: (value) =>
      new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(
        value / 100,
      ),
    money: (cents, currency) => formatCurrencyAmount(cents, currency, locale),
    date,
    // 2024-01-01 was a Monday.
    weekday: (isoDay) => weekdayFormat.format(new Date(Date.UTC(2024, 0, isoDay))),
    period: (from, to, fallback) => {
      const c = labels.common;
      let period = fallback;
      if (from != null && to != null) period = fill(c.range, { from: date(from), to: date(to) });
      else if (from != null) period = fill(c.since, { from: date(from) });
      else if (to != null) period = fill(c.until, { to: date(to) });
      return fill(c.period, { period });
    },
    summary: (label) => fill(labels.common.summaryLabel, { label }),
    moneyHeader: (label, currency, qualifier) =>
      qualifier != null ? `${label} (${qualifier}, ${currency})` : `${label} (${currency})`,
  };
}
