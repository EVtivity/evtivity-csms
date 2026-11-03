// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The one writer of station_layout_positions and of a site's layout settings
// (sites.layout_settings: the site type and the fields of every type). A
// station that gets a site (create, CSV import, site move) is placed on the
// first free spot of that site's layout (the rows below it when every spot is
// taken), so it never lands on another station; the layout Save writes the
// whole layout and, when it carries them, the settings; the site form sets the
// site type through setSiteLayoutType. Every write takes the site's
// transaction advisory lock, so two stations created in parallel never pick
// the same slot. Callers pass their transaction.
//
// A custom site (siteType custom) places its stations freely: each row also
// holds the charger point in meters and its turn (free_x_m, free_z_m,
// free_rotation_deg, @evtivity/lib/site-layout FreePlacement). The grid slot
// stays stored next to it, so switching to another type returns the station
// to its slot; switching to Custom converts the slots to free positions where
// the stations stand now.
//
// A depot (siteType depot) keeps grid slots: row 0 its bus bays, row 1 its
// truck lanes. A station with a Megawatt Charging System connector counts as
// a truck station (`depotStationKind`): it fills the default truck lane count,
// a new one takes a free truck lane first, and a site that turns into a depot
// moves its stations into the area of their kind (`fitDepotPositions`). A
// depot charges DC only: an AC station takes no bay or lane and stands below
// the layout.
//
// On a parking lot, an office or retail row and a street, AC and DC stations
// keep apart: a new station takes the first free spot of its group (DC next
// to the transformer, AC from the far end, `firstFreeSlotFor`), and a site
// that turns into one of these types regroups its stations
// (`fitGroupedPositions`). A layout Save keeps the positions an operator set.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  effectiveLayoutSettings,
  firstFreePlacement,
  firstFreeSlotFor,
  sharesSpotPair,
  splitDispenserCount,
  fitFreePlacementsInReach,
  fitGroupedPositions,
  fitPositionsToGrid,
  freePlacementFromSlot,
  freeSpotCount,
  freeFootprintsOverlap,
  freeSlotsFor,
  layoutStationCountsOfKinds,
  layoutStationKind,
  normalizeRotationDeg,
  positionToBay,
  resolveFreeOverlaps,
  sameLayoutSettings,
  siteTypeOf,
  usesFreePositions,
  chargerPlacementOf,
  DEFAULT_CHARGER_PLACEMENT,
} from '@evtivity/lib/site-layout';
import type {
  ChargerPlacement,
  FreePlacement,
  FreeStation,
  LayoutPoint,
  LayoutStationCounts,
  LayoutStationKind,
  SiteLayoutSettings,
  SiteType,
} from '@evtivity/lib/site-layout';
import { db } from '../config.js';
import {
  chargingStations,
  connectors,
  evses,
  sites,
  stationLayoutPositions,
} from '../schema/assets.js';
import { isOperatorStation } from './conformance-stations.js';

export type StationLayoutDb = Pick<
  typeof db,
  'select' | 'insert' | 'update' | 'delete' | 'execute'
>;

export interface LayoutPosition {
  stationId: string;
  positionX: number;
  positionY: number;
  /** The free position on a custom site; null clears it, undefined keeps the stored one. */
  free?: FreePlacement | null | undefined;
  /**
   * The station's card on the 2D board, in board px (whole px): null clears
   * it (the card shows its computed default slot), undefined keeps the stored
   * one. Never moves the 3D spot.
   */
  board?: { x: number; y: number } | null | undefined;
}

/**
 * A layout Save puts stations of a custom site on each other's parking
 * spots. `stations` holds their OCPP station ids.
 */
export class LayoutSpotsOverlapError extends Error {
  constructor(readonly stations: string[]) {
    super(`The parking spots of ${String(stations.length)} station(s) overlap`);
    this.name = 'LayoutSpotsOverlapError';
  }
}

/** The free position of a row, null when it has none (all three columns are set together). */
function freeOf(row: {
  freeXM?: string | null | undefined;
  freeZM?: string | null | undefined;
  freeRotationDeg?: string | null | undefined;
}): FreePlacement | null {
  if (row.freeXM == null || row.freeZM == null || row.freeRotationDeg == null) return null;
  return {
    x: Number(row.freeXM),
    z: Number(row.freeZM),
    rotationDeg: Number(row.freeRotationDeg),
  };
}

