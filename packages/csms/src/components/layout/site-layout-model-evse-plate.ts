// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The EVSE number plate of a charger with more than one EVSE (owner decision
// 2026-11-09): a small plate next to the EVSE's holsters, on the side that
// faces the EVSE's own spot, with its number (1, 2) and the EVSE's own status
// light. The plate is the owner's choice: 23 CFR 680.116(c)(8)(ii) asks the
// data a charger funded under 23 CFR 680 publishes to name each port by a
// "unique port identifier", and OCPP numbers EVSEs from 1, advisably from
// left to right (OCPP 2.0.1 Part 1, Numbering, as the research note gives it,
// not read here), so EVSE 1 is the left side seen from the front. The connectors of one EVSE share its
// plate and its light.
//
// Frame: the mounting face is z = 0, the plate stands out along +z, centered
// on the frame origin; the light above the number.

import * as THREE from 'three';
import {
  ModelParts,
  frontProfileG,
  torusG,
  type ModelKit,
  type Vec3,
} from './site-layout-model-kit';
import { roundedRect } from './site-layout-model-charger-parts';
import { AC_PEDESTAL } from './site-layout-model-ac-pedestal';
import { DC_HOLSTER, DC_SIDE_X } from './site-layout-model-dc-dispenser';
import { SPLIT_SATELLITE } from './site-layout-model-split-satellite';
import { wallBoxPlateAt } from './site-layout-model-wall-box';
import { BUS_DISPENSER, BUS_DISPENSER_HOLSTERS } from './site-layout-model-bus-dispenser';

/** The material slots of the plate: its body, the number face and the light's bezel. */
export const EVSE_PLATE_SLOTS = ['plate', 'face', 'bezel'] as const;
export type EvsePlateSlot = (typeof EVSE_PLATE_SLOTS)[number];

/**
 * The plate's sizes, derived: a number 40 mm high, over the 5/8 in (16 mm)
 * minimum of a visual character read from under 72 in at 40 to 70 in above
 * the floor (2010 ADA Standards 703.5.5), on a 60 by 100 mm plate 6 mm
 * thick, a 12 mm status light above it in a chrome bezel. No maker publishes
 * a port number plate size (research 2026-11-10).
 */
export const EVSE_PLATE = {
  widthM: 0.06,
  heightM: 0.1,
  depthM: 0.006,
  /** The number face: inset 5 mm, its lower 62 mm, the number 40 mm high on it. */
  face: { widthM: 0.05, heightM: 0.062, yM: -0.014, digitM: 0.04 },
  /** The status light: its radius and center above the plate's middle. */
  light: { rM: 0.012, yM: 0.031 },
} as const;

/** The number face canvas size (px), the face's proportions. */
export const EVSE_DIGIT_CANVAS = { width: 100, height: 124 } as const;

/** The plate body, the recessed number face and the status light's bezel (the light is the scene's). */
export function createEvsePlateKit(): ModelKit<EvsePlateSlot> {
  const p = new ModelParts<EvsePlateSlot>();
  const e = EVSE_PLATE;
  // The plate with the opening the number face sits in, 1 mm below its front.
  const opening = [...roundedRect(e.face.widthM, e.face.heightM, 0.005)].reverse();
  p.add(
    'plate',
    frontProfileG(roundedRect(e.widthM, e.heightM, 0.008), e.depthM, 0.0015, [opening]),
    { at: [0, 0, e.depthM / 2] },
  );
  p.add(
    'face',
    frontProfileG(roundedRect(e.face.widthM, e.face.heightM, 0.005), e.depthM - 0.001),
    {
      at: [0, e.face.yM, (e.depthM - 0.001) / 2],
    },
  );
  p.add('bezel', torusG(e.light.rM + 0.0015, 0.0018, 6, 20), {
    at: [0, e.light.yM, e.depthM + 0.0008],
  });
  return p.kit();
}

/** The status light's dome on the plate (its own material, the EVSE's status color). */
export function evsePlateLightGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(EVSE_PLATE.light.rM, 16, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  g.rotateX(Math.PI / 2);
  g.scale(1, 1, 0.35);
  g.translate(0, EVSE_PLATE.light.yM, EVSE_PLATE.depthM);
  return g;
}

