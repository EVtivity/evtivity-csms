// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The active session each station of the site layout shows (GET
// /v1/sites/:id/layout `session`). The route decides what the request may see:
// the session needs sessions:read, its driver drivers:read too. An erased
// driver shows as no driver. Avatars go through `withAvatars`, the one avatar
// read path.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, chargingSessions, drivers } from '@evtivity/database';
import { withAvatars } from '../services/account-avatar.js';
import type { AvatarView } from '../services/account-avatar.js';

export interface LayoutSessionDriver {
  id: string;
  name: string | null;
  avatar: AvatarView | null;
}

export interface LayoutStationSession {
  id: string;
  startedAt: string;
  energyDeliveredWh: number;
  currentCostCents: number | null;
  currency: string;
  driver: LayoutSessionDriver | null;
}

/** A driver's display name: first and last name, null when both are blank. */
export function layoutDriverName(firstName: string, lastName: string): string | null {
  const name = `${firstName} ${lastName}`.trim();
  return name === '' ? null : name;
}

/**
 * The newest active session of each station (by start, then creation), keyed by
 * the station's internal id. With `includeDriver` false every `driver` is null
 * and no driver row is read.
 */
export async function readLayoutStationSessions(
  stationIds: readonly string[],
  includeDriver: boolean,
): Promise<Map<string, LayoutStationSession>> {
  const out = new Map<string, LayoutStationSession>();
  if (stationIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([chargingSessions.stationId], {
      id: chargingSessions.id,
      stationId: chargingSessions.stationId,
      startedAt: sql<
        Date | string
      >`coalesce(${chargingSessions.startedAt}, ${chargingSessions.createdAt})`,
      energyDeliveredWh: chargingSessions.energyDeliveredWh,
      currentCostCents: chargingSessions.currentCostCents,
      currency: chargingSessions.currency,
      driverId: chargingSessions.driverId,
    })
    .from(chargingSessions)
    .where(
      and(
        inArray(chargingSessions.stationId, [...stationIds]),
        eq(chargingSessions.status, 'active'),
      ),
    )
    .orderBy(
      chargingSessions.stationId,
      desc(sql`coalesce(${chargingSessions.startedAt}, ${chargingSessions.createdAt})`),
      desc(chargingSessions.createdAt),
    );

  const driverIds = includeDriver
    ? [...new Set(rows.flatMap((r) => (r.driverId != null ? [r.driverId] : [])))]
    : [];
  const driverById = new Map<string, LayoutSessionDriver>();
  if (driverIds.length > 0) {
    const driverRows = await db
      .select({
        id: drivers.id,
        firstName: drivers.firstName,
        lastName: drivers.lastName,
        erasedAt: drivers.erasedAt,
        avatarKind: drivers.avatarKind,
        avatarOptions: drivers.avatarOptions,
        avatarS3Key: drivers.avatarS3Key,
        avatarS3Bucket: drivers.avatarS3Bucket,
        avatarUpdatedAt: drivers.avatarUpdatedAt,
      })
      .from(drivers)
      .where(inArray(drivers.id, driverIds));
    // An erased driver is a stub: no name and no avatar on the layout.
    const withAvatar = await withAvatars(driverRows.filter((d) => d.erasedAt == null));
    for (const d of withAvatar) {
      driverById.set(d.id, {
        id: d.id,
        name: layoutDriverName(d.firstName, d.lastName),
        avatar: d.avatar,
      });
    }
  }

  for (const r of rows) {
    const startedAt = r.startedAt instanceof Date ? r.startedAt : new Date(r.startedAt);
    out.set(r.stationId, {
      id: r.id,
      startedAt: startedAt.toISOString(),
      energyDeliveredWh: Number(r.energyDeliveredWh ?? '0'),
      currentCostCents: r.currentCostCents,
      currency: r.currency.toUpperCase(),
      driver: r.driverId != null ? (driverById.get(r.driverId) ?? null) : null,
    });
  }
  return out;
}
