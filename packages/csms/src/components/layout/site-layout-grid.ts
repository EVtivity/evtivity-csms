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
// Parking lot rows pair around the lanes like a double-row lot (`chargersAtBack`): row 0
// opens onto the lane after it with its chargers at the front edge of the lot,
// row 1 opens onto the same lane with its chargers at its back edge, and so on
// for rows 2 and 3 around the next lane but one. An odd last row opens onto the
// lane before it, so the outermost rows always have their chargers at the lot
// edges. The lane between two pairs is a through lane with charger backs on
// both sides.
//
// The site type changes the geometry and the surroundings (`Lot.siteType`):
// a parking lot is grass around the lot; an office or retail site has one row
// along a building, past a sidewalk, with its AC chargers as wall boxes on the
// facade (`wallMounted`) or on posts at the spots; a street has a parallel
// parking lane along each curb, with the chargers on posts on the sidewalks;
// a depot is a paved yard of bus bays (row 0) and truck pull-through lanes
// (row 1), each slot's station where `depotSlotPlacement` puts it.

import {
  chargerMountingOf,
  depotLayout,
  depotSlotPlacement,
  type DepotLayout,
  freeFootprint,
  freeSpotsExtent,
  freeToSite,
  snapFreePlacement,
  type FreePlacement,
  layoutFacingOf,
  layoutRowLengths,
  siteTypeOf,
  STANDARD_DIMENSIONS,
  type ChargerMounting,
  type FreeSpotType,
  type LayoutBay,
  type LayoutShape,
  type SiteType,
  parkingChargerOnIsland,
  parkingChargersAtBack,
  parkingChargerZ,
  parkingHeadStrip,
  parkingRowGap,
  parkingRowZ,
  CHARGER_BEHIND_STALL_HEAD_M,
  WHEEL_STOP,
} from '@evtivity/lib/site-layout';
import type { StationDisplayState } from '@/lib/station-display-state';

/** How far into its spot a station stands, from the front edge, in meters. */
export const BAY_STATION_Z = 0.9;
/** The painted gap at the front and back of each spot line, in meters. */
export const BAY_LINE_GAP = 0.7;

/**
 * The camera never comes nearer than this, in meters (owner decision
 * 2026-11-09: 1 m, close enough to read a connector face, an EVSE plate and
 * an RFID pad; it was 3 m from 2026-11-02). The eye height floor
 * (`MIN_CAMERA_HEIGHT`) still holds, so the camera comes this close only to
 * a point at about charger height (zoom at the pointer, `zoomTowardPoint`).
 */
export const MIN_DISTANCE = 1;

/**
 * The camera's near clipping plane at a view distance, in meters: a fifth of
 * the distance, from 0.1 to 0.5 m, so a model 1 m away is never cut while
 * the depth buffer keeps its precision far away (the far plane follows the
 * zoom-out limit). Derived.
 */
export function cameraNearM(distance: number): number {
  if (!Number.isFinite(distance)) return 0.5;
  return Math.min(0.5, Math.max(0.1, distance * 0.2));
}
/** The zoom-out limit is at least this, in meters. */
export const MAX_DISTANCE_MIN = 160;
/** Grass the camera may pan over around everything on the site, in meters. */
export const PAN_MARGIN = 30;

/** The width of the curb strip around the lot and along a street, in meters. */
export const CURB_M = 0.3;
/** A sidewalk: between the front curb and the building of an office or retail site, and along each side of a street, in meters. */
export const SIDEWALK_M = 2.4;
/** How far behind the curb a curbside charger post stands, on the sidewalk, in meters. */
export const CURB_POST_BACK_M = 0.45;
/** How far from the front end of its parallel spot a curbside charger post stands, in meters. */
export const CURB_POST_IN_M = 0.6;

export interface Lot {
  siteType: SiteType;
  /** Spots in each row (`layoutRowLengths`): a street has the left curb (row 0) and the right curb (row 1). */
  rowLengths: readonly number[];
  /** Spots in the longest row. */
  cols: number;
  /** Rows of spots. */
  rows: number;
  /** Spot width along the rows (a parallel spot: its length along the curb), in meters. */
  spotW: number;
  /** Spot depth across the rows (a parallel spot: the parking lane), in meters. */
  spotD: number;
  /** The drive aisle after a row (a street: its travel lanes), in meters. */
  lane: number;
  /** Spot depth plus lane: the distance between two rows. */
  pitch: number;
  /** The paved area: the lot, the row and its aisle, or the street from curb to curb. */
  width: number;
  depth: number;
  /** The facing as a rotation about the vertical axis, in radians (clockwise from above). */
  facing: number;
  /** Office or retail: wall boxes on the facade or posts at the spots. */
  mounting: ChargerMounting;
  /** Depot: the yard, its bays, lanes and roads (null on the other site types). */
  depot: DepotLayout | null;
}

/** The layout shape of a depot lot (its bus bays and truck lanes are its row lengths). */
function depotShape(lot: Lot): LayoutShape {
  return {
    siteType: 'depot',
    spotsPerRow: 1,
    rows: 1,
    facingDeg: 0,
    busBays: lot.rowLengths[0] ?? 0,
    truckLanes: lot.rowLengths[1] ?? 0,
  };
}

/** Where the station of a depot slot stands and its spot type (`depotSlotPlacement`). */
export function depotStationPlacement(bay: LayoutBay, lot: Lot): FreePlacement {
  return depotSlotPlacement(bay, depotShape(lot));
}

/**
 * The geometry of a site's layout in standard real dimensions
 * (`STANDARD_DIMENSIONS`): a parking lot of `rows` rows with a drive aisle
 * between each two; an office or retail site's one row along the building,
 * with the drive aisle in front of it; a street of two parallel parking lanes
 * (the left and right curb) around two travel lanes.
 */
