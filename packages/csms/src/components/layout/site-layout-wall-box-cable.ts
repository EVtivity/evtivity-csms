// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The tethered cable of an office or retail wall box (owner decisions
// 2026-11-02, 2026-11-09): one piece out of the gland under the box. Idle, it loops over
// the J hook beside the box in hanging turns and runs up into the handle
// docked in the front middle of the box, angled down along its face. Charging, it comes off the hook
// (left empty) and spans to the car's port, the rest of its length resting
// on the sidewalk and the curb.
//
// Frame: the station's own frame of an office row station (+z into the spot,
// the facade at `wallZ`), x across, y up from the ground.

import {
  AC_WALL_BOX,
  wallBoxGland,
  wallBoxHolsterMount,
  wallBoxWidth,
  type WallBoxPorts,
} from './site-layout-model-wall-box';
import {
  handleCableEntry,
  holsterPose,
  type CableEntry,
  type ConnectorKind,
} from './site-layout-connectors';
import { cableOutOfGland } from './site-layout-model-cable-gland';
import {
  CABLE_HOOK,
  cableHookSpec,
  sidewalkHookTurns,
  turnsWidth,
  type CableHookSpec,
} from './site-layout-model-cable-hook';
import type { Vec3 } from './site-layout-model-kit';
import { coilCable, type CoilCable, type CoilPlace } from './site-layout-cable-coil';
import { plugRoute, type PlugRoute } from './site-layout-cable-rest';
import { COIL_GROUND_CLEARANCE_M, hookCoilPlace } from './site-layout-charger-cables';

export { COIL_GROUND_CLEARANCE_M };
import type { GroundRect, SurfaceAt } from './site-layout-cable-surface';

/**
 * The cable length, the median of nine tethered residential Level 2 wall
 * units (25 ft, 7.62 m; manufacturer pages, research 2026-11-03):
 * ChargePoint Home Flex 23 ft (chargepoint.com/drivers/home/resource); Tesla
 * Wall Connector Gen 3 24 ft (energylibrary.tesla.com Gen3 install guide);
 * Grizzl-E Classic 24 ft (user manual rev 3.5, specification table, model
 * GR1-14-24; the product page says 25 ft); Emporia 25 ft
 * (emporiaenergy.com/ev-chargers, shop product page; the Pro install guide
 * says 24 ft); Enel X JuiceBox 40 25 ft (data sheet 012022); Wallbox Pulsar
 * Plus NA 25 ft (data sheet); ABB Terra AC NA 25 ft (installation manual
 * 9AKK108466A5307); Autel MaxiCharger AC Wallbox 25 ft (product page);
 * Siemens VersiCharge AC 20 ft (data sheet). Sorted 20, 23, 24, 24, 25, 25,
 * 25, 25, 25: the median 25 ft; with Emporia at 24 ft it would be 24 ft
 * (7.32 m). The commercial CPF50 is left out. Derived.
 */
export const WALL_BOX_CABLE_M = 7.62;

/**
 * Where the wall box's J hook is (its loops hanging parallel to the wall),
 * derived: 0.46 m right of the box center (the box half width 0.115 m, its
 * plate margin 0.01 m, room for a turn's bottom half width up to 0.3 m and a
 * 0.035 m gap), the cable's top over it 1.2 m above grade, inside the 15 to
 * 48 in (0.38 to 1.22 m) reach range (2010 ADA Standards 308.2, 308.3) so a
 * driver lifts the loops off. The 7.62 m cable hangs in up to four turns,
 * each open 0.3 m at its bottom (`bottomRadiusM` 0.15 m), a hand-coiled loop
 * of a tethered Level 2 cable; the turns' drop is solved so the length is
 * kept, their bottoms at least 0.1 m above the sidewalk. The turns' legs
 * then hang almost straight, so the cable coming up from its gland reaches
 * the first turn's plane beside them (`entryPlaneWithin` 0.4 of its way up)
 * and never passes through them: with 0.6 m open turns the legs slanted
 * across the way up from the gland (owner decision 2026-11-10, layout review
 * H1; derived by a search over the bottom width, the turns and the
 * fraction, every connector and port). Four turns of the 16.1 mm cable stand
 * 0.0996 m out, inside the 4 in of ADA 307.2 (`sidewalkHookTurns`). The
 * connector docks in the front middle of the box, angled down along its
 * face (`wallBoxHolsterMount`).
 */
export const WALL_BOX_HOOK = {
  x: 0.46,
  saddleTopY: 1.2,
  turns: 4,
  bottomRadiusM: 0.15,
  entryPlaneWithin: 0.4,
} as const;

/** One port of a wall box: the box's ports and the side the port is on (one port: right, 1). */
export interface WallBoxPort {
  ports: WallBoxPorts;
  side: -1 | 1;
}

/** The one port of a one-port box: its gland and hook on the right. */
export const SINGLE_WALL_BOX_PORT: WallBoxPort = { ports: 1, side: 1 };

/**
 * The x of the J hook of `port`: the one-port box `WALL_BOX_HOOK.x` right of
 * center; a two-port box one hook on each side for the cable of the port on
 * that side, as far out as the one-port rule gives for its wider body (half
 * width 0.24 m, plate margin 0.01 m, a turn's bottom half width 0.3 m and a
 * 0.035 m gap: 0.585 m). Derived.
 */
