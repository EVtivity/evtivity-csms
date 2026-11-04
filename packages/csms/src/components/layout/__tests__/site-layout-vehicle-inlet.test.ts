// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { VEHICLE_BODY_TYPES } from '@evtivity/lib/vehicle-appearance';
import { CAR_PORTS, carPortLocal, type CarPort } from '../site-layout-cable';
import { CAR_BODY_TYPES, CAR_PROFILES, isLargeBodyType, sceneCar } from '../site-layout-car';
import { inletMiddleSide, type CarMaterials } from '../site-layout-car-geometry';
import { faceOutline, CONNECTOR_SPECS, type ConnectorKind } from '../site-layout-connectors';
import { bodyTopAt } from '../site-layout-model-car-doors';
import { createVehicleInletKit } from '../site-layout-model-vehicle-inlet';
import { withVehicleInlet } from '../site-layout-scene-station-slots';
import {
  INLET,
  VEHICLE_INLET_KINDS,
  inletDoorBounds,
  inletOpenings,
  occupiedOpenings,
  plugFitsInlet,
  plugSeated,
  seatOutlines,
  vehicleInletOf,
  type VehicleInletKind,
} from '../site-layout-vehicle-inlet';
import { createVehicleKit } from '../site-layout-vehicle-kit';
import { kitBounds } from './vehicle-detail-bounds';

const PLUGS: readonly ConnectorKind[] = [
  'type1',
  'type2',
  'ccs1',
  'ccs2',
  'chademo',
  'nacs',
  'mcs',
];

function materials(): CarMaterials {
  const m = (name: string) => new THREE.MeshBasicMaterial({ name });
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

function triangles(g: THREE.Object3D): number {
  let n = 0;
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const geo = o.geometry as THREE.BufferGeometry;
      n += (geo.index?.count ?? geo.getAttribute('position').count) / 3;
    }
  });
  return n;
}

describe('the vehicle inlet for a plug', () => {
  it('gives each plug the inlet of its family, the way cars are built', () => {
    // A Type 1 plug goes into the AC part of a CCS1 inlet, a Type 2 into a CCS2 inlet.
    expect(vehicleInletOf('type1')).toBe('ccs1');
    expect(vehicleInletOf('ccs1')).toBe('ccs1');
    expect(vehicleInletOf('type2')).toBe('ccs2');
    expect(vehicleInletOf('ccs2')).toBe('ccs2');
    expect(vehicleInletOf('nacs')).toBe('nacs');
    expect(vehicleInletOf('mcs')).toBe('mcs');
    // A CHAdeMO car: CHAdeMO plus a Type 1 AC inlet, Type 2 at a European site.
    expect(vehicleInletOf('chademo')).toBe('chademo_type1');
    expect(vehicleInletOf('chademo', ['ccs1', 'chademo', 'type1'])).toBe('chademo_type1');
    expect(vehicleInletOf('chademo', ['ccs2', 'chademo'])).toBe('chademo_type2');
    expect(vehicleInletOf('chademo', ['type2'])).toBe('chademo_type2');
  });

  it('keeps one inlet per car family between an AC and a DC session', () => {
    expect(vehicleInletOf('type1')).toBe(vehicleInletOf('ccs1'));
    expect(vehicleInletOf('type2')).toBe(vehicleInletOf('ccs2'));
    for (const plug of PLUGS) {
      const inlet = vehicleInletOf(plug);
      expect(plugFitsInlet(inlet, plug), `${inlet} ${plug}`).toBe(true);
    }
    expect(plugFitsInlet('ccs1', 'type2')).toBe(false);
    expect(plugFitsInlet('chademo_type1', 'type1')).toBe(false);
  });

  it('fills the AC part of a combo inlet with an AC plug and both parts with a combo plug', () => {
    expect(inletOpenings('ccs1').map((o) => o.part)).toEqual(['ac', 'dc']);
    expect(occupiedOpenings('ccs1', 'type1')).toEqual([true, false]);
    expect(occupiedOpenings('ccs1', 'ccs1')).toEqual([true, true]);
    expect(occupiedOpenings('ccs2', 'type2')).toEqual([true, false]);
    expect(occupiedOpenings('ccs2', 'ccs2')).toEqual([true, true]);
    // The bare DC part of a CCS1 inlet under a Type 1 plug carries its two DC pins.
    expect(inletOpenings('ccs1')[1]?.contacts.map((c) => c.role)).toEqual(['dc', 'dc']);
    // A CHAdeMO car's AC inlet beside the CHAdeMO inlet, under its cap.
    const pair = inletOpenings('chademo_type2', 1);
    expect(pair.map((o) => [o.part, o.capped])).toEqual([
      ['whole', false],
      ['ac', true],
    ]);
    expect(Math.min(...(pair[1]?.outline.map((p) => p[0]) ?? [0]))).toBeGreaterThan(
      Math.max(...(pair[0]?.outline.map((p) => p[0]) ?? [0])),
    );
    expect(occupiedOpenings('chademo_type1', 'chademo')).toEqual([true, false]);
    expect(occupiedOpenings('nacs', null)).toEqual([false]);
  });

  it('seats every plug face inside its inlet receptacle', () => {
    for (const plug of PLUGS) {
      const inlet = vehicleInletOf(plug);
      expect(plugSeated(inlet, plug), `${inlet} ${plug}`).toBe(true);
      // The receptacle is no wider than the plug plus the clearance.
      const plugW = Math.max(...faceOutline(CONNECTOR_SPECS[plug]).map((p) => Math.abs(p[0])));
      const seatW = Math.max(
        ...seatOutlines(inlet, plug)
          .flat()
          .map((p) => Math.abs(p[0])),
      );
      expect(seatW - plugW, `${inlet} ${plug}`).toBeLessThan(INLET.clearanceM * 2.5);
    }
    // A Type 2 face does not fit the J1772 opening of a CCS1 inlet.
    expect(plugSeated('ccs1', 'type2')).toBe(false);
  });
});

