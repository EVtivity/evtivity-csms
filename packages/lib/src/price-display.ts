// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Whether prices shown to drivers include tax ('gross') or exclude it ('net').
 * Tariff prices are stored net; the cost calculation adds the tariff tax rate
 * on top. Browser-safe, so the portal can import it via
 * `@evtivity/lib/price-display`.
 */
export const PRICE_DISPLAYS = ['gross', 'net'] as const;

export type PriceDisplay = (typeof PRICE_DISPLAYS)[number];

/** Used when neither the driver nor the company setting company.priceDisplay is set. */
export const DEFAULT_PRICE_DISPLAY: PriceDisplay = 'net';

export function isPriceDisplay(value: unknown): value is PriceDisplay {
  return typeof value === 'string' && (PRICE_DISPLAYS as readonly string[]).includes(value);
}

/** The driver's choice, else the company setting, else the default. */
export function resolvePriceDisplay(driverValue: unknown, companyValue: unknown): PriceDisplay {
  if (isPriceDisplay(driverValue)) return driverValue;
  if (isPriceDisplay(companyValue)) return companyValue;
  return DEFAULT_PRICE_DISPLAY;
}

/** A net tariff price as shown: with the tax rate added for 'gross'. */
export function priceForDisplay(
  netPrice: number,
  taxRate: number,
  priceDisplay: PriceDisplay,
): number {
  return priceDisplay === 'gross' ? netPrice * (1 + taxRate) : netPrice;
}

/**
 * The tax contained in a total that includes tax, in cents. Sessions store only
 * the total; this is the same split the invoice service makes.
 */
export function includedTaxCents(totalCents: number, taxRate: number): number {
  if (taxRate <= 0) return 0;
  return totalCents - Math.round(totalCents / (1 + taxRate));
}
