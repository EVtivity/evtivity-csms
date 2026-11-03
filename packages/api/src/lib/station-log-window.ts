// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { getUserSiteIds } from './site-access.js';
import { readStationSiteWindows } from './site-layout-replay.js';

/**
 * From when a caller may read a station's log rows: null (no bound) for an
 * all-site user, else the start of the station's time at its current site,
 * or `closed` (no rows) when that time cannot be told or the station has no
 * site. A moved station's rows from another site never reach a site user.
 */
export async function stationLogSince(
  stationId: string,
  userId: string,
): Promise<Date | null | 'closed'> {
  const siteIds = await getUserSiteIds(userId);
  if (siteIds == null) return null;
  const [station] = await db.execute<{ site_id: string | null }>(
    sql`SELECT site_id FROM charging_stations WHERE id = ${stationId}`,
  );
  if (station?.site_id == null) return 'closed';
  const windows = await readStationSiteWindows(station.site_id, [stationId]);
  return windows.has(stationId) ? (windows.get(stationId) ?? null) : 'closed';
}