export function lotOf(settings: LayoutShape & { mounting?: ChargerMounting | undefined }): Lot {
  const d = STANDARD_DIMENSIONS;
  const siteType = siteTypeOf(settings);
  const rowLengths = layoutRowLengths(settings);
  const cols = Math.max(1, ...rowLengths);
  const facing = -(layoutFacingOf(settings) * Math.PI) / 180;
  const mounting = chargerMountingOf(settings);
  if (siteType === 'depot') {
    const depot = depotLayout(settings);
    return {
      siteType,
      rowLengths,
      cols,
      rows: rowLengths.length,
      spotW: d.spotWidthM,
      spotD: d.spotDepthM,
      lane: d.laneWidthM,
      pitch: d.spotDepthM + d.laneWidthM,
      width: depot.yard.maxX - depot.yard.minX,
      depth: depot.yard.maxZ - depot.yard.minZ,
      facing,
      mounting,
      depot,
    };
  }
  if (siteType === 'curbside') {
    const spotD = d.parallelSpotWidthM;
    const lane = 2 * d.travelLaneM;
    return {
      siteType,
      rowLengths,
      cols,
      rows: rowLengths.length,
      spotW: d.parallelSpotLengthM,
      spotD,
      lane,
      pitch: spotD + lane,
      width: cols * d.parallelSpotLengthM,
      depth: 2 * spotD + lane,
      facing,
      mounting,
      depot: null,
    };
  }
  const rows = rowLengths.length;
  return {
    siteType,
    rowLengths,
    cols,
    rows,
    spotW: d.spotWidthM,
    spotD: d.spotDepthM,
    lane: d.laneWidthM,
    pitch: d.spotDepthM + d.laneWidthM,
    width: cols * d.spotWidthM,
    // An office or retail row has its drive aisle in front of it.
    depth:
      siteType === 'office_retail'
        ? d.spotDepthM + d.laneWidthM
        : parkingRowZ(rows - 1, rows) + d.spotDepthM,
    facing,
    mounting,
    depot: null,
  };
}

export interface Point {
  x: number;
  z: number;
}

/** Whether a slot is a spot of the layout. */
export function isSpot(bay: LayoutBay, lot: Lot): boolean {
  return bay.row >= 0 && bay.col >= 0 && bay.col < (lot.rowLengths[bay.row] ?? 0);
}

/**
 * Whether the chargers of a row stand at its back edge (larger z) and face
 * the lane before it, instead of standing at its front edge and facing the
 * lane after it. A parking lot pairs its rows around the lanes: every odd
 * row, and an odd last row, is turned. A street turns its right curb (row
 * 1). An office or retail row and a row outside the layout (a station on the
 * grass) are not.
 */
export function chargersAtBack(row: number, lot: Lot): boolean {
  if (lot.siteType === 'curbside') return row === 1;
  if (lot.siteType === 'office_retail' || lot.siteType === 'depot') return false;
  return parkingChargersAtBack(row, lot.rows);
}

/**
 * The front edge of a row across the rows, in lot meters: a parking lot's
 * rows with an aisle between rows facing each other and a center island
 * between rows back to back (`parkingRowZ`); the other types one pitch apart.
 */
export function rowFrontZ(row: number, lot: Lot): number {
  return lot.siteType === 'parking_lot' ? parkingRowZ(row, lot.rows) : lot.pitch * row;
}

/** A stretch between two rows of a parking lot: a drive aisle or a curbed center island. */
export interface RowGap {
  kind: 'aisle' | 'island';
  /** Its front and back edge across the rows, in lot meters. */
  minZ: number;
  maxZ: number;
}

/**
 * The aisles and islands between the rows of a parking lot (none on the other
 * site types). A charger strip at the head of a row (`parkingHeadStrip`) is an
 * island of its own before the aisle.
 */
export function parkingRowGaps(lot: Lot): RowGap[] {
  if (lot.siteType !== 'parking_lot') return [];
  const gaps: RowGap[] = [];
  for (let r = 0; r + 1 < lot.rows; r++) {
    let minZ = parkingRowZ(r, lot.rows) + lot.spotD;
    if (parkingHeadStrip(r, lot.rows)) {
      const strip = STANDARD_DIMENSIONS.islandWidthM;
      gaps.push({ kind: 'island', minZ, maxZ: minZ + strip });
      minZ += strip;
    }
    gaps.push({ kind: parkingRowGap(r, lot.rows), minZ, maxZ: parkingRowZ(r + 1, lot.rows) });
  }
  return gaps;
}

/** Whether the chargers of a row stand on a parking lot's center island. */
export function chargerOnIsland(bay: LayoutBay, lot: Lot): boolean {
  return (
    lot.siteType === 'parking_lot' && isSpot(bay, lot) && parkingChargerOnIsland(bay.row, lot.rows)
  );
}

/**
 * The turn of a station in a spot about the vertical axis, in radians: 0 when
 * its front (screen, connectors, the bay with its car) faces +z, a half turn
 * for a row whose chargers stand at its back edge.
 */
export function bayTurn(bay: LayoutBay, lot: Lot): number {
  return chargersAtBack(bay.row, lot) ? Math.PI : 0;
}

/**
 * Where a station in a spot stands, in lot coordinates. A parking lot or an
 * office or retail row: at the curb side of its row. A street: on the
 * sidewalk behind the curb, near the front end of its parallel spot (the left
 * curb faces +z, the right curb is turned). A slot outside the layout stands
 * on the grass past it.
 */
export function bayToWorld(bay: LayoutBay, lot: Lot): Point {
  if (lot.siteType === 'depot') {
    const p = depotStationPlacement(bay, lot);
    return { x: p.x, z: p.z };
  }
  if (lot.siteType === 'curbside') {
    if (bay.row === 0)
      return { x: lot.spotW * bay.col + CURB_POST_IN_M, z: -(CURB_M + CURB_POST_BACK_M) };
    if (bay.row === 1) {
      return {
        x: lot.spotW * (bay.col + 1) - CURB_POST_IN_M,
        z: lot.depth + CURB_M + CURB_POST_BACK_M,
      };
    }
    return {
      x: lot.spotW * (bay.col + 0.5),
      z: lot.depth + CURB_M + SIDEWALK_M + 3 + (bay.row - 2) * 4,
    };
  }
  const x = lot.spotW * (bay.col + 0.5);
  // A parking lot charger stands on the center island of rows back to back.
  if (lot.siteType === 'parking_lot') return { x, z: parkingChargerZ(bay.row, lot.rows) };
  const intoRow = chargersAtBack(bay.row, lot) ? lot.spotD - BAY_STATION_Z : BAY_STATION_Z;
  return { x, z: lot.pitch * bay.row + intoRow };
}

/** The ground of a spot, in lot coordinates: a perpendicular spot of a row, or a parallel spot of a parking lane. */
export function spotRect(bay: LayoutBay, lot: Lot): Box {
  if (lot.depot != null) {
    const r = bay.row === 0 ? lot.depot.bays[bay.col] : lot.depot.lanes[bay.col];
    if (r != null) return { ...r };
  }
  const minX = lot.spotW * bay.col;
  const minZ =
    lot.siteType === 'curbside'
      ? bay.row === 0
        ? 0
        : lot.depth - lot.spotD
      : rowFrontZ(bay.row, lot);
  return { minX, maxX: minX + lot.spotW, minZ, maxZ: minZ + lot.spotD };
}

/** How far behind the charger the load management link ends, in meters. */
export const STATION_BACK_OFFSET = 0.45;

