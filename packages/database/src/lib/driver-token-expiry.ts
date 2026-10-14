// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, lte, lt, sql } from 'drizzle-orm';
import { db } from '../config.js';
import { driverTokens } from '../schema/drivers.js';

/**
 * Moves `updated_at` of every driver token whose expiry passed since it was
 * last updated, so an OCPI partner pulling Tokens changed since its last pull
 * (`date_from` on last_updated) sees it invalid. Returns the ids, for the
 * push. Idempotent: a token is touched once, after its expiry. The only
 * write to driver_tokens outside the API token service besides the prepaid
 * debit; it changes no field a person sees except the update time, so it
 * writes no audit row.
 */
export async function touchExpiredDriverTokens(now: Date = new Date()): Promise<string[]> {
  const rows = await db
    .update(driverTokens)
    .set({ updatedAt: now })
    .where(
      and(
        lte(driverTokens.expiresAt, now),
        lt(driverTokens.updatedAt, sql`${driverTokens.expiresAt}`),
      ),
    )
    .returning({ id: driverTokens.id });
  return rows.map((r) => r.id);
}
