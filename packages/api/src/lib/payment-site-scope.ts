// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  inOperatorStation,
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
    // A session's payment belongs to the site the session happened at.
    inArray(
      paymentRecords.sessionId,
      db
        .select({ id: chargingSessions.id })
        .from(chargingSessions)
        .where(inArray(chargingSessions.siteId, siteIds)),
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

/**
 * Leaves out the payment records of conformance (OCTT) stations: a session
 * record whose session's station, or a reservation fee record whose
 * reservation's station, is a conformance station. Records without a session
 * or reservation pass.
 */
export function paymentRecordsOfOperatorStations(): SQL {
  return and(
    inOperatorStation(
      sql`(SELECT ${chargingSessions.stationId} FROM ${chargingSessions} WHERE ${chargingSessions.id} = ${paymentRecords.sessionId})`,
    ),
    inOperatorStation(
      sql`(SELECT ${reservations.stationId} FROM ${reservations} WHERE ${reservations.id} = ${paymentRecords.reservationId})`,
    ),
  ) as SQL;
}