/** The building front (facade) of an office or retail site, in lot z: past the curb and sidewalk. */
export const FACADE_Z = -(CURB_M + SIDEWALK_M);
/** Depth and height of the building, in meters. */
export const BUILDING_DEPTH_M = 16;
export const BUILDING_HEIGHT_M = 8;
/** Building past the right end of the row (the entrance stands there), in meters. */
export const BUILDING_RIGHT_M = 9;
/** Building past the left end of the row, in meters. */
export const BUILDING_LEFT_M = 6;

/**
 * Whether a station is a wall box on the building facade: an AC charger in
 * the row of an office or retail site that mounts its chargers on the wall.
 * DC chargers, stall posts, stations off the row and every other site type
 * stand at the curb.
 */
export function wallMounted(bay: LayoutBay, lot: Lot, kind: 'ac' | 'dc'): boolean {
  return (
    lot.siteType === 'office_retail' &&
    lot.mounting === 'wall' &&
    kind === 'ac' &&
    bay.row === 0 &&
    isSpot(bay, lot)
  );
}

/**
 * How far in front of the facade line a wall sign's back sits, in meters: on
 * the outer face of the facade (its ground floor cladding and the window
 * strip stand up to 0.1 m proud of `FACADE_Z`), so the sign is on the wall,
 * not inside it.
 */
export const FACADE_SIGN_STANDOFF_M = 0.11;

/** How far the ground floor's stone base stands proud of `FACADE_Z` (0.06 m, up to 3.2 m high). */
export const FACADE_BASE_PROUD_M = 0.06;

/**
 * How far behind its spot point a wall box hangs on the facade, in the
 * station's own z (negative: toward the building): its back on the face of the
 * ground floor's stone base, so the box, its J hook and the cable turns on
 * it stand in front of the wall, never inside it.
 */
export function wallBoxOffset(): number {
  return FACADE_Z + FACADE_BASE_PROUD_M - BAY_STATION_Z;
}

/** The front edge of an AC pedestal's concrete pad (1.0 by 0.9 m, centered on the charger), in the station's own z. */
export const AC_PAD_FRONT_Z = 0.45;

/**
 * Whether a station that would stand in the head of its spot stands behind
 * the stall head line instead (`CHARGER_BEHIND_STALL_HEAD_M`): an AC pedestal
 * in a spot of a parking lot row whose charger edge is the lot edge (a Lot
 * Edge row, the first and last row of Islands), behind the curb strip, or of
 * an office or retail row with stall mounting, on the sidewalk (ChargePoint
 * CPF50 site design guide: the station "against the curb between spaces").
 * The stall keeps its full depth and its wheel stop the 2 ft setback from the
 * stall head (`WHEEL_STOP`). A DC dispenser keeps its place in the head of
 * its spot, behind its bollards; a wall box hangs on the facade; an island
 * charger already stands behind its curb, and so does a charger of the next
 * to last row of an odd lot, on the charger strip at its head
 * (`parkingHeadStrip`).
 */
export function chargerBehindStallHead(
  bay: LayoutBay,
  lot: Lot,
  kind: 'ac' | 'dc',
  wall: boolean,
): boolean {
  if (kind !== 'ac' || wall || !isSpot(bay, lot)) return false;
  if (lot.siteType === 'office_retail') return true;
  if (lot.siteType !== 'parking_lot' || chargerOnIsland(bay, lot)) return false;
  const front = rowFrontZ(bay.row, lot);
  const head = chargersAtBack(bay.row, lot) ? front + lot.spotD : front;
  return head <= 1e-6 || head >= lot.depth - 1e-6;
}

/** Whether a station's charger stands behind a curb at the head of its spot: on an island, or behind the lot edge or a sidewalk curb (`chargerBehindStallHead`). */
export function chargerAtCurb(bay: LayoutBay, lot: Lot, kind: 'ac' | 'dc', wall: boolean): boolean {
  return chargerOnIsland(bay, lot) || chargerBehindStallHead(bay, lot, kind, wall);
}

/**
 * How far behind its spot point (`bayToWorld`) a station stands, in its own
 * z (toward its curb): from `BAY_STATION_Z` into the spot to
 * `CHARGER_BEHIND_STALL_HEAD_M` behind the stall head for a station behind
 * the head (`chargerBehindStallHead`), else 0.
 */
export function stationBackShift(
  bay: LayoutBay,
  lot: Lot,
  kind: 'ac' | 'dc',
  wall: boolean,
): number {
  return chargerBehindStallHead(bay, lot, kind, wall)
    ? BAY_STATION_Z + CHARGER_BEHIND_STALL_HEAD_M
    : 0;
}

/**
 * What a wheel stop is set back from: the stall head line at a curb (an AC
 * pedestal stands behind it: on an island, behind the curb strip of a lot
 * edge, on an office or retail sidewalk, on the apron behind a custom site's
 * car spot, on a charger strip), or the front of the stall at a building (a
 * wall box hangs on the facade behind the sidewalk). No AC pedestal stands in
 * its stall.
 */
export type WheelStopMount = 'curb' | 'wall';

/**
 * Whether a station's spots get wheel stops, and measured from what
 * (`WHEEL_STOP`): AC stations in a spot of a parking lot or an office or
 * retail row and the car spots of an AC station on a custom site. DC chargers
 * keep their bollards; parallel spots along a curb and depot bays and lanes
 * get none; a station off the layout (on the grass) has no spot.
 */
export function wheelStopMount(input: {
  siteType: SiteType;
  kind: 'ac' | 'dc';
  wall: boolean;
  onSpot: boolean;
  /** A custom site station with bus bays or truck lanes. */
  largeSpot: boolean;
}): WheelStopMount | null {
  if (input.kind !== 'ac' || input.largeSpot) return null;
  switch (input.siteType) {
    case 'custom':
      return 'curb';
    case 'parking_lot':
    case 'office_retail':
      if (!input.onSpot) return null;
      return input.wall ? 'wall' : 'curb';
    default:
      return null;
  }
}

/**
 * The stall head line of a station's spot (where the stall begins, toward
 * the charger), in the station's own z: `CHARGER_BEHIND_STALL_HEAD_M` in
 * front of a pedestal behind its curb, else the front edge of the spot,
 * BAY_STATION_Z before the spot point (a wall box).
 */
export function stallHeadZ(mount: WheelStopMount): number {
  return mount === 'curb' ? CHARGER_BEHIND_STALL_HEAD_M : -BAY_STATION_Z;
}

/**
 * The near face of the wheel stop (toward the charger), in the station's own
 * z: `WHEEL_STOP.fromStallHeadM` from the stall head line.
 */
export function wheelStopNearZ(mount: WheelStopMount): number {
  return stallHeadZ(mount) + WHEEL_STOP.fromStallHeadM;
}

