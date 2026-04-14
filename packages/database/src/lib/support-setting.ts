// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

let cachedValue: boolean | undefined;
let cachedAt = 0;
const TTL_MS = 60_000;

export async function isSupportEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) {
    return cachedValue;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'support.enabled'));

    cachedValue = row == null || row.value === true; // default true when row missing
    cachedAt = now;
    return cachedValue;
  } catch {
    return cachedValue ?? true;
  }
}
