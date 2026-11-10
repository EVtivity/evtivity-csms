// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Depot chargers of the 3D site scene: pantographs, bus and MCS dispensers and their vehicles.

import { freeSpotRects, freeSpotTypeOf, type FreeSpotRect } from '@evtivity/lib/site-layout';
import type { VehicleBodyType } from '@evtivity/lib/vehicle-appearance';
import * as THREE from 'three';
import { busArmTipX, busGroundDrape, busSideDrape } from './site-layout-cable-large-vehicle';
import { sceneCar, vehicleSize } from './site-layout-car';
import { catenaryPoints } from './site-layout-charger-cables';
import { SCENE_COLORS } from './site-layout-colors';
import { CONNECTOR_SPECS, handleCableEntry, plugYaw } from './site-layout-connectors';
import type { FreeChargerModel } from './site-layout-free';
import { BUS_ROOF_RAILS, BUS_ROOF_Y } from './site-layout-large-vehicle-geometry';
import {
  largeVehiclePose,
  pantographPoint,
  type LargeVehiclePose,
} from './site-layout-large-vehicle-pose';
import { markerY } from './site-layout-marker';
import { vehicleInletOf } from './site-layout-vehicle-inlet';
import {
  mcsArmCable,
  mcsArmChargingYaw,
  mcsArmIdleYaw,
  mcsArmPole,
} from './site-layout-mcs-arm-cable';
import {
  BUS_DISPENSER,
  BUS_DISPENSER_HOLSTERS,
  BUS_DISPENSER_RFID,
  BUS_DISPENSER_SCREEN,
  cableArmOutlet,
  createBusDispenserKit,
  type CableArmTip,
} from './site-layout-model-bus-dispenser';
import type { Vec3 } from './site-layout-model-kit';
import { createMcsArmBoomKit, createMcsArmPoleKit } from './site-layout-model-mcs-cable-arm';
import {
  MCS_DISPENSER,
  MCS_DISPENSER_HOLSTER,
  MCS_DISPENSER_RFID,
  MCS_DISPENSER_SCREEN,
  createMcsDispenserKit,
} from './site-layout-model-mcs-dispenser';
import {
  PANTOGRAPH_HOOD,
  PANTOGRAPH_HOOD_RAIL_Y,
  createPantographHoodKit,
  pantographUpBoomY,
} from './site-layout-model-pantograph-hood';
import {
  PANTOGRAPH_DROP,
  PANTOGRAPH_HOUSING_BOTTOM_Y,
  PANTOGRAPH_LINKAGE,
  PANTOGRAPH_POLE,
  PANTOGRAPH_POLE_LOGO,
  PANTOGRAPH_POLE_RFID,
  PANTOGRAPH_POLE_SCREEN,
  createPantographLinkageKit,
  createPantographPoleKit,
  pantographDropFor,
} from './site-layout-model-pantograph-pole';
import { ROOF_PANTOGRAPH, createRoofPantographKit } from './site-layout-model-roof-pantograph';
import type { DepotMaterials } from './site-layout-model-scissor';

import type { SceneSlice } from './site-layout-scene-context';
import { slotKind } from './site-layout-scene-station-slots';
import {
  AVATAR_ABOVE_ROOF_M,
  type Palette,
  type SceneStation,
  type StationMaterials,
  type StationObject,
  type Templates,
} from './site-layout-scene-types';

type LargeChargersCtx = SceneSlice<
  | 'M'
  | 'addScreenMessage'
  | 'addRfidPad'
  | 'cabinetGlow'
  | 'cable'
  | 'carKit'
  | 'chargeContactGlow'
  | 'chargeFlowPath'
  | 'chargingCable'
  | 'connectorHandle'
  | 'holsteredConnector'
  | 'logoPanel'
  | 'modelKit'
  | 'modelOf',
  'buildLargeCharger' | 'placeLargeSpotProp'
>;

