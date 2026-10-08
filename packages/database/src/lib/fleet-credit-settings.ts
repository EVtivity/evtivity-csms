// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { createLogger } from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

const logger = createLogger('fleet-credit-settings');

export const FLEET_CREDIT_RESERVATION_KEY = 'fleet.creditReservationCents';

/** Used when the setting is unset or invalid (50.00 in the company currency). */
export const DEFAULT_FLEET_CREDIT_RESERVATION_CENTS = 5000;

/** Highest slice an operator can store (1,000,000.00 in the company currency). */
export const MAX_FLEET_CREDIT_RESERVATION_CENTS = 100_000_000;

/**
 * The stored slice when it is a whole number of cents from 1 to
 * MAX_FLEET_CREDIT_RESERVATION_CENTS, else null. A slice of 0 would let no
 * account session of a credit-limited fleet charge, so it is refused.
 */
export function parseFleetCreditReservationCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1 || value > MAX_FLEET_CREDIT_RESERVATION_CENTS) return null;
  return value;
}

const TTL_MS = 60_000;
let cachedValue: number | undefined;
let cachedAt = 0;

/**
 * The fleet credit an account session of a credit-limited fleet reserves at
 * its start, and by how much its cost ceiling grows while it charges
 * (`features/fleet-billing.md`, S8). 60 s cache; on a read error the last
 * value (or the default).
 */
export async function getFleetCreditReservationCents(): Promise<number> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) return cachedValue;

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, FLEET_CREDIT_RESERVATION_KEY));
    cachedValue =
      parseFleetCreditReservationCents(row?.value) ?? DEFAULT_FLEET_CREDIT_RESERVATION_CENTS;
    cachedAt = now;
    return cachedValue;
  } catch (err) {
    logger.warn(
      { err, key: FLEET_CREDIT_RESERVATION_KEY },
      'getFleetCreditReservationCents failed, using the cached value or default',
    );
    return cachedValue ?? DEFAULT_FLEET_CREDIT_RESERVATION_CENTS;
  }
}

/** Drops the cached slice so the next read sees an operator change. */
export function clearFleetCreditSettingsCache(): void {
  cachedValue = undefined;
  cachedAt = 0;
}
