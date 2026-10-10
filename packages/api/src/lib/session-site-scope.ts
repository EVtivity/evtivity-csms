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

/** Charging sessions at stations of the given sites. */
export function sessionsAtSites(siteIds: string[]): SQL {
  if (siteIds.length === 0) return inArray(chargingSessions.id, []);
  return inArray(chargingSessions.stationId, stationsAtSites(siteIds));
}

/** Reservations at stations of the given sites. */
export function reservationsAtSites(siteIds: string[]): SQL {
  if (siteIds.length === 0) return inArray(reservations.id, []);
  return inArray(reservations.stationId, stationsAtSites(siteIds));
}