export function installLargeChargers(scn: LargeChargersCtx): void {
  function vehiclePose(rect: FreeSpotRect, bodyType: VehicleBodyType): LargeVehiclePose {
    return largeVehiclePose(rect, scn.carKit(bodyType), vehicleSize(bodyType).width);
  }

  function bayPantographPoint(rect: FreeSpotRect): THREE.Vector3 {
    return pantographPoint(rect, scn.carKit('bus').roofContact ?? new THREE.Vector3(0, 3.38, 2.7));
  }

  const HOOD_Y = PANTOGRAPH_HOOD_RAIL_Y;

  // A heavy connector (MCS or high-power CCS) and its handle, facing +z.
  // The large chargers of a custom site (`FreeChargerModel`), in the station
  // frame. Truck: a megawatt dispenser on each lane island with a cable
  // management arm over the lane. Bus: a depot pantograph mast with a boom
  // over each bay (the power cabinet at its foot), or a tall dispenser with a
  // cable boom. Each has the screen (with the display message) and the
  // charging glow on its cabinet.
  function buildLargeCharger(
    g: THREE.Group,
    s: SceneStation,
    model: Exclude<FreeChargerModel, 'standard'>,
    palette: Palette,
    m: StationMaterials,
  ): { top: number; glow: StationObject['glow'] } {
    const spotType = freeSpotTypeOf(s.free);
    const rects = freeSpotRects(s.spots ?? 1, spotType);
    const mats = depotMaterials(m, palette);
    let glow: StationObject['glow'] = null;
    let top = 2.6;
    if (model === 'truck_mcs') {
      rects.forEach((r, i) => {
        // A generic megawatt (MCS) dispenser on its island facing the lane
        // (site-layout-model-mcs-dispenser.ts); its short heavy cable leaves a
        // gland low on the lane face; no overhead arm.
        const unit = scn.modelOf(
          scn.modelKit('mcs-dispenser', createMcsDispenserKit),
          'mcs-dispenser',
          mats,
        );
        unit.position.set(r.chargerX, 0, r.chargerZ);
        g.add(unit);
        scn.addRfidPad(unit, MCS_DISPENSER_RFID);
        const sc = MCS_DISPENSER_SCREEN;
        const screen: [number, number, number] = [r.chargerX + sc[0], sc[1], r.chargerZ + sc[2]];
        if (i === 0) {
          scn.addScreenMessage(g, s, 'dc', [screen[0], screen[1], screen[2] + 0.002]);
          glow = scn.cabinetGlow(g, s, screen);
        }
        g.add(scn.logoPanel('truck_mcs', palette, { x: r.chargerX, z: r.chargerZ }));
        const kind = s.connectorKinds?.[i]?.[0] ?? 'mcs';
        const d = CONNECTOR_SPECS[kind].cableDiameterM;
        const charging = s.prop === 'car' && (s.propSpot ?? 0) === i;
        const h = MCS_DISPENSER_HOLSTER;
        const end = scn.holsteredConnector(
          g,
          kind,
          { x: r.chargerX + h[0], y: h[1], z: r.chargerZ + h[2] },
          { x: 0, z: 1 },
          charging,
        );
        // The cable management arm on its pole beside the dispenser
        // (site-layout-model-mcs-cable-arm.ts). Idle, the boom stows toward the
        // holster and the cable runs from the head over the boom into the handle; while
        // charging the boom is drawn with the truck (`placeLargeSpotProp`).
        const pole = mcsArmPole({ x: r.chargerX, z: r.chargerZ });
        const poleModel = scn.modelOf(
          scn.modelKit('mcs-arm-pole', createMcsArmPoleKit),
          'mcs-arm',
          mats,
        );
        poleModel.position.set(pole[0], pole[1], pole[2]);
        g.add(poleModel);
        if (!charging) {
          const yaw = mcsArmIdleYaw(pole, end, MCS_CABLE_FLOOR_M, d);
          g.add(mcsBoom(pole, yaw, d, mats));
          g.add(
            scn.cable(
              mcsArmCable(pole, yaw, end, MCS_CABLE_FLOOR_M, d).map(
                (p) => [p[0], p[1], p[2]] as [number, number, number],
              ),
              m.rubber,
              d / 2,
            ),
          );
        }
      });
      top = markerY(MCS_DISPENSER.heightM);
    } else if (model === 'bus_dispenser') {
      // A dispenser at the head of the bays with a two-segment cable arm over
      // each bay (site-layout-model-bus-dispenser.ts); each cable hangs from
      // the balancer under its arm tip.
      const tips = rects.map((r) => busArmTip(r));
      const unit = scn.modelOf(
        scn.modelKit(`bus-dispenser:${JSON.stringify(tips)}`, () => createBusDispenserKit(tips)),
        'bus-dispenser',
        mats,
      );
      g.add(unit);
      scn.addRfidPad(g, BUS_DISPENSER_RFID);
      const sc = BUS_DISPENSER_SCREEN;
      const screen: [number, number, number] = [sc[0], sc[1], sc[2]];
      scn.addScreenMessage(g, s, 'dc', [screen[0], screen[1], screen[2] + 0.002]);
      glow = scn.cabinetGlow(g, s, screen);
      g.add(scn.logoPanel('bus_dispenser', palette));
      rects.forEach((_r, i) => {
        const tip = tips[i];
        const hp = BUS_DISPENSER_HOLSTERS[i % BUS_DISPENSER_HOLSTERS.length];
        if (tip == null || hp == null) return;
        const charging = s.prop === 'car' && (s.propSpot ?? 0) === i;
        const kind = slotKind(s, i, 0);
        const end = scn.holsteredConnector(
          g,
          kind,
          { x: hp[0], y: hp[1], z: hp[2] },
          { x: 0, z: 1 },
          charging,
        );
        if (!charging) {
          // From the balancer, one loop down in front of the cabinet, up into the handle.
          const outlet = cableArmOutlet(tip);
          const d = CONNECTOR_SPECS[kind].cableDiameterM;
          const below: [number, number, number] = [
            end.lead[0],
            end.lead[1] - 6 * d,
            end.lead[2] + 0.05,
          ];
          const loop = catenaryPoints(outlet, below, 0.4, 16);
          g.add(
            scn.cable(
              [...loop, end.lead, end.end].map(
                (p) => [p[0], p[1], p[2]] as [number, number, number],
              ),
              m.rubber,
              d / 2,
            ),
          );
        }
      });
      top = markerY(BUS_DISPENSER.armY + BUS_DISPENSER.arm.heightM / 2);
    } else {
      // A depot pantograph pole at the head of the bays (site-layout-model-pantograph-pole.ts):
      // the control module with the screen on the pole, the boom out over the
      // bays. Pantograph down: a scissor linkage over each bay, lowered onto
      // the roof rails of a bus that charges, folded up otherwise. Pantograph
      // up: a contact hood the bus roof pantograph rises into.
      const P = PANTOGRAPH_POLE;
      const points = rects.map((r) => bayPantographPoint(r));
      const reachZ = points[0]?.z ?? 3.6;
      const columnZ = reachZ - P.outreachM;
      const xs = points.map((pt) => Number(pt.x.toFixed(3)));
      // A hood pole carries its boom higher, so the hood hangs below it (pantographUpBoomY).
      const up = model === 'pantograph_up';
      const boomY = up ? pantographUpBoomY(P.boom.heightM) : P.boomY;
      const pole = scn.modelOf(
        scn.modelKit(`pantograph-pole:${model}:${xs.join(',')}`, () =>
          createPantographPoleKit({ outreachM: P.outreachM, headXs: xs, boomY, frames: !up }),
        ),
        'pantograph-pole',
        mats,
      );
      pole.position.z = columnZ;
      g.add(pole);
      const pad = PANTOGRAPH_POLE_RFID;
      scn.addRfidPad(g, [pad.x, pad.y, columnZ + pad.z]);
      const sc = PANTOGRAPH_POLE_SCREEN;
      const screen: [number, number, number] = [sc.x, sc.y, columnZ + sc.z];
      scn.addScreenMessage(g, s, 'dc', [screen[0], screen[1], screen[2] + 0.002]);
      glow = scn.cabinetGlow(g, s, screen);
      g.add(scn.logoPanel(model, palette, { x: 0, z: columnZ + PANTOGRAPH_POLE_LOGO.centerZ }));
      points.forEach((pt, i) => {
        const charging = s.prop === 'car' && (s.propSpot ?? 0) === i;
        if (model === 'pantograph_down') {
          // Lowered onto the bus roof rails while it charges, folded up otherwise.
          const drop = charging ? pantographDropFor(pt.y) : PANTOGRAPH_DROP.minM;
          const link = scn.modelOf(
            scn.modelKit(`pantograph-linkage:${drop.toFixed(3)}`, () =>
              createPantographLinkageKit(drop),
            ),
            'pantograph-linkage',
            mats,
          );
          link.position.set(pt.x, PANTOGRAPH_HOUSING_BOTTOM_Y, pt.z);
          g.add(link);
          if (charging && (s.cableFlow ?? true)) {
            // Energy runs down the linkage into the head on the roof rails, which glow.
            const headY = PANTOGRAPH_HOUSING_BOTTOM_Y - drop;
            g.add(
              scn.chargeFlowPath([
                [pt.x, PANTOGRAPH_HOUSING_BOTTOM_Y, pt.z],
                [pt.x, (PANTOGRAPH_HOUSING_BOTTOM_Y + headY) / 2, pt.z],
                [pt.x, headY, pt.z],
              ]),
              scn.chargeContactGlow([pt.x, headY, pt.z], PANTOGRAPH_LINKAGE.head.widthM / 2),
            );
          }
        } else {
          // The hood, its contact rails' underside at HOOD_Y, hung from the crossbar.
          const hanger = boomY - P.boom.heightM / 2 - (HOOD_Y + PANTOGRAPH_HOOD.topM);
          const hood = scn.modelOf(
            scn.modelKit(`pantograph-hood:${hanger.toFixed(3)}`, () =>
              createPantographHoodKit(hanger),
            ),
            'pantograph-hood',
            mats,
          );
          hood.position.set(pt.x, HOOD_Y, pt.z);
          g.add(hood);
        }
      });
      top = markerY(boomY + (P.heightM - P.boomY));
    }
    return { top, glow };
  }
  scn.buildLargeCharger = buildLargeCharger;

  // The materials of the depot charger kits for one station; without the
  // station's materials (a vehicle's roof pantograph) every painted part is steel.
  function depotMaterials(m: StationMaterials | null, palette: Palette): DepotMaterials {
    const metal = scn.M(SCENE_COLORS.galvanizedSteel, { roughness: 0.5, metalness: 0.6 });
    const rubber = m?.rubber ?? scn.M(SCENE_COLORS.rubber, { roughness: 0.9 });
    return {
      body: m?.shell ?? metal,
      plate: m?.accent ?? metal,
      trim: m?.dark ?? scn.M(SCENE_COLORS.dark1, { roughness: 0.6 }),
      metal,
      glass: m?.glass ?? scn.M(SCENE_COLORS.dark1, { roughness: 0.2 }),
      light: m?.light ?? metal,
      insulator: scn.M(SCENE_COLORS.insulator, { roughness: 0.6 }),
      copper: scn.M(SCENE_COLORS.copper, { roughness: 0.35, metalness: 0.85 }),
      rubber,
      stop: scn.M(SCENE_COLORS.emergencyStop, { roughness: 0.35 }),
      concrete: scn.M(palette.concrete, { roughness: 0.95 }),
    };
  }

  // The lowest an MCS cable hangs: 0.3 m over the 0.15 m lane island.
  const MCS_CABLE_FLOOR_M = 0.45;
  // A standard charger cable on the bay paving (0.012 m): its 0.022 m radius and room for the curve between points.
  const STANDARD_CABLE_GROUND_Y = 0.045;

  // The boom of an MCS cable arm on `pole`, turned to `yaw` (from +x toward +z).
  function mcsBoom(pole: Vec3, yaw: number, cableDiameterM: number, mats: DepotMaterials) {
    const boom = scn.modelOf(
      scn.modelKit(`mcs-arm-boom:${String(cableDiameterM)}`, () =>
        createMcsArmBoomKit(cableDiameterM),
      ),
      'mcs-arm',
      mats,
    );
    boom.position.set(pole[0], 0, pole[2]);
    // three.js turns +x toward -z for a positive angle.
    boom.rotation.y = -yaw;
    return boom;
  }

  // The arm tip of a bus dispenser over a bay: outside the left side of the
  // bus parked there (`busArmTipX`), 1.3 m into the bay.
  function busArmTip(r: FreeSpotRect): CableArmTip {
    return { x: busArmTipX((r.minX + r.maxX) / 2, vehicleSize('bus').width), z: 1.3 };
  }

  // The vehicle, sign or cone in a bus bay or a truck lane (`rect`), and the
  // charging connection: the cable from the dispenser boom down to the charge
  // inlet, a pantograph on the bus roof rails, or the cable of a standard
  // charger. Returns where a driver avatar floats (above the vehicle roof).
  function placeLargeSpotProp(
    g: THREE.Group,
    s: SceneStation,
    t: Templates,
    rect: FreeSpotRect,
    model: FreeChargerModel,
    palette: Palette,
  ): THREE.Vector3 | null {
    const truckLane = rect.heading === '+x';
    if (s.prop === 'cone') {
      const item = t.cone();
      // The templates stand 2.2 to 2.4 m into a car spot: move them into this one.
      if (truckLane) item.position.set(rect.chargerX - 2, 0, rect.minZ + 1.2 - 2.4);
      else item.position.set((rect.minX + rect.maxX) / 2, 0, 0.4);
      g.add(item);
      return null;
    }
    if (s.prop !== 'car') return null;
    // The vehicle's inlet takes the plug of a dispenser or a standard charger;
    // a pantograph bus charges on its roof with its inlet door closed.
    const plugKind =
      model === 'truck_mcs'
        ? (s.connectorKinds?.[0]?.[0] ?? 'mcs')
        : model === 'bus_dispenser'
          ? slotKind(s, s.propSpot ?? 0, 0)
          : model === 'standard'
            ? slotKind(s, 0, 0)
            : null;
    const own = s.car ?? sceneCar(null);
    const look =
      plugKind == null
        ? { ...own, plug: null }
        : { ...own, inlet: vehicleInletOf(plugKind), plug: plugKind };
    const pose = vehiclePose(rect, look.bodyType);
    const vehicle = t.vehicle(look);
    vehicle.position.set(pose.x, 0, pose.z);
    vehicle.rotation.y = pose.turn;
    g.add(vehicle);
    const rubber = scn.M(SCENE_COLORS.rubber, { roughness: 0.9 });
    const p = pose.port;
    // Out of a truck inlet on its left side (-z in a lane).
    const portOut: [number, number, number] = [p.x, p.y, p.z - 0.15];
    if (model === 'truck_mcs') {
      // The arm swings toward the inlet, its tip outside the truck's side; the
      // cable runs over the boom and down from the tip guide into the handle in the inlet.
      const kind = s.connectorKinds?.[0]?.[0] ?? 'mcs';
      const d = CONNECTOR_SPECS[kind].cableDiameterM;
      const pole = mcsArmPole({ x: rect.chargerX, z: rect.chargerZ });
      const side = pose.z - vehicleSize(look.bodyType).width / 2;
      const yaw = mcsArmChargingYaw(pole, [p.x, p.y, p.z], side - 0.25, d);
      g.add(mcsBoom(pole, yaw, d, depotMaterials(null, palette)));
      // The handle face into the inlet on the truck's left side (+z).
      const entry = handleCableEntry(p, 0, kind);
      const h = scn.connectorHandle(kind);
      h.position.copy(p);
      h.userData['plugged'] = true;
      g.add(h);
      g.add(
        scn.chargingCable(
          mcsArmCable(pole, yaw, entry, MCS_CABLE_FLOOR_M, d).map(
            (q) => [q[0], q[1], q[2]] as [number, number, number],
          ),
          rubber,
          d / 2,
          s.cableFlow ?? true,
        ),
      );
    } else if (model === 'bus_dispenser') {
      // From the spring balancer beside the bus down its outside into the
      // handle in the side inlet (`busSideDrape`).
      const kind = slotKind(s, s.propSpot ?? 0, 0);
      const yaw = plugYaw(p, pose.x, false);
      const h = scn.connectorHandle(kind);
      h.position.copy(p);
      h.rotation.y = yaw;
      h.userData['plugged'] = true;
      g.add(h);
      g.add(
        scn.chargingCable(
          busSideDrape(cableArmOutlet(busArmTip(rect)), handleCableEntry(p, yaw, kind)).map(
            (q) => [q[0], q[1], q[2]] as [number, number, number],
          ),
          rubber,
          CONNECTOR_SPECS[kind].cableDiameterM / 2,
          s.cableFlow ?? true,
        ),
      );
    } else if (model === 'pantograph_up' && pose.roof != null) {
      // The bus roof pantograph (site-layout-model-roof-pantograph.ts) on the
      // roof where the contact rails of a pantograph down bus would be (this
      // bus carries none), raised until its shoes meet the hood's contact rails.
      const rails = vehicle.getObjectByName(BUS_ROOF_RAILS);
      if (rails != null) vehicle.remove(rails);
      const rise = HOOD_Y - BUS_ROOF_Y;
      const roofPan = scn.modelOf(
        scn.modelKit(`roof-pantograph:${rise.toFixed(3)}`, () => createRoofPantographKit(rise)),
        'roof-pantograph',
        depotMaterials(null, palette),
      );
      // A part of the bus: placed in the vehicle's own frame, so it moves and hides with the bus.
      vehicle.updateMatrix();
      roofPan.position.copy(pose.roof).applyMatrix4(vehicle.matrix.clone().invert());
      roofPan.position.y = BUS_ROOF_Y;
      vehicle.add(roofPan);
      if (s.cableFlow ?? true) {
        // Energy runs from the hood rails, which glow where the shoes meet them, down the arm.
        const r = pose.roof;
        g.add(
          scn.chargeFlowPath([
            [r.x, HOOD_Y, r.z],
            [r.x, (HOOD_Y + BUS_ROOF_Y) / 2, r.z],
            [r.x, BUS_ROOF_Y, r.z],
          ]),
          scn.chargeContactGlow([r.x, HOOD_Y, r.z], ROOF_PANTOGRAPH.head.widthM / 2),
        );
      }
    } else if (model === 'standard') {
      // A standard charger at the head of the spot: down to the ground and along to the inlet.
      const start: [number, number, number] =
        s.kind === 'dc' ? [-0.42, 1.05, 0.12] : [-0.19, 1.05, 0.05];
      const route: Array<[number, number, number]> = truckLane
        ? [
            start,
            [start[0] - 0.1, 0.3, 0.35],
            [(start[0] + p.x) / 2, 0.08, (0.35 + p.z) / 2],
            [p.x - 0.35, 0.3, p.z],
            portOut,
            [p.x, p.y, p.z],
          ]
        : // Along the ground outside the vehicle's left side, never under it.
          busGroundDrape(
            start,
            [p.x, p.y, p.z],
            pose.x - vehicleSize(look.bodyType).width / 2,
            pose.z,
            STANDARD_CABLE_GROUND_Y,
          ).map((q) => [q[0], q[1], q[2]] as [number, number, number]);
      g.add(scn.chargingCable(route, rubber, undefined, s.cableFlow ?? true));
    }
    vehicle.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(vehicle);
    if (bounds.isEmpty()) return null;
    // Above the cab or the front of the body, not the middle of a long trailer.
    const front = truckLane
      ? new THREE.Vector3(pose.x - 2, bounds.max.y, pose.z)
      : new THREE.Vector3(pose.x, bounds.max.y, pose.z + 3);
    return new THREE.Vector3(front.x, front.y + AVATAR_ABOVE_ROOF_M, front.z);
  }
  scn.placeLargeSpotProp = placeLargeSpotProp;
}
