// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import {
  DEFAULT_CURRENCY,
  DEFAULT_PRICE_DISPLAY,
  isPriceDisplay,
  isSupportedCurrency,
  type PriceDisplay,
} from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

const DEFAULT_TIMEZONE = 'America/New_York';
const TTL_MS = 60_000;

let cachedTimezone: string | undefined;
let cachedAt = 0;

let cachedCurrency: string | undefined;
let cachedCurrencyAt = 0;

let cachedPriceDisplay: PriceDisplay | undefined;
let cachedPriceDisplayAt = 0;

/**
 * Cached reader for the `system.timezone` setting. Used by dashboard
 * endpoints that aggregate sessions by day in the operator's local
 * time. Falls back to America/New_York when unset or on error.
 */
export async function getSystemTimezone(): Promise<string> {
  const now = Date.now();
  if (cachedTimezone !== undefined && now - cachedAt < TTL_MS) {
    return cachedTimezone;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'system.timezone'));

    cachedTimezone = typeof row?.value === 'string' ? row.value : DEFAULT_TIMEZONE;
    cachedAt = now;
    return cachedTimezone;
  } catch {
    return cachedTimezone ?? DEFAULT_TIMEZONE;
  }
}

/**
 * Cached reader for the `company.currency` setting: the one currency the
 * platform bills and reports in. Falls back to DEFAULT_CURRENCY when the
 * setting is unset or not a supported two-decimal currency, and on error.
 */
export async function getCompanyCurrency(): Promise<string> {
  const now = Date.now();
  if (cachedCurrency !== undefined && now - cachedCurrencyAt < TTL_MS) {
    return cachedCurrency;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'company.currency'));

    const code = typeof row?.value === 'string' ? row.value.toUpperCase() : null;
    cachedCurrency = isSupportedCurrency(code) ? code : DEFAULT_CURRENCY;
    cachedCurrencyAt = now;
    return cachedCurrency;
  } catch {
    return cachedCurrency ?? DEFAULT_CURRENCY;
  }
}

/**
 * Cached reader for the `company.priceDisplay` setting: whether drivers see
 * prices including ('gross') or excluding ('net') tax unless they choose
 * otherwise. Falls back to DEFAULT_PRICE_DISPLAY when unset or invalid, and on
 * error.
 */
export async function getCompanyPriceDisplay(): Promise<PriceDisplay> {
  const now = Date.now();
  if (cachedPriceDisplay !== undefined && now - cachedPriceDisplayAt < TTL_MS) {
    return cachedPriceDisplay;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'company.priceDisplay'));

    cachedPriceDisplay = isPriceDisplay(row?.value) ? row.value : DEFAULT_PRICE_DISPLAY;
    cachedPriceDisplayAt = now;
    return cachedPriceDisplay;
  } catch {
    return cachedPriceDisplay ?? DEFAULT_PRICE_DISPLAY;
  }
}

export function clearSystemSettingsCache(): void {
  cachedTimezone = undefined;
  cachedAt = 0;
  cachedCurrency = undefined;
  cachedCurrencyAt = 0;
  cachedPriceDisplay = undefined;
  cachedPriceDisplayAt = 0;
}
