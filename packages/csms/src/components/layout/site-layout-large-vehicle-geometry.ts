// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The large vehicles of the 3D site layout, built in code to the real
// dimensions of site-layout-car.ts (LARGE_VEHICLE_SPECS): a box truck, a 12 m
// city bus and a semi truck with its 53 ft trailer. Each has a painted body
// with rounded edges and wheel arches, tinted glass, wheels with steel rims
// (dual tires on the rear axles), head and tail lights, mirrors, bumpers and
// the charge inlet on the left; the bus has the pantograph contact rails on
// its roof above the front axle.
//
// Same frame and kit as the cars (site-layout-car-geometry.ts): the nose at
// z = 0 facing -z, the body along +z, centered on x = 0, standing on y = 0;
// one merged geometry per material slot, shared by every vehicle of the type.

import * as THREE from 'three';
import {
  LARGE_VEHICLE_SPECS,
  type LargeBodyType,
  type LargeVehicleSpec,
  type ProfilePoint,
} from './site-layout-car';
import {
  extrudeProfile,
  mergeAssembly,
  roundedBox,
  tireGeometry,
  type CarKit,
  type CarMaterials,
} from './site-layout-car-geometry';
import { createBusDestinationSignKit } from './site-layout-model-bus-destination-sign';
import { createBusDoorKit } from './site-layout-model-bus-door';
import { createBusBatteryPodKit, createBusHvacKit } from './site-layout-model-bus-roof-pods';
import { createBoxRearDoorKit } from './site-layout-model-box-rear-door';
import { createTrailerRearDoorsKit } from './site-layout-model-trailer-rear-doors';
import { createTruckBatteryFairingKit } from './site-layout-model-truck-battery-fairing';
import { createTruckCabDoorKit } from './site-layout-model-truck-cab-door';
import {
  BUS_MIRROR,
  TRUCK_MIRROR_TUBE_RADIUS_M,
  busMirrorArmGeometry,
  busMirrorHead,
  mirrorTubeGeometry,
  truckMirror,
} from './site-layout-model-vehicle-mirror';

const TRUCK_TIRE_WIDTH_M = 0.3;

/**
 * The bus body roof, under the battery packs, the air conditioner and the
 * pantograph contact rails (eCitaro brochure: 3.10 m roof, 3.40 m over the
 * roof equipment).
 */
export const BUS_ROOF_Y = 3.1;

/**
 * The name of the bus's roof contact rail group (rails and feet). A bus that
 * charges through its own roof pantograph (pantograph up) carries none: the
 * scene removes the group and mounts the pantograph on the roof there.
 */
export const BUS_ROOF_RAILS = 'bus-roof-rails';
/** The gap between the two tires of a dual wheel. */
const DUAL_GAP_M = 0.04;

/**
 * A side outline with rounded corners: the points from the front bottom over
 * the top to the rear bottom (u back from the nose, v up), then the bottom
 * line at `bottom` with an arch over each axle. `radius` rounds every corner
 * of the outline (clipped to half of each edge).
 */
function sideShape(
  outline: readonly ProfilePoint[],
  bottom: number,
  arches: ReadonlyArray<{ z: number; r: number; width?: number }>,
  radius: number,
): THREE.Shape {
  const shape = new THREE.Shape();
  const pts = outline.map(([u, v]) => new THREE.Vector2(u, v));
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first == null || last == null) return shape;
  shape.moveTo(first.x, bottom);
  shape.lineTo(first.x, first.y);
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const at = pts[i];
    const next = pts[i + 1];
    if (prev == null || at == null || next == null) continue;
    const toPrev = prev.clone().sub(at);
    const toNext = next.clone().sub(at);
    const r = Math.min(radius, toPrev.length() / 2, toNext.length() / 2);
    const a = at.clone().add(toPrev.normalize().multiplyScalar(r));
    const b = at.clone().add(toNext.normalize().multiplyScalar(r));
    shape.lineTo(a.x, a.y);
    shape.quadraticCurveTo(at.x, at.y, b.x, b.y);
  }
  shape.lineTo(last.x, last.y);
  shape.lineTo(last.x, bottom);
  // Arches from the back to the front along the bottom.
  for (const arch of [...arches].sort((p, q) => q.z - p.z)) {
    const half = (arch.width ?? 0) / 2;
    const a0 = Math.asin(Math.max(-1, Math.min(1, (bottom - arch.r * 0.92) / arch.r)));
    const cy = arch.r * 0.92;
    shape.lineTo(arch.z + half + arch.r * Math.cos(a0), bottom);
    shape.absarc(arch.z + half, cy, arch.r, a0, Math.PI / 2, false);
    if (half > 0) shape.lineTo(arch.z - half, cy + arch.r);
    shape.absarc(arch.z - half, cy, arch.r, Math.PI / 2, Math.PI - a0, false);
  }
  shape.lineTo(first.x, bottom);
  return shape;
}