/** A free position as stored: cm, one decimal of a degree, the turn under 360 (car spots only). */
function storedFree(p: FreePlacement): FreePlacement {
  const cm = (v: number): number => Math.round(v * 100) / 100 + 0;
  return { x: cm(p.x), z: cm(p.z), rotationDeg: normalizeRotationDeg(p.rotationDeg) };
}

// The station id of the outer row, qualified: a select from one table leaves
// its columns unqualified, and inside a subquery an unqualified `id` or
// `station_id` names the subquery's own table.
const OUTER_STATION_ID = {
  station: sql.raw('"charging_stations"."id"'),
  layout: sql.raw('"station_layout_positions"."station_id"'),
} as const;
type OuterStation = keyof typeof OUTER_STATION_ID;

/** The EVSEs of a station, counted in the station read (its spots on a custom site). */
const evseCountOf = (outer: OuterStation) =>
  sql<number>`(SELECT count(*)::int FROM evses e WHERE e.station_id = ${OUTER_STATION_ID[outer]})`;

/**
 * The layout kind of each station (`layoutStationKind`: AC or DC, its depot
 * spot and its ports) from the connectors of its in-service EVSEs, by station id. A
 * station without connectors yet (a new station before its boot report) has
 * no entry: it joins no group.
 */
export async function readStationLayoutKinds(
  stationIds: readonly string[],
  executor: Pick<typeof db, 'select'> = db,
): Promise<Map<string, LayoutStationKind>> {
  const out = new Map<string, LayoutStationKind>();
  if (stationIds.length === 0) return out;
  const ids = [...new Set(stationIds)];
  const rows = await executor
    .select({
      stationId: evses.stationId,
      evseId: evses.id,
      connectorType: connectors.connectorType,
      maxPowerKw: connectors.maxPowerKw,
    })
    .from(connectors)
    .innerJoin(evses, eq(evses.id, connectors.evseId))
    .where(
      and(inArray(evses.stationId, ids), isNull(evses.retiredAt), isNull(connectors.retiredAt)),
    );
  const byStation = new Map<
    string,
    Array<{ connectorType: string | null; maxPowerKw: string | null }>
  >();
  const evsesOf = new Map<string, Set<string>>();
  for (const r of rows) {
    const list = byStation.get(r.stationId) ?? [];
    list.push({ connectorType: r.connectorType, maxPowerKw: r.maxPowerKw });
    byStation.set(r.stationId, list);
    const set = evsesOf.get(r.stationId) ?? new Set<string>();
    set.add(r.evseId);
    evsesOf.set(r.stationId, set);
  }
  // The in-service EVSEs are the station's ports (a dual-port AC pedestal shares two spots).
  for (const [id, list] of byStation) {
    out.set(id, layoutStationKind(list, evsesOf.get(id)?.size ?? 1));
  }
  return out;
}

/** The kinds of station ids in order (undefined for one without connectors). */
function kindsIn(
  kinds: ReadonlyMap<string, LayoutStationKind>,
  ids: readonly string[],
): Array<LayoutStationKind | undefined> {
  return ids.map((id) => kinds.get(id));
}

