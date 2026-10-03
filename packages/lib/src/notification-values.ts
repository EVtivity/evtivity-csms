// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { formatCurrencyAmount, formatUnitPrice } from './currency.js';
import { formatTaxRatePercent } from './price-display.js';

/**
 * Template variables formatted in the recipient's language. Callers do not
 * know the recipient's language (the dispatcher looks the driver up), so they
 * pass one of these values instead of a string, and dispatchDriverNotification
 * and dispatchSystemNotification format every such value with the recipient's
 * language before rendering (formatLocalizedVariables). The template renderer
 * never calls toString() (template-safety renders plain values only), so a
 * value must go through formatLocalizedVariables before rendering.
 *
 * Templates keep the raw variables (amountCents, currency, ...) next to the
 * formatted ones, so operator templates written against them keep working.
 */
export abstract class LocalizedValue {
  abstract format(locale: string): string;

  toString(): string {
    return this.format('en-US');
  }
}

/** An amount in cents of a currency: formatCurrencyAmount ("12,50 €" in de). */
export class MoneyValue extends LocalizedValue {
  constructor(
    readonly cents: number,
    readonly currency: string,
  ) {
    super();
  }

  format(locale: string): string {
    return formatCurrencyAmount(this.cents, this.currency, locale);
  }
}

/** A unit price in major units (a rate per kWh or minute): formatUnitPrice, 2 to 4 digits. */
export class UnitPriceValue extends LocalizedValue {
  constructor(
    readonly amount: number,
    readonly currency: string,
  ) {
    super();
  }

  format(locale: string): string {
    return formatUnitPrice(this.amount, this.currency, locale);
  }
}

/** A tax rate fraction (0.19) as a percentage number ("19", "7,5" in de). */
export class TaxRateValue extends LocalizedValue {
  constructor(readonly taxRate: number) {
    super();
  }

  format(locale: string): string {
    return formatTaxRatePercent(this.taxRate, locale);
  }
}

/** An amount in cents of a currency, formatted in the recipient's language. */
export function notificationMoney(cents: number, currency: string): MoneyValue {
  return new MoneyValue(cents, currency);
}

/** A unit price in major units, formatted in the recipient's language. */
export function notificationUnitPrice(amount: number, currency: string): UnitPriceValue {
  return new UnitPriceValue(amount, currency);
}

/** A tax rate fraction as a percentage number in the recipient's language. */
export function notificationTaxRate(taxRate: number): TaxRateValue {
  return new TaxRateValue(taxRate);
}

/** Every LocalizedValue replaced by its text in `language`. Other variables are unchanged. */
export function formatLocalizedVariables(
  variables: Record<string, unknown>,
  language: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variables)) {
    result[key] = value instanceof LocalizedValue ? value.format(language) : value;
  }
  return result;
}
