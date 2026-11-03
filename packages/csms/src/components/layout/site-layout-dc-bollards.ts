// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The bollards in front of a DC dispenser and where its car stops. Pure.

import { EQUIPMENT_BOLLARD } from './site-layout-links';
import { DC_DISPENSER } from './site-layout-model-dc-dispenser';

/**
 * How far the bollards stand from the dispenser, from its footprint: 310 mm
 * beside each side and 585 mm in front of the front face to the bollard (ABB
 * Terra 94/124/184 installation manual, "approved bollard location B"),
 * rounded up here to 600 mm so the front door opens clear of the bollards
 * (ABB Terra 184 UL: front door 600 mm; a design choice). ChargePoint Express 250 sets its two front bollards 1,700 mm
 * apart for head-in or back-in parking; this layout's are 1.52 m apart. The
 * clearances are to the bollard's face. Derived.
 */
export const DC_BOLLARD_CLEARANCE = { sideM: 0.31, frontM: 0.6 } as const;

/** The two pipe bollards in front of a DC dispenser: their x (each side) and center line z. */
export const DC_BOLLARD = {
  x: DC_DISPENSER.widthM / 2 + DC_BOLLARD_CLEARANCE.sideM + EQUIPMENT_BOLLARD.radiusM,
  z: DC_DISPENSER.frontZ + DC_BOLLARD_CLEARANCE.frontM + EQUIPMENT_BOLLARD.radiusM,
} as const;

/** The front face of the DC bollards (toward the car), in the station's z. */
export const DC_BOLLARD_FACE_M = DC_BOLLARD.z + EQUIPMENT_BOLLARD.radiusM;

/**
 * Where a car parked nose in at a DC dispenser stops: its nose 0.3 m clear of
 * the bollard faces, close enough that the 3.6 m cable (`DC_CABLE_M`) reaches
 * every front port. Derived.
 */
export const DC_CAR_FRONT_M = DC_BOLLARD_FACE_M + 0.3;

/**
 * How far a car backed into a DC spot keeps its tail from the bollard faces:
 * at least 36 in (US Access Board, Design Recommendations for Accessible
 * Electric Vehicle Charging Stations, Figure B2; owner rule 2026-11-02).
 */
export const BACKED_IN_BOLLARD_CLEARANCE_M = 0.9144;

/** Where a car backed into a DC spot stops, its tail toward the charger. */
export const DC_CAR_TAIL_M = DC_BOLLARD_FACE_M + BACKED_IN_BOLLARD_CLEARANCE_M;
