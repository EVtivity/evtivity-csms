// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { createLogger } from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

const logger = createLogger('prepaid-settings');

export const PREPAID_LOW_CREDIT_THRESHOLD_KEY = 'prepaid.lowCreditThresholdCents';

/** Used when the setting is unset or invalid. */
export const DEFAULT_PREPAID_LOW_CREDIT_THRESHOLD_CENTS = 500;

/** Highest threshold an operator can store (1,000,000.00 in the company currency). */
export const MAX_PREPAID_LOW_CREDIT_THRESHOLD_CENTS = 100_000_000;

/**
 * The stored threshold when it is a whole number of cents from 0 to
 * MAX_PREPAID_LOW_CREDIT_THRESHOLD_CENTS, else null. 0 turns the low credit
 * notice off.
 */
export function parsePrepaidLowCreditThresholdCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 0 || value > MAX_PREPAID_LOW_CREDIT_THRESHOLD_CENTS) return null;
  return value;
}

const TTL_MS = 60_000;
let cachedValue: number | undefined;
let cachedAt = 0;

/**
 * The prepaid balance, in cents of the company currency, below which a debit
 * sends the driver the `prepaid.LowCredit` notice (0: off). 60 s cache; on a
 * read error the last value (or the default).
 */
export async function getPrepaidLowCreditThresholdCents(): Promise<number> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) return cachedValue;

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, PREPAID_LOW_CREDIT_THRESHOLD_KEY));
    cachedValue =
      parsePrepaidLowCreditThresholdCents(row?.value) ?? DEFAULT_PREPAID_LOW_CREDIT_THRESHOLD_CENTS;
    cachedAt = now;
    return cachedValue;
  } catch (err) {
    logger.warn(
      { err, key: PREPAID_LOW_CREDIT_THRESHOLD_KEY },
      'getPrepaidLowCreditThresholdCents failed, using the cached value or default',
    );
    return cachedValue ?? DEFAULT_PREPAID_LOW_CREDIT_THRESHOLD_CENTS;
  }
}

/** Drops the cached threshold so the next read sees an operator change. */
export function clearPrepaidSettingsCache(): void {
  cachedValue = undefined;
  cachedAt = 0;
}
