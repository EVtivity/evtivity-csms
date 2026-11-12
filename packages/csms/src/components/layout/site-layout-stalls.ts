// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The stalls a station serves on a parking lot or an office or retail row,
// without three.js: a dual-port AC pedestal or a dual-outlet DC dispenser
// (and a two-port wall box on an office or retail row, on the facade)
// stands on the line between its spot and the partner spot and serves both (`sharesSpotPair`,
// `spotPairPartner` in @evtivity/lib/site-layout); the station of the
// accessible charging space serves one widened vehicle space beside a striped
// access aisle (`accessibleChargingSpace`, `ACCESSIBLE_SPACE`); a DC split
// system has a dispenser in each of its stalls (`splitDispenserCount`,
// `SPLIT_SYSTEM`). Every other station serves its own spot.

import { ACCESSIBLE_SPACE, type LayoutBay } from '@evtivity/lib/site-layout';
import {
  CURB_POST_IN_M,
  chargersAtBack,
  isSpot,
  spotRect,
  type Box,
  type Lot,
} from './site-layout-grid';

/** One stall a station serves: its middle across the row, in the station's own frame, and its width. */
export interface Stall {
  x: number;
  width: number;
}

export interface StationStalls {
  /** How far the charger stands from the middle of its spot along the row, in lot meters. */
  shiftX: number;
  /** The stalls it serves, EVSE order (a paired station: left first in its own frame; a split system: from its first dispenser), in its own frame. */
  stalls: Stall[];
  /** A DC split system: a dispenser stands in the head of every stall (EVSE order). */
  dispensers?: boolean | undefined;
}

/** The accessible charging space in lot meters: the widened vehicle space and the striped aisle. */
export interface AccessibleSpaceBoxes {
  vehicle: Box;
  aisle: Box;
}

/**
 * A two-port curb post (`TWO_PORT_CURB_POST`) from its spot `bay` and the
 * next one along its curb: it stands on the line between them, its two
 * spots in its own frame, EVSE 1's left of it (x from minus the spot length
 * to 0) and EVSE 2's right of it. The left curb (row 0) runs +x, so the post
 * moves the spot length less `CURB_POST_IN_M` along it; the right curb is
 * turned, so it moves `CURB_POST_IN_M`. Null off a street spot.
 */
export function curbPairStalls(bay: LayoutBay, lot: Lot): StationStalls | null {
  if (lot.siteType !== 'curbside' || !isSpot(bay, lot) || bay.row > 1) return null;
  const w = lot.spotW;
  return {
    shiftX: bay.row === 0 ? w - CURB_POST_IN_M : CURB_POST_IN_M,
    stalls: [
      { x: -w / 2, width: w },
      { x: w / 2, width: w },
    ],
  };
}

/** The partner spot of a parking lot or office or retail row spot on the 3D lot (columns 0 and 1, 2 and 3, ...). */
export function lotPairPartner(bay: LayoutBay, lot: Lot): LayoutBay | null {
  if ((lot.siteType !== 'parking_lot' && lot.siteType !== 'office_retail') || !isSpot(bay, lot)) {
    return null;
  }
  const partner = { col: bay.col % 2 === 0 ? bay.col + 1 : bay.col - 1, row: bay.row };
  return isSpot(partner, lot) ? partner : null;
}

/** The vehicle space and aisle of the accessible charging space, in lot meters. */
export function accessibleSpaceBoxes(
  space: { stall: LayoutBay; aisle: LayoutBay },
  lot: Lot,
): AccessibleSpaceBoxes {
  const w = lot.spotW;
  const { minZ: z0, maxZ: z1 } = spotRect(space.stall, lot);
  const aisleW = ACCESSIBLE_SPACE.aisleWidthM;
  if (space.aisle.col > space.stall.col) {
    const end = w * (space.aisle.col + 1);
    return {
      vehicle: { minX: w * space.stall.col, maxX: end - aisleW, minZ: z0, maxZ: z1 },
      aisle: { minX: end - aisleW, maxX: end, minZ: z0, maxZ: z1 },
    };
  }
  const start = w * space.aisle.col;
  return {
    vehicle: { minX: start + aisleW, maxX: w * (space.stall.col + 1), minZ: z0, maxZ: z1 },
    aisle: { minX: start, maxX: start + aisleW, minZ: z0, maxZ: z1 },
  };
}