describe('the vehicle inlet model', () => {
  it('closes the door without a plug and opens it square to the body with one', () => {
    for (const kind of VEHICLE_INLET_KINDS) {
      const closed = createVehicleInletKit({ kind, plug: null, side: 1, nose: false });
      const b = kitBounds(closed);
      // Flush: nothing more than 5 mm out of the body surface (z = -seatM).
      expect(b.min.z, kind).toBeGreaterThan(-INLET.seatM - 0.005);
      expect(closed.slotTriangles.chargePort, kind).toBeUndefined();
      const plug = kind.startsWith('chademo') ? 'chademo' : (kind as ConnectorKind);
      const open = createVehicleInletKit({ kind, plug, side: 1, nose: false });
      const door = inletDoorBounds(kind, 1);
      const o = kitBounds(open);
      // The open door stands out by its own width, at the hinge edge on the +x side.
      expect(-INLET.seatM - o.min.z, kind).toBeGreaterThan(door.maxX - door.minX);
      expect(o.max.x, kind).toBeGreaterThan(door.maxX);
      expect(open.slotTriangles.chargePort, kind).toBeGreaterThan(0);
      // The nose door lifts on its top edge.
      const nose = kitBounds(createVehicleInletKit({ kind, plug, side: 1, nose: true }));
      expect(nose.max.y, kind).toBeGreaterThan(door.maxY);
    }
  });

  it('shows the bare DC pins under an AC plug only', () => {
    const ac = createVehicleInletKit({ kind: 'ccs1', plug: 'type1', side: 1, nose: false });
    const dc = createVehicleInletKit({ kind: 'ccs1', plug: 'ccs1', side: 1, nose: false });
    expect(ac.slotTriangles.rim ?? 0).toBeGreaterThan(0);
    expect(dc.slotTriangles.rim ?? 0).toBe(0);
  });

  it('keeps every vehicle with every inlet within its triangle budget', () => {
    for (const bodyType of VEHICLE_BODY_TYPES) {
      const inlets: VehicleInletKind[] = isLargeBodyType(bodyType)
        ? ['ccs1', 'ccs2', 'mcs']
        : ['ccs1', 'ccs2', 'nacs', 'chademo_type1', 'chademo_type2'];
      for (const inlet of inlets) {
        for (const plug of [undefined, null] as const) {
          const port: CarPort = inlet.startsWith('chademo') ? 'front_center' : 'front_left';
          const n = triangles(createVehicleKit(bodyType, port, inlet, plug).build(materials()));
          expect(n, `${bodyType} ${inlet}`).toBeLessThan(isLargeBodyType(bodyType) ? 16000 : 9000);
        }
      }
    }
  });
});

