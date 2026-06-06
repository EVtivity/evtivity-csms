// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, getTableName, type SQL, type Column } from 'drizzle-orm';
import { maintenanceEvents } from '@evtivity/database';

/**
 * Correlated EXISTS that reports whether a station is covered by an active
 * maintenance event right now. Mirrors the coverage semantics of the
 * maintenance service: a null or empty affected_station_ids array means the
 * event covers the entire site.
 *
 * Pass the station-id and site-id columns to correlate against. Columns are
 * table-qualified because in a no-join outer query drizzle renders them
 * unqualified, which is ambiguous inside the subquery.
 */
export function buildUnderMaintenanceSubquery(
  stationIdColumn: Column,
  siteIdColumn: Column,
): SQL<boolean> {
  const stationRef = sql`${sql.identifier(getTableName(stationIdColumn.table))}.${sql.identifier(stationIdColumn.name)}`;
  const siteRef = sql`${sql.identifier(getTableName(siteIdColumn.table))}.${sql.identifier(siteIdColumn.name)}`;
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${maintenanceEvents} me
    WHERE me.status = 'active'
      AND me.site_id = ${siteRef}
      AND me.planned_start_at < now() AND me.planned_end_at > now()
      AND (me.affected_station_ids IS NULL
           OR me.affected_station_ids = '{}'::text[]
           OR ${stationRef} = ANY(me.affected_station_ids))
  )`;
}
