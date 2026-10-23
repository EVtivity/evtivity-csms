// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { inArray } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import { db, chargingSessions } from '@evtivity/database';

/**
 * Condition that keeps rows whose charging session column points to a session
 * that happened at one of `siteIds` (`charging_sessions.site_id`, stamped at
 * the start, never the station's current site, so a station move does not
 * hand its earlier CDRs and roaming sessions to the new site). Rows without a
 * local session (eMSP-role roaming data received from partners) and sessions
 * without a site drop out, so a site-restricted user sees only roaming data of
 * its own sites.
 * `siteIds` must not be empty: callers return an empty page first.
 */
export function sessionInSites(sessionIdColumn: AnyColumn, siteIds: string[]): SQL {
  return inArray(
    sessionIdColumn,
    db
      .select({ id: chargingSessions.id })
      .from(chargingSessions)
      .where(inArray(chargingSessions.siteId, siteIds)),
  );
}