describe('the inlet at every port position', () => {
  it('hinges the door toward the middle of the car', () => {
    expect(inletMiddleSide('front_left')).toBe(-1);
    expect(inletMiddleSide('front_right')).toBe(1);
    expect(inletMiddleSide('rear_left')).toBe(1);
    expect(inletMiddleSide('rear_right')).toBe(-1);
    expect(inletMiddleSide('front_center')).toBe(1);
  });

  it('puts the inlet at the port, on the body, clear of the wheel arch and the fender edge', () => {
    for (const bodyType of CAR_BODY_TYPES) {
      const p = CAR_PROFILES[bodyType];
      for (const port of CAR_PORTS) {
        const at = carPortLocal(p, port);
        const kit = createVehicleKit(bodyType, port, 'ccs1', 'type1');
        expect(kit.port.toArray(), `${bodyType} ${port}`).toEqual([at.x, at.y, at.z]);
        if (port === 'front_center') {
          expect(at.x).toBe(0);
          // The nose inlet over the grille (0.18 m above the bumper bottom), under the
          // headlights, the plug face just behind the nose front.
          const door = inletDoorBounds('chademo_type2');
          expect(at.y + door.minY, bodyType).toBeGreaterThan((p.body[0]?.[1] ?? 0) + 0.18);
          expect(at.y + door.maxY, bodyType).toBeLessThan(p.head[1] - 0.045);
          expect(at.z, bodyType).toBeGreaterThanOrEqual(INLET.seatM);
          expect(at.z, bodyType).toBeLessThan(0.1);
          continue;
        }
        expect(Math.abs(at.x)).toBeCloseTo(p.width / 2 - INLET.seatM, 9);
        if (bodyType === 'hatchback') continue;
        // Every side inlet's door opening under the fender top's rounding.
        for (const kind of ['ccs1', 'ccs2', 'nacs'] as const) {
          const door = inletDoorBounds(kind, inletMiddleSide(port));
          expect(at.y + door.maxY, `${bodyType} ${port} ${kind}`).toBeLessThan(
            bodyTopAt(p, at.z) - 0.04,
          );
        }
      }
    }
  });

  it('charges a CHAdeMO car at its nose and keeps other cars at their port', () => {
    const car = { ...sceneCar(null), port: 'rear_left' as const };
    expect(withVehicleInlet(car, 'chademo').port).toBe('front_center');
    expect(withVehicleInlet(car, 'chademo').inlet).toBe('chademo_type1');
    expect(withVehicleInlet(car, 'type1')).toMatchObject({
      port: 'rear_left',
      inlet: 'ccs1',
      plug: 'type1',
    });
    const bus = { ...sceneCar(null, 'bus'), port: 'rear_left' as const };
    expect(withVehicleInlet(bus, 'chademo').port).toBe('rear_left');
  });

  it('builds the inlet into the car with its door open at every port', () => {
    for (const port of CAR_PORTS) {
      const kit = createVehicleKit('sedan', port, 'nacs', 'nacs');
      const car = kit.build(materials());
      car.updateMatrixWorld(true);
      const light = car.children.find(
        (o) => o instanceof THREE.Mesh && (o.material as THREE.Material).name === 'chargePort',
      ) as THREE.Mesh | undefined;
      expect(light, port).toBeDefined();
      const b = new THREE.Box3().setFromObject(light!);
      const c = b.getCenter(new THREE.Vector3());
      // The status light ring sits around the plug, at the port.
      expect(c.distanceTo(kit.port), port).toBeLessThan(0.06);
    }
  });
});
