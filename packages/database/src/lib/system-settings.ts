// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

const DEFAULT_TIMEZONE = 'America/New_York';
const TTL_MS = 60_000;

let cachedTimezone: string | undefined;
let cachedAt = 0;

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