/** A painted body extruded across its width from a side outline. */
function body(shape: THREE.Shape, width: number, bevel: number): THREE.BufferGeometry {
  const g = extrudeProfile(shape, width, bevel, 4, 2);
  g.computeVertexNormals();
  return g;
}

interface Parts {
  /** Geometries to dispose after the merge. */
  list: THREE.BufferGeometry[];
  add: <T extends THREE.BufferGeometry>(g: T) => T;
}

function parts(): Parts {
  const list: THREE.BufferGeometry[] = [];
  return {
    list,
    add: (g) => {
      list.push(g);
      return g;
    },
  };
}

/**
 * The shared wheel geometries of a large vehicle: a truck tire, a steel disc
 * rim with a raised hub and wheel nuts, the brake drum behind it.
 */
function wheelParts(p: Parts, r: number) {
  const rimR = r * 0.56;
  return {
    tire: p.add(tireGeometry(r, TRUCK_TIRE_WIDTH_M, 18)),
    rim: p.add(new THREE.CylinderGeometry(rimR, rimR, 0.03, 18).rotateZ(Math.PI / 2)),
    rimLip: p.add(new THREE.TorusGeometry(rimR, 0.03, 6, 18).rotateY(Math.PI / 2)),
    hub: p.add(new THREE.CylinderGeometry(rimR * 0.38, rimR * 0.45, 0.12, 12).rotateZ(Math.PI / 2)),
    nut: p.add(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 6).rotateZ(Math.PI / 2)),
    drum: p.add(new THREE.CylinderGeometry(rimR * 0.8, rimR * 0.8, 0.16, 14).rotateZ(Math.PI / 2)),
    rimR,
  };
}

/** Adds the wheels of every axle: one tire a side, or two (dual) on a drive or trailer axle. */
function addWheels(
  g: THREE.Group,
  spec: LargeVehicleSpec,
  w: ReturnType<typeof wheelParts>,
  m: CarMaterials,
  trackWidth: number,
): void {
  const r = spec.wheelRadius;
  for (const axle of spec.axles) {
    for (const side of [-1, 1]) {
      const tires = axle.dual ? 2 : 1;
      // The outer face of the outer tire sits at the track edge.
      const outerX = side * (trackWidth / 2 - TRUCK_TIRE_WIDTH_M / 2);
      for (let i = 0; i < tires; i++) {
        const x = outerX - side * i * (TRUCK_TIRE_WIDTH_M + DUAL_GAP_M);
        const t = new THREE.Mesh(w.tire, m.tire);
        t.position.set(x, r, axle.z);
        g.add(t);
      }
      // The outer rim face: a dished disc, a lip, the hub and ten nuts. A
      // dual wheel shows its outer rim dished in, a single steer wheel out.
      const face = outerX + side * (TRUCK_TIRE_WIDTH_M / 2 - (axle.dual ? 0.07 : 0.04));
      const disc = new THREE.Mesh(w.rim, m.rim);
      disc.position.set(face - side * 0.02, r, axle.z);
      const lip = new THREE.Mesh(w.rimLip, m.rim);
      lip.position.set(face, r, axle.z);
      const hub = new THREE.Mesh(w.hub, m.rim);
      hub.position.set(face, r, axle.z);
      const drum = new THREE.Mesh(w.drum, m.trim);
      drum.position.set(outerX - side * (axle.dual ? 0.35 : 0.2), r, axle.z);
      g.add(disc, lip, hub, drum);
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        const nut = new THREE.Mesh(w.nut, m.trim);
        nut.position.set(
          face + side * 0.02,
          r + Math.cos(a) * w.rimR * 0.3,
          axle.z + Math.sin(a) * w.rimR * 0.3,
        );
        g.add(nut);
      }
    }
  }
}

