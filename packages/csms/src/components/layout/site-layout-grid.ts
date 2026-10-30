// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The parking lot geometry of the 3D site layout, without three.js so it can
// be unit tested. Spot (col, row) is grid slot (col, row) of the 2D board
// (@evtivity/lib/site-layout), so both views read and write the same stored
// positions. Lot coordinates are meters anchored at the front left corner of
// spot (0, 0): columns run along x, rows along z, a row is the spot depth plus
// the lane after it (none after the last row). The scene turns the whole lot
// by the facing; everything here is in lot coordinates.
//
// Rows pair around the lanes like a double-row lot (`chargersAtBack`): row 0
// opens onto the lane after it with its chargers at the front edge of the lot,
// row 1 opens onto the same lane with its chargers at its back edge, and so on
// for rows 2 and 3 around the next lane but one. An odd last row opens onto the
// lane before it, so the outermost rows always have their chargers at the lot
// edges. The lane between two pairs is a through lane with charger backs on
// both sides.

import { lotExtentM, type LayoutBay, type SiteLayoutGrid } from '@evtivity/lib/site-layout';
import type { StationDisplayState } from '@/lib/station-display-state';

/** How far into its spot a station stands, from the front edge, in meters. */
export const BAY_STATION_Z = 0.9;
/** The painted gap at the front and back of each spot line, in meters. */
export const BAY_LINE_GAP = 0.7;

/** The camera never comes nearer than this, in meters. */
export const MIN_DISTANCE = 6;
/** The zoom-out limit is at least this, in meters. */
export const MAX_DISTANCE_MIN = 160;
/** Grass the camera may pan over around everything on the site, in meters. */
export const PAN_MARGIN = 30;

export interface Lot {
  cols: number;
  rows: number;
  spotW: number;
  spotD: number;
  lane: number;
  /** Spot depth plus lane: the distance between two rows. */
  pitch: number;
  width: number;
  depth: number;
  /** The facing as a rotation about the vertical axis, in radians (clockwise from above). */
  facing: number;
}

export function lotOf(grid: SiteLayoutGrid): Lot {
  const { width, depth } = lotExtentM(grid);
  return {
    cols: grid.spotsPerRow,
    rows: grid.rows,
    spotW: grid.spotWidthM,
    spotD: grid.spotDepthM,
    lane: grid.laneWidthM,
    pitch: grid.spotDepthM + grid.laneWidthM,
    width,
    depth,
    facing: -(grid.facingDeg * Math.PI) / 180,
  };
}

export interface Point {
  x: number;
  z: number;
}

/**
 * Whether the chargers of a row stand at its back edge (larger z) and face
 * the lane before it, instead of standing at its front edge and facing the
 * lane after it. Rows pair around the lanes: every odd row, and an odd last
 * row, is turned. A row outside the lot (a station on the grass) is not.
 */
export function chargersAtBack(row: number, rows: number): boolean {
  if (row <= 0 || row >= rows) return false;
  return row % 2 === 1 || row === rows - 1;
}

/**
 * The turn of a station in a spot about the vertical axis, in radians: 0 when
 * its front (screen, connectors, the bay with its car) faces +z, a half turn
 * for a row whose chargers stand at its back edge.
 */
export function bayTurn(bay: LayoutBay, lot: Lot): number {
  return chargersAtBack(bay.row, lot.rows) ? Math.PI : 0;
}

/** Where a station in a spot stands, in lot coordinates: at the curb side of its row. */
export function bayToWorld(bay: LayoutBay, lot: Lot): Point {
  const intoRow = chargersAtBack(bay.row, lot.rows) ? lot.spotD - BAY_STATION_Z : BAY_STATION_Z;
  return { x: lot.spotW * (bay.col + 0.5), z: lot.pitch * bay.row + intoRow };
}

/** How far behind the charger the load management link ends, in meters. */
export const STATION_BACK_OFFSET = 0.45;

