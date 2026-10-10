// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Pure scope check for a row's site against the user's sites (the result of
 * getUserSiteIds). An all-site user (null) sees every row. A site-restricted
 * user sees only rows whose site is in the list: rows without a site (an
 * unsited station, its sessions and reservations) are visible to all-site
 * users only (owner decision 2026-10-09).
 */
export function siteInScope(
  siteIds: readonly string[] | null,
  siteId: string | null | undefined,
): boolean {
  if (siteIds == null) return true;
  if (siteId == null) return false;
  return siteIds.includes(siteId);
}