/** A mesh of `geometry` in `material` at a position, added to the group. */
function put(
  g: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  g.add(mesh);
  return mesh;
}

/** The charge inlet on the left side: a socket housing and its status light. */
function addInlet(g: THREE.Group, p: Parts, m: CarMaterials, port: THREE.Vector3): void {
  const housing = p.add(new THREE.BoxGeometry(0.05, 0.26, 0.3));
  const light = p.add(new THREE.BoxGeometry(0.03, 0.04, 0.2));
  put(g, housing, m.trim, port.x + 0.02, port.y, port.z);
  put(g, light, m.chargePort, port.x - 0.006, port.y + 0.16, port.z);
}

// ---------------------------------------------------------------- city bus

function buildBus(): CarKit {
  const spec = LARGE_VEHICLE_SPECS.bus;
  const L = spec.length;
  const W = spec.width;
  const r = spec.wheelRadius;
  const p = parts();
  // The body roof; the battery packs and the air conditioner on it reach the
  // bus's 3.4 m.
  const roofY = BUS_ROOF_Y;
  // The low floor body: a near-vertical front with a rounded top edge, the
  // roof, a vertical back; arches over both axles.
  const shell = p.add(
    body(
      sideShape(
        [
          [0.06, 0.34],
          [0.0, 0.62],
          [0.02, 2.2],
          [0.12, roofY - 0.05],
          [0.6, roofY],
          [L - 0.5, roofY],
          [L, roofY - 0.08],
          [L, 0.34],
        ],
        0.32,
        spec.axles.map((a) => ({ z: a.z, r: r + 0.08, width: a.dual ? 0.25 : 0.05 })),
        0.35,
      ),
      W,
      0.07,
    ),
  );
  // Glass: the windscreen across the front, a window band down each side,
  // the rear window; all just proud of the body.
  const windscreen = p.add(roundedBox(W - 0.16, 1.75, 0.02, 0.06));
  const sideBand = p.add(new THREE.BoxGeometry(0.02, 1.3, L - 2.2));
  const rearWindow = p.add(roundedBox(W - 0.5, 0.75, 0.02, 0.05));
  // Black window pillars over the side band, every 1.45 m.
  const mullion = p.add(new THREE.BoxGeometry(0.03, 1.3, 0.09));
  // Doors, roof battery packs and air conditioner, destination signs.
  const door = createBusDoorKit();
  const pod = createBusBatteryPodKit();
  const hvac = createBusHvacKit();
  // The raked front face at the sign height (outline from (0.02, 2.2) to (0.12, roofY - 0.05)).
  const signs = createBusDestinationSignKit({
    length: L,
    width: W,
    frontFaceZ: 0.02 + ((2.9 - 2.2) / (roofY - 0.05 - 2.2)) * 0.1,
  });
  p.list.push(...door.geometries, ...pod.geometries, ...hvac.geometries, ...signs.geometries);
  // The roof rails merge into a group of their own (BUS_ROOF_RAILS).
  const railParts = parts();
  const rail = railParts.add(new THREE.BoxGeometry(0.06, 0.04, 1.2));
  const railFoot = railParts.add(new THREE.BoxGeometry(0.08, 0.26, 0.08));
  // Lights, the destination display, bumpers, mirrors on arms.
  const lamp = p.add(roundedBox(0.34, 0.14, 0.06, 0.04));
  const tailLamp = p.add(roundedBox(0.14, 0.6, 0.05, 0.04));
  const bumper = p.add(roundedBox(W + 0.02, 0.3, 0.16, 0.06));
  // Mirrors on curved arms from the front corners (site-layout-model-vehicle-mirror.ts).
  const mirrorArms = ([-1, 1] as const).map((side) => p.add(busMirrorArmGeometry(side, W, roofY)));
  const bh = BUS_MIRROR.head;
  const mirror = p.add(roundedBox(bh.widthM, bh.heightM, bh.depthM, 0.04));
  const wheels = wheelParts(p, r);
  const port = new THREE.Vector3(-W / 2 - 0.01, spec.port.y, spec.port.z);
  const roofContact = new THREE.Vector3(
    0,
    spec.roofContact?.y ?? roofY + 0.26,
    spec.roofContact?.z ?? 2.7,
  );

  function assemble(m: CarMaterials): THREE.Group {
    const g = new THREE.Group();
    put(g, shell, m.paint, 0, 0, 0);
    put(g, windscreen, m.glass, 0, 1.95, -0.005);
    g.add(signs.build(m));
    put(g, rearWindow, m.glass, 0, 2.45, L + 0.005);
    for (const side of [-1, 1]) {
      const x = side * (W / 2 + 0.006);
      put(g, sideBand, m.glass, x, 1.9, 1.1 + (L - 2.2) / 2);
      for (let z = 1.6; z < L - 0.8; z += 1.45) put(g, mullion, m.trim, x + side * 0.005, 1.9, z);
      put(g, lamp, m.headlight, side * (W / 2 - 0.3), 0.78, -0.02);
      put(g, tailLamp, m.taillight, side * (W / 2 - 0.12), 1.05, L + 0.01);
      // A mirror on its curved arm from the front corner above the windshield.
      const arm = mirrorArms[side < 0 ? 0 : 1];
      if (arm != null) put(g, arm, m.trim, 0, 0, 0);
      const head = busMirrorHead(side < 0 ? -1 : 1, W);
      put(g, mirror, m.trim, ...head.center);
    }
    // Doors on the right (+x): at the front and in the middle.
    for (const dz of [0.95, 6.3]) {
      const d = door.build(m);
      d.position.set(W / 2 + 0.002, 1.55, dz);
      g.add(d);
    }
    put(g, bumper, m.trim, 0, 0.45, 0.02);
    put(g, bumper, m.trim, 0, 0.45, L - 0.02);
    // Roof: two battery packs behind the rails, the air conditioner at the back.
    for (const [kit, z] of [
      [pod, 5.1],
      [pod, 8.4],
      [hvac, 10.85],
    ] as const) {
      const unit = kit.build(m);
      unit.position.set(0, roofY - 0.005, z);
      g.add(unit);
    }
    addWheels(g, spec, wheels, m, W - 0.02);
    addInlet(g, p, m, port);
    return g;
  }
  // Pantograph contact rails above the front axle: four rails along the bus
  // on feet standing on the roof, their tops at the roof contact height.
  function assembleRails(m: CarMaterials): THREE.Group {
    const g = new THREE.Group();
    for (const x of [-0.45, -0.15, 0.15, 0.45]) {
      put(g, rail, m.rim, x, roofContact.y - 0.02, roofContact.z);
      for (const dz of [-0.5, 0.5]) put(g, railFoot, m.trim, x, roofY + 0.13, roofContact.z + dz);
    }
    return g;
  }
  const merged = mergeAssembly(assemble, p.list);
  const rails = mergeAssembly(assembleRails, railParts.list);
  function build(m: CarMaterials): THREE.Group {
    const g = merged.build(m);
    const r = rails.build(m);
    r.name = BUS_ROOF_RAILS;
    g.add(r);
    return g;
  }
  return {
    bodyType: 'bus',
    build,
    port,
    roofContact,
    geometries: [...merged.geometries, ...rails.geometries],
  };
}

