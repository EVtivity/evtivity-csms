// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc, sql, type SQL } from 'drizzle-orm';
import { fleets } from '@evtivity/database';
import { defineListSort, type ListSortDefinition } from '../list-sort.js';

// Correlated counts written out with aliases: a single-table select renders columns
// unqualified, so the fleet id must name "fleets".

/** The fleet's driver count, as `GET /v1/fleets` lists and sorts it. */
export const fleetDriverCountSql = sql<number>`(select count(*) from fleet_drivers fd where fd.fleet_id = "fleets"."id")::int`;

/**
 * The fleet's station count, as `GET /v1/fleets` lists and sorts it: with `siteIds` (a
 * site-restricted user) only the fleet's stations at those sites.
 */
export function fleetStationCountSql(siteIds: string[] | null): SQL<number> {
  if (siteIds == null) {
    return sql<number>`(select count(*) from fleet_stations fs where fs.fleet_id = "fleets"."id")::int`;
  }
  if (siteIds.length === 0) return sql<number>`0`;
  return sql<number>`(select count(*) from fleet_stations fs inner join charging_stations cs on cs.id = fs.station_id where fs.fleet_id = "fleets"."id" and cs.site_id in ${siteIds})::int`;
}

type FleetSortKey = 'name' | 'description' | 'driverCount' | 'stationCount' | 'createdAt';

/**
 * The sortable columns of `GET /v1/fleets` (`api/routes.md`, "List sorting"), for the
 * caller's sites (the station count counts only the stations the caller sees). The keys do
 * not depend on the sites, so the route schema uses `fleetListSort(null).query`.
 */
export function fleetListSort(siteIds: string[] | null): ListSortDefinition<FleetSortKey> {
  return defineListSort<FleetSortKey>(
    {
      name: fleets.name,
      description: fleets.description,
      driverCount: fleetDriverCountSql,
      stationCount: fleetStationCountSql(siteIds),
      createdAt: fleets.createdAt,
    },
    {
      tieBreaker: fleets.id,
      defaultOrder: [desc(fleets.createdAt), desc(fleets.id)],
    },
  );
}
