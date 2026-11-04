// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Props built once per rebuild and cloned per station: vehicles, cables, signs, equipment.

import { EV_SIGNS } from '@evtivity/lib/site-layout';
import type { VehicleBodyType } from '@evtivity/lib/vehicle-appearance';
import * as THREE from 'three';
import { carPortInStation, parksBackedIn, type Point3 } from './site-layout-cable';
import { plugRoute } from './site-layout-cable-rest';
import {
  SURFACE_M,
  cableBlocked,
  carToStation,
  curbsideSurface,
  officeRowSurface,
  tireFootprints,
} from './site-layout-cable-surface';
import { CAR_PROFILES, isLargeBodyType, vehicleSize, type CarBodyType } from './site-layout-car';
import { AC_CABLE_M, DC_CABLE_M, acGlandOut, dcGlandOut } from './site-layout-charger-cables';
import { SCENE_COLORS } from './site-layout-colors';
import {
  CONNECTOR_SPECS,
  handleCableEntry,
  plugYaw,
  type CableEntry,
} from './site-layout-connectors';
import { curbChargingRoute, parallelPlace, parallelPort } from './site-layout-curb-cable';
import { DC_BOLLARD } from './site-layout-dc-bollards';
import { CURB_POST_BACK_M, wallBoxOffset } from './site-layout-grid';
import { EQUIPMENT_BOLLARD } from './site-layout-links';
import { WALL_BOX_BOTTOM_M } from './site-layout-marker';
import { CABLE_MIN_BEND_RATIO } from './site-layout-model-cable-gland';
import { createContactlessReaderKit } from './site-layout-model-reader-contactless';
import { createBatteryCabinetKit } from './site-layout-model-battery';
import type { PanelLabelSpot } from './site-layout-model-nema3r-enclosure';
import { createPowerCabinetKit } from './site-layout-model-power-cabinet';
import type { PowerSlot } from './site-layout-model-power-slots';
import { createRackPanelboardKit } from './site-layout-model-rack-panelboard';
import { createOutdoorSwitchboardKit } from './site-layout-model-switchboard';
import { createPadMountTransformerKit } from './site-layout-model-transformer';
import { createDryTransformerKit, dryTransformerSize } from './site-layout-model-dry-transformer';
import { createWallPanelboardKit } from './site-layout-model-wall-panelboard';
import { createScreenReaderKit } from './site-layout-model-reader-screen';
import { createSiteWheelStopKit } from './site-layout-model-wheel-stop';
import { signSupport, type StationSigns } from './site-layout-signs';
import { wallBoxChargingCable } from './site-layout-wall-box-cable';

import type { SceneSlice } from './site-layout-scene-context';
import { carLookPort, inletKey } from './site-layout-scene-station-slots';
import type { Palette, Templates } from './site-layout-scene-types';

type TemplatesCtx = SceneSlice<
  | 'M'
  | 'box'
  | 'cableGround'
  | 'carKit'
  | 'chargingCable'
  | 'connectorHandle'
  | 'evSignTexture'
  | 'modelKit'
  | 'modelOf'
  | 'shadowed'
  | 'theme'
  | 'track'
  | 'warningTexture',
  'templates'
>;

