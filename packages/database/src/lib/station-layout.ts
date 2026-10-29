// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The one writer of station_layout_positions. A station that gets a site
// (create, CSV import, site move) is placed on the first free grid slot of
// that site, so it never lands on another station; the layout Save writes the
// whole layout. Every write takes the site's transaction advisory lock, so two
// stations created in parallel never pick the same slot. Callers pass their
// transaction.

import { eq, sql } from 'drizzle-orm';
import { firstFreeSlot } from '@evtivity/lib/site-layout';
import type { LayoutPoint } from '@evtivity/lib/site-layout';
import { db } from '../config.js';
import { stationLayoutPositions } from '../schema/assets.js';

export type StationLayoutDb = Pick<typeof db, 'select' | 'insert' | 'delete' | 'execute'>;

async function lockSiteLayout(tx: StationLayoutDb, siteId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`station_layout:${siteId}`}))`);
}

/** The stored positions of a site's stations. */
export async function readSiteLayoutPositions(
  siteId: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<{ stationId: string; positionX: number; positionY: number }[]> {
  const rows = await executor
    .select({
      stationId: stationLayoutPositions.stationId,
      positionX: stationLayoutPositions.positionX,
      positionY: stationLayoutPositions.positionY,
    })
    .from(stationLayoutPositions)
    .where(eq(stationLayoutPositions.siteId, siteId));
  return rows.map((r) => ({
    stationId: r.stationId,
    positionX: Number(r.positionX),
    positionY: Number(r.positionY),
  }));
}

/**
 * Places the station on the site's layout: a station that already has a
 * position at this site keeps it; any other (none yet, or a row of another
 * site) gets the first free slot of this site. Returns the position.
 */
export async function placeStationOnLayout(
  tx: StationLayoutDb,
  siteId: string,
  stationId: string,
): Promise<LayoutPoint> {
  await lockSiteLayout(tx, siteId);
  const rows = await tx
    .select({
      stationId: stationLayoutPositions.stationId,
      siteId: stationLayoutPositions.siteId,
      positionX: stationLayoutPositions.positionX,
      positionY: stationLayoutPositions.positionY,
    })
    .from(stationLayoutPositions)
    .where(eq(stationLayoutPositions.siteId, siteId));
  const own = rows.find((r) => r.stationId === stationId);
  if (own != null) return { x: Number(own.positionX), y: Number(own.positionY) };
  // A row of another site (the station moved without going through here).
  await tx.delete(stationLayoutPositions).where(eq(stationLayoutPositions.stationId, stationId));
  const slot = firstFreeSlot(rows.map((r) => ({ x: Number(r.positionX), y: Number(r.positionY) })));
  await tx.insert(stationLayoutPositions).values({
    siteId,
    stationId,
    positionX: String(slot.x),
    positionY: String(slot.y),
  });
  return slot;
}

/**
 * A station changed site: its position at the old site goes, and it is placed
 * on the new site's layout (none when it has no site now).
 */
export async function moveStationLayout(
  tx: StationLayoutDb,
  stationId: string,
  siteId: string | null,
): Promise<void> {
  if (siteId == null) {
    await tx.delete(stationLayoutPositions).where(eq(stationLayoutPositions.stationId, stationId));
    return;
  }
  await placeStationOnLayout(tx, siteId, stationId);
}

/**
 * The layout Save: one row per station of the site, with its position. The
 * caller checks every station belongs to the site.
 */
export async function saveSiteLayout(
  tx: StationLayoutDb,
  siteId: string,
  positions: readonly { stationId: string; positionX: number; positionY: number }[],
): Promise<void> {
  await lockSiteLayout(tx, siteId);
  for (const pos of positions) {
    await tx
      .insert(stationLayoutPositions)
      .values({
        siteId,
        stationId: pos.stationId,
        positionX: String(pos.positionX),
        positionY: String(pos.positionY),
      })
      .onConflictDoUpdate({
        target: stationLayoutPositions.stationId,
        set: {
          siteId,
          positionX: String(pos.positionX),
          positionY: String(pos.positionY),
          updatedAt: new Date(),
        },
      });
  }
}
