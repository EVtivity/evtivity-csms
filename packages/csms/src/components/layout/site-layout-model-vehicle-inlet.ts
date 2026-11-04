// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The charge inlet of a 3D layout vehicle (car, bus, truck), built in the
// inlet frame of site-layout-vehicle-inlet.ts (the plugged handle's frame:
// the plug face at the origin facing +z into the vehicle, the body surface
// at z = -INLET.seatM). From the body out:
// - a painted housing behind the door opening, back into the body, so the
//   inlet reads as a pocket molded into the panel wherever the panel curves
//   away (the edge of a fender, a nose);
// - the dark shut line around the door opening;
// - closed (no plug): the door, flush in the opening;
// - open (plugged): the inlet face with a receptacle rim around each opening
//   (the mirror of the plug faces, `inletOpenings`), the bare openings of the
//   parts the plug leaves free (the DC openings under a Type 1 or Type 2
//   plug) with their pins, the status light ring around the filled opening,
//   the door standing open on its hinge (`INLET_DOOR_OPEN_DEG`), and on a
//   CHAdeMO car the AC inlet under its cap and the CHAdeMO cap hanging on
//   its tether.
// Merged per car material slot; the vehicle kit places the group at its port.

import * as THREE from 'three';
import type { ConnectorKind } from './site-layout-connectors';
import type { CarMaterials } from './site-layout-car-geometry';
import {
  ModelParts,
  boxG,
  cylG,
  frontProfileG,
  type ModelKit,
  type Pt,
} from './site-layout-model-kit';
import {
  INLET,
  grownOutline,
  inletDoorBounds,
  inletFaceBounds,
  inletOpenings,
  occupiedOpenings,
  type Bounds2,
  type VehicleInletKind,
} from './site-layout-vehicle-inlet';

type Slot = keyof CarMaterials;

export interface VehicleInletInput {
  kind: VehicleInletKind;
  /** The plugged connector, or null: the door is closed. */
  plug: ConnectorKind | null;
  /** The x side (inlet frame) of the door hinge and of a CHAdeMO car's AC inlet: toward the car's middle. */
  side: -1 | 1;
  /** A nose port: the door hinges on its top edge. */
  nose: boolean;
}

/** A rounded rectangle, counter clockwise, two points per corner. */
function roundRect(b: Bounds2, r: number): Pt[] {
  const c = Math.min(r, (b.maxX - b.minX) / 2, (b.maxY - b.minY) / 2);
  const k = c * (1 - Math.SQRT1_2);
  return [
    [b.minX + c, b.minY],
    [b.maxX - c, b.minY],
    [b.maxX - k, b.minY + k],
    [b.maxX, b.minY + c],
    [b.maxX, b.maxY - c],
    [b.maxX - k, b.maxY - k],
    [b.maxX - c, b.maxY],
    [b.minX + c, b.maxY],
    [b.minX + k, b.maxY - k],
    [b.minX, b.maxY - c],
    [b.minX, b.minY + c],
    [b.minX + k, b.minY + k],
  ];
}

const reversed = (p: readonly Pt[]): Pt[] => [...p].reverse();

/** A flat ring (outer minus inner) facing -z at depth z. */
function flatRing(outer: readonly Pt[], inner: readonly Pt[], z: number): THREE.BufferGeometry {
  // Built mirrored in x and turned a half turn about y, so it faces out (-z)
  // with its front side (a mirror alone would flip the winding).
  const mirror = (p: readonly Pt[]) => p.map(([x, y]) => new THREE.Vector2(-x, y));
  const s = new THREE.Shape(mirror(reversed(outer)));
  // A counter clockwise outline mirrored is clockwise: the winding of a hole.
  if (inner.length > 2) s.holes.push(new THREE.Path(mirror(inner)));
  const g = new THREE.ShapeGeometry(s, 1);
  g.rotateY(Math.PI);
  g.translate(0, 0, z);
  return g;
}

/** A front outline extruded from z = zFront back to zBack (zBack > zFront), holes clockwise. */
function slab(
  outline: readonly Pt[],
  zFront: number,
  zBack: number,
  holes: readonly (readonly Pt[])[] = [],
): THREE.BufferGeometry {
  const g = frontProfileG(outline, zBack - zFront, 0, holes);
  g.translate(0, 0, (zFront + zBack) / 2);
  return g;
}

