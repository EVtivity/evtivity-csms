// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import { createLogger } from '@evtivity/lib';

const logger = createLogger('fleet-charging-setting');

const KEY = 'fleetCharging.enabled';
const TTL_MS = 60_000;
// A failed read counts as off for a short time, so a database outage is not
// queried on every call.
const FAILURE_TTL_MS = 5_000;

let cachedValue: boolean | undefined;
let cachedAt = 0;

/** Drop the cached value so the next read sees a just-saved setting. */
export function clearFleetChargingSettingCache(): void {
  cachedValue = undefined;
  cachedAt = 0;
}

/**
 * Whether route-aware fleet charging (the departure planner and its charging
 * profiles) is on. Off when the row is missing, not `true`, or cannot be read:
 * a failed read keeps the planner off for 5 seconds.
 */
export async function isFleetChargingEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) {
    return cachedValue;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, KEY));
    cachedValue = row?.value === true;
    cachedAt = now;
    return cachedValue;
  } catch (err) {
    logger.warn({ err, key: KEY }, 'isFleetChargingEnabled failed, fleet charging stays off');
    cachedValue = false;
    cachedAt = now - (TTL_MS - FAILURE_TTL_MS);
    return false;
  }
}
