// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The one writer of station_layout_positions and of a site's layout settings
// (sites.layout_settings: the paved lot and the transformers on the grass). A
// station that gets a site (create, CSV import, site move) is placed on the
// first free spot of that site's lot (the rows below a full lot when every
// spot is taken), so it never lands on another station; the layout Save writes
// the whole layout and, when it carries them, the settings. Every write takes
// the site's transaction advisory lock, so two stations created in parallel
// never pick the same slot. Callers pass their transaction.

import { and, eq, sql } from 'drizzle-orm';
import {
  effectiveLayoutSettings,
  firstFreeSlot,
  fitPositionsToGrid,
  freeSlotsFor,
  positionToBay,
  sameLayoutSettings,
} from '@evtivity/lib/site-layout';
import type { LayoutPoint, SiteLayoutSettings } from '@evtivity/lib/site-layout';
import { db } from '../config.js';
import { chargingStations, sites, stationLayoutPositions } from '../schema/assets.js';
import { isOperatorStation } from './conformance-stations.js';

export type StationLayoutDb = Pick<
  typeof db,
  'select' | 'insert' | 'update' | 'delete' | 'execute'
>;

export interface LayoutPosition {
  stationId: string;
  positionX: number;
  positionY: number;
}

/**
 * A lot change leaves stations outside the lot with no free spot inside it.
 * `stations` holds their OCPP station ids.
 */
export class LayoutGridTooSmallError extends Error {
  constructor(readonly stations: string[]) {
    super(`The parking lot has no free spot for ${String(stations.length)} station(s)`);
    this.name = 'LayoutGridTooSmallError';
  }
}

