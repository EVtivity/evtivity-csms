// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  formatLocalizedVariables,
  notificationMoney,
  notificationTaxRate,
  notificationUnitPrice,
} from '../notification-values.js';
import { compileAllowedTemplate } from '../template-safety.js';

describe('notification values', () => {
  it('formats money in the recipient language and currency', () => {
    const vars = formatLocalizedVariables(
      { amountFormatted: notificationMoney(1250, 'EUR'), amountCents: 1250, currency: 'EUR' },
      'de',
    );
    expect(vars['amountFormatted']).toBe('12,50 €');
    // Raw variables stay for operator templates.
    expect(vars['amountCents']).toBe(1250);
    expect(vars['currency']).toBe('EUR');
  });

  it('formats money for English recipients', () => {
    const vars = formatLocalizedVariables({ total: notificationMoney(123456, 'USD') }, 'en');
    expect(vars['total']).toBe('$1,234.56');
  });

  it('formats unit prices with up to 4 digits and tax rates without trailing zeros', () => {
    const vars = formatLocalizedVariables(
      {
        idleFeeFormatted: notificationUnitPrice(0.2561, 'EUR'),
        taxRatePercent: notificationTaxRate(0.075),
      },
      'de',
    );
    expect(vars['idleFeeFormatted']).toBe('0,2561 €');
    expect(vars['taxRatePercent']).toBe('7,5');
  });

  it('leaves other variables unchanged', () => {
    const input = { name: 'x', count: 3, flag: false, empty: '' };
    expect(formatLocalizedVariables(input, 'de')).toEqual(input);
  });

  it('falls back to en-US for an unknown language', () => {
    const vars = formatLocalizedVariables({ a: notificationMoney(500, 'GBP') }, 'not a locale!');
    expect(vars['a']).toBe('£5.00');
  });

  it('renders in the recipient language once formatted', () => {
    const render = compileAllowedTemplate('Paid {{amountFormatted}}');
    const vars = formatLocalizedVariables(
      { amountFormatted: notificationMoney(1250, 'EUR') },
      'es',
    );
    expect(render(vars)).toBe('Paid 12,50\u00a0€');
  });
});