export function installTemplates(scn: TemplatesCtx): void {
  // Fixed per kit; each kit is built once for the scene's life.
  let cabinetLabel: PanelLabelSpot | null = null;
  let rackLabel: PanelLabelSpot | null = null;
  let wallLabel: PanelLabelSpot | null = null;
  function templates(palette: Palette): Templates {
    const cache = new Map<string, THREE.Object3D>();
    const once = <T extends THREE.Object3D>(key: string, make: () => T): T => {
      let item = cache.get(key);
      if (item == null) {
        item = make();
        cache.set(key, item);
      }
      return item.clone() as T;
    };
    // Built for each station, never shared: a charging cable rests on the ground
    // under its own station (`cableGround`), which differs from station to station.
    const perStation = <T extends THREE.Object3D>(_key: string, make: () => T): T => make();
    const concrete = (): THREE.Material => scn.M(palette.concrete, { roughness: 0.95 });
    const metal = (): THREE.Material =>
      scn.M(SCENE_COLORS.chargerMetal, { roughness: 0.4, metalness: 0.7 });
    // The geometry warning label of the transformer, battery and switchboard.
    const signMaterials = (): Record<'sign' | 'ink', THREE.Material> => ({
      sign: scn.M(SCENE_COLORS.warning, { roughness: 0.5 }),
      ink: scn.M(SCENE_COLORS.warningInk, { roughness: 0.6 }),
    });
    const powerMaterials = (): Record<PowerSlot, THREE.Material> => ({
      body: scn.M(palette.switchboard, { roughness: 0.45, metalness: 0.35 }),
      door: scn.M(palette.switchboardDoor, { roughness: 0.4, metalness: 0.35 }),
      plate: scn.M(palette.switchboardDoor, { roughness: 0.4, metalness: 0.35 }),
      trim: scn.M(SCENE_COLORS.dark1, { roughness: 0.6 }),
      metal: metal(),
      concrete: concrete(),
      glass: scn.M(SCENE_COLORS.glass, { roughness: 0.1, metalness: 0.3 }),
      light: scn.M(SCENE_COLORS.chargePort, {
        emissive: SCENE_COLORS.chargePort,
        emissiveIntensity: 0.6,
      }),
      label: scn.M(palette.signPlate, { roughness: 0.4 }),
      conduit: scn.M(SCENE_COLORS.signPost, { roughness: 0.5, metalness: 0.6 }),
    });
    // The textured warning label a power kit leaves room for on its door.
    const warningLabel = (spot: PanelLabelSpot): THREE.Mesh => {
      const edge = scn.M(SCENE_COLORS.dark1, { roughness: 0.6 });
      const face = scn.M('#ffffff', { map: scn.warningTexture(), roughness: 0.5 });
      const label = scn.box(spot.widthM, spot.heightM, 0.003, [edge, edge, edge, edge, face, edge]);
      label.position.set(spot.at[0], spot.at[1], spot.at[2] + 0.0015);
      return label;
    };
    // The car parks nose to the charger, CAR_FRONT in front of it, inside its spot.
    const CAR_FRONT = 0.7;
    // The charge port on the front left fender of each body type.
    const portAt = (bodyType: VehicleBodyType, noseZ = CAR_FRONT): [number, number, number] => {
      const port = scn.carKit(bodyType).port;
      return [port.x, port.y, noseZ + port.z];
    };
    // A car parallel parked along a curb (station local +z is the street): it
    // faces -x with its right side 0.3 m from the curb, its nose just past the
    // post, so its charge port (front left) is on the street side.
    const CURB_FACE_Z = CURB_POST_BACK_M;
    const parallelAt = (bodyType: VehicleBodyType): [number, number] => [
      -0.4,
      CURB_FACE_Z + 0.3 + vehicleSize(bodyType).width / 2,
    ];
    // Shared by every car of one look: the glass, tires, rims, trim and lights.
    const glass = scn.track(
      new THREE.MeshPhysicalMaterial({
        color: SCENE_COLORS.carGlass,
        roughness: 0.12,
        metalness: 0,
        clearcoat: 0.6,
        clearcoatRoughness: 0.1,
        envMapIntensity: 0.55,
      }),
    );
    const carShared = {
      glass,
      tire: scn.M(SCENE_COLORS.rubber, { roughness: 0.85 }),
      rim: scn.M(SCENE_COLORS.rim, { roughness: 0.25, metalness: 0.9 }),
      trim: scn.M(SCENE_COLORS.dark1, { roughness: 0.55 }),
      headlight: scn.M(SCENE_COLORS.headlight, {
        emissive: SCENE_COLORS.headlight,
        emissiveIntensity: scn.theme.dark ? 1.4 : 0.3,
      }),
      taillight: scn.M(SCENE_COLORS.taillight, {
        emissive: SCENE_COLORS.taillight,
        emissiveIntensity: scn.theme.dark ? 1.2 : 0.4,
      }),
      chargePort: scn.M(SCENE_COLORS.chargePort, {
        emissive: SCENE_COLORS.chargePort,
        emissiveIntensity: 0.6,
      }),
      // A semi trailer's van body and bus roof pods: white, satin.
      panel: scn.M(SCENE_COLORS.vehiclePanel, { roughness: 0.4, metalness: 0.2 }),
    };
    // A glossy paint with a clear coat, one material per color.
    const paints = new Map<string, THREE.Material>();
    const paintFor = (color: string): THREE.Material => {
      let paint = paints.get(color);
      if (paint == null) {
        paint = scn.track(
          new THREE.MeshPhysicalMaterial({
            color,
            roughness: 0.35,
            metalness: 0.45,
            clearcoat: 1,
            clearcoatRoughness: 0.08,
          }),
        );
        paints.set(color, paint);
      }
      return paint;
    };
    const result: Templates = {
      vehicle: (look) =>
        once(`vehicle-${look.bodyType}-${look.color}-${inletKey(look)}`, () =>
          scn
            .carKit(look.bodyType, undefined, look.inlet, look.plug)
            .build({ ...carShared, paint: paintFor(look.color) }),
        ),
      car: (look, frontZ = CAR_FRONT) =>
        once(
          `car-${look.bodyType}-${look.color}-${carLookPort(look)}-${inletKey(look)}-${String(frontZ)}`,
          () => {
            const g = new THREE.Group();
            const port = carLookPort(look);
            const car = scn.carKit(look.bodyType, port, look.inlet, look.plug).build({
              ...carShared,
              paint: paintFor(look.color),
            });
            if (parksBackedIn(port) && !isLargeBodyType(look.bodyType)) {
              // Backed in: turned a half turn, its tail `frontZ` in front of the charger.
              car.rotation.y = Math.PI;
              car.position.z = frontZ + CAR_PROFILES[look.bodyType].length;
            } else {
              car.position.z = frontZ;
            }
            g.add(car);
            return g;
          },
        ),
      carParallel: (look) =>
        once(
          `carParallel-${look.bodyType}-${look.color}-${carLookPort(look)}-${inletKey(look)}`,
          () => {
            const g = new THREE.Group();
            // Parallel along the curb, facing -x, never backed in (site-layout-curb-cable.ts).
            const port = carLookPort(look);
            const car = scn.carKit(look.bodyType, port, look.inlet, look.plug).build({
              ...carShared,
              paint: paintFor(look.color),
            });
            const place = isLargeBodyType(look.bodyType)
              ? null
              : parallelPlace(CAR_PROFILES[look.bodyType], port);
            const at = parallelAt(look.bodyType);
            car.rotation.y = Math.PI / 2;
            car.position.set(place?.noseX ?? at[0], 0, place?.centerZ ?? at[1]);
            g.add(car);
            return g;
          },
        ),
      // From the plugged connector's holster to the handle in the car's port (`carPortInStation`).
      cable: (kind, look, offsetX = 0, frontZ = CAR_FRONT, flowing = true, plug = {}) =>
        perStation(
          `cable-${kind}-${look.bodyType}-${carLookPort(look)}-${String(offsetX)}-${String(frontZ)}-${String(flowing)}-${plug.connector ?? ''}-${String(plug.side ?? '')}-${String(plug.backM ?? 0)}-${plug.mouth == null ? '' : `${String(plug.mouth.x)},${String(plug.mouth.y)},${String(plug.mouth.z)}`}-${plug.bounds == null ? '' : `${String(plug.bounds.minX)},${String(plug.bounds.maxX)}`}`,
          () => {
            const bodyType = look.bodyType;
            const legacy = portAt(bodyType, frontZ);
            const carPort = carLookPort(look);
            const at = isLargeBodyType(bodyType)
              ? { x: legacy[0] + offsetX, y: legacy[1], z: legacy[2] }
              : carPortInStation(CAR_PROFILES[bodyType], carPort, { x: offsetX, z: frontZ });
            const dcKind = kind === 'dc' || kind === 'curb-dc';
            const connector = plug.connector ?? (dcKind ? 'ccs1' : 'type1');
            const radius = CONNECTOR_SPECS[connector].cableDiameterM / 2;
            const rubber = scn.M(SCENE_COLORS.rubber, { roughness: 0.9 });
            const g = new THREE.Group();
            // The handle in the port, its face into the car; the cable leaves its grip.
            const placePlug = (port: Point3, yaw: number): CableEntry => {
              const h = scn.connectorHandle(connector);
              h.position.set(port.x, port.y, port.z);
              h.rotation.y = yaw;
              h.userData['plugged'] = true;
              g.add(h);
              return handleCableEntry(port, yaw, connector);
            };
            if (kind === 'curb-ac' || kind === 'curb-dc') {
              // From the post's own anchor (a DC cable out of its gland, an AC one off
              // its coil) to the car's port, around the car or over it, never across
              // the travel lane (site-layout-curb-cable.ts).
              const from = (
                kind === 'curb-dc'
                  ? dcGlandOut(-1, 0, connector)
                  : acGlandOut(plug.glandX ?? 0, CONNECTOR_SPECS[connector].cableDiameterM)
              ).map((p) => [p[0], p[1], p[2]] as const);
              const profile = CAR_PROFILES[bodyType as CarBodyType];
              const place = parallelPlace(profile, carPort);
              const pp = parallelPort(profile, carPort, place);
              const entry = placePlug(pp.at, pp.yaw);
              const route = curbChargingRoute({
                from,
                plug: { lead: entry.lead, end: entry.end },
                port: carPort,
                place,
                surface: curbsideSurface(),
                cableDiameterM: CONNECTOR_SPECS[connector].cableDiameterM,
              });
              g.add(
                scn.chargingCable(
                  route.map((p) => [p[0], p[1], p[2]] as [number, number, number]),
                  rubber,
                  radius,
                  flowing,
                ),
              );
              return g;
            }
            const nose = carPort === 'front_center' && !isLargeBodyType(bodyType);
            const entry = placePlug(at, plugYaw(at, offsetX, nose));
            if (kind === 'wall') {
              // From the hanger coil across the sidewalk to the port, its length kept
              // (site-layout-wall-box-cable.ts).
              const profile = CAR_PROFILES[bodyType as CarBodyType];
              const d = CONNECTOR_SPECS[connector].cableDiameterM;
              const car = {
                minX: offsetX - profile.width / 2,
                maxX: offsetX + profile.width / 2,
                minZ: frontZ,
                maxZ: frontZ + profile.length,
              };
              const toCar = carToStation(
                { x: offsetX, z: frontZ },
                profile.length,
                parksBackedIn(carPort),
              );
              const run = wallBoxChargingCable({
                wallZ: wallBoxOffset(),
                boxBottomM: WALL_BOX_BOTTOM_M,
                cableDiameterM: d,
                plug: { lead: entry.lead, end: entry.end },
                car,
                nosePort: nose,
                surface: scn.cableGround ?? officeRowSurface(),
                blocked: cableBlocked({
                  body: car,
                  bodyHeightM: profile.height,
                  tires: tireFootprints(profile, toCar),
                  posts: [],
                  radiusM: d / 2,
                }),
              });
              g.add(
                scn.chargingCable(
                  run.points.map((p) => [p[0], p[1], p[2]] as [number, number, number]),
                  rubber,
                  radius,
                  flowing,
                ),
              );
              return g;
            }
            // From the mouth of the plugged connector's empty holster (`holsterSlots`), else the one on the port's side.
            const side = plug.side ?? (at.x > 0.001 ? 1 : -1);
            const back = plug.backM ?? 0;
            // The cable leaves its own gland, off its hanger (a satellite's from its holster mouth).
            const from: Array<[number, number, number]> = (
              plug.mouth != null
                ? [[plug.mouth.x, plug.mouth.y, plug.mouth.z] as const]
                : kind === 'dc'
                  ? dcGlandOut(side, back, connector)
                  : acGlandOut(plug.glandX ?? 0, CONNECTOR_SPECS[connector].cableDiameterM)
            ).map((p) => [p[0], p[1], p[2]]);
            // Down to the ground, along it outside the car and its tires, up into the
            // handle (site-layout-cable-rest.ts); a DC cable keeps its 3.6 m.
            const profile = isLargeBodyType(bodyType) ? null : CAR_PROFILES[bodyType];
            const width = profile?.width ?? vehicleSize(bodyType).width;
            const length = profile?.length ?? vehicleSize(bodyType).length;
            const d = CONNECTOR_SPECS[connector].cableDiameterM;
            const toCar = carToStation(
              { x: offsetX, z: frontZ },
              length,
              parksBackedIn(carPort) && !isLargeBodyType(bodyType),
            );
            const route = plugRoute({
              blocked: cableBlocked({
                body: {
                  minX: offsetX - width / 2,
                  maxX: offsetX + width / 2,
                  minZ: frontZ,
                  maxZ: frontZ + length,
                },
                bodyHeightM: profile?.height ?? vehicleSize(bodyType).height,
                tires: profile != null ? tireFootprints(profile, toCar) : [],
                posts: dcKind
                  ? [-DC_BOLLARD.x, DC_BOLLARD.x].map((x) => ({
                      x,
                      z: DC_BOLLARD.z,
                      radiusM: EQUIPMENT_BOLLARD.radiusM,
                      heightM: EQUIPMENT_BOLLARD.heightM,
                    }))
                  : [],
                radiusM: d / 2,
              }),
              from,
              plug: { lead: entry.lead, end: entry.end },
              car: {
                minX: offsetX - width / 2,
                maxX: offsetX + width / 2,
                minZ: frontZ,
                maxZ: frontZ + length,
              },
              nosePort: nose,
              surface: scn.cableGround ?? ((): number => SURFACE_M.paving),
              radiusM: d / 2,
              bendM: CABLE_MIN_BEND_RATIO * d,
              ...(plug.mouth == null ? { lengthM: dcKind ? DC_CABLE_M : AC_CABLE_M } : {}),
              ...(plug.bounds != null ? { bounds: plug.bounds } : {}),
            });
            g.add(
              scn.chargingCable(
                route.points.map((p) => [p[0], p[1], p[2]] as [number, number, number]),
                rubber,
                radius,
                flowing,
              ),
            );
            return g;
          },
        ),
      wheelStop: () =>
        once('wheelStop', () => {
          // The precast stop (site-layout-model-wheel-stop.ts).
          const stop = scn.modelOf(
            scn.modelKit('wheelStop', createSiteWheelStopKit),
            'wheel-stop',
            {
              concrete: scn.M(palette.concrete, { roughness: 0.95 }),
              paint: scn.M(SCENE_COLORS.bollard, { roughness: 0.6 }),
              hole: scn.M(SCENE_COLORS.dark1, { roughness: 0.9 }),
              metal: scn.M(SCENE_COLORS.chargerMetal, { roughness: 0.5, metalness: 0.6 }),
            },
          );
          stop.traverse((o) => {
            o.raycast = () => undefined;
          });
          return stop;
        }),
      evSigns: (mount: StationSigns) =>
        once(`evSigns:${String(mount.onWall)}:${String(mount.towAwayBottomM)}`, () => {
          // A wall sign is placed at the facade by the caller (mount.z).
          const g = new THREE.Group();
          const backing = scn.M(SCENE_COLORS.signBack, { roughness: 0.6, metalness: 0.5 });
          // A sign panel: a thin aluminum blank with its face in front.
          const panel = (w: number, h: number, bottom: number, face: THREE.CanvasTexture): void => {
            const blank = scn.box(w, h, 0.004, backing);
            blank.position.set(0, bottom + h / 2, mount.onWall ? 0.004 : 0.03);
            // Sign faces are retroreflective sheeting (MUTCD 11th Edition,
            // Section 2A.21). Drawing them unlit is a display choice, so the
            // legend reads in the dark theme and in the shade of a canopy.
            const plate = new THREE.Mesh(
              scn.track(new THREE.PlaneGeometry(w, h)),
              scn.track(new THREE.MeshBasicMaterial({ map: face, toneMapped: false })),
            );
            plate.position.set(0, bottom + h / 2, mount.onWall ? 0.0065 : 0.0325);
            g.add(blank, plate);
          };
          panel(
            EV_SIGNS.chargingOnly.widthM,
            EV_SIGNS.chargingOnly.heightM,
            mount.chargingOnlyBottomM,
            scn.evSignTexture('chargingOnly'),
          );
          if (mount.towAwayBottomM != null) {
            panel(
              EV_SIGNS.towAway.widthM,
              EV_SIGNS.towAway.heightM,
              mount.towAwayBottomM,
              scn.evSignTexture('towAway'),
            );
          }
          const support = signSupport(mount);
          if (support.kind === 'post') {
            const steel = scn.M(SCENE_COLORS.signPost, { roughness: 0.5, metalness: 0.7 });
            // The galvanized square tube from the ground to the top sign.
            const post = scn.box(
              EV_SIGNS.postWidthM,
              support.topM - support.bottomM,
              EV_SIGNS.postWidthM,
              steel,
            );
            post.position.y = (support.topM + support.bottomM) / 2;
            // The anchor post it slides into, driven into the ground.
            const anchor = scn.box(
              EV_SIGNS.anchorWidthM,
              support.anchorTopM,
              EV_SIGNS.anchorWidthM,
              steel,
            );
            anchor.position.y = support.anchorTopM / 2;
            g.add(post, anchor);
          }
          return g;
        }),
      cone: () =>
        once('cone', () => {
          const g = new THREE.Group();
          const orange = scn.M(SCENE_COLORS.cone, { roughness: 0.6 });
          const white = scn.M(SCENE_COLORS.coneBand, { roughness: 0.5 });
          const base = scn.box(0.42, 0.04, 0.42, orange);
          base.position.y = 0.02;
          const height = 0.62;
          const radius = 0.17;
          const cone = scn.shadowed(
            new THREE.Mesh(scn.track(new THREE.ConeGeometry(radius, height, 24)), orange),
          );
          cone.position.y = 0.04 + height / 2;
          g.add(base, cone);
          for (const [from, to] of [
            [0.3, 0.4],
            [0.55, 0.63],
          ] as const) {
            const r = (f: number) => radius * (1 - f) + 0.004;
            const band = scn.shadowed(
              new THREE.Mesh(
                scn.track(
                  new THREE.CylinderGeometry(r(to), r(from), (to - from) * height, 24, 1, true),
                ),
                white,
              ),
            );
            band.position.y = 0.04 + ((from + to) / 2) * height;
            g.add(band);
          }
          g.position.set(0.15, 0, 2.2);
          return g;
        }),
      // The power equipment models (one file each, site-layout-model-<model>.ts):
      // the pad-mounted transformer, the containerized battery, the outdoor
      // switchboard, the split system power cabinet and the rack and wall
      // panelboards, each on its pad or wall in its own frame, the front +z.
      battery: () =>
        once('battery', () =>
          scn.modelOf(scn.modelKit('battery', createBatteryCabinetKit), 'battery', {
            ...signMaterials(),
            concrete: concrete(),
            body: scn.M(palette.battery, { roughness: 0.5, metalness: 0.25 }),
            door: scn.M(palette.battery, { roughness: 0.45, metalness: 0.25 }),
            seam: scn.M(SCENE_COLORS.dark1, { roughness: 0.7 }),
            metal: metal(),
            vent: scn.M(palette.batteryVent, { roughness: 0.6, metalness: 0.4 }),
            light: scn.M(SCENE_COLORS.chargePort, {
              emissive: SCENE_COLORS.chargePort,
              emissiveIntensity: 0.6,
            }),
            plate: scn.M(palette.signPlate, { roughness: 0.4 }),
          }),
        ),
      transformer: () =>
        once('transformer', () =>
          scn.modelOf(scn.modelKit('transformer', createPadMountTransformerKit), 'transformer', {
            ...signMaterials(),
            concrete: concrete(),
            body: scn.M(palette.transformer, { roughness: 0.55, metalness: 0.3 }),
            fin: scn.M(palette.transformerFin, { roughness: 0.5, metalness: 0.35 }),
            seam: scn.M(SCENE_COLORS.dark1, { roughness: 0.7 }),
            metal: metal(),
            plate: scn.M(palette.signPlate, { roughness: 0.4 }),
          }),
        ),
      powerCabinet: () =>
        once('powerCabinet', () => {
          const kit = scn.modelKit('power-cabinet', () => {
            const model = createPowerCabinetKit();
            cabinetLabel = model.label;
            return model.kit;
          });
          const g = scn.modelOf(kit, 'power-cabinet', powerMaterials());
          if (cabinetLabel != null) g.add(warningLabel(cabinetLabel));
          return g;
        }),
      switchboard: () =>
        once('switchboard', () =>
          scn.modelOf(scn.modelKit('switchboard', createOutdoorSwitchboardKit), 'switchboard', {
            ...signMaterials(),
            concrete: concrete(),
            body: scn.M(palette.switchboard, { roughness: 0.45, metalness: 0.35 }),
            door: scn.M(palette.switchboardDoor, { roughness: 0.4, metalness: 0.35 }),
            seam: scn.M(SCENE_COLORS.dark1, { roughness: 0.6 }),
            metal: metal(),
            plate: scn.M(palette.signPlate, { roughness: 0.4 }),
          }),
        ),
      panelboard: () =>
        once('panelboard', () => {
          const kit = scn.modelKit('rack-panelboard', () => {
            const model = createRackPanelboardKit();
            rackLabel = model.label;
            return model.kit;
          });
          const g = scn.modelOf(kit, 'rack-panelboard', powerMaterials());
          if (rackLabel != null) g.add(warningLabel(rackLabel));
          return g;
        }),
      dryTransformer: (kva) => {
        const size = dryTransformerSize(kva);
        return once(`dry-transformer-${String(size.kva)}`, () =>
          scn.modelOf(
            scn.modelKit(`dry-transformer:${String(size.kva)}`, () =>
              createDryTransformerKit(size),
            ),
            'dry-transformer',
            {
              ...signMaterials(),
              concrete: concrete(),
              body: scn.M(palette.dryTransformer, { roughness: 0.5, metalness: 0.3 }),
              vent: scn.M(palette.dryTransformerVent, { roughness: 0.8 }),
              seam: scn.M(SCENE_COLORS.dark1, { roughness: 0.6, metalness: 0.2 }),
              metal: metal(),
              plate: scn.M(palette.signPlate, { roughness: 0.4 }),
              conduit: scn.M(SCENE_COLORS.chargerMetal, { roughness: 0.45, metalness: 0.6 }),
            },
          ),
        );
      },
      wallPanelboard: () =>
        once('wall-panelboard', () => {
          const kit = scn.modelKit('wall-panelboard', () => {
            const model = createWallPanelboardKit();
            wallLabel = model.label;
            return model.kit;
          });
          const g = scn.modelOf(kit, 'wall-panelboard', powerMaterials());
          if (wallLabel != null) g.add(warningLabel(wallLabel));
          return g;
        }),
      // A card reader on its bracket, its back on the host surface at the origin: the
      // screen reader for a model with a display, else the contactless reader
      // (site-layout-model-reader-screen.ts, site-layout-model-reader-contactless.ts).
      terminal: (hasDisplay, online) =>
        once(`terminal-${String(hasDisplay)}-${String(online)}`, () => {
          const statusColor =
            online === true ? SCENE_COLORS.terminalOnline : SCENE_COLORS.terminalOffline;
          const dark = scn.M(SCENE_COLORS.dark1, { roughness: 0.5 });
          const kit = hasDisplay
            ? scn.modelKit('reader-screen', createScreenReaderKit)
            : scn.modelKit('reader-contactless', createContactlessReaderKit);
          return scn.modelOf(kit, hasDisplay ? 'reader-screen' : 'reader-contactless', {
            body: scn.M(SCENE_COLORS.terminalBody, { roughness: 0.45 }),
            bezel: dark,
            screen: scn.M(SCENE_COLORS.glass, {
              roughness: 0.1,
              emissive: online === true ? SCENE_COLORS.terminalScreen : '#000000',
              emissiveIntensity: online === true ? 1.1 : 0,
            }),
            zone: scn.M(palette.signPlate, { roughness: 0.4 }),
            mark: dark,
            light: scn.M(statusColor, {
              emissive: statusColor,
              emissiveIntensity: online === true ? 1 : 0.1,
            }),
            metal: scn.M(SCENE_COLORS.chargerMetal, { roughness: 0.4, metalness: 0.7 }),
            slot: scn.M(SCENE_COLORS.rubber, { roughness: 0.9 }),
          });
        }),
    };
    return result;
  }
  scn.templates = templates;
}
