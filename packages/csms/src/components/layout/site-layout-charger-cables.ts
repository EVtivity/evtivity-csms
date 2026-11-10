// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The routes of the holstered charger cables of the 3D site layout, without
// three.js: each cable leaves its body through its gland (`cableOutOfGland`),
// hangs in one free loop (a catenary) and rises into the boot of its handle
// in the holster. Pure, so tests check every route against the bodies,
// vents, ground and the other cables.

import {
  CONNECTOR_SPECS,
  handleCableEntry,
  holsterPose,
  type ConnectorKind,
} from './site-layout-connectors';
import { cableOutOfGland } from './site-layout-model-cable-gland';
import {
  DC_HOLSTER as DC_HOLSTER_MOUNT,
  DC_SIDE_X,
  dcGland,
  dcHookZ,
} from './site-layout-model-dc-dispenser';
import {
  CABLE_HOOK,
  cableHookSpec,
  cableHookTurnZ,
  coilTopRadius,
  sidewalkHookTurns,
  turnsWidth,
  type CableClass,
  type CableHookSpec,
} from './site-layout-model-cable-hook';
import { bottomRadiusSteps, clearCoilCable, type CoilPlace } from './site-layout-cable-coil';
import type { Vec3 } from './site-layout-model-kit';
import { AC_PEDESTAL, acGland } from './site-layout-model-ac-pedestal';
import { SURFACE_M, type SurfaceAt } from './site-layout-cable-surface';

/** How far over the ground an idle loop's bottom hangs (cable center above the surface). */
export const COIL_GROUND_CLEARANCE_M = 0.1;

/**
 * A hanging cable between two points as a catenary: in the vertical plane
 * through p1 and p2, with D their horizontal distance and h1, h2 their
 * heights above the lowest point y0, the curve is y = y0 + a (cosh((s - s0) / a) - 1).
 * It passes p1 at s = 0 and p2 at s = D when
 * a acosh(1 + h1 / a) + a acosh(1 + h2 / a) = D, which grows with a, so a
 * bisection finds the one a; s0 = a acosh(1 + h1 / a). The cable length
 * follows as a sinh(s0 / a) + a sinh((D - s0) / a): the sag (y0) is chosen
 * and the length derived, the same curve as a cable of that length hanging
 * from the two points. `n` points from p1 to p2 inclusive.
 */
export function catenaryPoints(p1: Vec3, p2: Vec3, lowestY: number, n = 16): Vec3[] {
  const dx = p2[0] - p1[0];
  const dz = p2[2] - p1[2];
  const D = Math.max(1e-4, Math.hypot(dx, dz));
  const h1 = Math.max(0, p1[1] - lowestY);
  const h2 = Math.max(0, p2[1] - lowestY);
  const span = (a: number): number => a * Math.acosh(1 + h1 / a) + a * Math.acosh(1 + h2 / a);
  let lo = 1e-5;
  let hi = 1e3;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (span(mid) > D) hi = mid;
    else lo = mid;
  }
  const a = (lo + hi) / 2;
  const s0 = a * Math.acosh(1 + h1 / a);
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const s = t * D;
    return [p1[0] + dx * t, lowestY + a * (Math.cosh((s - s0) / a) - 1), p1[2] + dz * t] as const;
  });
}

/** The length of a polyline route. */
export function routeLength(points: readonly Vec3[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a == null || b == null) continue;
    len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return len;
}

/** The holster on a DC dispenser side wall: its mount and its cup facing out of the wall. */
export const DC_HOLSTER = { x: DC_SIDE_X + 0.015, ...DC_HOLSTER_MOUNT } as const;

/** Where the handle of a DC holster's cable enters (its boot), from the holster pose. */
export function dcHolsterEntry(
  side: -1 | 1,
  backM: number,
  kind: ConnectorKind,
): { lead: Vec3; end: Vec3 } {
  const pose = holsterPose(
    { x: side * DC_HOLSTER.x, y: DC_HOLSTER.y, z: DC_HOLSTER.z - backM },
    {
      x: side,
      z: 0,
    },
  );
  const entry = handleCableEntry(pose.handle, pose.handleYaw, kind);
  return { lead: entry.lead, end: entry.end };
}

/**
 * The charging cable of a DC dispenser: 3.6 m, the median standard CCS cable
 * of seven all-in-one DC fast chargers (ABB Terra 184 UL 6 m, Tritium PKM150
 * 3.6 m, alpitronic HYC300 3.5 m, alpitronic HYC400 3.5 m, BTC Power Gen 4
 * 180 kW 5.49 m, Wallbox Supernova 180 5 m, Delta UFC 200 3.2 m; manufacturer
 * product guides and data sheets, research 2026-11-02; the Tritium, alpitronic
 * HYC300 and ABB values confirmed by a later review, the Delta one
 * unverified). Sorted 3.2, 3.5, 3.5, 3.6, 5, 5.49, 6: the median 3.6 m. Derived.
 */
