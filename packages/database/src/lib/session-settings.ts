// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

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
  } catch {
    return cachedValue ?? 24;
  }
}