/** Where the number texture plane stands in the plate frame: just in front of the recessed face. */
export function evseDigitZ(): number {
  return EVSE_PLATE.depthM - 0.001 + 0.0004;
}

/** What drawing the number needs of a canvas 2D context. */
export interface DigitContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillRect: (x: number, y: number, w: number, h: number) => void;
  fillText: (text: string, x: number, y: number, maxWidth?: number) => void;
}

/** Draws EVSE number `n` white on the dark face, 40/62 of the face high. */
export function drawEvseDigit(ctx: DigitContext, n: number, fontFamily: string): void {
  const { width, height } = EVSE_DIGIT_CANVAS;
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#f9fafb';
  const px = Math.round((height * EVSE_PLATE.face.digitM) / EVSE_PLATE.face.heightM / 0.72);
  ctx.font = `700 ${String(px)}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), width / 2, height / 2 + px * 0.04, width * 0.9);
}

/** Where a plate mounts on a charger and which way it faces (a turn about y, 0 faces +z). */
export interface EvsePlateMount {
  at: Vec3;
  turnY: number;
}

/**
 * The plate of the EVSE on `side` of a DC dispenser (-1 left, 1 right, OCPP
 * order: EVSE 1 left): on the side wall, 0.26 m over the holsters' 1.1 m
 * mount, centered over the EVSE's holsters (`backs`, how far back each
 * stands), so it reads above the handles and below the outlet vent (1.72 m).
 */
export function dcEvsePlate(side: -1 | 1, backs: readonly number[]): EvsePlateMount {
  const zs = backs.length > 0 ? backs.map((b) => DC_HOLSTER.z - b) : [DC_HOLSTER.z];
  const z = (Math.min(...zs) + Math.max(...zs)) / 2;
  return { at: [side * DC_SIDE_X, DC_HOLSTER.y + 0.26, z], turnY: side * (Math.PI / 2) };
}

/**
 * The plate of the port on `side` of a dual-port AC pedestal: on the head's
 * side wall over the holster (1.186 m), its center at 1.38 m and 30 mm in
 * front of the holster, clear of the handle.
 */
export function acEvsePlate(side: -1 | 1): EvsePlateMount {
  return {
    at: [side * (AC_PEDESTAL.head.widthM / 2), 1.38, 0.03],
    turnY: side * (Math.PI / 2),
  };
}

/**
 * The plate of the port on `side` of a two-port wall box with its bottom
 * `bottomM` above grade: on the fascia over the port's dock and status ring,
 * facing the spot (`wallBoxPlateAt`); at the 0.68 m box bottom its center
 * 1.015 m up, inside the box.
 */
export function wallBoxEvsePlate(bottomM: number, side: -1 | 1): EvsePlateMount {
  return { at: wallBoxPlateAt(bottomM, side), turnY: 0 };
}

/**
 * The plate of outlet `index` (EVSE order) of a dual-outlet bus dispenser: on
 * the cabinet front over that outlet's holster (1.2 m), its center 0.26 m
 * above it as on the DC dispenser (1.46 m, inside the 40 to 70 in band of
 * 2010 ADA Standards 703.5.5), facing the bays.
 */
export function busDispenserEvsePlate(index: number): EvsePlateMount {
  const h = BUS_DISPENSER_HOLSTERS[index % BUS_DISPENSER_HOLSTERS.length] ?? [0, 1.2, 0];
  return { at: [h[0], h[1] + 0.26, BUS_DISPENSER.depthM / 2 + 0.004], turnY: 0 };
}

/**
 * The plate of a split satellite (one EVSE each): on the front plate under
 * the RFID pad, its center at 0.85 m, facing the satellite's own spot.
 */
export const SATELLITE_EVSE_PLATE: EvsePlateMount = {
  at: [0, 0.85, SPLIT_SATELLITE.depthM / 2 + 0.006],
  turnY: 0,
};
