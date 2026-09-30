// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatCurrencyAmount } from '@evtivity/lib/currency';
import { formatNumber as formatLocaleNumber } from '@evtivity/lib/number';
import i18next from 'i18next';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * The selected UI language, which drives number and currency formatting. Read
 * from the global i18next instance that @/i18n initializes; falls back to "en"
 * before initialization (e.g. in unit tests).
 */
function uiLocale(): string {
  return i18next.isInitialized ? i18next.language : 'en';
}

/** Format a number for display with fixed fraction digits in the UI language. */
export function formatNumber(value: number, fractionDigits: number): string {
  return formatLocaleNumber(value, uiLocale(), fractionDigits);
}

export function formatCents(cents: number | null | undefined, currency: string): string {
  if (cents == null) return 'n/a';
  return formatCurrencyAmount(cents, currency, uiLocale());
}

/** Format a price in major units (e.g. a tariff rate of 0.49) as currency, rounded to cents. */
export function formatPrice(amount: number, currency: string): string {
  return formatCents(Math.round(amount * 100), currency);
}

export function formatEnergy(wh: string | number | null | undefined): string {
  if (wh == null) return 'n/a';
  const value = typeof wh === 'string' ? parseFloat(wh) : wh;
  return `${formatNumber(value / 1000, 2)} kWh`;
}

export function formatDate(date: string | Date | null | undefined, timezone?: string): string {
  if (date == null) return 'n/a';
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
  if (startedAt == null || endedAt == null) return 'n/a';
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 0) return 'n/a';
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
  if (energyWh == null) return 'n/a';
  const wh = typeof energyWh === 'string' ? parseFloat(energyWh) : energyWh;
  if (isNaN(wh)) return 'n/a';
  const miles = (wh / 1000) * efficiencyMiPerKwh;
  if (unit === 'km') {
    const km = miles * 1.60934;
    return `${formatNumber(km, 0)} km`;
  }
  return `${formatNumber(miles, 0)} Miles`;
}

export function formatMonthYear(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();
}
