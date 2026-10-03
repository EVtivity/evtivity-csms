// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Shapes amounts into the OCPI Price class of the negotiated version and reads
// them back. Tax math lives in @evtivity/lib/price-display; this module only
// formats tax lines (net and tax in cents per tax rate) for the wire.

import { taxTotals, vatPercentFromFraction } from '@evtivity/lib/price-display';
import type { TaxLine } from '@evtivity/lib/price-display';
import type { OcpiVersion, OcpiVersionedPrice } from '../types/ocpi.js';

/** The tax name sent in 2.3.0 TaxAmount objects. */
export const OCPI_TAX_NAME = 'VAT';

/** The split costs a CDR carries: the total and, when known, each dimension. */
export interface OcpiCdrCost {
  total: TaxLine[];
  energy?: TaxLine[];
  time?: TaxLine[];
  fixed?: TaxLine[];
  parking?: TaxLine[];
  reservation?: TaxLine[];
}

function centsToAmount(cents: number): number {
  return cents / 100;
}

/**
 * Tax lines (one per tax rate) as an OCPI Price.
 * - 2.2.1 (Price class): `excl_vat` is the net amount, `incl_vat` the gross.
 * - 2.3.0 (§17.8 Price class): `before_taxes` is the net amount and `taxes`
 *   holds one TaxAmount per tax rate with its percentage (§17.9). A line
 *   without tax (rate 0) is not an applicable tax and is left out.
 */
export function toOcpiPrice(lines: readonly TaxLine[], version: OcpiVersion): OcpiVersionedPrice {
  const totals = taxTotals(lines);
  if (version === '2.3.0') {
    const taxes = lines
      .filter((l) => l.taxRate !== 0)
      .map((l) => ({
        name: OCPI_TAX_NAME,
        percentage: vatPercentFromFraction(l.taxRate),
        amount: centsToAmount(l.taxCents),
      }));
    return taxes.length > 0
      ? { before_taxes: centsToAmount(totals.netCents), taxes }
      : { before_taxes: centsToAmount(totals.netCents) };
  }
  return { excl_vat: centsToAmount(totals.netCents), incl_vat: centsToAmount(totals.grossCents) };
}

/**
 * The amount excluding taxes of a partner's Price: `excl_vat` in 2.2.1,
 * `before_taxes` in 2.3.0. Null when the field is missing or not a number.
 */
export function priceExclTax(price: unknown, version: OcpiVersion): number | null {
  if (price == null || typeof price !== 'object') return null;
  const value = (price as Record<string, unknown>)[
    version === '2.3.0' ? 'before_taxes' : 'excl_vat'
  ];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
