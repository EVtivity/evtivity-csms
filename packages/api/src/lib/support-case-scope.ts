// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  chargingSessions,
  chargingStations,
  supportCaseSessions,
  supportCases,
} from '@evtivity/database';

/**
 * Build a SQL condition that filters support cases by site access for a
 * site-restricted operator (P11, multi-tenant isolation):
 * - a case with a station is visible when the station is in one of the
 *   user's sites (an unsited station is out of scope)
 * - a case without a station is visible only when it has linked sessions and
 *   every linked session ran at a station in the user's sites; a case with
 *   neither station nor sessions belongs to no site and is visible to
 *   all-site users only
 */
export function supportCaseSiteCondition(siteIds: string[]): SQL {
  if (siteIds.length === 0) return sql`false`;
  const siteList = sql.join(
    siteIds.map((siteId) => sql`${siteId}`),
    sql`, `,
  );
  return sql`(CASE
    WHEN ${supportCases.stationId} IS NOT NULL THEN EXISTS (
      SELECT 1 FROM ${chargingStations}
      WHERE ${chargingStations.id} = ${supportCases.stationId}
        AND ${chargingStations.siteId} IN (${siteList})
    )
    ELSE EXISTS (
      SELECT 1 FROM ${supportCaseSessions}
      WHERE ${supportCaseSessions.caseId} = ${supportCases.id}
    ) AND NOT EXISTS (
      SELECT 1 FROM ${supportCaseSessions}
      JOIN ${chargingSessions} ON ${chargingSessions.id} = ${supportCaseSessions.sessionId}
      LEFT JOIN ${chargingStations} ON ${chargingStations.id} = ${chargingSessions.stationId}
      WHERE ${supportCaseSessions.caseId} = ${supportCases.id}
        AND (${chargingStations.siteId} IS NULL OR ${chargingStations.siteId} NOT IN (${siteList}))
    )
  END)`;
}