export function wallBoxHookX(port: WallBoxPort = SINGLE_WALL_BOX_PORT): number {
  if (port.ports === 1) return WALL_BOX_HOOK.x;
  const reach = WALL_BOX_HOOK.x - AC_WALL_BOX.widthM / 2;
  return port.side * (wallBoxWidth(2) / 2 + reach);
}

/** The J hook of a cable of `cableDiameterM`: room for the coil's turns. */
export function wallBoxHookSpec(cableDiameterM: number): CableHookSpec {
  return cableHookSpec(
    turnsWidth(sidewalkHookTurns(WALL_BOX_HOOK.turns, cableDiameterM), cableDiameterM),
  );
}

/** Where the coil of `port` hangs; the hook group stands at `mount` (its rod axis on the facade). */
export function wallBoxCoilPlace(
  wallZ: number,
  cableDiameterM: number,
  port: WallBoxPort = SINGLE_WALL_BOX_PORT,
): CoilPlace & { mount: Vec3 } {
  // The cable's center line tops out at `saddleTopY`, resting on the rod.
  const mount: Vec3 = [
    wallBoxHookX(port),
    WALL_BOX_HOOK.saddleTopY - CABLE_HOOK.rodRadiusM - cableDiameterM / 2,
    wallZ,
  ];
  // The turns stack out along the hook from the facade, the cable up the box side of it.
  const place = hookCoilPlace({
    mount,
    out: [0, 0, 1],
    across: [port.side, 0, 0],
    cableDiameterM,
    cable: 'ac',
  });
  return { ...place, mount };
}

/** The cable's first run: out of the gland of `port` under the box, bent toward its hook. */
export function wallBoxGlandRun(
  wallZ: number,
  boxBottomM: number,
  cableDiameterM: number,
  port: WallBoxPort = SINGLE_WALL_BOX_PORT,
): Vec3[] {
  const gl = wallBoxGland(boxBottomM, port.ports, port.side);
  return cableOutOfGland([gl.at[0], gl.at[1], wallZ + gl.at[2]], gl.axis, cableDiameterM, [
    port.side,
    0,
    0,
  ]);
}

/**
 * Where the cable runs into the handle of `port` docked in its dock, angled
 * down along the box face (`wallBoxHolsterMount`), in the station frame.
 */
export function wallBoxDockEntry(o: {
  wallZ: number;
  boxBottomM: number;
  kind: ConnectorKind;
  port?: WallBoxPort;
}): CableEntry {
  const port = o.port ?? SINGLE_WALL_BOX_PORT;
  const dock = wallBoxHolsterMount(o.boxBottomM, port.ports, port.ports === 2 ? port.side : -1);
  const pose = holsterPose(
    { x: dock.mount.x, y: dock.mount.y, z: o.wallZ + dock.mount.z },
    dock.facing,
    dock.noseUp,
  );
  return handleCableEntry(pose.handle, pose.handleYaw, o.kind, dock.noseUp);
}

/** The idle cable of `port`: its gland, the turns over its hook, the handle in its dock. */
export function wallBoxIdleCable(o: {
  wallZ: number;
  boxBottomM: number;
  cableDiameterM: number;
  dock: { lead: Vec3; end: Vec3 };
  sidewalkY: number;
  lengthM?: number;
  port?: WallBoxPort;
}): CoilCable {
  const port = o.port ?? SINGLE_WALL_BOX_PORT;
  return coilCable({
    entry: wallBoxGlandRun(o.wallZ, o.boxBottomM, o.cableDiameterM, port),
    place: wallBoxCoilPlace(o.wallZ, o.cableDiameterM, port),
    cableDiameterM: o.cableDiameterM,
    handle: o.dock,
    floorY: o.sidewalkY + o.cableDiameterM / 2 + COIL_GROUND_CLEARANCE_M,
    lengthM: o.lengthM ?? WALL_BOX_CABLE_M,
    preferTurns: [3, 2, 4, 1].filter(
      (n) => n <= sidewalkHookTurns(WALL_BOX_HOOK.turns, o.cableDiameterM),
    ),
    entryHeading: [port.side, 0, 0],
    bottomRadiusM: WALL_BOX_HOOK.bottomRadiusM,
    entryPlaneWithin: WALL_BOX_HOOK.entryPlaneWithin,
  });
}

/**
 * The charging cable of `port` (default the one port): off its empty hook,
 * its gland to the car's port (`plugRoute`), its 7.62 m kept.
 */
export function wallBoxChargingCable(o: {
  wallZ: number;
  boxBottomM: number;
  cableDiameterM: number;
  plug: { lead: Vec3; end: Vec3 };
  car: GroundRect;
  nosePort: boolean;
  surface: SurfaceAt;
  blocked?: (p: Vec3) => boolean;
  lengthM?: number;
  port?: WallBoxPort;
}): PlugRoute {
  return plugRoute({
    from: wallBoxGlandRun(o.wallZ, o.boxBottomM, o.cableDiameterM, o.port),
    plug: o.plug,
    car: o.car,
    nosePort: o.nosePort,
    surface: o.surface,
    radiusM: o.cableDiameterM / 2,
    bendM: 6 * o.cableDiameterM,
    lengthM: o.lengthM ?? WALL_BOX_CABLE_M,
    ...(o.blocked != null ? { blocked: o.blocked } : {}),
  });
}
