// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, type SQL, type Column } from 'drizzle-orm';
import { evses, connectors } from '@evtivity/database';

/**
 * Correlated subquery that derives a single station-level status from the
 * statuses of all its connectors. Used by the station list, station detail,
 * and maintenance station-preview so every surface shows the same status.
 *
 * Pass the station-id column to correlate against (e.g. `chargingStations.id`).
 * The CASE precedence (charging > reserved > faulted > unknown > available >
 * unavailable) must stay identical across callers; the frontend status badge
 * mapping depends on these exact values.
 */
export function buildDerivedStatusSubquery(stationIdColumn: Column): SQL<string> {
  return sql<string>`(
    SELECT CASE
      WHEN COUNT(c2.id) FILTER (WHERE c2.status IN ('occupied', 'charging', 'preparing', 'ev_connected', 'suspended_ev', 'suspended_evse')) > 0 THEN 'charging'
      WHEN COUNT(c2.id) FILTER (WHERE c2.status = 'reserved') > 0 THEN 'reserved'
      WHEN COUNT(c2.id) FILTER (WHERE c2.status = 'faulted') > 0 THEN 'faulted'
      WHEN COUNT(c2.id) = 0 THEN 'unknown'
      WHEN COUNT(c2.id) FILTER (WHERE c2.status = 'available') = COUNT(c2.id) THEN 'available'
      ELSE 'unavailable'
    END
    FROM ${evses} e2
    JOIN ${connectors} c2 ON c2.evse_id = e2.id
    WHERE e2.station_id = ${stationIdColumn}
  )`;
}