export function createVehicleInletKit(input: VehicleInletInput): ModelKit<Slot> {
  const parts = new ModelParts<Slot>();
  const s = INLET.seatM;
  const surface = -s;
  const door = inletDoorBounds(input.kind, input.side);
  const shut = roundRect(
    {
      minX: door.minX - INLET.shutLineM,
      maxX: door.maxX + INLET.shutLineM,
      minY: door.minY - INLET.shutLineM,
      maxY: door.maxY + INLET.shutLineM,
    },
    0.022,
  );
  const doorOutline = roundRect(door, 0.02);
  // The painted housing, from just in front of the body back into it.
  parts.add('paint', slab(shut, surface - 0.0006, surface + 0.06));
  parts.add('trim', flatRing(shut, doorOutline, surface - 0.0012));

  if (input.plug == null) {
    // Closed: the door flush in its opening, 1 mm proud of the shut line.
    parts.add('paint', slab(doorOutline, surface - 0.0042, surface - 0.0012));
    return parts.kit();
  }

  const openings = inletOpenings(input.kind, input.side);
  const filled = occupiedOpenings(input.kind, input.plug);
  const ring = INLET.clearanceM + INLET.wallM;
  const faceFront = surface - INLET.faceM;
  const rimFront = faceFront - INLET.rimDepthM;
  // The dark pocket behind the inlet face, seen in the gap around it.
  parts.add(
    'tire',
    flatRing(
      doorOutline,
      roundRect(inletFaceBounds(input.kind, input.side), 0.014),
      surface - 0.0013,
    ),
  );
  // The inlet face, with a hole for every opening the plug leaves bare and its cap does not close.
  const bare = openings.filter((o, i) => filled[i] !== true && !o.capped);
  parts.add(
    'trim',
    slab(
      roundRect(inletFaceBounds(input.kind, input.side), 0.014),
      faceFront,
      surface - 0.0013,
      bare.map((o) => reversed(grownOutline(o.outline, INLET.clearanceM))),
    ),
  );
  // A receptacle rim around each opening.
  for (const o of openings) {
    parts.add(
      'trim',
      slab(grownOutline(o.outline, ring), rimFront, faceFront + 0.0005, [
        reversed(grownOutline(o.outline, INLET.clearanceM)),
      ]),
    );
  }
  // A bare opening: its dark insert at the back of the hole and a pin per contact standing out of it.
  const insertZ = surface - 0.0016;
  for (const o of bare) {
    parts.add('tire', flatRing(grownOutline(o.outline, INLET.clearanceM), [], insertZ));
    for (const c of o.contacts) {
      const r = Math.max(0.0008, c.d * 0.36);
      const length = 0.008;
      parts.add('rim', cylG(r, r, length, c.d > 0.006 ? 8 : 6), {
        at: [c.x, c.y, insertZ - length / 2],
        rot: [Math.PI / 2, 0, 0],
      });
    }
  }
  // The status light ring around the filled opening (lit while plugged in).
  const main = openings.find((_, i) => filled[i] === true);
  if (main != null) {
    parts.add(
      'chargePort',
      flatRing(
        grownOutline(main.outline, ring + 0.0045),
        grownOutline(main.outline, ring + 0.0015),
        faceFront - 0.0004,
      ),
    );
  }
  // The capped AC inlet of a CHAdeMO car: its rubber cap over the rim.
  for (const o of openings) {
    if (!o.capped) continue;
    parts.add(
      'tire',
      slab(grownOutline(o.outline, ring + 0.002), rimFront - 0.014, rimFront + 0.001),
    );
  }
  // The CHAdeMO inlet's own cap, off and hanging on its tether under the inlet face.
  if (input.kind === 'chademo_type1' || input.kind === 'chademo_type2') {
    const cap = grownOutline(openings[0]?.outline ?? [], ring + 0.002);
    const capR = Math.max(...cap.map(([, y]) => y));
    const face = inletFaceBounds(input.kind, input.side);
    const capY = face.minY - capR - 0.012;
    parts.add('tire', slab(cap, rimFront - 0.016, rimFront), { at: [0, capY, -0.004] });
    parts.add('tire', boxG(0.012, face.minY - (capY + capR) + 0.01, 0.004), {
      at: [0, (face.minY + capY + capR) / 2, rimFront - 0.006],
    });
  }
  // The door, open on its hinge: square to the body at the hinge edge.
  const w = door.maxX - door.minX;
  const h = door.maxY - door.minY;
  const t = INLET.doorThicknessM;
  const panel = slab(
    roundRect({ minX: -w / 2, maxX: w / 2, minY: -h / 2, maxY: h / 2 }, 0.02),
    -t / 2,
    t / 2,
  );
  const hingeZ = surface - 0.002;
  if (input.nose) {
    // Lifted on its top edge: the panel stands out level over the inlet.
    parts.add('paint', panel, {
      at: [(door.minX + door.maxX) / 2, door.maxY + t / 2, hingeZ - h / 2],
      rot: [Math.PI / 2, 0, 0],
    });
    parts.add('trim', boxG(0.03, 0.01, 0.024), {
      at: [(door.minX + door.maxX) / 2, door.maxY - 0.004, hingeZ - 0.01],
    });
  } else {
    const hx = input.side > 0 ? door.maxX : door.minX;
    parts.add('paint', panel, {
      at: [hx + input.side * (t / 2), (door.minY + door.maxY) / 2, hingeZ - w / 2],
      rot: [0, Math.PI / 2, 0],
    });
    parts.add('trim', boxG(0.01, 0.03, 0.024), {
      at: [hx - input.side * 0.004, (door.minY + door.maxY) / 2, hingeZ - 0.01],
    });
  }
  return parts.kit();
}
