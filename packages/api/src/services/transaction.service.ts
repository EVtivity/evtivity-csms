// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, ilike, desc, sql, inArray } from 'drizzle-orm';
import { db, inOperatorStation } from '@evtivity/database';
import { transactionEvents, chargingSessions, chargingStations } from '@evtivity/database';
import type { PaginationParams, PaginatedResponse } from '../lib/pagination.js';
import { containsPattern } from '../lib/like-pattern.js';

export async function listTransactionEvents(
  params: PaginationParams,
  siteIds?: string[] | null,
): Promise<PaginatedResponse<(typeof transactionEvents)['$inferSelect']>> {
  const { page, limit, search } = params;
  const offset = (page - 1) * limit;

  // Events of sessions at conformance (OCTT) stations are never listed.
  const conditions = [inOperatorStation(chargingSessions.stationId)];
  if (search) {
    conditions.push(ilike(transactionEvents.triggerReason, containsPattern(search)));
  }
  if (siteIds != null) {
    // The site the session happened at, as for the session routes.
    conditions.push(inArray(chargingSessions.siteId, siteIds));
  }

  const where = and(...conditions);

  const baseQuery = db
    .select({ event: transactionEvents })
    .from(transactionEvents)
    .innerJoin(chargingSessions, eq(transactionEvents.sessionId, chargingSessions.id));

  const [data, countRows] = await Promise.all([
    baseQuery
      .where(where)
      .orderBy(desc(transactionEvents.createdAt), desc(transactionEvents.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(transactionEvents)
      .innerJoin(chargingSessions, eq(transactionEvents.sessionId, chargingSessions.id))
      .where(where),
  ]);

  return { data: data.map((r) => r.event), total: countRows[0]?.count ?? 0 };
}

export async function getTransactionEventsBySession(sessionId: string) {
  return db
    .select()
    .from(transactionEvents)
    .where(eq(transactionEvents.sessionId, sessionId))
    .orderBy(transactionEvents.seqNo);
}

/**
 * The session of a transaction at a station (its OCPP identity). A
 * transactionId is unique per station only (OCPP 2.1 E01.FR.08).
 */
export async function getSessionByTransactionId(stationOcppId: string, transactionId: string) {
  const [row] = await db
    .select({ session: chargingSessions })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .where(
      and(
        eq(chargingStations.stationId, stationOcppId),
        eq(chargingSessions.transactionId, transactionId),
      ),
    );
  return row?.session ?? null;
}
