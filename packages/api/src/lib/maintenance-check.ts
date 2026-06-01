// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, inArray, or, isNull, sql } from 'drizzle-orm';
import { db, maintenanceEvents, chargingStations } from '@evtivity/database';
import { AppError } from '@evtivity/lib';
import { getPubSub } from './pubsub.js';

export interface MaintenanceConflict {
  id: string;
  siteId: string;
  status: 'scheduled' | 'active' | 'completed' | 'cancelled';
  plannedStartAt: Date;
  plannedEndAt: Date;
  affectedStationIds: string[] | null;
}

interface CacheEntry {
  events: MaintenanceConflict[];
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function overlaps(eventStart: Date, eventEnd: Date, windowStart: Date, windowEnd: Date): boolean {
  return eventStart < windowEnd && eventEnd > windowStart;
}

function appliesToStation(event: MaintenanceConflict, stationId: string): boolean {
  if (event.affectedStationIds == null) return true;
  if (event.affectedStationIds.length === 0) return true;
  return event.affectedStationIds.includes(stationId);
}

async function loadStationMaintenance(stationId: string): Promise<MaintenanceConflict[]> {
  const cached = cache.get(stationId);
  if (cached != null && cached.expiresAt > Date.now()) {
    return cached.events;
  }

  const [station] = await db
    .select({ siteId: chargingStations.siteId })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationId));

  if (station == null || station.siteId == null) {
    cache.set(stationId, { events: [], expiresAt: Date.now() + CACHE_TTL_MS });
    return [];
  }

  const rows = await db
    .select({
      id: maintenanceEvents.id,
      siteId: maintenanceEvents.siteId,
      status: maintenanceEvents.status,
      plannedStartAt: maintenanceEvents.plannedStartAt,
      plannedEndAt: maintenanceEvents.plannedEndAt,
      affectedStationIds: maintenanceEvents.affectedStationIds,
    })
    .from(maintenanceEvents)
    .where(
      and(
        eq(maintenanceEvents.siteId, station.siteId),
        inArray(maintenanceEvents.status, ['scheduled', 'active']),
        or(
          isNull(maintenanceEvents.affectedStationIds),
          sql`${maintenanceEvents.affectedStationIds} = '{}'::text[]`,
          sql`${stationId} = ANY(${maintenanceEvents.affectedStationIds})`,
        ),
      ),
    );

  const events: MaintenanceConflict[] = rows.map((r) => ({
    id: r.id,
    siteId: r.siteId,
    status: r.status,
    plannedStartAt: r.plannedStartAt,
    plannedEndAt: r.plannedEndAt,
    affectedStationIds: r.affectedStationIds,
  }));

  cache.set(stationId, { events, expiresAt: Date.now() + CACHE_TTL_MS });
  return events;
}

export async function findMaintenanceConflicts(
  stationId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<MaintenanceConflict[]> {
  const events = await loadStationMaintenance(stationId);
  return events.filter(
    (e) =>
      appliesToStation(e, stationId) &&
      overlaps(e.plannedStartAt, e.plannedEndAt, startsAt, endsAt),
  );
}

export class MaintenanceConflictError extends AppError {
  public readonly details: {
    maintenanceEventId: string;
    plannedStartAt: string;
    plannedEndAt: string;
  };

  constructor(event: MaintenanceConflict) {
    super(
      'Reservation falls within a scheduled maintenance window',
      409,
      'RESERVATION_DURING_MAINTENANCE',
    );
    this.name = 'MaintenanceConflictError';
    this.details = {
      maintenanceEventId: event.id,
      plannedStartAt: event.plannedStartAt.toISOString(),
      plannedEndAt: event.plannedEndAt.toISOString(),
    };
  }
}

export async function assertNoMaintenanceConflict(
  stationId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<void> {
  const conflicts = await findMaintenanceConflicts(stationId, startsAt, endsAt);
  if (conflicts.length === 0) return;
  const first = conflicts[0];
  if (first == null) return;
  throw new MaintenanceConflictError(first);
}

/** Clear the in-process cache only. Used by the cache-invalidate pub/sub
 *  listener so a broadcast invalidation does not re-publish. */
export function clearMaintenanceCheckCacheLocal(): void {
  cache.clear();
}

/**
 * Invalidate the maintenance check cache across all API pods.
 * Call this when maintenance events enter/exit, are cancelled, or are deleted.
 */
export function invalidateMaintenanceCheckCache(): void {
  clearMaintenanceCheckCacheLocal();
  void getPubSub()
    .publish('cache_invalidate', JSON.stringify({ kind: 'maintenance' }))
    .catch(() => {
      // Best-effort; peers fall back to TTL.
    });
}
