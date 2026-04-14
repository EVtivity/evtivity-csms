// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TariffInput } from './cost-calculator.js';

export function formatPricingDisplay(
  tariff: TariffInput,
  format: 'standard' | 'compact',
  currency: string,
): string {
  const sym = currencySymbol(currency);

  const perKwh = tariff.pricePerKwh != null ? Number(tariff.pricePerKwh) : 0;
  const perMin = tariff.pricePerMinute != null ? Number(tariff.pricePerMinute) : 0;
  const perSession = tariff.pricePerSession != null ? Number(tariff.pricePerSession) : 0;
  const idleFee = tariff.idleFeePricePerMinute != null ? Number(tariff.idleFeePricePerMinute) : 0;
  const taxRate = tariff.taxRate != null ? Number(tariff.taxRate) : 0;

  if (format === 'compact') {
    const parts: string[] = [];
    if (perKwh > 0) parts.push(`${sym}${perKwh.toFixed(2)}/kWh`);
    if (perMin > 0) parts.push(`${sym}${perMin.toFixed(2)}/min`);
    if (perSession > 0) parts.push(`${sym}${perSession.toFixed(2)} session`);
    if (idleFee > 0) parts.push(`${sym}${idleFee.toFixed(2)}/min idle`);
    return parts.length > 0 ? parts.join(' + ') : 'Free';
  }

  // Standard format
  const parts: string[] = [];
  if (perKwh > 0) parts.push(`Energy: ${sym}${perKwh.toFixed(2)}/kWh`);
  if (perMin > 0) parts.push(`Time: ${sym}${perMin.toFixed(2)}/min`);
  if (perSession > 0) parts.push(`Session: ${sym}${perSession.toFixed(2)}`);
  if (idleFee > 0) parts.push(`Idle: ${sym}${idleFee.toFixed(2)}/min`);
  if (taxRate > 0) parts.push(`Tax: ${(taxRate * 100).toFixed(0)}%`);
  return parts.length > 0 ? parts.join(' | ') : 'Free';
}

const DEFAULT_CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '\u20AC',
  GBP: '\u00A3',
  CAD: 'CA$',
  AUD: 'A$',
  CHF: 'CHF ',
  SEK: 'kr',
  NOK: 'kr',
  DKK: 'kr',
  MXN: 'MX$',
  CNY: '\u00A5',
};

let customSymbols: Record<string, string> = {};

export function setCurrencySymbols(symbols: Record<string, string>): void {
  customSymbols = symbols;
}

export function getCurrencySymbols(): Record<string, string> {
  return { ...DEFAULT_CURRENCY_SYMBOLS, ...customSymbols };
}

export function currencySymbol(currency: string): string {
  const all = getCurrencySymbols();
  return all[currency] ?? `${currency} `;
}
