// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import {
  formatCurrencyAmount,
  formatFlatPrice as formatLocaleFlatPrice,
  formatUnitPrice as formatLocaleUnitPrice,
} from '@evtivity/lib/currency';
import { formatNumber as formatLocaleNumber } from '@evtivity/lib/number';
import { formatTaxRatePercent } from '@evtivity/lib/price-display';
import { formatDateTime } from '@evtivity/lib/timezone';
import i18next from 'i18next';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * The selected UI language, which drives number, currency and date formatting. Read
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

/**
 * Format a unit price in major units (e.g. a tariff rate of 0.2561 per kWh) as
 * currency with 2 to 4 fraction digits, so rates finer than a cent stay exact.
 */
export function formatUnitPrice(amount: number, currency: string): string {
  return formatLocaleUnitPrice(amount, currency, uiLocale());
}

/** Format a flat amount in major units (a session fee) as money, rounded to the cent. */
export function formatFlatPrice(amount: number, currency: string): string {
  return formatLocaleFlatPrice(amount, currency, uiLocale());
}

/** Format a tax rate (0.19) as a percentage number in the UI language without trailing zeros (19). */
export function formatTaxPercent(taxRate: number): string {
  return formatTaxRatePercent(taxRate, uiLocale());
}

export function formatEnergy(wh: string | number | null | undefined): string {
  if (wh == null) return 'n/a';
  const value = typeof wh === 'string' ? parseFloat(wh) : wh;
  return `${formatNumber(value / 1000, 2)} kWh`;
}

/**
 * Format date and time without seconds in the UI language, e.g. "Mar 5, 2026, 9:04 AM"
 * (en) or "05.03.2026, 09:04" (de). Without a time zone the browser's is used.
 */
export function formatDate(date: string | Date | null | undefined, timezone?: string): string {
  if (date == null) return 'n/a';
  return formatDateTime(
    date,
    timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    { dateStyle: 'medium', timeStyle: 'short' },
    uiLocale(),
  );
}

/** Format a clock time in the UI language and time zone, e.g. "3:05 PM" (en) or "15:05" (de). */
export function formatClockTime(date: string | Date | number, timezone: string): string {
  return formatDateTime(
    typeof date === 'number' ? new Date(date) : date,
    timezone,
    { timeStyle: 'short' },
    uiLocale(),
  );
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
  return date.toLocaleDateString(uiLocale(), { month: 'long', year: 'numeric' }).toUpperCase();
}
