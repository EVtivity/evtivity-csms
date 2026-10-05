// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

export const WEBHOOK_ALLOWED_PRIVATE_HOSTS_KEY = 'notifications.webhookAllowedPrivateHosts';

const TTL_MS = 60_000;
let cachedHosts: string[] | undefined;
let cachedAt = 0;

/**
 * Hosts notification webhooks may reach although they are, or resolve to,
 * private addresses (`notifications.webhookAllowedPrivateHosts`, lowercased).
 * Empty when unset. 60 s cache; on a read error the last value (or empty).
 */
export async function getWebhookAllowedPrivateHosts(): Promise<string[]> {
  const now = Date.now();
  if (cachedHosts !== undefined && now - cachedAt < TTL_MS) return cachedHosts;

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, WEBHOOK_ALLOWED_PRIVATE_HOSTS_KEY));
    const value = row?.value;
    cachedHosts = Array.isArray(value)
      ? value.filter((h): h is string => typeof h === 'string').map((h) => h.toLowerCase())
      : [];
    cachedAt = now;
    return cachedHosts;
  } catch {
    return cachedHosts ?? [];
  }
}

/** Drops the cached webhook allowlist so the next read sees an operator change. */
export function clearWebhookSettingsCache(): void {
  cachedHosts = undefined;
  cachedAt = 0;
}
