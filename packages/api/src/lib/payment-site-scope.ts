// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, inArray, or, type SQL } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  paymentRecords,
  reservations,
} from '@evtivity/database';

/**
 * Keeps the payment records of the given sites (an operator's
 * `getUserSiteIds()`): a session record through its session's station, a
 * reservation fee record through its reservation's station. Callers handle
 * an unrestricted operator (null) and an empty list themselves.
 */
export function paymentRecordsAtSites(siteIds: string[]): SQL {
  return or(
    inArray(
      paymentRecords.sessionId,
      db
        .select({ id: chargingSessions.id })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
        .where(inArray(chargingStations.siteId, siteIds)),
    ),
    inArray(
      paymentRecords.reservationId,
      db
        .select({ id: reservations.id })
        .from(reservations)
        .innerJoin(chargingStations, eq(chargingStations.id, reservations.stationId))
        .where(inArray(chargingStations.siteId, siteIds)),
    ),
  ) as SQL;
}
