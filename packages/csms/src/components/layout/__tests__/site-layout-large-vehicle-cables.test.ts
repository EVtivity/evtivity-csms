// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { INLET, inletDoorBounds } from '../site-layout-vehicle-inlet';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { freeSpotRects } from '@evtivity/lib/site-layout';
import { busArmTipX, busGroundDrape, busSideDrape } from '../site-layout-cable-large-vehicle';
import { LARGE_VEHICLE_SPECS, vehicleSize } from '../site-layout-car';
import type { CarMaterials } from '../site-layout-car-geometry';
import {
  CONNECTOR_SPECS,
  handleCableEntry,
  plugYaw,
  type ConnectorKind,
} from '../site-layout-connectors';
import { BUS_ROOF_RAILS, BUS_ROOF_Y, SEMI_PORT_BOX } from '../site-layout-large-vehicle-geometry';
import { largeVehiclePose, pantographPoint } from '../site-layout-large-vehicle-pose';
import { mcsArmCable, mcsArmChargingYaw, mcsArmPole } from '../site-layout-mcs-arm-cable';
import { cableArmOutlet } from '../site-layout-model-bus-dispenser';
import type { Vec3 } from '../site-layout-model-kit';
import {
  PANTOGRAPH_HOOD_RAIL_Y,
  createPantographHoodKit,
} from '../site-layout-model-pantograph-hood';
import {
  PANTOGRAPH_DROP,
  PANTOGRAPH_HOUSING_BOTTOM_Y,
  PANTOGRAPH_LINKAGE,
  createPantographLinkageKit,
  pantographDropFor,
} from '../site-layout-model-pantograph-pole';
import { createRoofPantographKit } from '../site-layout-model-roof-pantograph';
import { createVehicleKit } from '../site-layout-vehicle-kit';
import { boundsOf, depotMaterials } from './depot-model-helpers';

function carMaterials(): CarMaterials {
  const m = (name: string) => {
    const mat = new THREE.MeshBasicMaterial();
    mat.name = name;
    return mat;
  };
  return {
    paint: m('paint'),
    glass: m('glass'),
    tire: m('tire'),
    rim: m('rim'),
    trim: m('trim'),
    headlight: m('headlight'),
    taillight: m('taillight'),
    chargePort: m('chargePort'),
    panel: m('panel'),
  };
}

/** The smooth curve the scene draws through a route, sampled densely. */
function sample(route: readonly Vec3[]): THREE.Vector3[] {
  const curve = new THREE.CatmullRomCurve3(route.map((p) => new THREE.Vector3(...p)));
  return curve.getPoints(400);
}

const BUS_KINDS: ConnectorKind[] = ['ccs1', 'ccs2', 'nacs'];
const bus = LARGE_VEHICLE_SPECS.bus;
const busKit = createVehicleKit('bus');

/** A bus in each bay of a two-bay station, with its body box and tires in the station frame. */
function busesInBays() {
  return freeSpotRects(2, 'bus_bay').map((rect) => {
    const pose = largeVehiclePose(rect, busKit, bus.width);
    const body = {
      minX: pose.x - bus.width / 2,
      maxX: pose.x + bus.width / 2,
      minZ: pose.z,
      maxZ: pose.z + bus.length,
      topY: bus.height,
    };
    return { rect, pose, body };
  });
}

function insideBody(
  p: THREE.Vector3,
  b: { minX: number; maxX: number; minZ: number; maxZ: number; topY: number },
  r: number,
): boolean {
  return (
    p.x > b.minX - r && p.x < b.maxX + r && p.z > b.minZ - r && p.z < b.maxZ + r && p.y < b.topY + r
  );
}

/** Under a wheel: inside the tire's ground patch (track by length), at any height below the axle. */
function underWheel(p: THREE.Vector3, poseX: number, poseZ: number, r: number): boolean {
  return bus.axles.some((axle) => {
    const z = poseZ + axle.z;
    return (
      Math.abs(Math.abs(p.x - poseX) - bus.width / 2 + 0.3) < 0.35 + r &&
      Math.abs(p.z - z) < bus.wheelRadius + r &&
      p.y < bus.wheelRadius * 2
    );
  });
}

