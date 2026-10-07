// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import { createLogger } from '@evtivity/lib';

const logger = createLogger('auto-disable-setting');

let cachedValue: boolean | undefined;
let cachedAt = 0;
const TTL_MS = 60_000;

export async function isAutoDisableOnCriticalEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) {
    return cachedValue;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'security.autoDisableOnCritical'));

    // Default is enabled. A missing row matches the seed default and the
    // DB-error fallback below, so callers get consistent "enabled" semantics
    // unless an operator explicitly stored value === false.
    cachedValue = row == null || row.value !== false;
    cachedAt = now;
    return cachedValue;
  } catch (err) {
    logger.warn(
      { err, key: 'security.autoDisableOnCritical' },
      'isAutoDisableOnCriticalEnabled failed, using the cached value or default',
    );
    return cachedValue ?? true;
  }
}