/** The middle of the wheel stop along the spot, in the station's own z. */
export function wheelStopCenterZ(mount: WheelStopMount): number {
  return wheelStopNearZ(mount) + WHEEL_STOP.depthM / 2;
}

/**
 * How far past the wheel stop's far face a front axle stands when its tire
 * rests against the stop's top edge (a tire of radius `wheelRadius` touches a
 * step of the stop's height that far ahead of its axle).
 */
export function tireTouchAhead(wheelRadius: number): number {
  const h = Math.min(WHEEL_STOP.heightM, wheelRadius);
  return Math.sqrt(wheelRadius ** 2 - (wheelRadius - h) ** 2);
}

/**
 * Where the nose of a car parked against the wheel stop stands, in the
 * station's own z: its front tires at the stop, its body `frontAxle` meters
 * ahead of the axle.
 */
export function carNoseAtStop(
  mount: WheelStopMount,
  profile: { frontAxle: number; wheelRadius: number },
): number {
  return (
    wheelStopNearZ(mount) +
    WHEEL_STOP.depthM +
    tireTouchAhead(profile.wheelRadius) -
    profile.frontAxle
  );
}

/**
 * Where the tail of a car backed in against the wheel stop stands, in the
 * station's own z: its rear tires at the stop, its body `length - rearAxle`
 * meters behind the axle (a car whose charge port is at the rear backs in).
 */
export function carTailAtStop(
  mount: WheelStopMount,
  profile: { length: number; rearAxle: number; wheelRadius: number },
): number {
  return (
    wheelStopNearZ(mount) +
    WHEEL_STOP.depthM +
    tireTouchAhead(profile.wheelRadius) -
    (profile.length - profile.rearAxle)
  );
}

/**
 * The back of a station in a spot (where its load management link ends), in
 * lot coordinates: behind the charger on the curb side of its row, the
 * charger `backShift` behind its spot point (`stationBackShift`).
 */
export function stationBackPoint(bay: LayoutBay, lot: Lot, backShift = 0): Point {
  const p = bayToWorld(bay, lot);
  const sign = chargersAtBack(bay.row, lot) ? 1 : -1;
  return { x: p.x, z: p.z + sign * (STATION_BACK_OFFSET + backShift) };
}

/**
 * The building of an office or retail site, in lot coordinates: along the
 * front edge of the row past the sidewalk, wider than the row on both sides
 * (the entrance is on the right part).
 */
export function buildingBox(lot: Lot): Box {
  return {
    minX: -BUILDING_LEFT_M,
    maxX: lot.width + BUILDING_RIGHT_M,
    minZ: FACADE_Z - BUILDING_DEPTH_M,
    maxZ: FACADE_Z,
  };
}

/**
 * The points the framing takes in for the building: the facade line and a
 * strip behind it, not the whole building, so Fit to View stays on the row
 * with the building as its backdrop.
 */
export function buildingFramePoints(lot: Lot): Point[] {
  const b = buildingBox(lot);
  return [
    { x: b.minX + 2, z: FACADE_Z - 1 },
    { x: b.maxX - 2, z: FACADE_Z - 1 },
  ];
}

/**
 * The paved and built ground of the site type, in lot coordinates: the lot,
 * the row with its aisle and sidewalk, or the street with both sidewalks.
 */
