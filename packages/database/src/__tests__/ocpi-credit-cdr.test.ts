// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({ db: {} }));

const { creditCdrData, negateOcpiPrice } = await import('../lib/ocpi-credit-cdr.js');

describe('negateOcpiPrice', () => {
  it('negates a 2.2.1 Price', () => {
    expect(negateOcpiPrice({ excl_vat: 4, incl_vat: 4.76 })).toEqual({
      excl_vat: -4,
      incl_vat: -4.76,
    });
    expect(negateOcpiPrice({ excl_vat: 4 })).toEqual({ excl_vat: -4 });
  });

  it('negates a 2.3.0 Price including every tax amount', () => {
    expect(
      negateOcpiPrice({
        before_taxes: 4,
        taxes: [
          { name: 'VAT', percentage: 19, amount: 0.57 },
          { name: 'VAT', percentage: 7, amount: 0.07 },
        ],
      }),
    ).toEqual({
      before_taxes: -4,
      taxes: [
        { name: 'VAT', percentage: 19, amount: -0.57 },
        { name: 'VAT', percentage: 7, amount: -0.07 },
      ],
    });
    expect(negateOcpiPrice({ before_taxes: 4 })).toEqual({ before_taxes: -4 });
  });

  it('returns null for a value that is not a Price', () => {
    expect(negateOcpiPrice(null)).toBeNull();
    expect(negateOcpiPrice({ total: 4 })).toBeNull();
    expect(negateOcpiPrice(4)).toBeNull();
  });
});

describe('creditCdrData', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  const original = {
    id: 'cdr-1',
    total_cost: { excl_vat: 4, incl_vat: 4.76 },
    total_energy_cost: { excl_vat: 3, incl_vat: 3.57 },
    total_fixed_cost: { excl_vat: 1, incl_vat: 1.19 },
    total_energy: 10,
    last_updated: '2026-09-01T11:00:00.000Z',
  };

  it('negates only total_cost and keeps every other field of the original (OCPI 10.1.1)', () => {
    expect(creditCdrData(original, 'cdr-1', 'cdr-2', 'wrong tariff', now)).toEqual({
      ...original,
      id: 'cdr-2',
      credit: true,
      credit_reference_id: 'cdr-1',
      remark: 'wrong tariff',
      total_cost: { excl_vat: -4, incl_vat: -4.76 },
      last_updated: '2026-10-02T12:00:00.000Z',
    });
  });

  it('credits a 2.3.0 CDR in its own Price shape', () => {
    const credit = creditCdrData(
      { id: 'cdr-1', total_cost: { before_taxes: 4, taxes: [{ name: 'VAT', amount: 0.76 }] } },
      'cdr-1',
      'cdr-2',
      'x',
      now,
    );
    expect(credit?.['total_cost']).toEqual({
      before_taxes: -4,
      taxes: [{ name: 'VAT', amount: -0.76 }],
    });
  });

  it('returns null for a stored CDR without total_cost', () => {
    expect(creditCdrData({ id: 'cdr-1' }, 'cdr-1', 'cdr-2', 'x', now)).toBeNull();
  });
});
