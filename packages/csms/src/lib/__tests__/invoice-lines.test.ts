// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { describeInvoiceLine } from '../invoice-lines';
import { formatTaxPercent } from '../formatting';
import en from '../../i18n/locales/en.json';

/** A t() that resolves English keys and interpolates {{vars}}. */
const t = ((key: string, vars: Record<string, unknown> = {}) => {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], en);
  return String(value).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name]));
}) as unknown as TFunction;

describe('describeInvoiceLine', () => {
  it('labels component lines and their segment', () => {
    expect(describeInvoiceLine({ description: 'x', metadata: { kind: 'idleFee' } }, t, 'en')).toBe(
      'Idle fee',
    );
    expect(
      describeInvoiceLine({ description: 'x', metadata: { kind: 'energy', segment: 2 } }, t, 'en'),
    ).toBe('Segment 2: Energy');
  });

  it('labels session lines with their date and energy', () => {
    expect(
      describeInvoiceLine(
        {
          description: 'x',
          metadata: { kind: 'session', sessionDate: '2026-06-04', energyWh: 12345 },
        },
        t,
        'en',
      ),
    ).toBe('Charging session Jun 4, 2026 (12.35 kWh)');
  });

  it('keeps the stored description without a known kind', () => {
    expect(describeInvoiceLine({ description: 'Legacy', metadata: null }, t, 'en')).toBe('Legacy');
    expect(describeInvoiceLine({ description: 'Legacy', metadata: { kind: 'x' } }, t, 'en')).toBe(
      'Legacy',
    );
  });
});

describe('formatTaxPercent', () => {
  it('formats string and number rates as percentage numbers', () => {
    expect(formatTaxPercent('0.19')).toBe('19');
    expect(formatTaxPercent(0.075)).toBe('7.5');
  });

  it('gets its percent sign from invoices.taxRateValue', () => {
    expect(t('invoices.taxRateValue', { rate: formatTaxPercent('0.19') })).toBe('19%');
  });
});