/** The back of a station in a spot (where its load management link ends), in lot coordinates. */
export function stationBackPoint(bay: LayoutBay, lot: Lot): Point {
  const p = bayToWorld(bay, lot);
  const back = chargersAtBack(bay.row, lot.rows) ? STATION_BACK_OFFSET : -STATION_BACK_OFFSET;
  return { x: p.x, z: p.z + back };
}

/** The spot under a lot point, inside the lot: never negative, never past its last column or row. */
export function worldToBay(x: number, z: number, lot: Lot): LayoutBay {
  return {
    col: Math.min(lot.cols - 1, Math.max(0, Math.floor(x / lot.spotW))),
    // The nearest row by its spot center, so a charger at either edge maps to its own row.
    row: Math.min(lot.rows - 1, Math.max(0, Math.round((z - lot.spotD / 2) / lot.pitch))),
  };
}

/** Clamps a dragged station's point to the station spots of the lot. */
export function clampToLot(x: number, z: number, lot: Lot): Point {
  const first = bayToWorld({ col: 0, row: 0 }, lot);
  const last = bayToWorld({ col: lot.cols - 1, row: lot.rows - 1 }, lot);
  return {
    x: Math.min(last.x, Math.max(first.x, x)),
    z: Math.min(last.z, Math.max(first.z, z)),
  };
}

export interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** The lot plus every point outside it (stations on the grass, transformers), with a small border. */
export function sceneBox(lot: Lot, points: readonly Point[]): Box {
  let minX = 0;
  let maxX = lot.width;
  let minZ = 0;
  let maxZ = lot.depth;
  for (const p of points) {
    minX = Math.min(minX, p.x - 2);
    maxX = Math.max(maxX, p.x + 2);
    minZ = Math.min(minZ, p.z - 2);
    maxZ = Math.max(maxZ, p.z + 4);
  }
  return { minX, maxX, minZ, maxZ };
}

/** A box turned by `angle` about the lot origin: the box around the turned corners. */
export function rotateBox(box: Box, angle: number): Box {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const xs: number[] = [];
  const zs: number[] = [];
  for (const x of [box.minX, box.maxX]) {
    for (const z of [box.minZ, box.maxZ]) {
      // three.js rotation about y: x' = x cos + z sin, z' = -x sin + z cos.
      xs.push(x * c + z * s);
      zs.push(-x * s + z * c);
    }
  }
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  };
}

function frameDistance(box: Box, aspect: number): number {
  const w = box.maxX - box.minX + 4;
  const d = box.maxZ - box.minZ + 4;
  const vHalf = ((CAMERA_FOV / 2) * Math.PI) / 180;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  // The camera looks down at about 35 degrees, so the depth shows foreshortened;
  // the near edge comes closer to the camera, hence the margin.
  const forWidth = w / 2 / Math.tan(hHalf);
  const forDepth = (d * 0.62) / 2 / Math.tan(vHalf);
  return Math.max(forWidth, forDepth) * 1.18 + 4;
}

/**
 * The camera framing of Fit to View for a box (world coordinates, after the
 * facing): where the camera looks and how far it stands.
 */
export function fitFrame(
  box: Box,
  aspect: number,
): { target: { x: number; y: number; z: number }; distance: number } {
  return {
    target: { x: (box.minX + box.maxX) / 2, y: 0.5, z: (box.minZ + box.maxZ) / 2 + 0.6 },
    distance: frameDistance(box, aspect),
  };
}

/** Where the front camera stands, per unit of distance: low, in front of the chargers. */
export const FRONT_CAMERA_OFFSET = { x: 0.08, y: 0.5, z: 0.92 } as const;

/**
 * Fit to View in front of the lot (the dashboard widget): the site framed
 * before the facing turns it, then camera and target turned with it, so the
 * camera faces the chargers whatever the facing. `box` is the site box in
 * lot coordinates (sceneBox, not turned).
 */