export const DC_CABLE_M = 3.6;

/**
 * The charging cable of a DC dispenser with two EVSEs, which stands on the
 * line between the two spots it serves: 6 m (19.6 ft), the cable of the
 * dual-outlet ABB Terra 184 (NA data sheet, document 9AKK107991A4247 rev J:
 * "Charge cable 6 m (19.6 ft)"; "The Terra 124 and 184 models can charge two
 * vehicles at the same time",
 * https://library.e.abb.com/public/dde7c01ce17b45b1857b214235bbb7e7/Terra_124_184_NA_Data-Sheet-J.pdf,
 * verified 2026-11-10). The 3.6 m median cable does not reach the port of a
 * car on the far side of its stall from the dispenser (layout review H2,
 * owner decision 2026-11-10).
 */
export const DC_PAIRED_CABLE_M = 6;

/** The cable length of a DC dispenser with `evses` EVSEs: two serve two spots (`DC_PAIRED_CABLE_M`). */
export function dcDispenserCableM(evses: number): number {
  return evses >= 2 ? DC_PAIRED_CABLE_M : DC_CABLE_M;
}

/**
 * Where a cable loops over a J hook (site-layout-model-cable-hook.ts) whose
 * rod axis leaves the body face at `mount` along `out`: the turns hang
 * parallel to the face, stacked out along the throat (`offsetM` past the
 * turns of cables nearer the face), the cable resting on the rod's top and
 * bending over it at `coilTopRadius`; `across` runs from the side the cable
 * comes up (the entry) to the far side.
 */
export function hookCoilPlace(o: {
  mount: Vec3;
  out: Vec3;
  across: Vec3;
  cableDiameterM: number;
  cable: CableClass;
  offsetM?: number;
  /** A wider top bend than the cable's minimum (`coilTopRadius`), never a tighter one. */
  topRadiusM?: number;
}): CoilPlace {
  const d = o.cableDiameterM;
  const r1 = Math.max(coilTopRadius(d, o.cable), o.topRadiusM ?? 0);
  const z = cableHookTurnZ(0, d, o.offsetM ?? 0);
  // The cable's center line tops out a rod radius and a cable radius over the rod axis.
  const lift = CABLE_HOOK.rodRadiusM + d / 2 - r1;
  return {
    center: [o.mount[0] + o.out[0] * z, o.mount[1] + lift, o.mount[2] + o.out[2] * z],
    u: o.across,
    axis: o.out,
    r1,
  };
}

/**
 * The rod top of a DC dispenser's J hooks: 1.2 m, just above the holster
 * height in front of and behind the handles (their loops clear the handles'
 * grips by standing 0.17 m in front of the front holster and 0.15 m behind
 * one behind it, `dcHookZ`) and inside the 0.38 to 1.22 m reach range (2010
 * ADA Standards 308.2, 308.3), so a driver lifts the loop off. One turn of
 * the 3.6 m cable then hangs clear of the pad with its bottom no wider
 * than 0.15 m in radius for every connector, so the loops of a side's two
 * cables never meet and the way up to the handle stays clear of the gland's
 * U (at 1.1 m the CHAdeMO loop needed a 0.27 m bottom and touched the back
 * loop). Derived (review 2026-11-10, H1).
 */
export const DC_HOOK_TOP_M = 1.2;

/** Turns a DC cable may take on its hook: up to 2. */
const DC_HOOK_TURNS = 2;

/** The J hook of a DC holster's cable: its throat holds the cable's turns. */
export function dcHookSpec(kind: ConnectorKind): CableHookSpec {
  return cableHookSpec(turnsWidth(DC_HOOK_TURNS, CONNECTOR_SPECS[kind].cableDiameterM));
}

/**
 * Where a DC holster's loop hangs: on its J hook on the side wall
 * (`dcHookZ`, the front holster's in front of it, a holster behind it its
 * own behind it), the turns parallel to the wall and stacked out along the
 * hook; the cable comes up the loop's inner edge, the one toward the
 * middle of the wall where its gland is (the back edge of the front loop,
 * the front edge of the back loop), so the two loops of one side never meet.
 */
export function dcCoilPlace(
  side: -1 | 1,
  backM: number,
  kind: ConnectorKind,
): CoilPlace & {
  /** The hook group's position (its rod axis on the side wall). */
  mount: Vec3;
} {
  const d = CONNECTOR_SPECS[kind].cableDiameterM;
  const mount: Vec3 = [side * DC_SIDE_X, DC_HOOK_TOP_M - CABLE_HOOK.rodRadiusM, dcHookZ(backM)];
  const place = hookCoilPlace({
    mount,
    out: [side, 0, 0],
    // In from the inner edge, nearer the gland: the back edge of the front loop, the front of the back one.
    across: [0, 0, backM > 0 ? -1 : 1],
    cableDiameterM: d,
    cable: 'dc',
  });
  return { ...place, mount };
}