describe('bus side drape (bus dispenser)', () => {
  it('hangs the arm tip outside the bus side', () => {
    for (const { rect, body } of busesInBays()) {
      const tipX = busArmTipX((rect.minX + rect.maxX) / 2, bus.width);
      expect(tipX).toBeLessThan(body.minX - 0.25);
    }
  });

  it('runs outside the bus body, clear of the wheels and above the ground', () => {
    for (const { rect, pose, body } of busesInBays()) {
      for (const kind of BUS_KINDS) {
        const r = CONNECTOR_SPECS[kind].cableDiameterM / 2;
        const p = pose.port;
        const yaw = plugYaw(p, pose.x, false);
        const entry = handleCableEntry(p, yaw, kind);
        const outlet = cableArmOutlet({
          x: busArmTipX((rect.minX + rect.maxX) / 2, bus.width),
          z: 1.3,
        });
        const route = busSideDrape(outlet, entry);
        // The last two points run straight into the boot of the handle in the inlet.
        for (const q of sample(route.slice(0, -2))) {
          const at = q
            .toArray()
            .map((v) => v.toFixed(3))
            .join(',');
          expect(insideBody(q, body, r), `${kind} ${at}`).toBe(false);
          expect(underWheel(q, pose.x, pose.z, r), `${kind} ${at}`).toBe(false);
          expect(q.y, `${kind} ${at}`).toBeGreaterThan(r + 0.1);
        }
        // It ends in the handle, which faces into the left side.
        expect(route.at(-1)).toEqual(entry.end);
        expect(yaw).toBeCloseTo(Math.PI / 2, 6);
      }
    }
  });
});

describe('bus ground drape (standard charger in a bus bay)', () => {
  it('rests on the ground outside the bus and never runs under it', () => {
    for (const { pose, body } of busesInBays()) {
      const r = 0.022;
      const p = pose.port;
      const route = busGroundDrape([-0.19, 1.05, 0.05], [p.x, p.y, p.z], body.minX, pose.z, 0.045);
      for (const q of sample(route.slice(0, -2))) {
        const at = q
          .toArray()
          .map((v) => v.toFixed(3))
          .join(',');
        expect(insideBody(q, body, r), at).toBe(false);
        expect(underWheel(q, pose.x, pose.z, r), at).toBe(false);
        expect(q.y, at).toBeGreaterThanOrEqual(0.012 + r - 0.002);
      }
    }
  });
});

