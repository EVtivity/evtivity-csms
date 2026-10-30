// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The parking grid of the 3D site layout, without three.js so it can be unit
// tested. Bay (col, row) is grid slot (col, row) of the 2D board
// (@evtivity/lib/site-layout), so both views read and write the same stored
// positions. World coordinates are anchored at bay (0, 0): the corner of bay
// (col, row) sits at x = BAY_W col, z = BAY_D row, so a station that moves
// never shifts the others.

import type { LayoutBay } from '@evtivity/lib/site-layout';

/** Bay width and depth in meters. */
export const BAY_W = 3.2;
export const BAY_D = 5.6;
/** How far into its bay a station stands, from the front edge, in meters. */
export const BAY_STATION_Z = 0.9;
/** The painted gap at the front and back of each bay line, in meters. */
export const BAY_LINE_GAP = 0.7;

/** The edit area (outlined bays a station may be dropped on): at least this size. */
export const EDIT_MIN_COLS = 64;
export const EDIT_MIN_ROWS = 48;
/** Free bays the edit area keeps beyond the farthest station. */
export const EDIT_MARGIN = 32;

/** The camera never comes nearer than this, in meters. */
export const MIN_DISTANCE = 6;
/** The zoom-out limit is at least this, in meters. */
export const MAX_DISTANCE_MIN = 320;

export interface GridSize {
  cols: number;
  rows: number;
}

/** The world x and z of a station standing in a bay. */
export function bayToWorld(bay: LayoutBay): { x: number; z: number } {
  return { x: BAY_W * (bay.col + 0.5), z: BAY_D * bay.row + BAY_STATION_Z };
}

/**
 * The bay under a world point (where a station there would stand), inside
 * the edit area: never negative, never past its last column or row.
 */
export function worldToBay(x: number, z: number, area: GridSize): LayoutBay {
  return {
    col: Math.min(area.cols - 1, Math.max(0, Math.floor(x / BAY_W))),
    row: Math.min(area.rows - 1, Math.max(0, Math.floor((z - BAY_STATION_Z) / BAY_D + 0.5))),
  };
}

/** Clamps a dragged station's world point to the station spots of the edit area. */
export function clampToArea(x: number, z: number, area: GridSize): { x: number; z: number } {
  const first = bayToWorld({ col: 0, row: 0 });
  const last = bayToWorld({ col: area.cols - 1, row: area.rows - 1 });
  return {
    x: Math.min(last.x, Math.max(first.x, x)),
    z: Math.min(last.z, Math.max(first.z, z)),
  };
}

/** The edit area for these bays: large, and always well past the farthest station. */
export function editArea(bays: Iterable<LayoutBay>): GridSize {
  let cols = EDIT_MIN_COLS;
  let rows = EDIT_MIN_ROWS;
  for (const b of bays) {
    cols = Math.max(cols, b.col + 1 + EDIT_MARGIN);
    rows = Math.max(rows, b.row + 1 + EDIT_MARGIN);
  }
  return { cols, rows };
}

function frameDistance(frame: GridSize, aspect: number): number {
  const w = frame.cols * BAY_W;
  const d = frame.rows * BAY_D;
  return Math.max((w + 3) / aspect, d + 3) * 1.25 + 5;
}

/**
 * The camera framing of Fit to View for a frame of `frame.cols` by
 * `frame.rows` bays from bay (0, 0): where the camera looks and how far it
 * stands. Fit frames the stations, never the whole ground.
 */
export function fitFrame(
  frame: GridSize,
  aspect: number,
): { target: { x: number; y: number; z: number }; distance: number } {
  return {
    target: { x: (frame.cols * BAY_W) / 2, y: 0.5, z: (frame.rows * BAY_D) / 2 + 0.6 },
    distance: frameDistance(frame, aspect),
  };
}

/**
 * The zoom-out limit: at least MAX_DISTANCE_MIN, and three times the Fit to
 * View distance of a tall phone stage, so a large site can be seen whole.
 */
export function maxZoomDistance(frame: GridSize): number {
  return Math.max(MAX_DISTANCE_MIN, frameDistance(frame, 0.5) * 3);
}

/**
 * Fog that fades the ground into the background toward the horizon at any
 * zoom, measured from the camera: clear around the target, gone well before
 * the ground ends.
 */
export function fogRange(cameraDistance: number): { near: number; far: number } {
  return { near: cameraDistance * 1.6, far: cameraDistance * 4.5 };
}

/**
 * The bays the painted ground covers: the frame plus enough bays on every side
 * that it reaches past the fog even at the zoom-out limit, so it reads as
 * endless. One textured plane draws it, whatever its size.
 */
export function groundBays(frame: GridSize): {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
} {
  const reach = fogRange(maxZoomDistance(frame)).far + 200;
  const cols = Math.ceil(reach / BAY_W);
  const rows = Math.ceil(reach / BAY_D);
  return { minCol: -cols, maxCol: frame.cols + cols, minRow: -rows, maxRow: frame.rows + rows };
}