export function frontCamera(
  box: Box,
  facing: number,
  aspect: number,
): { target: { x: number; y: number; z: number }; position: { x: number; y: number; z: number } } {
  const { target, distance } = fitFrame(box, aspect);
  const c = Math.cos(facing);
  const s = Math.sin(facing);
  // three.js rotation about y: x' = x cos + z sin, z' = -x sin + z cos.
  const turn = (x: number, z: number): { x: number; z: number } => ({
    x: x * c + z * s,
    z: -x * s + z * c,
  });
  const t = turn(target.x, target.z);
  const p = turn(
    target.x + distance * FRONT_CAMERA_OFFSET.x,
    target.z - 0.6 + distance * FRONT_CAMERA_OFFSET.z,
  );
  return {
    target: { x: t.x, y: target.y, z: t.z },
    position: { x: p.x, y: distance * FRONT_CAMERA_OFFSET.y, z: p.z },
  };
}

/** The zoom-out limit: at least MAX_DISTANCE_MIN, and three times the Fit to View distance of a tall stage. */
export function maxZoomDistance(box: Box): number {
  return Math.max(MAX_DISTANCE_MIN, frameDistance(box, 0.5) * 3);
}

/** Fog measured from the camera: clear around the target, gone well before the ground ends. */
export function fogRange(cameraDistance: number): { near: number; far: number } {
  return { near: cameraDistance * 1.6, far: cameraDistance * 4.5 };
}

/** Vertical field of view of the camera, in degrees. */
export const CAMERA_FOV = 35;

/**
 * The lowest the camera may orbit, as the polar angle from straight down, in
 * radians: the top edge of the view stays 2.5 degrees below the horizon, so
 * every pixel of the stage shows the ground (no sky).
 */
export const MAX_POLAR_ANGLE = ((90 - CAMERA_FOV / 2 - 2.5) * Math.PI) / 180;

/** Where the camera may look: the site box plus PAN_MARGIN of grass. */
export function panBox(box: Box): Box {
  return {
    minX: box.minX - PAN_MARGIN,
    maxX: box.maxX + PAN_MARGIN,
    minZ: box.minZ - PAN_MARGIN,
    maxZ: box.maxZ + PAN_MARGIN,
  };
}

export function clampTarget(x: number, z: number, pan: Box): Point {
  return {
    x: Math.min(pan.maxX, Math.max(pan.minX, x)),
    z: Math.min(pan.maxZ, Math.max(pan.minZ, z)),
  };
}

/**
 * The grass ground: wherever the camera looks inside `pan`, it reaches past
 * the fog at the zoom-out limit of `frame`, so it fills the view to every edge.
 */
export function groundBox(frame: Box, pan: Box): Box {
  const distance = maxZoomDistance(frame);
  const reach = distance + fogRange(distance).far + 50;
  return {
    minX: pan.minX - reach,
    maxX: pan.maxX + reach,
    minZ: pan.minZ - reach,
    maxZ: pan.maxZ + reach,
  };
}

/** What stands in a station's spot besides the charger. */
export type StationProp = 'car' | 'reservedSign' | 'cone' | null;

/**
 * The prop of a spot, from the one station state the label shows: a car on a
 * cable while charging, a Reserved sign while reserved, a traffic cone in
 * maintenance, nothing otherwise.
 */
export function stationProp(state: StationDisplayState): StationProp {
  switch (state) {
    case 'charging':
      return 'car';
    case 'reserved':
      return 'reservedSign';
    case 'maintenance':
      return 'cone';
    default:
      return null;
  }
}

/**
 * The size of a logo on a back panel: as large as fits inside the panel less
 * the padding on every side, keeping the logo's aspect (never stretched).
 */
export function logoFit(
  panel: { width: number; height: number },
  image: { width: number; height: number },
  padding: number,
): { width: number; height: number } {
  const w = Math.max(0, panel.width - 2 * padding);
  const h = Math.max(0, panel.height - 2 * padding);
  if (image.width <= 0 || image.height <= 0 || w === 0 || h === 0) return { width: 0, height: 0 };
  const scale = Math.min(w / image.width, h / image.height);
  return { width: image.width * scale, height: image.height * scale };
}