// ---------------------------------------------------------------- box truck

/** A conventional truck cab: the short hood, the raked windshield, the roof; returns its side outline. */
function cabOutline(
  hoodTop: number,
  windshieldBase: number,
  roof: number,
  back: number,
  hoodLength: number,
): ProfilePoint[] {
  return [
    [0.05, 0.42],
    [0.0, 0.7],
    [0.03, hoodTop - 0.12],
    [0.35, hoodTop],
    [hoodLength, windshieldBase],
    [hoodLength + 0.5, roof - 0.06],
    [hoodLength + 0.75, roof],
    [back - 0.05, roof],
    [back, roof - 0.15],
    [back, 0.75],
  ];
}

function buildBoxTruck(): CarKit {
  const spec = LARGE_VEHICLE_SPECS.box_truck;
  const L = spec.length;
  const W = spec.width;
  const cabW = 2.42;
  const r = spec.wheelRadius;
  const p = parts();
  const hoodLength = 1.3;
  const cabBack = 2.69;
  const roof = 2.6;
  const front = spec.axles[0]?.z ?? 0.95;
  const cab = p.add(
    body(
      sideShape(
        cabOutline(1.55, 1.65, roof, cabBack, hoodLength),
        0.5,
        [{ z: front, r: r + 0.08 }],
        0.2,
      ),
      cabW,
      0.12,
    ),
  );
  // The windshield and the door windows.
  const windshield = p.add(roundedBox(cabW - 0.24, 0.02, 1.05, 0.05));
  const sideWindow = p.add(new THREE.BoxGeometry(0.02, 0.62, 0.85));
  // The box: floor at the deck height, the roof at the full height.
  const boxFront = 2.77;
  const deck = 1.2;
  const box = p.add(roundedBox(W, spec.height - deck, L - boxFront, 0.06));
  const post = p.add(new THREE.BoxGeometry(0.03, spec.height - deck - 0.1, 0.06));
  const rubRail = p.add(new THREE.BoxGeometry(0.04, 0.08, L - boxFront));
  // Chassis: the frame rails, the battery packs between the axles, the rear underride bar.
  const frame = p.add(new THREE.BoxGeometry(0.12, 0.25, L - cabBack));
  const batteries = createTruckBatteryFairingKit({
    outerX: 1.24,
    packDepth: 0.5,
    centerY: 0.8,
    centerZ: 4.9,
    length: 2.6,
    height: 0.6,
  });
  // The cab door behind the front wheel arch, under the side window (1.725 to 2.575 m).
  const cabDoor = createTruckCabDoorKit({
    halfWidth: cabW / 2,
    front: 1.7,
    rear: cabBack - 0.07,
    bottom: 0.62,
    top: 2.48,
    windowBottom: 1.81,
    steps: [0.42],
  });
  const rearDoor = createBoxRearDoorKit({ width: W, deck, height: spec.height, rearZ: L });
  p.list.push(...batteries.geometries, ...cabDoor.geometries, ...rearDoor.geometries);
  const underride = p.add(new THREE.BoxGeometry(W - 0.3, 0.12, 0.12));
  const bumper = p.add(roundedBox(cabW + 0.06, 0.28, 0.2, 0.06));
  const grille = p.add(roundedBox(1.0, 0.55, 0.04, 0.04));
  const lamp = p.add(roundedBox(0.3, 0.14, 0.06, 0.04));
  const tailLamp = p.add(roundedBox(0.2, 0.12, 0.04, 0.03));
  const mirror = p.add(roundedBox(0.08, 0.45, 0.2, 0.03));
  // Mirrors on door frame brackets, 0.6 m behind the hood line: behind the
  // windshield's rounded edge at the bracket heights (site-layout-model-vehicle-mirror.ts).
  const mirrors = ([-1, 1] as const).map((side) =>
    truckMirror(side, cabW / 2, {
      y: 2.2,
      z: hoodLength + 0.6,
      headOutM: 0.24,
      head: [0.08, 0.45, 0.2],
    }),
  );
  const mirrorTubes = mirrors.flatMap((mm) =>
    mm.tubes.map((t) => p.add(mirrorTubeGeometry(t.from, t.to, TRUCK_MIRROR_TUBE_RADIUS_M))),
  );
  const wheels = wheelParts(p, r);
  const port = new THREE.Vector3(-1.21, spec.port.y, spec.port.z);
  const windshieldAt = new THREE.Vector3(0, (1.65 + roof) / 2 + 0.01, hoodLength + 0.27);
  const windshieldTilt = Math.atan2(0.55, roof - 1.65);

  function assemble(m: CarMaterials): THREE.Group {
    const g = new THREE.Group();
    put(g, cab, m.paint, 0, 0, 0);
    const ws = put(g, windshield, m.glass, 0, windshieldAt.y, windshieldAt.z);
    ws.rotation.x = windshieldTilt - Math.PI / 2;
    put(g, box, m.paint, 0, deck + (spec.height - deck) / 2, boxFront + (L - boxFront) / 2);
    put(g, grille, m.trim, 0, 1.0, -0.02);
    put(g, bumper, m.trim, 0, 0.55, 0.0);
    for (const side of [-1, 1]) {
      put(g, sideWindow, m.glass, side * (cabW / 2 + 0.005), 2.12, hoodLength + 0.85);
      put(g, lamp, m.headlight, side * (cabW / 2 - 0.3), 1.25, -0.01);
      put(g, tailLamp, m.taillight, side * (W / 2 - 0.2), 1.05, L + 0.01);
      const mm = mirrors[side < 0 ? 0 : 1];
      if (mm != null) put(g, mirror, m.trim, ...mm.head.center);
      put(g, frame, m.trim, side * 0.45, 0.8, cabBack + (L - cabBack) / 2);
      put(g, rubRail, m.trim, side * (W / 2 + 0.015), deck + 0.06, boxFront + (L - boxFront) / 2);
      for (let z = boxFront + 0.6; z < L - 0.2; z += 1.1) {
        put(g, post, m.trim, side * (W / 2 + 0.012), deck + (spec.height - deck) / 2, z);
      }
    }
    for (const tube of mirrorTubes) put(g, tube, m.trim, 0, 0, 0);
    g.add(batteries.build(m), cabDoor.build(m), rearDoor.build(m));
    put(g, underride, m.trim, 0, 0.5, L - 0.1);
    addWheels(g, spec, wheels, m, 2.36);
    addInlet(g, p, m, port);
    return g;
  }
  const { build, geometries } = mergeAssembly(assemble, p.list);
  return { bodyType: 'box_truck', build, port, geometries };
}

