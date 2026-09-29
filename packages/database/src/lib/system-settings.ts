// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

const DEFAULT_TIMEZONE = 'America/New_York';
const DEFAULT_CURRENCY = 'USD';
const TTL_MS = 60_000;

let cachedTimezone: string | undefined;
let cachedAt = 0;

let cachedCurrency: string | undefined;
let cachedCurrencyAt = 0;

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
 * Cached reader for the `company.currency` setting, the operator's reporting
 * currency. Financial aggregates attribute sessions without a tariff currency
 * to it, and list it first. Falls back to USD when unset, malformed, or on
 * error.
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

    cachedCurrency =
      typeof row?.value === 'string' && /^[A-Za-z]{3}$/.test(row.value)
        ? row.value.toUpperCase()
        : DEFAULT_CURRENCY;
    cachedCurrencyAt = now;
    return cachedCurrency;
  } catch {
    return cachedCurrency ?? DEFAULT_CURRENCY;
  }
}

export function clearSystemSettingsCache(): void {
  cachedTimezone = undefined;
  cachedAt = 0;
  cachedCurrency = undefined;
  cachedCurrencyAt = 0;
}
