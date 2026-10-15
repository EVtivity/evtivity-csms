// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { formatChartDateLabel } from '../chart-theme';

describe('formatChartDateLabel', () => {
  it('formats YYYY-MM-DD strings as day and month in the UI language without timezone shift', () => {
    expect(formatChartDateLabel('2026-05-30')).toBe('5/30');
    expect(formatChartDateLabel('2026-12-01')).toBe('12/1');
  });

  it('follows the UI language', async () => {
    const i18next = (await import('i18next')).default;
    await i18next.init({ lng: 'de', resources: {} });
    try {
      expect(formatChartDateLabel('2026-05-30')).toBe('30.5.');
    } finally {
      await i18next.changeLanguage('en');
    }
  });

  it('passes through non-date strings', () => {
    expect(formatChartDateLabel('Mon')).toBe('Mon');
  });

  it('does not crash when ApexCharts passes a number', () => {
    // Line charts convert date-like categories to a numeric axis and call
    // the formatter with numbers; a throw here blanks the whole chart.
    expect(formatChartDateLabel(3)).toBe('3');
  });

  it('does not crash when ApexCharts passes undefined', () => {
    expect(formatChartDateLabel(undefined)).toBe('');
  });
});
