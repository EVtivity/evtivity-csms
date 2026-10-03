// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { SUPPORTED_CURRENCIES } from '@evtivity/lib';
import { PaymentValidationError } from '../../errors.js';

/**
 * Platform currencies Adyen does not take in cents. Adyen gives IDR 0 minor
 * units while the platform stores cents (Adyen's table deviates from ISO 4217;
 * https://docs.adyen.com/development-resources/currency-codes), so IDR is
 * blocked (D-A3).
 */
export const ADYEN_BLOCKED_CURRENCIES: readonly string[] = ['IDR'];

/** Every other supported currency has 2 minor units at Adyen: cents are minor units. */
export const ADYEN_CURRENCIES: readonly string[] = SUPPORTED_CURRENCIES.filter(
  (c) => !ADYEN_BLOCKED_CURRENCIES.includes(c),
);

export interface AdyenAmount {
  value: number;
  currency: string;
}

function adyenCurrency(currency: string): string {
  const code = currency.toUpperCase();
  if (!ADYEN_CURRENCIES.includes(code)) {
    throw new PaymentValidationError(`Adyen payments in ${code} are not supported`);
  }
  return code;
}

/** Cents to an Adyen amount (minor units). */
export function toAdyenAmount(cents: number, currency: string): AdyenAmount {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new PaymentValidationError('Amount must be a non-negative integer of cents');
  }
  return { value: cents, currency: adyenCurrency(currency) };
}

/** An Adyen amount (minor units) to cents. */
export function fromAdyenAmount(amount: AdyenAmount): number {
  adyenCurrency(amount.currency);
  if (!Number.isInteger(amount.value) || amount.value < 0) {
    throw new PaymentValidationError('Adyen returned an invalid amount');
  }
  return amount.value;
}
