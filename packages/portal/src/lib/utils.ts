// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
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

export function currencySymbol(currency: string): string {
  const all = { ...DEFAULT_CURRENCY_SYMBOLS, ...customSymbols };
  return all[currency] ?? `${currency} `;
}

export function formatCents(cents: number | null | undefined, currency = 'USD'): string {
  if (cents == null) return '--';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

export function formatEnergy(wh: string | number | null | undefined): string {
  if (wh == null) return '--';
  const value = typeof wh === 'string' ? parseFloat(wh) : wh;
  return `${(value / 1000).toFixed(2)} kWh`;
}

export function formatDate(date: string | Date | null | undefined, timezone?: string): string {
  if (date == null) return '--';
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timezone != null ? { timeZone: timezone } : {}),
  });
}

export function formatDuration(
  startedAt: string | Date | null | undefined,
  endedAt: string | Date | null | undefined,
): string {
  if (startedAt == null || endedAt == null) return '--';
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 0) return '--';
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}

export function formatDistance(
  energyWh: string | number | null | undefined,
  efficiencyMiPerKwh: number,
  unit: 'miles' | 'km' = 'miles',
): string {
  if (energyWh == null) return '--';
  const wh = typeof energyWh === 'string' ? parseFloat(energyWh) : energyWh;
  if (isNaN(wh)) return '--';
  const miles = (wh / 1000) * efficiencyMiPerKwh;
  if (unit === 'km') {
    const km = miles * 1.60934;
    return `${km.toFixed(0)} km`;
  }
  return `${miles.toFixed(0)} Miles`;
}

/** @deprecated Use formatDistance instead */
export function formatMiles(
  energyWh: string | number | null | undefined,
  efficiencyMiPerKwh: number,
): string {
  return formatDistance(energyWh, efficiencyMiPerKwh, 'miles');
}

export function formatMonthYear(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();
}
