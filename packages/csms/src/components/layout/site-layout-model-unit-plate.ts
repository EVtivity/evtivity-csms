// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The box number plate of a unit charger (owner decision 2026-11-11): every
// charger box of a station with units (a master and its extenders, GitHub
// discussion 59: the master numbers its boxes 1 to 8, the master Box 1 and the
// extenders after it) carries its number on a plate, so the box a driver
// stands at matches the box the operator names. A generic plate, no brand:
// the EVSE plate's build (site-layout-model-evse-plate.ts) without its status
// light, wider for numbers up to 64 (`STATION_UNITS_MAX`). The number is the
// unit's 1-based place in the station's unit order (its sort order), never a
// number read from the name, which is operator text and may hold none or
// several.
//
// Frame: the mounting face is z = 0, the plate stands out along +z, centered
// on the frame origin.

import { ModelParts, frontProfileG, type ModelKit, type Vec3 } from './site-layout-model-kit';
import { roundedRect } from './site-layout-model-charger-parts';
import { AC_PEDESTAL } from './site-layout-model-ac-pedestal';
import { AC_WALL_BOX } from './site-layout-model-wall-box';
import { DC_DISPENSER } from './site-layout-model-dc-dispenser';
import type { DigitContext, EvsePlateMount } from './site-layout-model-evse-plate';

/** The material slots of the plate: its body and the number face. */
export const UNIT_PLATE_SLOTS = ['plate', 'face'] as const;
export type UnitPlateSlot = (typeof UNIT_PLATE_SLOTS)[number];

/**
 * The plate's sizes, derived: a number 30 mm high, over the 5/8 in (16 mm)
 * minimum of a visual character (2010 ADA Standards 703.5.5), on a 90 by 50 mm
 * plate 6 mm thick (two digits side by side at the EVSE plate's proportions).
 * It fits the AC pedestal head front between the screen and the status lenses
 * (`acPedestalUnitPlate`). No maker publishes a box number plate size.
 */
export const UNIT_PLATE = {
  widthM: 0.09,
  heightM: 0.05,
  depthM: 0.006,
  /** The number face: inset 5 mm, the number 30 mm high on it. */
  face: { widthM: 0.08, heightM: 0.04, digitM: 0.03 },
} as const;

/** The number face canvas size (px), the face's proportions. */
export const UNIT_NUMBER_CANVAS = { width: 200, height: 100 } as const;

/** The plate body and its recessed number face. */
export function createUnitPlateKit(): ModelKit<UnitPlateSlot> {
  const p = new ModelParts<UnitPlateSlot>();
  const u = UNIT_PLATE;
  const opening = [...roundedRect(u.face.widthM, u.face.heightM, 0.004)].reverse();
  p.add(
    'plate',
    frontProfileG(roundedRect(u.widthM, u.heightM, 0.006), u.depthM, 0.0015, [opening]),
    { at: [0, 0, u.depthM / 2] },
  );
  p.add(
    'face',
    frontProfileG(roundedRect(u.face.widthM, u.face.heightM, 0.004), u.depthM - 0.001),
    { at: [0, 0, (u.depthM - 0.001) / 2] },
  );
  return p.kit();
}

/** Where the number texture plane stands in the plate frame: just in front of the recessed face. */
export function unitNumberZ(): number {
  return UNIT_PLATE.depthM - 0.001 + 0.0004;
}

/** Draws box number `n` white on the dark face, 30/40 of the face high. */
export function drawUnitNumber(ctx: DigitContext, n: number, fontFamily: string): void {
  const { width, height } = UNIT_NUMBER_CANVAS;
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#f9fafb';
  const px = Math.round((height * UNIT_PLATE.face.digitM) / UNIT_PLATE.face.heightM / 0.72);
  ctx.font = `700 ${String(px)}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), width / 2, height / 2 + px * 0.04, width * 0.9);
}

/**
 * The plate on an AC pedestal: on the head front between the screen and the
 * status lenses, centered, so no hood, lens glow or pad covers it: the
 * screen's bottom at 1.317 m, the glow ring around a lens (its radius plus
 * 18 mm) reaching 1.208 m, the plate centered between them (derived).
 */
export function acPedestalUnitPlate(): EvsePlateMount {
  const a = AC_PEDESTAL;
  const screenBottom = a.screen.y - a.screen.heightM / 2;
  const glowTop = a.lensY + a.lensR + 0.018;
  // On the face panel, 7 mm proud of the head front (as the RFID pads).
  return { at: [0, (screenBottom + glowTop) / 2, a.frontZ + 0.007], turnY: 0 };
}

/**
 * The plate on a DC dispenser: on the front 0.12 m above the screen's center
 * (its top at 1.514 m), center 1.59 m, under the dispenser's 2.08 m top.
 */
export function dcDispenserUnitPlate(): EvsePlateMount {
  const d = DC_DISPENSER;
  return { at: [0, d.screen.y + d.screen.heightM / 2 + 0.076, d.frontZ + 0.002], turnY: 0 };
}

/**
 * The plate of a wall box: on the facade 50 mm above the box (one port or
 * two), centered on it, facing the spot; 6 mm off the wall, inside the 4 in a
 * wall object may stand out over a path (2010 ADA Standards 307.2).
 */
export function wallBoxUnitPlate(bottomM: number, wallZ: number): EvsePlateMount {
  const at: Vec3 = [0, bottomM + AC_WALL_BOX.heightM + 0.05 + UNIT_PLATE.heightM / 2, wallZ];
  return { at, turnY: 0 };
}

/**
 * The plate on a depot charger (a bus dispenser cabinet, a megawatt dispenser,
 * a pantograph pole's control module): centered under its 0.44 by 0.34 m
 * screen, 35 mm below the screen's bottom (clear of its bezel), on the same face (`screen` is the
 * screen's center, its z the face). Derived: the RFID pads stand at least
 * 0.33 m under the screen center and off center, below the plate.
 */
export function plateUnderScreen(screen: Vec3, screenHeightM: number): EvsePlateMount {
  return {
    at: [screen[0], screen[1] - screenHeightM / 2 - 0.035 - UNIT_PLATE.heightM / 2, screen[2]],
    turnY: 0,
  };
}

/** The OCPP EVSE numbers a plate's hover label names: "1", "1 and 2", "1, 2 and 3". */
export function unitPlateEvseList(evseIds: readonly number[], and: string): string {
  const ids = [...evseIds].sort((a, b) => a - b).map(String);
  if (ids.length <= 1) return ids[0] ?? '';
  return `${ids.slice(0, -1).join(', ')} ${and} ${ids[ids.length - 1] ?? ''}`;
}
