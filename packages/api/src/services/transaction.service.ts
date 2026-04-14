// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, ilike, desc, sql, inArray } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { transactionEvents, chargingSessions, chargingStations } from '@evtivity/database';
import type { PaginationParams, PaginatedResponse } from '../lib/pagination.js';

export async function listTransactionEvents(
  params: PaginationParams,
  siteIds?: string[] | null,
): Promise<PaginatedResponse<(typeof transactionEvents)['$inferSelect']>> {
  const { page, limit, search } = params;
  const offset = (page - 1) * limit;

  const conditions = [];
  if (search) {
    conditions.push(ilike(transactionEvents.triggerReason, `%${search}%`));
  }
  if (siteIds != null) {
    conditions.push(inArray(chargingStations.siteId, siteIds));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const baseQuery = db
    .select({ event: transactionEvents })
    .from(transactionEvents)
    .innerJoin(chargingSessions, eq(transactionEvents.sessionId, chargingSessions.id))
    .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id));

  const [data, countRows] = await Promise.all([
    baseQuery.where(where).orderBy(desc(transactionEvents.createdAt)).limit(limit).offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(transactionEvents)
      .innerJoin(chargingSessions, eq(transactionEvents.sessionId, chargingSessions.id))
      .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
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

export async function getSessionByTransactionId(transactionId: string) {
  const [session] = await db
    .select()
    .from(chargingSessions)
    .where(eq(chargingSessions.transactionId, transactionId));
  return session ?? null;
}
