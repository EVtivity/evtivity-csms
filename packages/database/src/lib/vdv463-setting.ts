// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import { createLogger } from '@evtivity/lib';

const logger = createLogger('vdv463-setting');

export const VDV463_ENABLED_KEY = 'vdv463.enabled';
const TTL_MS = 60_000;
// A failed read counts as off for a short time, so a database outage is not
// queried on every connection attempt.
const FAILURE_TTL_MS = 5_000;

let cachedValue: boolean | undefined;
let cachedAt = 0;

/** Drop the cached value so the next read sees a just-saved setting. */
export function clearVdv463SettingCache(): void {
  cachedValue = undefined;
  cachedAt = 0;
}

/**
 * Whether the bus depot interface (VDV 463) accepts depot system connections.
 * Off when the row is missing, not `true`, or cannot be read (fail closed).
 */
export async function isVdv463Enabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) return cachedValue;
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, VDV463_ENABLED_KEY));
    cachedValue = row?.value === true;
    cachedAt = now;
    return cachedValue;
  } catch (err) {
    logger.warn(
      { err, key: VDV463_ENABLED_KEY },
      'isVdv463Enabled failed, the interface stays off',
    );
    cachedValue = false;
    cachedAt = now - (TTL_MS - FAILURE_TTL_MS);
    return false;
  }
}
