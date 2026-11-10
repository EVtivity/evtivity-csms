// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { db, operatorStationSql } from '@evtivity/database';
import { readStationSiteWindows } from './site-layout-replay.js';

/** Station ids per `readStationSiteWindows` call. */
export const SECURITY_EVENT_WINDOW_CHUNK = 500;

export interface SecurityEventWindow {
  /** charging_stations.id */
  id: string;
  /** The earliest receipt time (`created_at`) of the station's rows the caller may read. */
  since: Date;
}

/**
 * The stations of a site-restricted caller that hold security events received
 * since `since`, each with the receipt time from which its rows belong to its
 * current site (security case 284): the later of `since` and the start of the
 * station's time at the site. A station whose window is closed (its newest
 * audited move went to another site, or it has no window) is left out, so a
 * moved station's events from another site never reach a site user. Conformance
 * stations are never counted, like everywhere on the dashboard.
 */
export async function securityEventWindows(
  siteIds: readonly string[],
  since: Date,
  siteFilter?: string,
): Promise<SecurityEventWindow[]> {
  const scope = siteFilter != null ? [siteFilter] : siteIds;
  if (scope.length === 0) return [];
  const siteList = sql.join(
    scope.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT s.id, s.site_id FROM charging_stations s
    WHERE s.site_id IN (${siteList}) AND ${sql.raw(operatorStationSql('s'))}
      AND EXISTS (
        SELECT 1 FROM security_events e
        WHERE e.station_id = s.id AND e.created_at >= ${since.toISOString()}::timestamptz
      )
  `)) as unknown as Array<{ id: string; site_id: string }>;

  const bySite = new Map<string, string[]>();
  for (const row of rows) {
    const ids = bySite.get(row.site_id) ?? [];
    ids.push(row.id);
    bySite.set(row.site_id, ids);
  }

  const windows: SecurityEventWindow[] = [];
  for (const [siteId, ids] of bySite) {
    for (let i = 0; i < ids.length; i += SECURITY_EVENT_WINDOW_CHUNK) {
      const chunk = ids.slice(i, i + SECURITY_EVENT_WINDOW_CHUNK);
      const read = await readStationSiteWindows(siteId, chunk);
      for (const id of chunk) {
        const from = read.get(id);
        // Missing from the map counts as closed (fail closed).
        if (from === undefined || from === 'closed') continue;
        const start = from == null || from.getTime() < since.getTime() ? since : from;
        windows.push({ id, since: start });
      }
    }
  }
  return windows;
}
