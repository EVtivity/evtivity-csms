// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The time windows behind the virtual status signs of the site layout (GET
// /v1/sites/:id/layout `reservation` and `maintenanceWindow`): the
// reservation holding a station now and the active maintenance event
// covering it. The route decides what the request may see: the reservation
// needs reservations:read; the maintenance window shows with sites:read, as
// `inMaintenance` does. Both read the stations of the one site the route
// already scoped to the caller.

import { and, asc, gt, inArray, lte, or, eq, sql } from 'drizzle-orm';
import { db, maintenanceEvents, reservations } from '@evtivity/database';

export interface LayoutTimeWindow {
  /** When it started (null: a reservation that holds from its creation). */
  startsAt: string | null;
  /** When it ends. */
  endsAt: string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

/**
 * The reservation holding each station now: `active` or `in_use`, or
 * `scheduled` with its start passed, not expired. The earliest ending one
 * per station, keyed by the station's internal id.
 */
export async function readLayoutReservations(
  stationIds: readonly string[],
): Promise<Map<string, LayoutTimeWindow>> {
  const out = new Map<string, LayoutTimeWindow>();
  if (stationIds.length === 0) return out;
  const rows = await db
    .select({
      stationId: reservations.stationId,
      startsAt: reservations.startsAt,
      expiresAt: reservations.expiresAt,
    })
    .from(reservations)
    .where(
      and(
        inArray(reservations.stationId, [...stationIds]),
        gt(reservations.expiresAt, sql`now()`),
        or(
          inArray(reservations.status, ['active', 'in_use']),
          and(eq(reservations.status, 'scheduled'), lte(reservations.startsAt, sql`now()`)),
        ),
      ),
    )
    .orderBy(asc(reservations.expiresAt));
  for (const row of rows) {
    if (out.has(row.stationId)) continue;
    out.set(row.stationId, {
      startsAt: row.startsAt == null ? null : iso(row.startsAt),
      endsAt: iso(row.expiresAt),
    });
  }
  return out;
}

/**
 * The active maintenance event covering each station of `siteId` now (the
 * coverage of `buildUnderMaintenanceSubquery`: no affected stations means the
 * whole site), the earliest ending one per station.
 */
export async function readLayoutMaintenanceWindows(
  siteId: string,
  stationIds: readonly string[],
): Promise<Map<string, LayoutTimeWindow>> {
  const out = new Map<string, LayoutTimeWindow>();
  if (stationIds.length === 0) return out;
  const rows = await db
    .select({
      startedAt: maintenanceEvents.startedAt,
      plannedStartAt: maintenanceEvents.plannedStartAt,
      plannedEndAt: maintenanceEvents.plannedEndAt,
      affected: maintenanceEvents.affectedStationIds,
    })
    .from(maintenanceEvents)
    .where(
      and(
        eq(maintenanceEvents.siteId, siteId),
        eq(maintenanceEvents.status, 'active'),
        sql`${maintenanceEvents.plannedStartAt} < now()`,
        sql`${maintenanceEvents.plannedEndAt} > now()`,
      ),
    )
    .orderBy(asc(maintenanceEvents.plannedEndAt));
  for (const row of rows) {
    const covered =
      row.affected == null || row.affected.length === 0
        ? stationIds
        : stationIds.filter((id) => row.affected?.includes(id) === true);
    for (const id of covered) {
      if (out.has(id)) continue;
      out.set(id, {
        startsAt: iso(row.startedAt ?? row.plannedStartAt),
        endsAt: iso(row.plannedEndAt),
      });
    }
  }
  return out;
}
