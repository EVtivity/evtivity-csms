// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

let cachedValue: boolean | undefined;
let cachedAt = 0;
const TTL_MS = 60_000;

export async function isPncEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) {
    return cachedValue;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'pnc.enabled'));

    cachedValue = row != null && row.value === true;
    cachedAt = now;
    return cachedValue;
  } catch {
    return cachedValue ?? false;
  }
}

let cachedAllowedHosts: string[] | undefined;
let allowedHostsCachedAt = 0;

/**
 * Hosts the CSMS may contact for OCSP although they are private or internal
 * addresses (`pnc.ocsp.allowedPrivateHosts`, lowercased). Empty when unset.
 */
export async function getOcspAllowedPrivateHosts(): Promise<string[]> {
  const now = Date.now();
  if (cachedAllowedHosts !== undefined && now - allowedHostsCachedAt < TTL_MS) {
    return cachedAllowedHosts;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'pnc.ocsp.allowedPrivateHosts'));

    const value = row?.value;
    cachedAllowedHosts = Array.isArray(value)
      ? value.filter((h): h is string => typeof h === 'string').map((h) => h.toLowerCase())
      : [];
    allowedHostsCachedAt = now;
    return cachedAllowedHosts;
  } catch {
    return cachedAllowedHosts ?? [];
  }
}

/** Invalidate the cached PnC settings (pnc.enabled and the OCSP host
 * allowlist). Call after PUT /v1/pnc/settings so OCPP handlers and other
 * readers do not keep returning the stale value for up to 60 seconds after an
 * operator change. */
export function clearPncSettingsCache(): void {
  cachedValue = undefined;
  cachedAt = 0;
  cachedAllowedHosts = undefined;
  allowedHostsCachedAt = 0;
}
