// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * All-time dashboard totals (session count, energy, revenue, electricity
 * cost) read every session of the user's sites. They are computed with the
 * live definition, at most once a minute per site scope and API process, and
 * shared by every user with that scope, so a dashboard request never scans
 * every session. The figures of today stay live.
 */
export const DASHBOARD_TOTALS_TTL_MS = 60_000;

/** Entries kept at most; the oldest is dropped beyond it. */
const MAX_ENTRIES = 500;

interface Entry {
  expiresAt: number;
  value: Promise<unknown>;
}

const entries = new Map<string, Entry>();

/** The cache key of a site scope: every site, or the sorted site ids. */
export function siteScopeKey(siteIds: readonly string[] | null): string {
  return siteIds == null ? '*' : [...siteIds].sort().join(',');
}

/**
 * The cached value of `key`, loaded with `load` when missing or older than
 * the TTL. Concurrent callers share one load; a failed load is not kept.
 */
export function cachedDashboardTotals<T>(
  key: string,
  load: () => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  const hit = entries.get(key);
  if (hit != null && hit.expiresAt > now) return hit.value as Promise<T>;

  const value = load();
  entries.delete(key);
  entries.set(key, { expiresAt: now + DASHBOARD_TOTALS_TTL_MS, value });
  value.catch(() => {
    // fail-open: the caller gets the rejection; the entry is dropped so the next request loads again
    if (entries.get(key)?.value === value) entries.delete(key);
  });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest == null) break;
    entries.delete(oldest);
  }
  return value;
}

/** Empties the cache (tests). */
export function clearDashboardTotalsCache(): void {
  entries.clear();
}
