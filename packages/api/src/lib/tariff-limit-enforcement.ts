// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { db, operatorStationSql } from '@evtivity/database';

/**
 * For each tariff with a current limit, the sites it reaches whose load
 * management is off (or not set up), where nothing enforces the limit. A
 * tariff reaches every site through the default group; the sites and the
 * stations' sites of a site or station group; every site through a driver
 * or fleet group. A Selected Sites tariff reaches only its sites.
 * `visibleSiteIds` (null: every site) keeps other sites out of the reply.
 */
export async function unenforcedLimitSiteIds(
  tariffIds: readonly string[],
  visibleSiteIds: readonly string[] | null,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (tariffIds.length === 0 || (visibleSiteIds != null && visibleSiteIds.length === 0)) {
    return result;
  }
  const idList = (ids: readonly string[]) =>
    sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
  const visible = visibleSiteIds != null ? sql`AND s.id IN (${idList(visibleSiteIds)})` : sql``;
  const rows = (await db.execute(sql`SELECT t.id AS tariff_id, s.id AS site_id
    FROM tariffs t
    JOIN pricing_groups g ON g.id = t.pricing_group_id
    JOIN sites s ON (
      g.is_default
      OR EXISTS (
        SELECT 1 FROM pricing_group_sites pgs
        WHERE pgs.pricing_group_id = g.id AND pgs.site_id = s.id
      )
      OR EXISTS (
        SELECT 1 FROM pricing_group_stations pgst
        JOIN charging_stations cs ON cs.id = pgst.station_id
        WHERE pgst.pricing_group_id = g.id AND cs.site_id = s.id
          AND ${sql.raw(operatorStationSql('cs'))}
      )
      OR EXISTS (SELECT 1 FROM pricing_group_drivers pgd WHERE pgd.pricing_group_id = g.id)
      OR EXISTS (SELECT 1 FROM pricing_group_fleets pgf WHERE pgf.pricing_group_id = g.id)
    )
    LEFT JOIN site_load_management slm ON slm.site_id = s.id
    WHERE t.id IN (${idList(tariffIds)})
      AND t.max_current_a IS NOT NULL
      AND (
        t.site_scope <> 'selected'
        OR EXISTS (SELECT 1 FROM tariff_sites ts WHERE ts.tariff_id = t.id AND ts.site_id = s.id)
      )
      AND slm.is_enabled IS NOT TRUE
      ${visible}
    ORDER BY t.id, s.id`)) as unknown as Array<{ tariff_id: string; site_id: string }>;
  for (const row of rows) {
    const list = result.get(row.tariff_id) ?? [];
    list.push(row.site_id);
    result.set(row.tariff_id, list);
  }
  return result;
}
