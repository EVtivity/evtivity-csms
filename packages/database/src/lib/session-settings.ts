// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import { createLogger } from '@evtivity/lib';

const logger = createLogger('session-settings');

/**
 * Connector statuses of a transaction still running at the station: the EV
 * is connected and the station charges, pauses or idles. `preparing` (no
 * transaction yet) and `finishing` (the transaction ended) are left out. The
 * stale session cleanup does not fault a session whose online station shows
 * one of these (or sent a transaction event since the cutoff), and the
 * stuck-session suggestions keep offering a stop for it.
 */
export const STALE_CLEANUP_IN_TRANSACTION_STATUSES = [
  'occupied',
  'charging',
  'ev_connected',
  'suspended_ev',
  'suspended_evse',
  'idle',
  'discharging',
] as const;

let cachedValue: number | undefined;
let cachedAt = 0;
const TTL_MS = 60_000;

export async function getStaleSessionTimeoutHours(): Promise<number> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) {
    return cachedValue;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'session.staleTimeoutHours'));

    cachedValue = row != null && typeof row.value === 'number' ? row.value : 24;
    cachedAt = now;
    return cachedValue;
  } catch (err) {
    logger.warn(
      { err, key: 'session.staleTimeoutHours' },
      'getStaleSessionTimeoutHours failed, using the cached value or default',
    );
    return cachedValue ?? 24;
  }
}
