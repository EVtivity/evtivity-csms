// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { chargingStations } from '@evtivity/database';

/**
 * SET value for charging_stations.circuit_id in an UPDATE that may move the
 * station to `newSiteId`. A circuit belongs to a panel of one site, so a
 * station that changes site leaves its circuit: the column is cleared when
 * the stored site differs from the new one and kept otherwise. The CASE reads
 * the row's current site inside the UPDATE, so it needs no prior read.
 */
export function circuitIdAfterSiteChange(newSiteId: string | null): SQL {
  return sql`CASE WHEN ${chargingStations.siteId} IS NOT DISTINCT FROM ${newSiteId} THEN ${chargingStations.circuitId} ELSE NULL END`;
}
