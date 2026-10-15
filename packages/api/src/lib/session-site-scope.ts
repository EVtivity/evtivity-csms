// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { inArray, type SQL } from 'drizzle-orm';
import { db, chargingSessions, chargingStations, reservations } from '@evtivity/database';

/**
 * Keeps the rows at stations of the given sites (an operator's
 * `getUserSiteIds()`). Unsited stations are left out, so a site-restricted
 * operator never sees them. An empty list matches nothing. Callers skip the
 * condition for an unrestricted operator (null).
 */
function stationsAtSites(siteIds: string[]) {
  return db
    .select({ id: chargingStations.id })
    .from(chargingStations)
    .where(inArray(chargingStations.siteId, siteIds));
}

/**
 * Charging sessions that happened at the given sites: the session's own site
 * (`charging_sessions.site_id`), so a station moved to another site leaves its
 * earlier sessions at the old site. A session without a site (a station
 * without one, a deleted site, or a row an older release inserted) is left
 * out, so only an unrestricted operator sees it.
 */
export function sessionsAtSites(siteIds: string[]): SQL {
  if (siteIds.length === 0) return inArray(chargingSessions.id, []);
  return inArray(chargingSessions.siteId, siteIds);
}

/** Reservations at stations of the given sites. */
export function reservationsAtSites(siteIds: string[]): SQL {
  if (siteIds.length === 0) return inArray(reservations.id, []);
  return inArray(reservations.stationId, stationsAtSites(siteIds));
}