/**
 * The stalls a station in `bay` serves and where its charger stands:
 * `pair` for a dual-port AC pedestal (between its spot and the partner spot),
 * `access` when the station holds the accessible charging space. Null for a
 * slot off the layout, a street and a depot (one stall, drawn as before).
 */
export function stationStalls(
  bay: LayoutBay,
  lot: Lot,
  opts: {
    pair: boolean;
    access: { stall: LayoutBay; aisle: LayoutBay } | null;
    /** A DC split system's dispensers, one per stall from `bay` along its row (`splitDispenserCount`). */
    span?: number | undefined;
    /**
     * The partner column of a two-spot unit charger (`unitPartnerCol`): the
     * next spot of its station's run, whatever the lot's column parity.
     * With `pair` it replaces `lotPairPartner`.
     */
    partnerCol?: number | null | undefined;
  },
): StationStalls | null {
  if ((lot.siteType !== 'parking_lot' && lot.siteType !== 'office_retail') || !isSpot(bay, lot)) {
    return null;
  }
  const w = lot.spotW;
  const center = (col: number): number => w * (col + 0.5);
  // A turned row (chargers at its back edge) faces -z: its own x runs the other way.
  const sign = chargersAtBack(bay.row, lot) ? -1 : 1;
  const span = opts.span ?? 1;
  if (span > 1) {
    // A split system: a dispenser in the head of each of its stalls, the first at the station.
    const cols = Array.from({ length: span }, (_, i) => bay.col + i).filter((col) =>
      isSpot({ col, row: bay.row }, lot),
    );
    return {
      shiftX: 0,
      // Centimeters, so equal spots give equal offsets.
      stalls: cols.map((col) => ({
        x: Math.round(sign * (center(col) - center(bay.col)) * 100) / 100 + 0,
        width: w,
      })),
      dispensers: true,
    };
  }
  const access = opts.access;
  const forced = opts.partnerCol != null ? { col: opts.partnerCol, row: bay.row } : null;
  const partner = !opts.pair
    ? null
    : forced != null
      ? isSpot(forced, lot)
        ? forced
        : null
      : lotPairPartner(bay, lot);
  if (partner != null) {
    const lineX = w * Math.max(bay.col, partner.col);
    // EVSE 1 serves the left stall seen from the charger's front (OCPP 2.0.1
    // Part 1, Numbering: "from left to right"), on a turned row too; the
    // stall of the accessible charging space is its widened vehicle space.
    const stalls = [bay.col, partner.col].map((col) => {
      if (access != null && access.stall.col === col && access.stall.row === bay.row) {
        const { vehicle } = accessibleSpaceBoxes(access, lot);
        return {
          x: sign * ((vehicle.minX + vehicle.maxX) / 2 - lineX),
          width: vehicle.maxX - vehicle.minX,
        };
      }
      return { x: sign * (center(col) - lineX), width: w };
    });
    return {
      shiftX: lineX - center(bay.col),
      stalls: stalls.sort((a, b) => a.x - b.x),
    };
  }
  if (access != null && access.stall.col === bay.col && access.stall.row === bay.row) {
    const { vehicle } = accessibleSpaceBoxes(access, lot);
    return {
      shiftX: 0,
      stalls: [
        {
          x: sign * ((vehicle.minX + vehicle.maxX) / 2 - center(bay.col)),
          width: vehicle.maxX - vehicle.minX,
        },
      ],
    };
  }
  return { shiftX: 0, stalls: [{ x: 0, width: w }] };
}
