// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import { createLogger } from '@evtivity/lib';

const logger = createLogger('rfid-self-service-setting');

/** Whether drivers add, rename, deactivate, reactivate and remove their own RFID cards. */
export const RFID_SELF_SERVICE_SETTING_KEY = 'portal.rfidSelfServiceEnabled';

let cachedValue: boolean | undefined;
let cachedAt = 0;
const TTL_MS = 60_000;

/** Drop the cached value so the next read sees a just-saved setting. */
export function clearDriverRfidSelfServiceCache(): void {
  cachedValue = undefined;
  cachedAt = 0;
}

/**
 * True when drivers manage their own RFID cards (the default, also when the
 * row is missing). A stored value other than `true` reads as off.
 *
 * A security control, so it fails closed: a read error returns the last
 * cached value, and with none it returns false, so driver card writes are
 * refused until the setting can be read.
 */
export async function isDriverRfidSelfServiceEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) {
    return cachedValue;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, RFID_SELF_SERVICE_SETTING_KEY));

    cachedValue = row == null || row.value === true;
    cachedAt = now;
    return cachedValue;
  } catch (err) {
    logger.warn(
      { err, key: RFID_SELF_SERVICE_SETTING_KEY },
      'isDriverRfidSelfServiceEnabled failed, using the cached value or refusing driver card writes',
    );
    return cachedValue ?? false;
  }
}
