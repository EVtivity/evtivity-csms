// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db, getReservationSettings } from '@evtivity/database';
import { reservations } from '@evtivity/database';

/**
 * Returns true if the given EVSE has an active reservation whose startsAt
 * falls within the configured buffer window from now.
 *
 * When bufferMinutes is 0, the check is skipped and false is returned.
 * When evseDbId is null, checks only station-level reservations (evseId IS NULL).
 */
export async function isEvseInReservationBuffer(
  stationDbId: string,
  evseDbId: string | null,
): Promise<boolean> {
  const config = await getReservationSettings();
  if (config.bufferMinutes <= 0) return false;

  const now = new Date();
  const bufferCutoff = new Date(now.getTime() + config.bufferMinutes * 60_000);

  const conditions = [
    eq(reservations.stationId, stationDbId),
    inArray(reservations.status, ['active']),
    gte(reservations.expiresAt, now),
    // The reservation's intended start time (or created_at if null) falls within [now, now + bufferMinutes]
    sql`COALESCE(${reservations.startsAt}, ${reservations.createdAt}) <= ${bufferCutoff}`,
    sql`COALESCE(${reservations.startsAt}, ${reservations.createdAt}) >= ${now}`,
  ];

  if (evseDbId != null) {
    // A station-wide reservation (evseId IS NULL) also blocks any EVSE on that station
    conditions.push(or(eq(reservations.evseId, evseDbId), isNull(reservations.evseId)) as SQL);
  }

  const rows = await db
    .select({ id: reservations.id })
    .from(reservations)
    .where(and(...conditions))
    .limit(1);

  return rows.length > 0;
}
