// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, inArray } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import { db, chargingSessions, chargingStations } from '@evtivity/database';

/**
 * Condition that keeps rows whose charging session column points to a session
 * at a station in one of `siteIds`. Rows without a local session (eMSP-role
 * roaming data received from partners) and sessions at unsited stations drop
 * out, so a site-restricted user sees only roaming data of its own sites.
 * `siteIds` must not be empty: callers return an empty page first.
 */
export function sessionInSites(sessionIdColumn: AnyColumn, siteIds: string[]): SQL {
  return inArray(
    sessionIdColumn,
    db
      .select({ id: chargingSessions.id })
      .from(chargingSessions)
      .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
      .where(inArray(chargingStations.siteId, siteIds)),
  );
}