describe('pantograph contacts', () => {
  const rails = busKit.build(carMaterials()).getObjectByName(BUS_ROOF_RAILS);

  it('gives the bus a removable roof rail group standing on the roof', () => {
    expect(rails).toBeDefined();
    const b = boundsOf(rails!);
    expect(b.min.y).toBeCloseTo(BUS_ROOF_Y, 3);
    expect(b.max.y).toBeCloseTo(busKit.roofContact!.y, 3);
  });

  it('lowers the pantograph down onto the rails with no gap and no overlap', () => {
    const rect = freeSpotRects(1, 'bus_bay')[0]!;
    const pose = largeVehiclePose(rect, busKit, bus.width);
    const pt = pantographPoint(rect, busKit.roofContact!);
    // The bay's contact point is the middle of the rails of the parked bus.
    expect(pt.x).toBeCloseTo(pose.roof!.x, 6);
    expect(pt.z).toBeCloseTo(pose.roof!.z, 6);
    const link = createPantographLinkageKit(pantographDropFor(pt.y)).build(depotMaterials());
    link.position.set(pt.x, PANTOGRAPH_HOUSING_BOTTOM_Y, pt.z);
    const head = boundsOf(link);
    const railsTop = boundsOf(rails!).max.y;
    expect(head.min.y).toBeCloseTo(railsTop, 4);
    // Each contact pad lands on a rail.
    for (const x of PANTOGRAPH_LINKAGE.contactXs) expect([-0.45, -0.15, 0.15, 0.45]).toContain(x);
  });

  it('folds the idle pantograph clear of the bus roof', () => {
    const idle = createPantographLinkageKit(PANTOGRAPH_DROP.minM).build(depotMaterials());
    idle.position.y = PANTOGRAPH_HOUSING_BOTTOM_Y;
    expect(boundsOf(idle).min.y).toBeGreaterThan(bus.height + 0.5);
  });

  it('raises the bus roof pantograph from the roof to the hood rails, nothing past them', () => {
    const rise = PANTOGRAPH_HOOD_RAIL_Y - BUS_ROOF_Y;
    const roofPan = createRoofPantographKit(rise).build(depotMaterials());
    roofPan.position.y = BUS_ROOF_Y;
    const b = boundsOf(roofPan);
    expect(b.min.y).toBeCloseTo(BUS_ROOF_Y, 4);
    expect(b.max.y).toBeCloseTo(PANTOGRAPH_HOOD_RAIL_Y, 4);
    // The hood's contact rails' underside is at its origin.
    const hood = boundsOf(createPantographHoodKit(0.1).build(depotMaterials()));
    expect(hood.min.y).toBeLessThan(0);
    // Only the copper shoes reach the rail underside; the guide horns stay below it.
    const tops: number[] = [];
    roofPan.updateMatrixWorld(true);
    roofPan.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const box = new THREE.Box3().setFromObject(o);
      tops.push(box.max.y);
    });
    for (const y of tops) expect(y).toBeLessThanOrEqual(PANTOGRAPH_HOOD_RAIL_Y + 1e-6);
  });

  it('stands the roof pantograph on the bus roof surface', () => {
    const shell = busKit.build(carMaterials());
    shell.remove(shell.getObjectByName(BUS_ROOF_RAILS)!);
    shell.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(
      new THREE.Vector3(0.3, 6, busKit.roofContact!.z),
      new THREE.Vector3(0, -1, 0),
    );
    const hit = ray.intersectObject(shell, true)[0];
    expect(hit?.point.y).toBeCloseTo(BUS_ROOF_Y, 2);
  });
});

describe('MCS truck inlet', () => {
  const semi = LARGE_VEHICLE_SPECS.semi_truck;
  const kit = createVehicleKit('semi_truck');

  it('sits at a reachable height inside the charge port box', () => {
    // Above the frame rails, below the 48 in high reach (2010 ADA 308.2.1).
    expect(semi.port.y).toBeGreaterThan(1.09);
    expect(semi.port.y).toBeLessThanOrEqual(1.22);
    const box = SEMI_PORT_BOX;
    expect(semi.port.y - 0.13).toBeGreaterThan(box.centerY - box.heightM / 2);
    expect(semi.port.y + 0.18).toBeLessThan(box.centerY + box.heightM / 2);
    expect(Math.abs(semi.port.z - box.centerZ)).toBeLessThan(box.lengthM / 2 - 0.15);
    // The plug face sits in the inlet on the box face, the box on the left frame rail.
    expect(box.outerX + kit.port.x).toBeCloseTo(INLET.seatM, 9);
    const door = inletDoorBounds('mcs');
    expect(semi.port.y + door.minY).toBeGreaterThan(box.centerY - box.heightM / 2);
    expect(semi.port.y + door.maxY).toBeLessThan(box.centerY + box.heightM / 2);
    expect(door.maxX - door.minX).toBeLessThan(box.lengthM);
  });

  it('keeps the MCS arm cable outside the truck side down to the inlet', () => {
    for (const rect of freeSpotRects(2, 'truck_pull_through')) {
      const pose = largeVehiclePose(rect, kit, semi.width);
      const p = pose.port;
      const side = pose.z - vehicleSize('semi_truck').width / 2;
      const pole = mcsArmPole({ x: rect.chargerX, z: rect.chargerZ });
      const d = CONNECTOR_SPECS.mcs.cableDiameterM;
      const yaw = mcsArmChargingYaw(pole, [p.x, p.y, p.z], side - 0.25, d);
      const entry = handleCableEntry(p, 0, 'mcs');
      const route = mcsArmCable(pole, yaw, entry, 0.45, d);
      const r = d / 2;
      for (const q of sample(route.slice(0, -2))) {
        expect(q.z, q.toArray().join(',')).toBeLessThan(side - r);
        expect(q.y).toBeGreaterThan(0.45 - 0.01);
      }
      expect(route.at(-1)).toEqual(entry.end);
    }
  });
});
