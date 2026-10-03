// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import type { TaxLine } from '@evtivity/lib/price-display';
import { priceExclTax, toOcpiPrice } from '../lib/ocpi-price.js';

const twoRates: TaxLine[] = [
  { taxRate: 0.19, netCents: 280, taxCents: 54 },
  { taxRate: 0.07, netCents: 100, taxCents: 7 },
];

const untaxed: TaxLine[] = [{ taxRate: 0, netCents: 250, taxCents: 0 }];

describe('toOcpiPrice', () => {
  it('sends the net as excl_vat and the amount charged as incl_vat in 2.2.1', () => {
    expect(toOcpiPrice(twoRates, '2.2.1')).toEqual({ excl_vat: 3.8, incl_vat: 4.41 });
    expect(toOcpiPrice(untaxed, '2.2.1')).toEqual({ excl_vat: 2.5, incl_vat: 2.5 });
  });

  it('sends before_taxes and one TaxAmount per rate as a percentage in 2.3.0', () => {
    expect(toOcpiPrice(twoRates, '2.3.0')).toEqual({
      before_taxes: 3.8,
      taxes: [
        { name: 'VAT', percentage: 19, amount: 0.54 },
        { name: 'VAT', percentage: 7, amount: 0.07 },
      ],
    });
  });

  it('leaves taxes out in 2.3.0 when no tax applies', () => {
    expect(toOcpiPrice(untaxed, '2.3.0')).toEqual({ before_taxes: 2.5 });
  });
});

describe('priceExclTax', () => {
  it('reads excl_vat in 2.2.1 and before_taxes in 2.3.0', () => {
    expect(priceExclTax({ excl_vat: 4, incl_vat: 4.4 }, '2.2.1')).toBe(4);
    expect(priceExclTax({ before_taxes: 4, taxes: [] }, '2.3.0')).toBe(4);
  });

  it('rejects a Price of the other version or a non-number', () => {
    expect(priceExclTax({ before_taxes: 4 }, '2.2.1')).toBeNull();
    expect(priceExclTax({ excl_vat: 4 }, '2.3.0')).toBeNull();
    expect(priceExclTax({ excl_vat: '5.00' }, '2.2.1')).toBeNull();
    expect(priceExclTax(5, '2.2.1')).toBeNull();
    expect(priceExclTax(null, '2.2.1')).toBeNull();
  });
});