export function layoutGroundBox(lot: Lot): Box {
  switch (lot.siteType) {
    case 'office_retail':
      return { minX: 0, maxX: lot.width, minZ: FACADE_Z, maxZ: lot.depth };
    case 'curbside':
      return {
        minX: 0,
        maxX: lot.width,
        minZ: -(CURB_M + SIDEWALK_M),
        maxZ: lot.depth + CURB_M + SIDEWALK_M,
      };
    case 'depot':
      return lot.depot != null ? { ...lot.depot.yard } : { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    default:
      return { minX: 0, maxX: lot.width, minZ: 0, maxZ: lot.depth };
  }
}

/**
 * The ground a depot's cable runs keep to: the box around its bays, the bus
 * head strip, its truck lanes and their islands, not the whole yard. The
 * equipment of each charger group then stands at the end of its own rows
 * (the bus heads, the truck lane ends) and its circuits run along those row
 * ends, never around the drive lane and the truck roads.
 */
export function depotLinkGround(depot: DepotLayout): Box {
  const rects = [
    ...depot.bays,
    ...depot.lanes,
    ...depot.islands,
    ...(depot.busHead != null ? [depot.busHead] : []),
  ];
  if (rects.length === 0) return { ...depot.yard };
  return {
    minX: Math.min(...rects.map((r) => r.minX)),
    maxX: Math.max(...rects.map((r) => r.maxX)),
    minZ: Math.min(...rects.map((r) => r.minZ)),
    maxZ: Math.max(...rects.map((r) => r.maxZ)),
  };
}

/**
 * The glow of a charging station's front at `timeS` seconds: a gentle pulse
 * of the emissive strip and its halo, or a steady glow when `timeS` is null
 * (reduced motion).
 */
export function chargingGlowLevel(timeS: number | null): { intensity: number; halo: number } {
  if (timeS == null) return { intensity: 1.3, halo: 0.3 };
  const wave = 0.5 + 0.5 * Math.sin(timeS * 2.4);
  return { intensity: 0.8 + 0.9 * wave, halo: 0.14 + 0.26 * wave };
}

/**
 * The status light of a faulted station: a quick on and off blink (about one
 * a second), or steady and bright without motion (`null`, prefers-reduced-motion).
 */
export function faultLightLevel(timeS: number | null): number {
  if (timeS == null) return 0.9;
  const wave = Math.max(0, Math.sin(timeS * 6.3));
  return 0.1 + 1.6 * wave;
}

/**
 * The overhead badges (state markers and driver avatars) are world-size
 * within a clamp (owner decision 2026-11-01): `worldM` across in the scene,
 * so they shrink with the site as the camera moves away, never larger on
 * screen than their full size up close (`markerPx`, `avatarPx`, the sizes
 * they had before) and never smaller than a readable minimum (`minMarkerPx`,
 * `minAvatarPx`). The world size and the minimums are no source: about a
 * third of a 2.7 m stall, and the 14 to 16 px the owner named.
 */
export const OVERHEAD_BADGE = {
  worldM: 0.9,
  markerPx: 24,
  avatarPx: 28,
  minMarkerPx: 14,
  minAvatarPx: 16,
  /** The smallest hover and click area of a badge on screen (WCAG 2.2 SC 2.5.8, Target Size (Minimum): 24 by 24 CSS px). */
  minHitPx: 24,
} as const;

/**
 * The hit area of an overhead badge drawn at `fullPx` and shown at `scale`,
 * in the badge's own (unscaled) px: never less than `OVERHEAD_BADGE.minHitPx`
 * on screen, so a badge scaled down far away still takes a 24 px hover and
 * click (owner report 2026-11-01).
 */
export function overheadHitPx(scale: number, fullPx: number): number {
  if (!(scale > 0)) return fullPx;
  return Math.max(fullPx, OVERHEAD_BADGE.minHitPx / scale);
}

/**
 * The on-screen pixels per world meter at `distance` meters from a
 * perspective camera with vertical field of view `fovDeg` over a stage
 * `stageHeightPx` high.
 */
export function pixelsPerMeter(distance: number, fovDeg: number, stageHeightPx: number): number {
  if (!(distance > 0) || !(stageHeightPx > 0)) return Infinity;
  return stageHeightPx / 2 / (Math.tan(((fovDeg / 2) * Math.PI) / 180) * distance);
}

/**
 * The scale of an overhead badge drawn at `fullPx` (its size up close) where
 * a world meter takes `pxPerMeter` pixels: the badge's world size in pixels
 * over its full size, at most 1 and at least `minPx / fullPx`.
 */
export function overheadBadgeScale(pxPerMeter: number, fullPx: number, minPx: number): number {
  const world = (OVERHEAD_BADGE.worldM * pxPerMeter) / fullPx;
  const floor = Math.min(1, minPx / fullPx);
  if (!Number.isFinite(world)) return 1;
  return Math.min(1, Math.max(floor, world));
}

/**
 * The share of state markers that may overlap another before the view counts
 * as crowded (no source: two back-to-back pedestals on an island overlap at
 * any normal zoom; when a quarter or more of the markers do, the site is
 * zoomed out too far for avatars).
 */
export const CROWDED_MARKER_SHARE = 0.25;

/**
 * Whether the state markers crowd each other: at least CROWDED_MARKER_SHARE
 * of them overlap another on screen. The view then draws only the state
 * markers and drops the driver avatars, so a zoomed-out site stays clean.
 */
export function overheadBadgesCrowded(
  rects: ReadonlyArray<{ left: number; top: number; right: number; bottom: number }>,
): boolean {
  if (rects.length < 2) return false;
  const sorted = rects
    .map((rect, index) => ({ rect, index }))
    .sort((p, q) => p.rect.left - q.rect.left);
  const overlapping = new Set<number>();
  sorted.forEach((a, i) => {
    for (const b of sorted.slice(i + 1)) {
      if (b.rect.left >= a.rect.right) break;
      if (a.rect.top < b.rect.bottom && b.rect.top < a.rect.bottom) {
        overlapping.add(a.index);
        overlapping.add(b.index);
      }
    }
  });
  return overlapping.size > 0 && overlapping.size >= CROWDED_MARKER_SHARE * rects.length;
}

/** From this many stations, far station labels hide (a large site stays readable and fast). */
export const LABEL_CULL_FROM = 40;

/**
 * Whether a station label shows at `distance` meters from the camera: always
 * on a site of fewer than LABEL_CULL_FROM stations, else only within 1.4
 * times the distance to the point the camera looks at (at least 40 m).
 */
export function stationLabelInRange(
  distance: number,
  viewDistance: number,
  stationCount: number,
): boolean {
  if (stationCount < LABEL_CULL_FROM) return true;
  return distance <= Math.max(40, viewDistance * 1.4);
}

/**
 * The spot under a lot point: the nearest spot of the layout (a row with no
 * spots, such as an empty curb, is never chosen). Null when the layout has
 * no spot.
 */
export function worldToBay(x: number, z: number, lot: Lot): LayoutBay | null {
  let best: LayoutBay | null = null;
  let bestDistance = Infinity;
  if (lot.siteType === 'depot') {
    // The bay or lane whose ground is nearest the point.
    for (let row = 0; row < lot.rows; row++) {
      for (let col = 0; col < (lot.rowLengths[row] ?? 0); col++) {
        const r = spotRect({ col, row }, lot);
        const dx = x < r.minX ? r.minX - x : x > r.maxX ? x - r.maxX : 0;
        const dz = z < r.minZ ? r.minZ - z : z > r.maxZ ? z - r.maxZ : 0;
        const d = dx * dx + dz * dz;
        if (d < bestDistance) {
          best = { col, row };
          bestDistance = d;
        }
      }
    }
    return best;
  }
  for (let row = 0; row < lot.rows; row++) {
    const n = lot.rowLengths[row] ?? 0;
    if (n === 0) continue;
    const r = spotRect({ col: 0, row }, lot);
    const dz = z < r.minZ ? r.minZ - z : z > r.maxZ ? z - r.maxZ : 0;
    const col = Math.min(n - 1, Math.max(0, Math.floor(x / lot.spotW)));
    const c = spotRect({ col, row }, lot);
    const dx = x < c.minX ? c.minX - x : x > c.maxX ? x - c.maxX : 0;
    const d = dx * dx + dz * dz;
    if (d < bestDistance) {
      best = { col, row };
      bestDistance = d;
    }
  }
  return best;
}

/** Clamps a dragged station's point to the station points of the spots of the layout. */
export function clampToLot(x: number, z: number, lot: Lot): Point {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let row = 0; row < lot.rows; row++) {
    const n = lot.rowLengths[row] ?? 0;
    if (n === 0) continue;
    for (const col of [0, n - 1]) {
      const p = bayToWorld({ col, row }, lot);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
  }
  if (!Number.isFinite(minX)) return { x, z };
  return {
    x: Math.min(maxX, Math.max(minX, x)),
    z: Math.min(maxZ, Math.max(minZ, z)),
  };
}

export interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** The ground of the site type plus every point outside it (stations on the grass, transformers), with a small border. */
export function sceneBox(lot: Lot, points: readonly Point[]): Box {
  let { minX, maxX, minZ, maxZ } = layoutGroundBox(lot);
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

/**
 * Where the front camera stands, per unit of distance: straight in front of
 * the chargers at about eye height for a person across the lot (about 11.5
 * degrees above the ground, within `MAX_POLAR_ANGLE`).
 */
export const FRONT_CAMERA_OFFSET = { x: 0, y: 0.2, z: 0.98 } as const;
/** The front camera looks at charger height, not the ground. */
export const FRONT_TARGET_Y = 1.1;
/** The front camera stands closer than Fit to View: the lot fills the width of the stage. */
export const FRONT_DISTANCE_SCALE = 0.75;
/** Where the overview camera stands, per unit of distance: higher, from the front right. */
export const OVERVIEW_CAMERA_OFFSET = { x: 0.22, y: 0.62, z: 0.86 } as const;

/**
 * Fit to View in front of the lot (the dashboard widget, `FRONT_CAMERA_OFFSET`)
 * or from above it (`OVERVIEW_CAMERA_OFFSET`, the overview of an office or
 * retail site, so the building stays behind the lot): the site framed before
 * the facing turns it, then camera and target turned with it, so the camera
 * faces the chargers whatever the facing. `box` is the site box in lot
 * coordinates (sceneBox, not turned).
 */
export function frontCamera(
  box: Box,
  facing: number,
  aspect: number,
  offset: { x: number; y: number; z: number } = FRONT_CAMERA_OFFSET,
): { target: { x: number; y: number; z: number }; position: { x: number; y: number; z: number } } {
  const { target: framed, distance: framedDistance } = fitFrame(box, aspect);
  const front = offset === FRONT_CAMERA_OFFSET;
  const target = front ? { ...framed, y: FRONT_TARGET_Y } : framed;
  // Seen from eye height the depth takes little height, so the lot can come closer.
  const distance = front ? framedDistance * FRONT_DISTANCE_SCALE : framedDistance;
  const c = Math.cos(facing);
  const s = Math.sin(facing);
  // three.js rotation about y: x' = x cos + z sin, z' = -x sin + z cos.
  const turn = (x: number, z: number): { x: number; z: number } => ({
    x: x * c + z * s,
    z: -x * s + z * c,
  });
  const t = turn(target.x, target.z);
  const p = turn(target.x + distance * offset.x, target.z - 0.6 + distance * offset.z);
  return {
    target: { x: t.x, y: target.y, z: t.z },
    position: { x: p.x, y: target.y + distance * offset.y, z: p.z },
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
 * radians: 88 degrees, just above horizontal, so the camera can tilt down to
 * an eye-level view across the lot (the Layout tab, full screen and the
 * dashboard card alike). The top of the view then shows the haze above the
 * horizon (the fog and the background are the same color, so the ground
 * fades into it). MIN_CAMERA_HEIGHT keeps the camera above the ground.
 */
export const MAX_POLAR_ANGLE = (88 * Math.PI) / 180;

/** The lowest the camera may stand above the ground, in meters: eye height. */
export const MIN_CAMERA_HEIGHT = 1.6;

/**
 * The camera height after an orbit, zoom or pan: never below eye height, so a
 * low orbit or a zoom close to the ground never goes under the paving.
 */
export function clampCameraHeight(y: number): number {
  return Number.isFinite(y) ? Math.max(MIN_CAMERA_HEIGHT, y) : MIN_CAMERA_HEIGHT;
}

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

/** What stands in a station's spot besides the charger: physical things only. */
export type StationProp = 'car' | 'cone' | null;

/**
 * The prop of a spot: a car on a cable while charging or while any connector
 * is plugged in (a fault, a suspended or finished session: the car stays until
 * it is unplugged), else a traffic cone in maintenance (crews put cones out),
 * nothing otherwise. A reservation has no physical sign: it shows as a
 * virtual sign (`virtualSignOf`).
 */
export function stationProp(state: StationDisplayState, pluggedIn = false): StationProp {
  if (pluggedIn) return 'car';
  switch (state) {
    case 'charging':
      return 'car';
    case 'maintenance':
      return 'cone';
    default:
      return null;
  }
}

/**
 * A virtual status sign: a translucent overlay floating over the spot, not a
 * physical sign (physical signs follow the MUTCD), for a station reserved now
 * or in an active maintenance window.
 */
export type VirtualSign = 'reserved' | 'maintenance';

/** How opaque a virtual sign is drawn (translucent, so it reads as an overlay; the legend swatch too). */
export const VIRTUAL_SIGN_OPACITY = 0.58;

/** The virtual sign of a station state, or null. */
export function virtualSignOf(state: StationDisplayState): VirtualSign | null {
  return state === 'reserved' || state === 'maintenance' ? state : null;
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

/** Every charger model the 3D view builds: the standard DC dispenser, AC pedestal and wall box, and the large models of depots and custom sites. */
export type ChargerLogoModel =
  | 'dc'
  | 'ac'
  | 'truck_mcs'
  | 'bus_dispenser'
  | 'pantograph_down'
  | 'pantograph_up';

/**
 * Where a charger model carries the company logo, as manufacturers brand
 * their units: on the back of a dispenser, pedestal or cabinet (the face
 * without the screen, connectors or card reader; a dual-port AC pedestal has
 * both ports on its front), and on the front of a wall box below its face
 * plate (its back is on the wall). A plain plate of `width` by `height` m,
 * centered at `x`, `y` and `z`: in the station frame for `dc`, `ac` and
 * `wall` (`wall`: from the wall box offset), from the cabinet center for the
 * large models (the truck MCS dispenser of each lane, the bus dispenser, the
 * pantograph control module, beside the steel pole that stands behind it).
 * `facing` is the side the logo shows on (-1 back, +1 front): the front for a
 * wall box and the pantograph control module (both backs are covered).
 */
export const CHARGER_LOGO_PANELS: Readonly<
  Record<
    ChargerLogoModel,
    {
      width: number;
      height: number;
      x: number;
      y: number;
      z: number;
      facing: -1 | 1;
      /** A side face: the panel turned this far about y (radians) around the model center the scene passes. */
      turn?: number;
    }
  >
> = {
  // Every plate stands on the flat part of its face with at least 2 cm left on
  // each side (owner report 2026-11-01: the plates ran onto the rounded edges).
  // The DC dispenser back (DC_DISPENSER: 732 mm wide, its flat back 692 mm
  // between the 20 mm rounded edges): a plate in its upper part, inside the
  // back door seam.
  dc: { width: 0.52, height: 0.4, x: 0, y: 1.6, z: -0.382, facing: -1 },
  // The pedestal head's flat back (CHARGER_LOGO_FACES.ac, the head 346 mm
  // wide): 0.2 of its 0.287 m flat width, so the plate never reaches the rounded corners.
  ac: { width: 0.2, height: 0.24, x: 0, y: 1.3, z: -0.1285, facing: -1 },
  // The MCS dispenser back (0.62 m flat), upper part, clear of the island bollards.
  truck_mcs: { width: 0.52, height: 0.4, x: 0, y: 1.8, z: -0.22, facing: -1 },
  // The bus dispenser back beside its cable mast (x -0.09 to 0.09 m), inside the 0.74 m flat face.
  bus_dispenser: { width: 0.26, height: 0.26, x: 0.22, y: 1.6, z: -0.36, facing: -1 },
  // The pantograph control module (owner decision 2026-11-02): its front keeps only the
  // screen, card reader and status light, so the plate goes on its side facing the bay
  // entrance (-x, the gate end of the yard), in the module's own frame (`PANTOGRAPH_POLE_LOGO`, a test keeps the two equal).
  pantograph_down: {
    width: 0.37,
    height: 0.37,
    x: 0,
    y: 1.45,
    z: 0.506,
    facing: 1,
    turn: -Math.PI / 2,
  },
  pantograph_up: {
    width: 0.37,
    height: 0.37,
    x: 0,
    y: 1.45,
    z: 0.506,
    facing: 1,
    turn: -Math.PI / 2,
  },
};

/**
 * The face each charger model's logo panel stands on, as the scene builds the
 * model (`site-layout-scene.ts`): `width` across the whole face (rounded
 * corners and the 15 mm bevel included), `flatWidth` its flat part, `minY`
 * to `maxY` its height, `z` its plane, in the frame of CHARGER_LOGO_PANELS.
 * The AC pedestal head is `AC_PEDESTAL.head` (site-layout-model-ac-pedestal.ts) from 0.9 m;
 * the DC dispenser body `DC_DISPENSER` (site-layout-model-dc-dispenser.ts) from 0.08 m;
 * the large models' cabinets `cabinet()` (corner 0.08) from 0.12 m; a wall
 * box's logo plate hangs on the wall under the box. A test keeps every panel
 * inside its face.
 */
export const CHARGER_LOGO_FACES: Readonly<
  Record<
    ChargerLogoModel,
    { width: number; flatWidth: number; minY: number; maxY: number; z: number }
  >
> = {
  dc: { width: 0.732, flatWidth: 0.692, minY: 0.08, maxY: 2.03, z: -0.374 },
  ac: { width: 0.346, flatWidth: 0.286, minY: 0.9, maxY: 1.47, z: -0.1225 },
  truck_mcs: { width: 0.81, flatWidth: 0.62, minY: 0.105, maxY: 2.335, z: -0.225 },
  bus_dispenser: { width: 0.93, flatWidth: 0.74, minY: 0.105, maxY: 2.435, z: -0.365 },
  // The side of the control module (`PANTOGRAPH_POLE.module`: 0.477 m deep, its
  // 0.03 m rounded edges leave 0.417 m flat; up to 2.05 m) above its louvers (to 0.84 m).
  pantograph_down: { width: 0.477, flatWidth: 0.417, minY: 0.86, maxY: 2.02, z: 0.5 },
  pantograph_up: { width: 0.477, flatWidth: 0.417, minY: 0.86, maxY: 2.02, z: 0.5 },
};

// Custom sites: no lot, street or building. Every station stands at its free
// position (@evtivity/lib/site-layout FreePlacement) with its own spots on a
// paved apron; the framing takes in the spots of every station.

/** The box around a set of points, with a border (null without points). */
export function pointsBox(points: readonly Point[], border = 2): Box | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX: minX - border, maxX: maxX + border, minZ: minZ - border, maxZ: maxZ + border };
}

/** The ground of a custom site: the spots of every station and every point outside them. */
export function customSceneBox(
  stations: ReadonlyArray<{ placement: FreePlacement; spots: number }>,
  points: readonly Point[],
): Box {
  const corners = stations.flatMap((s) => freeFootprint(s.placement, s.spots));
  return pointsBox([...corners, ...points]) ?? { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
}

/** The back of a station at a free position (where its load management link ends). */
export function freeBackPoint(p: FreePlacement): Point {
  return freeToSite(p, 0, -STATION_BACK_OFFSET);
}

/** How near two stations' points must be on an axis to draw an alignment guide, in meters. */
export const GUIDE_TOLERANCE_M = 0.05;

export interface AlignmentGuide {
  /** `x`: the stations share an x (a line along z); `z`: they share a z. */
  axis: 'x' | 'z';
  from: Point;
  to: Point;
}

/**
 * The alignment guides of a station being moved: a line to each other
 * station whose charger point shares its x or its z (within
 * GUIDE_TOLERANCE_M), at most one per axis (the nearest).
 */
export function alignmentGuides(moving: Point, others: readonly Point[]): AlignmentGuide[] {
  const guides: AlignmentGuide[] = [];
  for (const axis of ['x', 'z'] as const) {
    let best: Point | null = null;
    let bestDistance = Infinity;
    for (const o of others) {
      if (Math.abs(o[axis] - moving[axis]) > GUIDE_TOLERANCE_M) continue;
      const d = Math.hypot(o.x - moving.x, o.z - moving.z);
      if (d > 0.01 && d < bestDistance) {
        best = o;
        bestDistance = d;
      }
    }
    if (best != null) guides.push({ axis, from: best, to: moving });
  }
  return guides;
}

/**
 * The turn of a station toward the pointer while its rotation handle is
 * dragged: the handle stands in front of the station (its local +z), so the
 * turn is the angle from the station to the pointer, clockwise from above.
 * Snapped to 15 degrees unless `free` (Shift), then one decimal.
 */
export function handleRotation(center: Point, pointer: Point, free: boolean): number {
  // Local +z maps to (sin a, cos a) with a = -rotation (freeToSite).
  const a = Math.atan2(pointer.x - center.x, pointer.z - center.z);
  const deg = (-a * 180) / Math.PI;
  return snapFreePlacement({ x: 0, z: 0, rotationDeg: deg }, { freeRotation: free }).rotationDeg;
}

/**
 * Where the rotation handle of a station stands, in its own frame: 1.6 m past
 * the back of its spots (6.2 m for car spots).
 */
export function rotationHandleZ(spots: number, spotType: FreeSpotType = 'car'): number {
  return Math.round((freeSpotsExtent(spots, spotType).back + 1.6) * 100) / 100;
}

/**
 * Fit to View on a narrow stage (a phone) for a wide site: the window of
 * `windowM` meters along the site's long axis that holds the most stations,
 * over the full depth, so the stations stay readable; the full site is one
 * zoom (or a second Fit to View) away. Returns `box` unchanged on a wide
 * stage, a site that is not wide, or one already narrower than the window.
 */
export const NARROW_STAGE_PX = 640;
export const DENSE_WINDOW_M = 24;
export function denseFrameBox(
  box: Box,
  stations: readonly Point[],
  stageWidthPx: number,
  windowM: number = DENSE_WINDOW_M,
): Box {
  if (stageWidthPx >= NARROW_STAGE_PX || stations.length === 0) return box;
  const width = box.maxX - box.minX;
  const depth = box.maxZ - box.minZ;
  const alongX = width >= depth;
  const long = alongX ? width : depth;
  if (long <= windowM * 1.25 || long < (alongX ? depth : width) * 1.5) return box;
  const coord = (p: Point): number => (alongX ? p.x : p.z);
  const sorted = [...stations].map(coord).sort((a, b) => a - b);
  let bestStart = sorted[0] ?? 0;
  let bestCount = 0;
  let j = 0;
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i] ?? 0;
    while (j < sorted.length && (sorted[j] ?? 0) <= start + windowM) j++;
    if (j - i > bestCount) {
      bestCount = j - i;
      bestStart = start;
    }
  }
  // Center the window on the stations it holds.
  const inWindow = sorted.filter((v) => v >= bestStart && v <= bestStart + windowM);
  const mid = ((inWindow[0] ?? bestStart) + (inWindow.at(-1) ?? bestStart)) / 2;
  const lo = Math.max(alongX ? box.minX : box.minZ, mid - windowM / 2);
  const hi = Math.min(alongX ? box.maxX : box.maxZ, lo + windowM);
  return alongX ? { ...box, minX: lo, maxX: hi } : { ...box, minZ: lo, maxZ: hi };
}

/** The charger screens a message shows on: size in meters and the canvas it is drawn on. */
export const SCREEN_MESSAGE = {
  dc: { width: 0.42, height: 0.32, canvas: { width: 512, height: 390 } },
  // The 7 in 16:9 screen of the all-in-one DC dispenser (ABB Terra 184), its active area.
  dc7in: { width: 0.155, height: 0.087, canvas: { width: 512, height: 288 } },
  ac: { width: 0.13, height: 0.082, canvas: { width: 256, height: 162 } },
  // The 60 by 34 mm display of the AC wall box (`AC_WALL_BOX.display`).
  wallbox: { width: 0.06, height: 0.034, canvas: { width: 256, height: 145 } },
  // The 5.7 in 4:3 display of the AC pedestal (ChargePoint CT4021).
  ac57in: { width: 0.116, height: 0.087, canvas: { width: 256, height: 192 } },
  // The 95 by 54 mm display of a card reader with a screen (`SCREEN_READER.screen`)
  // at the scene scale of the reader models (`READER_SCENE_SCALE`, 1.5).
  reader: { width: 0.1425, height: 0.081, canvas: { width: 256, height: 146 } },
} as const;

/**
 * The reach range a card reader's interface stays within, in meters above
 * the ground: 15 to 48 in (2010 ADA Standards for Accessible Design, 308.2
 * forward reach and 308.3 side reach, unobstructed).
 */
export const READER_REACH_M = { min: 15 * 0.0254, max: 48 * 0.0254 } as const;

/** How far above its mount point the reader's card interface sits (the model scaled 1.5), in meters. */
export const READER_INTERFACE_ABOVE_MOUNT_M = 0.045;

/**
 * A card reader of an AC wall box mounts on the facade above the box (owner
 * decision 2026-11-10), clear of the J hooks and cable turns beside it
 * (`WALL_BOX_HOOK`: from 0.31 m right of a one-port box's center, from
 * 0.435 m either side of a two-port box) and of its signs (a one-port box's
 * beside it at x -0.75, a two-port box's over it from 1.5 m,
 * `DUAL_WALL_SIGN`). Derived: the bracket at 1.14 m puts the reader's bottom
 * (0.021 m under the mount at the scene scale) 0.03 m over the box's
 * mounting plate top (0.68 + 0.4 + 0.01 m = 1.09 m) and its card interface
 * 1.185 m up, within the 48 in (1.219 m) high reach of the 2010 ADA
 * Standards 308.2 and 308.3; it stands 0.0975 m off the wall at the scene
 * scale (bracket standoff 0.025 m plus the 0.04 m screen reader, times 1.5),
 * within the 4 in of 307.2. A connector's reader on a two-port box sits over
 * its own dock (`AC_WALL_BOX.dual.dockX`, 0.125 m); a second station-wide
 * reader one reader width (0.198 m scaled) plus a 0.022 m gap to the left.
 */
export const WALL_READER = { mountY: 1.14, portX: 0.125, pitchM: 0.22 } as const;

/**
 * Where a card reader mounts on its charger, in the charger's own frame: the
 * point on the host surface its bracket stands on (the reader models stand
 * off it themselves). On the front of a DC dispenser (integrated, as
 * dispensers of the class offer it), a connector's reader under its side of
 * the screen and a station-wide one in the middle below; on the front of an
 * AC pedestal's column (0.233 m wide, so its readers stack, the first EVSE's
 * below the second's); on the facade above an AC wall box (`WALL_READER`).
 * Every card interface stays within `READER_REACH_M`.
 */
export function readerMount(
  kind: 'dc' | 'ac',
  wall: boolean,
  side: -1 | 0 | 1,
  index: number,
  wallOffset: number,
  wallPorts: 1 | 2 = 1,
  count = 1,
): { x: number; y: number; z: number } {
  if (kind === 'dc') {
    // The DC dispenser front fascia: 10 mm proud of the 0.34 m front (`DC_DISPENSER`).
    return { x: side === 0 ? -index * 0.16 : side * 0.17, y: side === 0 ? 0.72 : 0.92, z: 0.35 };
  }
  if (wall) {
    // Over the box: a connector's reader over its own dock of a two-port box;
    // station-wide readers centered over a two-port box (its coils on both
    // sides), from the middle to the left over a one-port box (its coil right).
    const x =
      side !== 0 && wallPorts === 2
        ? side * WALL_READER.portX
        : wallPorts === 2
          ? (index - (count - 1) / 2) * WALL_READER.pitchM
          : -index * WALL_READER.pitchM;
    return { x, y: WALL_READER.mountY, z: wallOffset };
  }
  // The AC pedestal column front (`AC_PEDESTAL.post`: 0.18 m deep).
  return {
    x: side === 0 ? -index * 0.16 : 0,
    y: side === -1 ? 0.62 : side === 1 ? 0.94 : 0.78,
    z: 0.09,
  };
}

/** One holstered cable of a dispenser: the side it hangs on (-1 left, 1 right) and how far back from the front holsters, in meters. */
export interface DispenserHolster {
  side: -1 | 1;
  backM: number;
}

/**
 * The holsters of a dispenser with `cables` connectors (one holstered cable
 * per connector; a multi-standard dispenser such as the ABB Terra 54 CJG has
 * CCS, CHAdeMO and an AC Type 2 cable): left, right, then a second pair 0.25
 * m behind them at the same height (`HOLSTER_PITCH_M`), at most four. At least one.
 */
export function dispenserHolsters(cables: number): DispenserHolster[] {
  const n = Math.max(1, Math.min(4, Math.round(cables)));
  return Array.from({ length: n }, (_, k) => ({
    side: k % 2 === 0 ? -1 : 1,
    backM: k >= 2 ? 0.25 : 0,
  }));
}