// ---------------------------------------------------------------- semi truck

/**
 * The semi's charge port box, in the vehicle frame: from the left frame rail
 * (its outer face at 0.52 m) out to 1.29 m, just inside the 1.33 m battery
 * fairing face, and between the cab (2.95 m) and the fairing (3.6 m) along
 * the truck. Its 0.5 m height around the 1.18 m inlet center keeps the socket
 * and its status light inside it. Derived from the semi's own dimensions.
 */
export const SEMI_PORT_BOX = {
  innerX: 0.52,
  outerX: 1.29,
  centerY: 1.2,
  heightM: 0.5,
  centerZ: 3.275,
  lengthM: 0.55,
} as const;

function buildSemiTruck(): CarKit {
  const spec = LARGE_VEHICLE_SPECS.semi_truck;
  const L = spec.length;
  const W = spec.width;
  const cabW = 2.5;
  const r = spec.wheelRadius;
  const p = parts();
  const hoodLength = 1.5;
  // Bumper to back of cab 116 in, the cab roof at 2.95 m and the roof
  // deflector up to 4.0 m, just under the trailer (eCascadia day cab).
  const cabBack = 2.95;
  const steer = spec.axles[0]?.z ?? 1.45;
  const cab = p.add(
    body(
      sideShape(
        [
          [0.06, 0.5],
          [0.0, 0.78],
          [0.05, 1.3],
          [0.75, 1.6],
          [hoodLength, 1.85],
          [hoodLength + 0.45, 2.85],
          [hoodLength + 0.7, 2.95],
          [hoodLength + 0.9, 3.15],
          [cabBack - 0.15, 3.92],
          [cabBack, 4.0],
          [cabBack, 1.0],
        ],
        0.55,
        [{ z: steer, r: r + 0.09 }],
        0.3,
      ),
      cabW,
      0.16,
    ),
  );
  const windshield = p.add(roundedBox(cabW - 0.3, 0.02, 1.05, 0.06));
  const sideWindow = p.add(new THREE.BoxGeometry(0.02, 0.6, 0.75));
  // Side fairings over the battery packs between the charge inlet and the
  // drive axles.
  const batteries = createTruckBatteryFairingKit({
    outerX: cabW / 2 + 0.08,
    packDepth: 0.7,
    centerY: 0.95,
    centerZ: 4.3,
    length: 1.4,
    height: 0.85,
  });
  // The cab door behind the steer axle arch (to 2.06 m), under the side window (1.925 to 2.675 m).
  const cabDoor = createTruckCabDoorKit({
    halfWidth: cabW / 2,
    front: 2.12,
    rear: cabBack - 0.08,
    bottom: 0.72,
    top: 2.88,
    windowBottom: 2.2,
    steps: [0.45],
  });
  const frame = p.add(new THREE.BoxGeometry(0.14, 0.28, 4.8));
  // The charge port box on the left frame rail between the back of the cab
  // and the battery fairing, the inlet in a dark bezel on its outer face.
  const portBox = SEMI_PORT_BOX;
  const portBoxShell = p.add(
    roundedBox(portBox.outerX - portBox.innerX, portBox.heightM, portBox.lengthM, 0.04),
  );
  const portBezel = p.add(roundedBox(0.02, 0.36, 0.42, 0.015));
  const portDrip = p.add(new THREE.BoxGeometry(0.06, 0.02, portBox.lengthM - 0.04));
  const fifthWheel = p.add(new THREE.CylinderGeometry(0.45, 0.45, 0.12, 18));
  const mudflap = p.add(new THREE.BoxGeometry(0.4, 0.6, 0.02));
  const bumper = p.add(roundedBox(cabW + 0.04, 0.35, 0.25, 0.08));
  const grille = p.add(roundedBox(1.1, 0.55, 0.04, 0.05));
  const lamp = p.add(roundedBox(0.36, 0.12, 0.08, 0.04));
  const mirror = p.add(roundedBox(0.08, 0.5, 0.22, 0.03));
  // Mirrors on door frame brackets, 0.5 m behind the hood line: behind the
  // windshield's rounded edge at the bracket heights (site-layout-model-vehicle-mirror.ts).
  const mirrors = ([-1, 1] as const).map((side) =>
    truckMirror(side, cabW / 2, {
      y: 2.35,
      z: hoodLength + 0.5,
      headOutM: 0.26,
      head: [0.08, 0.5, 0.22],
    }),
  );
  const mirrorTubes = mirrors.flatMap((mm) =>
    mm.tubes.map((t) => p.add(mirrorTubeGeometry(t.from, t.to, TRUCK_MIRROR_TUBE_RADIUS_M))),
  );
  // The 53 ft dry van trailer: a white box on its floor, corner posts, a
  // bottom rail, side skirts, landing gear legs, rear doors with lock bars.
  // The kingpin 36 in behind the trailer front, on the fifth wheel.
  const fifthWheelZ = 6.0;
  const trailerFront = fifthWheelZ - 0.91;
  const floor = 1.25;
  const trailerLength = L - trailerFront;
  const van = p.add(roundedBox(W, spec.height - floor, trailerLength, 0.05));
  const cornerPost = p.add(new THREE.BoxGeometry(0.08, spec.height - floor, 0.08));
  const bottomRail = p.add(new THREE.BoxGeometry(0.05, 0.16, trailerLength));
  const roofRail = p.add(new THREE.BoxGeometry(0.04, 0.06, trailerLength));
  const logisticPost = p.add(new THREE.BoxGeometry(0.02, spec.height - floor - 0.25, 0.04));
  const skirt = p.add(new THREE.BoxGeometry(0.03, 0.6, 7.4));
  const leg = p.add(new THREE.BoxGeometry(0.12, floor - 0.1, 0.12));
  const foot = p.add(new THREE.BoxGeometry(0.3, 0.05, 0.3));
  const rearDoors = createTrailerRearDoorsKit({
    width: W,
    floor,
    height: spec.height,
    rearZ: L,
  });
  p.list.push(...batteries.geometries, ...cabDoor.geometries, ...rearDoors.geometries);
  const underride = p.add(new THREE.BoxGeometry(W - 0.3, 0.12, 0.12));
  const tailLamp = p.add(roundedBox(0.22, 0.12, 0.04, 0.03));
  const wheels = wheelParts(p, r);
  const port = new THREE.Vector3(-cabW / 2 - 0.08, spec.port.y, spec.port.z);
  const windshieldTilt = Math.atan2(0.45, 2.85 - 1.85);

  function assemble(m: CarMaterials): THREE.Group {
    const g = new THREE.Group();
    put(g, cab, m.paint, 0, 0, 0);
    const ws = put(g, windshield, m.glass, 0, (1.85 + 2.85) / 2 + 0.01, hoodLength + 0.23);
    ws.rotation.x = windshieldTilt - Math.PI / 2;
    put(g, grille, m.trim, 0, 1.05, -0.02);
    put(g, bumper, m.trim, 0, 0.62, 0.02);
    put(g, fifthWheel, m.trim, 0, 1.22, fifthWheelZ);
    const boxX = -(portBox.innerX + portBox.outerX) / 2;
    put(g, portBoxShell, m.paint, boxX, portBox.centerY, portBox.centerZ);
    put(g, portBezel, m.trim, -portBox.outerX - 0.005, port.y, port.z);
    put(
      g,
      portDrip,
      m.trim,
      -portBox.outerX + 0.02,
      portBox.centerY + portBox.heightM / 2 + 0.01,
      portBox.centerZ,
    );
    for (const tube of mirrorTubes) put(g, tube, m.trim, 0, 0, 0);
    for (const side of [-1, 1]) {
      put(g, sideWindow, m.glass, side * (cabW / 2 + 0.005), 2.5, hoodLength + 0.8);
      put(g, lamp, m.headlight, side * (cabW / 2 - 0.32), 1.2, 0.02);
      const mm = mirrors[side < 0 ? 0 : 1];
      if (mm != null) put(g, mirror, m.trim, ...mm.head.center);
      put(g, frame, m.trim, side * 0.45, 0.95, 5.35);
      put(g, mudflap, m.trim, side * 1.05, 0.55, 7.55);
      // Trailer posts, rails, skirts and lights.
      const x = side * (W / 2 + 0.01);
      put(
        g,
        cornerPost,
        m.trim,
        side * (W / 2 - 0.03),
        floor + (spec.height - floor) / 2,
        trailerFront + 0.04,
      );
      put(
        g,
        cornerPost,
        m.trim,
        side * (W / 2 - 0.03),
        floor + (spec.height - floor) / 2,
        L - 0.04,
      );
      put(g, bottomRail, m.trim, x + side * 0.01, floor + 0.08, trailerFront + trailerLength / 2);
      put(g, roofRail, m.trim, x, spec.height - 0.03, trailerFront + trailerLength / 2);
      for (let z = trailerFront + 1.2; z < L - 0.6; z += 1.2) {
        put(g, logisticPost, m.panel, x, floor + (spec.height - floor) / 2, z);
      }
      put(g, skirt, m.panel, side * (W / 2 - 0.05), floor - 0.3, 12.4);
      put(g, leg, m.trim, side * 0.75, (floor - 0.1) / 2 + 0.05, 8.0);
      put(g, foot, m.trim, side * 0.75, 0.025, 8.0);
      put(g, tailLamp, m.taillight, side * (W / 2 - 0.25), floor + 0.25, L + 0.02);
    }
    put(g, van, m.panel, 0, floor + (spec.height - floor) / 2, trailerFront + trailerLength / 2);
    g.add(batteries.build(m), cabDoor.build(m), rearDoors.build(m));
    put(g, underride, m.trim, 0, 0.55, L - 0.3);
    addWheels(g, spec, wheels, m, 2.5);
    addInlet(g, p, m, port);
    return g;
  }
  const { build, geometries } = mergeAssembly(assemble, p.list);
  return { bodyType: 'semi_truck', build, port, geometries };
}

/** The kit of one large body type. */
export function createLargeVehicleKit(bodyType: LargeBodyType): CarKit {
  if (bodyType === 'bus') return buildBus();
  if (bodyType === 'box_truck') return buildBoxTruck();
  return buildSemiTruck();
}