async function lockSiteLayout(tx: StationLayoutDb, siteId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`station_layout:${siteId}`}))`);
}

/** The stored layout settings of a site, null when it never saved any. */
export async function readStoredLayoutSettings(
  siteId: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<SiteLayoutSettings | null> {
  const [row] = await executor
    .select({ layoutSettings: sites.layoutSettings })
    .from(sites)
    .where(eq(sites.id, siteId));
  return row?.layoutSettings ?? null;
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
 * The layout settings the views and the placement use: the stored ones, else
 * the default lot grown to hold the stored positions, with one transformer.
 */
export async function readSiteLayoutSettings(
  siteId: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<SiteLayoutSettings> {
  const stored = await readStoredLayoutSettings(siteId, executor);
  if (stored != null) return effectiveLayoutSettings(stored);
  const positions = await readSiteLayoutPositions(siteId, executor);
  return effectiveLayoutSettings(
    null,
    positions.map((p) => positionToBay({ x: p.positionX, y: p.positionY })),
  );
}

/**
 * Places the station on the site's layout: a station that already has a
 * position at this site keeps it; any other (none yet, or a row of another
 * site) gets the first free spot of this site's lot (the rows below a full
 * lot when every spot is taken). Returns the position.
 */
export async function placeStationOnLayout(
  tx: StationLayoutDb,
  siteId: string,
  stationId: string,
): Promise<LayoutPoint> {
  await lockSiteLayout(tx, siteId);
  const stored = await readStoredLayoutSettings(siteId, tx);
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
  const points = rows.map((r) => ({ x: Number(r.positionX), y: Number(r.positionY) }));
  const settings = effectiveLayoutSettings(
    stored,
    points.map((p) => positionToBay(p)),
  );
  const slot = firstFreeSlot(points, settings);
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

export interface SavedSiteLayout {
  settingsBefore: SiteLayoutSettings;
  settingsAfter: SiteLayoutSettings;
  /** True when the stored settings changed. */
  settingsChanged: boolean;
  /** Stations the lot moved inside it (their new positions are saved). */
  moved: LayoutPosition[];
}

/**
 * The layout Save: one row per given station, with its position, and the
 * layout settings when `settings` is given (null resets them to the default;
 * undefined keeps the stored ones). The caller checks every station belongs to
 * the site.
 *
 * Positions rule: a station whose spot lies inside the lot keeps its position;
 * one outside moves to the nearest free spot inside and that position is saved
 * (`moved`). A settings change that leaves a station with no free spot throws
 * LayoutGridTooSmallError and writes nothing; without one such stations keep
 * their positions (a station placed below a full lot stays on the grass until
 * the lot grows). A site without stored settings has the default lot grown to
 * hold every station, so nothing is outside it. Transformers stand on the
 * grass: one on the lot moves to the nearest lot side.
 */
export async function saveSiteLayout(
  tx: StationLayoutDb,
  siteId: string,
  positions: readonly LayoutPosition[],
  settings?: SiteLayoutSettings | null,
): Promise<SavedSiteLayout> {
  await lockSiteLayout(tx, siteId);
  const stored = await readStoredLayoutSettings(siteId, tx);
  const target = settings === undefined ? stored : settings;

  // Every operator station of the site, at its sent, saved or free position.
  const stationRows = await tx
    .select({
      id: chargingStations.id,
      stationId: chargingStations.stationId,
      positionX: stationLayoutPositions.positionX,
      positionY: stationLayoutPositions.positionY,
    })
    .from(chargingStations)
    .leftJoin(
      stationLayoutPositions,
      and(
        eq(stationLayoutPositions.stationId, chargingStations.id),
        eq(stationLayoutPositions.siteId, chargingStations.siteId),
      ),
    )
    .where(and(eq(chargingStations.siteId, siteId), isOperatorStation()));
  const storedPoints = stationRows.flatMap((s) =>
    s.positionX != null && s.positionY != null
      ? [{ x: Number(s.positionX), y: Number(s.positionY) }]
      : [],
  );
  const settingsBefore = effectiveLayoutSettings(
    stored,
    storedPoints.map((p) => positionToBay(p)),
  );

  const sent = new Map(positions.map((p) => [p.stationId, { x: p.positionX, y: p.positionY }]));
  const located: Array<{ id: string; stationId: string; point: LayoutPoint | null }> =
    stationRows.map((s) => ({
      id: s.id,
      stationId: s.stationId,
      point:
        sent.get(s.id) ??
        (s.positionX != null && s.positionY != null
          ? { x: Number(s.positionX), y: Number(s.positionY) }
          : null),
    }));
  const placed = located.flatMap((s) => (s.point != null ? [s.point] : []));
  const unplaced = located.filter((s) => s.point == null);
  const placementGrid = effectiveLayoutSettings(
    target,
    placed.map((p) => positionToBay(p)),
  );
  const slots = freeSlotsFor(unplaced.length, placed, placementGrid);
  unplaced.forEach((s, i) => {
    s.point = slots[i] ?? null;
  });
  const finalBays = located.flatMap((s) => (s.point != null ? [positionToBay(s.point)] : []));
  const settingsAfter = effectiveLayoutSettings(target, finalBays);

  const moved: LayoutPosition[] = [];
  if (target != null) {
    const fit = fitPositionsToGrid(
      located.flatMap((s) => (s.point != null ? [{ key: s.id, position: s.point }] : [])),
      settingsAfter,
    );
    if (fit.unfit.length > 0 && settings !== undefined) {
      const names = new Map(located.map((s) => [s.id, s.stationId]));
      throw new LayoutGridTooSmallError(fit.unfit.map((id) => names.get(id) ?? id));
    }
    for (const [stationId, point] of fit.moved) {
      moved.push({ stationId, positionX: point.x, positionY: point.y });
    }
  }

  const toWrite = new Map(positions.map((p) => [p.stationId, p]));
  for (const m of moved) toWrite.set(m.stationId, m);
  for (const pos of toWrite.values()) {
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

  // Stored as sent with the transformers on the grass; null resets.
  const nextStored = settings === undefined ? stored : settings === null ? null : settingsAfter;
  const settingsChanged =
    settings !== undefined &&
    (stored == null || nextStored == null
      ? stored !== nextStored
      : !sameLayoutSettings(stored, nextStored));
  if (settingsChanged) {
    await tx
      .update(sites)
      .set({ layoutSettings: nextStored, updatedAt: new Date() })
      .where(eq(sites.id, siteId));
  }
  return { settingsBefore, settingsAfter, settingsChanged, moved };
}
