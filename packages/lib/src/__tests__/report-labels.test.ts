// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { fillReportLabel, getReportLabels } from '../report-labels.js';
import { UI_LANGUAGES } from '../languages.js';

/** Dotted paths of every leaf string, e.g. "revenue.sheets.byDay". */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafPaths(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

function leafValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Object.values(value as Record<string, unknown>).flatMap(leafValues);
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
}

describe('report labels', () => {
  const en = getReportLabels('en');
  const enPaths = leafPaths(en).sort();

  it.each(UI_LANGUAGES)('%s has exactly the English keys, all non-empty', (language) => {
    const labels = getReportLabels(language);
    expect(leafPaths(labels).sort()).toEqual(enPaths);
    for (const text of leafValues(labels)) expect(text.trim()).not.toBe('');
  });

  it.each(UI_LANGUAGES)('%s keeps the placeholders of each English label', (language) => {
    const labels = getReportLabels(language) as unknown as Record<string, unknown>;
    for (const path of enPaths) {
      const get = (root: unknown): string =>
        path
          .split('.')
          .reduce((node, key) => (node as Record<string, unknown>)[key], root) as string;
      expect(placeholders(get(labels)), `${language} ${path}`).toEqual(placeholders(get(en)));
    }
  });

  it.each(UI_LANGUAGES)('%s sheet names are valid XLSX worksheet names', (language) => {
    const labels = getReportLabels(language);
    const reports = [
      labels.revenue,
      labels.energy,
      labels.driverActivity,
      labels.sessions,
      labels.utilization,
      labels.stationHealth,
      labels.sustainability,
    ];
    for (const report of reports) {
      for (const name of Object.values(report.sheets)) {
        expect(name.length).toBeLessThanOrEqual(31);
        expect(name).not.toMatch(/[[\]:*?/\\]/);
      }
    }
  });

  it('uses each language locale for formatting', () => {
    expect(UI_LANGUAGES.map((l) => getReportLabels(l).locale)).toEqual([
      'en-US',
      'de-DE',
      'es-ES',
      'ko-KR',
      'zh-CN',
      'zh-TW',
    ]);
  });

  it('falls back to English for an unknown or missing language', () => {
    expect(getReportLabels('fr')).toBe(en);
    expect(getReportLabels(null)).toBe(en);
    expect(getReportLabels(undefined)).toBe(en);
  });

  it('fills placeholders and leaves unknown ones in place', () => {
    expect(fillReportLabel('{from} to {to}', { from: 'a', to: 'b' })).toBe('a to b');
    expect(fillReportLabel('{value} {unit}', { value: '1' })).toBe('1 {unit}');
  });
});
