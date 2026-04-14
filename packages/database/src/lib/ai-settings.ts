// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

let cachedValue: boolean | undefined;
let cachedAt = 0;
const TTL_MS = 60_000;

export async function isChatbotAiEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) {
    return cachedValue;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'chatbotAi.enabled'));

    cachedValue = row != null && row.value === true;
    cachedAt = now;
    return cachedValue;
  } catch {
    return cachedValue ?? false;
  }
}

export function clearChatbotAiSettingsCache(): void {
  cachedValue = undefined;
  cachedAt = 0;
}
