// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc, sql } from 'drizzle-orm';
import { chargingStations, siteLoadManagement, sites } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/sites` (`api/routes.md`, "List sorting"): FROM `sites`
 * with the operator stations and the load management row joined, grouped by site.
 */
export const siteListSort = defineListSort(
  {
    name: sites.name,
    // The list shows "City, State": city first, then state.
    location: sql`nullif(concat_ws(', ', ${sites.city}, ${sites.state}), '')`,
    stationCount: sql`count(${chargingStations.id})`,
    loadManagement: sql`coalesce(${siteLoadManagement.isEnabled}, false)`,
    createdAt: sites.createdAt,
  },
  {
    tieBreaker: sites.id,
    defaultOrder: [desc(sites.createdAt), desc(sites.id)],
  },
);
