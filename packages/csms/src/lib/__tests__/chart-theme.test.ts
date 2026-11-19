// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  categoryChartResponsive,
  formatChartDateLabel,
  PHONE_AXIS_MAX_LABELS,
  PHONE_CHART_BREAKPOINT,
  phoneAxisResponsive,
  phoneCategoryAxis,
} from '../chart-theme';

describe('phoneCategoryAxis', () => {
  // ApexCharts shows label i when i % round(count / (tickAmount + 1)) === 0.
  function shownLabels(count: number): number {
    const axis = phoneCategoryAxis(count);
    if (axis.tickAmount == null) return count;
    const multiple = Math.round(count / (Number(axis.tickAmount) + 1));
    return Array.from({ length: count }, (_, i) => i).filter((i) => i % multiple === 0).length;
  }

  it('rotates the labels by 45 degrees and hides overlapping ones', () => {
    expect(phoneCategoryAxis(5).labels).toEqual({
      rotate: -45,
      rotateAlways: true,
      hideOverlappingLabels: true,
    });
  });

  it('keeps every label up to the phone maximum', () => {
    expect(phoneCategoryAxis(PHONE_AXIS_MAX_LABELS).tickAmount).toBeUndefined();
    expect(shownLabels(8)).toBe(8);
  });

  it('shows at most the phone maximum of labels for every range up to a year', () => {
    for (let count = 1; count <= 366; count++) {
      const shown = shownLabels(count);
      expect(shown, `count ${String(count)}`).toBeLessThanOrEqual(PHONE_AXIS_MAX_LABELS);
      expect(shown, `count ${String(count)}`).toBeGreaterThanOrEqual(
        Math.min(count, Math.floor(PHONE_AXIS_MAX_LABELS / 2)),
      );
    }
  });
});

describe('categoryChartResponsive', () => {
  it('keeps the compact height below 768 px and adds the phone axis below 640 px', () => {
    const [compact, phone] = categoryChartResponsive(30);
    expect(compact).toEqual({ breakpoint: 768, options: { chart: { height: 250 } } });
    expect(phone?.breakpoint).toBe(PHONE_CHART_BREAKPOINT);
    expect(phone?.options).toMatchObject({
      chart: { height: 250 },
      xaxis: { tickAmount: 9, labels: { rotate: -45, rotateAlways: true } },
    });
  });

  it('passes other phone options through phoneAxisResponsive', () => {
    const entry = phoneAxisResponsive(12, { options: { dataLabels: { enabled: false } } });
    expect(entry.options).toMatchObject({
      dataLabels: { enabled: false },
      xaxis: { tickAmount: 5 },
    });
    expect(entry.options).not.toHaveProperty('chart');
  });
});

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