/** The station counts of a site's operator stations (the layout defaults by depot kind). */
export async function readSiteStationCounts(
  siteId: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<LayoutStationCounts> {
  const rows = await executor
    .select({ id: chargingStations.id })
    .from(chargingStations)
    .where(and(eq(chargingStations.siteId, siteId), isOperatorStation()));
  const ids = rows.map((r) => r.id);
  return layoutStationCountsOfKinds(kindsIn(await readStationLayoutKinds(ids, executor), ids));
}

/** A charger placement sent for a site type other than a parking lot. */
export class ChargerPlacementSiteTypeError extends Error {
  constructor() {
    super('Charger placement is a parking lot setting');
    this.name = 'ChargerPlacementSiteTypeError';
  }
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

/** A stored 2D board position (both columns, else none). */
export function boardOf(row: {
  boardX?: number | null | undefined;
  boardY?: number | null | undefined;
}): { x: number; y: number } | null {
  return row.boardX != null && row.boardY != null ? { x: row.boardX, y: row.boardY } : null;
}

/** The stored positions of a site's stations. */
export async function readSiteLayoutPositions(
  siteId: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<LayoutPosition[]> {
  const rows = await executor
    .select({
      stationId: stationLayoutPositions.stationId,
      positionX: stationLayoutPositions.positionX,
      positionY: stationLayoutPositions.positionY,
      freeXM: stationLayoutPositions.freeXM,
      freeZM: stationLayoutPositions.freeZM,
      freeRotationDeg: stationLayoutPositions.freeRotationDeg,
      boardX: stationLayoutPositions.boardX,
      boardY: stationLayoutPositions.boardY,
    })
    .from(stationLayoutPositions)
    .where(eq(stationLayoutPositions.siteId, siteId));
  return rows.map((r) => ({
    stationId: r.stationId,
    positionX: Number(r.positionX),
    positionY: Number(r.positionY),
    free: freeOf(r),
    board: boardOf(r),
  }));
}

/**
 * The layout settings the views and the placement use: the stored ones (the
 * fields of the site type filled in from `stationCount` where absent), else
 * the default lot grown to hold the stored positions, with one transformer.
 * `stationCount` is the operator stations at the site (a depot reads them by
 * kind, `readSiteStationCounts`); the stored positions are counted when it is
 * not given.
 */
export async function readSiteLayoutSettings(
  siteId: string,
  executor: Pick<typeof db, 'select'> = db,
  stationCount?: number | LayoutStationCounts,
): Promise<SiteLayoutSettings> {
  const stored = await readStoredLayoutSettings(siteId, executor);
  const positions = await readSiteLayoutPositions(siteId, executor);
  return effectiveLayoutSettings(
    stored,
    positions.map((p) => positionToBay({ x: p.positionX, y: p.positionY })),
    stationCount,
  );
}

/**
 * Places the station on the site's layout: a station that already has a
 * position at this site keeps it; any other (none yet, or a row of another
 * site) gets the first free spot of this site's layout (the rows below it
 * when every spot is taken), on a depot the first free spot of its own area
 * (a truck lane for a station with an MCS connector, else a bus bay), and on
 * a custom site also a free position right of the other stations
 * (`firstFreePlacement`, counted with two spots). Returns the grid position.
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
      freeXM: stationLayoutPositions.freeXM,
      freeZM: stationLayoutPositions.freeZM,
      freeRotationDeg: stationLayoutPositions.freeRotationDeg,
      evseCount: evseCountOf('layout'),
    })
    .from(stationLayoutPositions)
    .where(eq(stationLayoutPositions.siteId, siteId));
  const own = rows.find((r) => r.stationId === stationId);
  if (own != null) return { x: Number(own.positionX), y: Number(own.positionY) };
  // A row of another site (the station moved without going through here).
  await tx.delete(stationLayoutPositions).where(eq(stationLayoutPositions.stationId, stationId));
  const points = rows.map((r) => ({ x: Number(r.positionX), y: Number(r.positionY) }));
  // The stations placed at the site and this one.
  const ids = [...rows.map((r) => r.stationId), stationId];
  const kinds = await readStationLayoutKinds(ids, tx);
  const kind = kinds.get(stationId);
  const settings = effectiveLayoutSettings(
    stored,
    points.map((p) => positionToBay(p)),
    layoutStationCountsOfKinds(kindsIn(kinds, ids)),
  );
  // The first free spot of the station's group (a depot: of its area), never
  // inside the other charging kind's range.
  const slot = firstFreeSlotFor(
    rows.map((r) => ({
      x: Number(r.positionX),
      y: Number(r.positionY),
      charging: kinds.get(r.stationId)?.charging ?? null,
      pair: sharesSpotPair(kinds.get(r.stationId), settings),
      span: splitDispenserCount(kinds.get(r.stationId), settings),
    })),
    settings,
    kind,
  );
  const free = usesFreePositions(settings)
    ? firstFreePlacement(
        rows.flatMap((r) => {
          const placement = freeOf(r);
          return placement != null ? [{ placement, spots: freeSpotCount(r.evseCount) }] : [];
        }),
      )
    : null;
  await tx.insert(stationLayoutPositions).values({
    siteId,
    stationId,
    positionX: String(slot.x),
    positionY: String(slot.y),
    ...(free != null ? freeColumns(free) : {}),
  });
  return slot;
}

/** The free columns of a row: the position, or all null. */
function freeColumns(free: FreePlacement | null): {
  freeXM: string | null;
  freeZM: string | null;
  freeRotationDeg: string | null;
} {
  if (free == null) return { freeXM: null, freeZM: null, freeRotationDeg: null };
  const p = storedFree(free);
  return { freeXM: String(p.x), freeZM: String(p.z), freeRotationDeg: String(p.rotationDeg) };
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

/** Upserts layout rows of the site (a row of another site moves here). */
async function writePositions(
  tx: StationLayoutDb,
  siteId: string,
  positions: Iterable<LayoutPosition>,
): Promise<void> {
  for (const pos of positions) {
    // undefined keeps the stored free position (none on a new row).
    const free = pos.free === undefined ? {} : freeColumns(pos.free);
    const board =
      pos.board === undefined
        ? undefined
        : pos.board === null
          ? { boardX: null, boardY: null }
          : { boardX: Math.round(pos.board.x), boardY: Math.round(pos.board.y) };
    await tx
      .insert(stationLayoutPositions)
      .values({
        siteId,
        stationId: pos.stationId,
        positionX: String(pos.positionX),
        positionY: String(pos.positionY),
        ...free,
        ...(board ?? {}),
      })
      .onConflictDoUpdate({
        target: stationLayoutPositions.stationId,
        set: {
          // A row that moves to this site counts as placed here now: the day
          // replay reads created_at as the start of the station's time here.
          createdAt: sql`CASE WHEN ${stationLayoutPositions.siteId} = ${siteId} THEN ${stationLayoutPositions.createdAt} ELSE now() END`,
          siteId,
          positionX: String(pos.positionX),
          positionY: String(pos.positionY),
          ...free,
          // A 2D board position counts only at its site: a row that moves to
          // this site without a sent one starts at the computed default slot.
          ...(board ?? {
            boardX: sql`CASE WHEN ${stationLayoutPositions.siteId} = ${siteId} THEN ${stationLayoutPositions.boardX} ELSE NULL END`,
            boardY: sql`CASE WHEN ${stationLayoutPositions.siteId} = ${siteId} THEN ${stationLayoutPositions.boardY} ELSE NULL END`,
          }),
          updatedAt: new Date(),
        },
      });
  }
}

interface SiteStationRow {
  id: string;
  stationId: string;
  positionX: string | null;
  positionY: string | null;
  freeXM?: string | null | undefined;
  freeZM?: string | null | undefined;
  freeRotationDeg?: string | null | undefined;
  evseCount?: number | null | undefined;
  /** AC or DC and the depot spot (`layoutStationKind`); undefined without connectors. */
  kind: LayoutStationKind | undefined;
}

/** Every operator station of the site with its saved position at the site (null when none). */
async function readSiteStations(tx: StationLayoutDb, siteId: string): Promise<SiteStationRow[]> {
  const rows = await tx
    .select({
      id: chargingStations.id,
      stationId: chargingStations.stationId,
      positionX: stationLayoutPositions.positionX,
      positionY: stationLayoutPositions.positionY,
      freeXM: stationLayoutPositions.freeXM,
      freeZM: stationLayoutPositions.freeZM,
      freeRotationDeg: stationLayoutPositions.freeRotationDeg,
      evseCount: evseCountOf('station'),
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
  const kinds = await readStationLayoutKinds(
    rows.map((r) => r.id),
    tx,
  );
  return rows.map((r) => ({ ...r, kind: kinds.get(r.id) }));
}

export interface SavedSiteLayout {
  settingsBefore: SiteLayoutSettings;
  settingsAfter: SiteLayoutSettings;
  /** True when the stored settings changed. */
  settingsChanged: boolean;
  /** Stations the lot moved inside it, or (custom site) that got a free position; their new positions are saved. */
  moved: LayoutPosition[];
}

/**
 * The free positions of stations converted from grid slots: overlaps with the
 * `fixed` stations and each other resolved (`resolveFreeOverlaps`), then every
 * point brought within the stored reach (`fitFreePlacementsInReach`), so
 * switching a large layout to Custom never stores a point out of range. The
 * `fixed` stations keep their positions. Returns each converted station's
 * position as stored.
 */
function settleConvertedPlacements(
  fixed: ReadonlyArray<FreeStation<string>>,
  converted: ReadonlyArray<FreeStation<string>>,
): Map<string, FreePlacement> {
  const all = [...fixed, ...converted];
  const resolved = resolveFreeOverlaps(all);
  const settled = all.map((s) => ({ ...s, placement: resolved.get(s.key) ?? s.placement }));
  const fitted = fitFreePlacementsInReach(settled);
  const fixedKeys = new Set(fixed.map((s) => s.key));
  const out = new Map<string, FreePlacement>();
  for (const s of settled) {
    if (fixedKeys.has(s.key)) continue;
    out.set(s.key, storedFree(fitted.get(s.key) ?? s.placement));
  }
  return out;
}

/**
 * The free positions of a custom site's stations: the sent one, else the
 * stored one, else (switching from another type) the station's grid slot
 * where it stands under `from` (`freePlacementFromSlot`, overlaps resolved),
 * else (already Custom) a free position right of the others. Returns every
 * station with its position and spots, and the ones that got a new position.
 */
function freeLayoutOf(
  stations: ReadonlyArray<{ id: string; row: SiteStationRow; point: LayoutPoint | null }>,
  sent: ReadonlyMap<string, FreePlacement>,
  from: SiteLayoutSettings,
): {
  all: Array<{ key: string; placement: FreePlacement; spots: number }>;
  assigned: Map<string, FreePlacement>;
} {
  const assigned = new Map<string, FreePlacement>();
  const known: Array<{ key: string; placement: FreePlacement; spots: number }> = [];
  const missing: Array<{ id: string; spots: number; point: LayoutPoint | null }> = [];
  for (const s of stations) {
    const spots = freeSpotCount(s.row.evseCount ?? 1);
    const placement = sent.get(s.id) ?? freeOf(s.row);
    if (placement != null) known.push({ key: s.id, placement: storedFree(placement), spots });
    else missing.push({ id: s.id, spots, point: s.point });
  }
  if (!usesFreePositions(from)) {
    const converted = missing.map((m) => ({
      key: m.id,
      placement: freePlacementFromSlot(positionToBay(m.point ?? { x: 20, y: 20 }), from),
      spots: m.spots,
    }));
    const settled = settleConvertedPlacements(known, converted);
    for (const c of converted) {
      const placement = settled.get(c.key) ?? storedFree(c.placement);
      assigned.set(c.key, placement);
      known.push({ ...c, placement });
    }
  } else {
    for (const m of missing) {
      const placement = firstFreePlacement(known, m.spots);
      assigned.set(m.id, placement);
      known.push({ key: m.id, placement, spots: m.spots });
    }
  }
  return { all: known, assigned };
}

/**
 * The layout Save: one row per given station, with its position, and the
 * layout settings when `settings` is given (null resets them to the default;
 * undefined keeps the stored ones). The caller checks every station belongs to
 * the site.
 *
 * On a custom site every station needs a free position (the sent one, else
 * the stored one, else one assigned and saved, `freeLayoutOf`); a sent
 * position whose spots overlap another station's throws
 * LayoutSpotsOverlapError and writes nothing.
 *
 * Positions rule: a station whose spot is part of the layout keeps its
 * position; any other moves to the nearest free spot and that position is
 * saved (`moved`). A settings change that leaves a station with no free spot
 * throws LayoutGridTooSmallError and writes nothing; without one such
 * stations keep their positions (a station placed below a full layout stays
 * off it until the layout grows). A site without stored settings has the
 * default lot grown to hold every station, so nothing is outside it.
 * Transformers stand on the grass: one on the lot moves to the nearest lot
 * side. Fields of the site type left unset are filled from the station count
 * and stored.
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
  const stationRows = await readSiteStations(tx, siteId);
  const stationCount = layoutStationCountsOfKinds(stationRows.map((r) => r.kind));
  const storedPoints = stationRows.flatMap((s) =>
    s.positionX != null && s.positionY != null
      ? [{ x: Number(s.positionX), y: Number(s.positionY) }]
      : [],
  );
  const settingsBefore = effectiveLayoutSettings(
    stored,
    storedPoints.map((p) => positionToBay(p)),
    stationCount,
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
  const kindById = new Map(stationRows.map((r) => [r.id, r.kind]));
  const placedPoints = located.flatMap((s) => (s.point != null ? [s.point] : []));
  const unplaced = located.filter((s) => s.point == null);
  const placementGrid = effectiveLayoutSettings(
    target,
    placedPoints.map((p) => positionToBay(p)),
    stationCount,
  );
  const placed = located.flatMap((s) =>
    s.point != null
      ? [
          {
            ...s.point,
            charging: kindById.get(s.id)?.charging ?? null,
            pair: sharesSpotPair(kindById.get(s.id), placementGrid),
            span: splitDispenserCount(kindById.get(s.id), placementGrid),
          },
        ]
      : [],
  );
  const slots = freeSlotsFor(
    unplaced.map((s) => kindById.get(s.id)),
    placed,
    placementGrid,
  );
  unplaced.forEach((s, i) => {
    s.point = slots[i] ?? null;
  });
  const finalBays = located.flatMap((s) => (s.point != null ? [positionToBay(s.point)] : []));
  const settingsAfter = effectiveLayoutSettings(target, finalBays, stationCount);

  const moved: LayoutPosition[] = [];
  if (usesFreePositions(settingsAfter)) {
    const sentFree = new Map(
      positions.flatMap((p) => (p.free != null ? [[p.stationId, p.free] as const] : [])),
    );
    const free = freeLayoutOf(
      stationRows.map((row, i) => ({ id: row.id, row, point: located[i]?.point ?? null })),
      sentFree,
      settingsBefore,
    );
    // A sent position may not put a station on another's spots.
    const clash = free.all.filter(
      (s) =>
        sentFree.has(s.key) && free.all.some((o) => o.key !== s.key && freeFootprintsOverlap(s, o)),
    );
    if (clash.length > 0) {
      const names = new Map(located.map((s) => [s.id, s.stationId]));
      throw new LayoutSpotsOverlapError(clash.map((s) => names.get(s.key) ?? s.key));
    }
    for (const [stationId, placement] of free.assigned) {
      const point = located.find((s) => s.id === stationId)?.point ?? null;
      if (point == null) continue;
      moved.push({ stationId, positionX: point.x, positionY: point.y, free: placement });
    }
  } else if (target != null) {
    const fit = fitPositionsToGrid(
      located.flatMap((s) =>
        s.point != null ? [{ key: s.id, position: s.point, kind: kindById.get(s.id) }] : [],
      ),
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
  for (const m of moved) toWrite.set(m.stationId, { ...toWrite.get(m.stationId), ...m });
  await writePositions(tx, siteId, toWrite.values());

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

export interface SiteTypeChange {
  /** False when the site already had this type and charger placement (nothing written). */
  changed: boolean;
  /** The site type changed. */
  typeChanged: boolean;
  /** The parking lot's charger placement changed (`chargerPlacementOf`). */
  placementChanged: boolean;
  settingsBefore: SiteLayoutSettings;
  settingsAfter: SiteLayoutSettings;
  /** Stations the new layout moved onto a free spot, or (to Custom) gave a free position; their positions are saved. */
  moved: LayoutPosition[];
}

const TYPE_FIELDS = [
  'chargers',
  'mounting',
  'chargersLeft',
  'chargersRight',
  'busBays',
  'truckLanes',
] as const;

/**
 * Sets the site type (the site create and edit form). Every other field of
 * the settings stays, so switching back restores it; the fields the old type
 * showed are stored as shown, and fields of the new type that were never set
 * stay unset, so they follow the station count (an office or retail site gets
 * one charger position per station, a street splits them over both curbs)
 * until a layout Save stores them. A station outside the new layout moves to
 * the nearest free spot; one with no free spot keeps its position (off the
 * layout, like a station placed below a full lot), no error. Switching to a
 * depot sorts the stations into its areas (`fitDepotPositions`: bus stations
 * into bus bays, truck stations into truck lanes). Switching to
 * Custom gives every placed station a free position where it stands now (its
 * slot converted to meters, `freePlacementFromSlot`; stations whose spots
 * would overlap slide along their row, and stations beyond the stored reach
 * of 400 m are packed into free places within it); switching from Custom returns the
 * stations to their stored slots by the same positions rule. No-op when the
 * site already has the type.
 */
export async function setSiteLayoutType(
  tx: StationLayoutDb,
  siteId: string,
  siteType: SiteType | undefined,
  options: { chargerPlacement?: ChargerPlacement | undefined } = {},
): Promise<SiteTypeChange> {
  await lockSiteLayout(tx, siteId);
  const stored = await readStoredLayoutSettings(siteId, tx);
  const stationRows = await readSiteStations(tx, siteId);
  const located = stationRows.flatMap((s) =>
    s.positionX != null && s.positionY != null
      ? [{ id: s.id, point: { x: Number(s.positionX), y: Number(s.positionY) } }]
      : [],
  );
  const bays = located.map((s) => positionToBay(s.point));
  const count = layoutStationCountsOfKinds(stationRows.map((r) => r.kind));
  const settingsBefore = effectiveLayoutSettings(stored, bays, count);
  const typeBefore = siteTypeOf(settingsBefore);
  const typeAfter = siteType ?? typeBefore;
  // A charger placement belongs to a parking lot only.
  if (options.chargerPlacement != null && typeAfter !== 'parking_lot') {
    throw new ChargerPlacementSiteTypeError();
  }
  const placementBefore = chargerPlacementOf(settingsBefore);
  const placementAfter =
    options.chargerPlacement ??
    (typeBefore === 'parking_lot' ? placementBefore : DEFAULT_CHARGER_PLACEMENT);
  const placementChanged = typeAfter === 'parking_lot' && placementAfter !== placementBefore;
  if (typeBefore === typeAfter && !placementChanged) {
    return {
      changed: false,
      typeChanged: false,
      placementChanged: false,
      settingsBefore,
      settingsAfter: settingsBefore,
      moved: [],
    };
  }
  const typeFields: readonly string[] = [...TYPE_FIELDS, 'chargerPlacement'];
  const nextStored = Object.fromEntries(
    Object.entries({ ...settingsBefore, siteType: typeAfter }).filter(
      ([key]) => !typeFields.includes(key),
    ),
  ) as unknown as SiteLayoutSettings;
  if (
    typeAfter === 'parking_lot' &&
    (placementAfter !== DEFAULT_CHARGER_PLACEMENT || options.chargerPlacement != null)
  ) {
    nextStored.chargerPlacement = placementAfter;
  }
  for (const key of TYPE_FIELDS) {
    const shownBefore =
      (typeBefore === 'office_retail' && (key === 'chargers' || key === 'mounting')) ||
      (typeBefore === 'curbside' && (key === 'chargersLeft' || key === 'chargersRight')) ||
      (typeBefore === 'depot' && (key === 'busBays' || key === 'truckLanes'));
    const value = shownBefore ? settingsBefore[key] : stored?.[key];
    if (value !== undefined) Object.assign(nextStored, { [key]: value });
  }
  const settingsAfter = effectiveLayoutSettings(nextStored, bays, count);
  let moved: LayoutPosition[];
  if (usesFreePositions(settingsAfter)) {
    // Where each station stands now: its slot under the type before, converted.
    const converted = stationRows.flatMap((row) => {
      const at = located.find((s) => s.id === row.id);
      return at == null
        ? []
        : [
            {
              key: row.id,
              point: at.point,
              placement: freePlacementFromSlot(positionToBay(at.point), settingsBefore),
              spots: freeSpotCount(row.evseCount ?? 1),
            },
          ];
    });
    const settled = settleConvertedPlacements([], converted);
    moved = converted.map((c) => ({
      stationId: c.key,
      positionX: c.point.x,
      positionY: c.point.y,
      free: settled.get(c.key) ?? storedFree(c.placement),
    }));
  } else {
    // A depot sorts the stations into its areas; the other types group AC and DC.
    const kinds = new Map(stationRows.map((r) => [r.id, r.kind]));
    const fit = fitGroupedPositions(
      located.map((s) => ({ key: s.id, position: s.point, kind: kinds.get(s.id) })),
      settingsAfter,
    );
    moved = [...fit.moved].map(([stationId, point]) => ({
      stationId,
      positionX: point.x,
      positionY: point.y,
    }));
  }
  await writePositions(tx, siteId, moved);
  await tx
    .update(sites)
    .set({ layoutSettings: nextStored, updatedAt: new Date() })
    .where(eq(sites.id, siteId));
  return {
    changed: true,
    typeChanged: typeAfter !== typeBefore,
    placementChanged,
    settingsBefore,
    settingsAfter,
    moved,
  };
}
