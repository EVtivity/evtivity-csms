// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { createLogger } from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

const logger = createLogger('idling-setting');

let cachedValue: number | undefined;
let cachedAt = 0;
const TTL_MS = 60_000;

export async function getIdlingGracePeriodMinutes(): Promise<number> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) {
    return cachedValue;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'idling.gracePeriodMinutes'));

    cachedValue = row != null && typeof row.value === 'number' ? row.value : 30;
    cachedAt = now;
    return cachedValue;
  } catch (err) {
    logger.debug({ err }, 'getIdlingGracePeriodMinutes lookup failed; returning cached/default');
    return cachedValue ?? 30;
  }
}
