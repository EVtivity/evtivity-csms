// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPdfCanRender } = vi.hoisted(() => ({ mockPdfCanRender: vi.fn(() => true) }));
vi.mock('../cjk-fonts.js', () => ({ pdfCanRender: mockPdfCanRender }));

import { reportLocale } from '../report-generators/report-locale.js';
import {
  csvRows,
  dateCell,
  fixedCell,
  moneyCell,
  pdfRows,
  percentCell,
} from '../report-generators/report-cells.js';

/** Intl uses no-break spaces in some locales; compare with plain spaces. */
const plain = (text: string): string => text.replace(/[\u00a0\u202f]/g, ' ');

beforeEach(() => {
  mockPdfCanRender.mockReturnValue(true);
});

describe('reportLocale', () => {
  it('formats numbers, percentages, money and dates in the language locale', () => {
    const en = reportLocale('en', 'pdf');
    const de = reportLocale('de', 'pdf');

    expect(en.number(1234.5)).toBe('1,234.5');
    expect(de.number(1234.5)).toBe('1.234,5');
    expect(de.number(12.3, 2)).toBe('12,30');
    expect(en.percent(12.5)).toBe('12.5%');
    expect(plain(de.percent(12.5))).toBe('12,5 %');
    expect(plain(de.money(123450, 'EUR'))).toBe('1.234,50 €');
    expect(en.money(123450, 'USD')).toBe('$1,234.50');
    expect(en.date('2026-01-05')).toBe('01/05/2026');
    expect(de.date('2026-01-05')).toBe('05.01.2026');
    expect(reportLocale('zh', 'pdf').date('2026-01-05')).toBe('2026/01/05');
  });

  it('formats a wall-clock date and time without shifting it', () => {
    expect(reportLocale('de', 'pdf').date('2026-01-05 14:30:00.123456')).toBe('05.01.2026, 14:30');
  });

  it('leaves a value that is not a date unchanged', () => {
    expect(reportLocale('de', 'pdf').date('n/a')).toBe('n/a');
  });

  it('names ISO weekdays in the language', () => {
    expect(reportLocale('en', 'csv').weekday(1)).toBe('Mon');
    expect(reportLocale('en', 'csv').weekday(7)).toBe('Sun');
    expect(reportLocale('de', 'csv').weekday(1)).toBe('Mo');
  });

  it('builds the period line from the date filters', () => {
    const en = reportLocale('en', 'pdf');
    const de = reportLocale('de', 'pdf');
    expect(en.period(undefined, undefined, en.labels.common.allTime)).toBe('Period: All time');
    expect(de.period('2026-01-01', '2026-01-31', de.labels.common.allTime)).toBe(
      'Zeitraum: 01.01.2026 bis 31.01.2026',
    );
    expect(en.period('2026-01-01', undefined, '')).toBe('Period: From 01/01/2026');
    expect(en.period(undefined, '2026-01-31', '')).toBe('Period: Until 01/31/2026');
  });

  it('writes summary labels and money headers', () => {
    const zh = reportLocale('zh', 'pdf');
    expect(zh.summary(zh.labels.revenue.summary.totalTax)).toBe('总税额：');
    const en = reportLocale('en', 'csv');
    expect(en.moneyHeader('Revenue', 'EUR', en.labels.common.inclTax)).toBe(
      'Revenue (incl. tax, EUR)',
    );
    expect(en.moneyHeader('Total', 'EUR')).toBe('Total (EUR)');
  });

  it('falls back to English for an unknown language', () => {
    expect(reportLocale('fr', 'csv').language).toBe('en');
    expect(reportLocale(null, 'csv').language).toBe('en');
  });

  it('renders a CJK PDF in English when the fonts are missing, other formats unchanged', () => {
    mockPdfCanRender.mockReturnValue(false);
    expect(reportLocale('ko', 'pdf').language).toBe('en');
    expect(reportLocale('ko', 'csv').language).toBe('ko');
    expect(reportLocale('ko', 'xlsx').labels.revenue.title).toBe('매출 보고서');
  });
});

describe('report cells', () => {
  const rows = [
    [
      'Site A',
      moneyCell(123450, 'EUR'),
      fixedCell(12.3, 2),
      percentCell(42.5),
      dateCell('2026-01-05'),
      1234,
    ],
  ];

  it('keeps CSV values machine-readable', () => {
    expect(csvRows(rows)).toEqual([['Site A', '1234.50', '12.30', 42.5, '2026-01-05', 1234]]);
  });

  it('formats PDF values in the report language', () => {
    const [row] = pdfRows(rows, reportLocale('de', 'pdf'));
    expect((row ?? []).map((v) => plain(String(v)))).toEqual([
      'Site A',
      '1.234,50 €',
      '12,30',
      '42,5 %',
      '05.01.2026',
      '1.234',
    ]);
  });
});