/**
 * The route of a holstered DC cable, `lengthM` long (`DC_CABLE_M`, a two-EVSE
 * dispenser's `DC_PAIRED_CABLE_M` in two turns): out of its gland on
 * the side wall (along the axis, then bent down at 6 cable diameters), in a
 * U up over its J hook in whole hanging turns (`coilCable`, the loop clear of the
 * pad by 0.1 m), then off the bottom of the last turn up into the handle's
 * boot straight along the boot axis. The front holster's hook is in front of
 * it, a holster behind it has its hook behind it, so the two loops of one
 * side never meet. No cable crosses a vent (the inlet grille is on the
 * front, the outlet high on the sides).
 */
export function dcHolsterCable(
  side: -1 | 1,
  backM: number,
  kind: ConnectorKind,
  surface: SurfaceAt = (x, z) =>
    Math.abs(x) <= 0.8 && Math.abs(z) <= 0.6 ? 0.08 : SURFACE_M.paving,
  lengthM: number = DC_CABLE_M,
): Vec3[] {
  const d = CONNECTOR_SPECS[kind].cableDiameterM;
  const gland = dcGland(side, backM);
  const out = cableOutOfGland(gland.at, gland.axis, d, [0, -1, 0]);
  const entry = dcHolsterEntry(side, backM, kind);
  const place = dcCoilPlace(side, backM, kind);
  const under = surface(place.center[0], place.center[2]);
  const floorY = under + d / 2 + COIL_GROUND_CLEARANCE_M;
  const key = `${String(side)}|${String(backM)}|${kind}|${floorY.toFixed(4)}|${String(lengthM)}`;
  const known = DC_IDLE_ROUTES.get(key);
  if (known != null) return known;
  // The loop's bottom as open as it must be (0.12 to 0.36 m) for the length
  // to hang clear of the pad, the way up from it to the handle clear of the
  // gland's U beside it: the cable never passes through itself (`clearCoilCable`).
  const points = clearCoilCable(
    {
      entry: out,
      place,
      cableDiameterM: d,
      handle: entry,
      floorY,
      lengthM,
      preferTurns: [1, 2],
      entryHeading: [0, -1, 0],
    },
    bottomRadiusSteps(0.12, 0.36),
  ).points;
  DC_IDLE_ROUTES.set(key, points);
  return points;
}

/** The idle DC routes solved so far (the search is pure, its inputs few). */
const DC_IDLE_ROUTES = new Map<string, Vec3[]>();

/**
 * The charging cable of an AC pedestal and a curb post: the median standard
 * cable of twelve commercial AC pedestals and posts, 19 ft (5.79 m):
 * ChargePoint CT4000 18 ft, ChargePoint CPF50 18 ft, Blink IQ 200 23 ft,
 * EVBox BusinessLine (NA) 18 ft, SemaConnect / Blink Series 6 18 ft, Enel X
 * JuicePedestal 20 ft, Enphase IQ EV Charger 2 25 ft, Siemens VersiCharge
 * commercial 20 ft, ABB Terra AC 16.4 ft, Wallbox Commander 2 16.4 ft, FLO
 * CoRe+ 25 ft, FLO SmartTWO-BSR curbside post 22 ft (manufacturer spec
 * sheets, research 2026-11-02). Sorted, the middle two are 18 and 20 ft. Derived.
 */
export const AC_CABLE_M = 5.79;

/** An AC pedestal holster on the head side: 15 mm out from the head, at the cited holster height. */
export const AC_HOLSTER = {
  x: AC_PEDESTAL.head.widthM / 2 + 0.015,
  y: AC_PEDESTAL.holsterY,
} as const;

/** Where an AC pedestal cable enters the boot of its holstered handle on `side`. */
export function acHolsterEntry(side: -1 | 1, kind: ConnectorKind): { lead: Vec3; end: Vec3 } {
  const pose = holsterPose({ x: side * AC_HOLSTER.x, y: AC_HOLSTER.y, z: 0 }, { x: side, z: 0 });
  const entry = handleCableEntry(pose.handle, pose.handleYaw, kind);
  return { lead: entry.lead, end: entry.end };
}

/** The rod top of an AC pedestal's J hooks: 30 mm under the head, so the turns clear it. */
export const AC_HOOK_TOP_M = AC_PEDESTAL.head.bottomM - 0.03;

/** Turns an AC pedestal or curb post cable may take on its hook: up to 4. */
const AC_HOOK_TURNS = 4;

/** The J hook of an AC pedestal cable: out of the column side, the turns parallel to the side. */
export function acHookSpec(cableDiameterM: number): CableHookSpec {
  return cableHookSpec(
    turnsWidth(sidewalkHookTurns(AC_HOOK_TURNS, cableDiameterM), cableDiameterM),
  );
}

/** Where an AC pedestal cable loops: its J hook on the column side on `side`. */
export function acCoilPlace(
  side: -1 | 1,
  cableDiameterM: number,
): CoilPlace & {
  /** The hook group's position (its rod axis on the column side). */
  mount: Vec3;
} {
  const face = AC_PEDESTAL.post.widthM / 2;
  const mount: Vec3 = [side * face, AC_HOOK_TOP_M - CABLE_HOOK.rodRadiusM, 0];
  // The cable comes up the front of the hook and over to the back.
  const place = hookCoilPlace({
    mount,
    out: [side, 0, 0],
    across: [0, 0, -1],
    cableDiameterM,
    cable: 'ac',
  });
  return { ...place, mount };
}

/**
 * The run of an AC pedestal cable out of its gland under the head (at
 * `glandX`): straight down along the gland axis past the strain relief, in
 * front of the column, so it never enters the body; the cable hangs on from
 * there (`acHolsterCable`). `side` is the hook's side (the run is the same).
 */
export function acGlandRun(glandX: number, side: -1 | 1, cableDiameterM: number): Vec3[] {
  const g = acGland(glandX);
  // The points along the axis to the strain relief tip (no bend: the cable hangs down).
  return cableOutOfGland(g.at, g.axis, cableDiameterM, [side, 0, 0]).slice(0, 4);
}

/**
 * The first run of a plugged AC pedestal cable: out of its gland under the
 * head (at `glandX`), bent at 6 cable diameters toward the front, where the
 * car stands, so it leaves the head clear of the column.
 */
export function acGlandOut(glandX: number, cableDiameterM: number): Vec3[] {
  const g = acGland(glandX);
  return cableOutOfGland(g.at, g.axis, cableDiameterM, [0, 0, 1]);
}

/**
 * The route of a holstered AC pedestal cable, `AC_CABLE_M` long: out of its
 * gland, up the front of its J hook on the column side and over it in
 * whole hanging turns (`coilCable`, the turns' bottom 0.1 m over the pad,
 * each turn further out along the hook), then off the bottom of the last
 * (outermost) turn up into the handle's boot along its axis.
 */
export function acHolsterCable(
  glandX: number,
  side: -1 | 1,
  cableDiameterM: number,
  handle: { lead: Vec3; end: Vec3 },
  surface: SurfaceAt = (x, z) =>
    Math.abs(x) <= 0.5 && Math.abs(z) <= 0.45 ? 0.08 : SURFACE_M.paving,
): Vec3[] {
  const d = cableDiameterM;
  const place = acCoilPlace(side, d);
  const under = surface(place.center[0], place.center[2]);
  const floorY = under + d / 2 + COIL_GROUND_CLEARANCE_M;
  const key = [glandX, side, d, floorY, ...handle.lead, ...handle.end]
    .map((v) => v.toFixed(5))
    .join('|');
  const known = AC_IDLE_ROUTES.get(key);
  if (known != null) return known;
  // The turns' bottom as open as the top bend (at least 0.12 m), else wider
  // in 0.03 m steps up to 0.3 m, the first that never passes through itself
  // (`clearCoilCable`, owner decision 2026-11-10).
  const points = clearCoilCable(
    {
      entry: acGlandRun(glandX, side, d),
      place,
      cableDiameterM: d,
      handle,
      floorY,
      lengthM: AC_CABLE_M,
      // No more turns than the hook holds (`sidewalkHookTurns`: a thick cable fewer).
      preferTurns: [3, 2, 4, 1].filter((n) => n <= sidewalkHookTurns(AC_HOOK_TURNS, d)),
      // Down from the gland in a U in front of the column and up the hook's front side.
      enterFrom: 'side',
      // The gland stands behind the hook's first turn (under the head, toward its middle).
      entryBehindFirstTurn: true,
      entryHeading: [0, -1, 0],
    },
    [Math.max(0.12, place.r1), ...bottomRadiusSteps(0.15, 0.3)],
  ).points;
  AC_IDLE_ROUTES.set(key, points);
  return points;
}

/** The idle AC pedestal and curb post routes solved so far. */
const AC_IDLE_ROUTES = new Map<string, Vec3[]>();

/** The first run of a plugged DC cable: out of its holster's gland (the cable then runs to the car). */
export function dcGlandOut(side: -1 | 1, backM: number, kind: ConnectorKind): Vec3[] {
  const g = dcGland(side, backM);
  return cableOutOfGland(g.at, g.axis, CONNECTOR_SPECS[kind].cableDiameterM, [0, -1, 0]);
}
