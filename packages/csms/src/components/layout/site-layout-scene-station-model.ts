// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// One station's model in the 3D site scene: charger, holsters, cables, readers, props.

import { freeSpotRects, freeSpotTypeOf, freeSpotsExtent } from '@evtivity/lib/site-layout';
import * as THREE from 'three';
import { isLargeBodyType, sceneCar } from './site-layout-car';
import { SCENE_COLORS } from './site-layout-colors';
import { holsterPose, holsterSlots } from './site-layout-connectors';
import { curbPortOf } from './site-layout-curb-cable';
import {
  CURB_POST_BACK_M,
  FACADE_BASE_PROUD_M,
  FACADE_SIGN_STANDOFF_M,
  dispenserHolsters,
  isSpot,
  readerMount,
  rotationHandleZ,
  wallBoxOffset,
  wheelStopCenterZ,
  wheelStopMount,
  type Point,
} from './site-layout-grid';
import { chargerPadRects, freeStationRaisedRects, stationGround } from './site-layout-ground';
import { acGlandX } from './site-layout-model-ac-pedestal';
import { READER_SCENE_SCALE } from './site-layout-model-reader-parts';
import { stallSignPostXs, stationSignMount } from './site-layout-signs';

import type { SceneSlice } from './site-layout-scene-context';
import {
  carFrontAtStop,
  carFrontWithoutStop,
  carLookPort,
  dcDispenserCableOf,
  pluggedHolster,
  satelliteHolsterMount,
  slotKind,
  withAcGland,
  withVehicleInlet,
} from './site-layout-scene-station-slots';
import {
  AVATAR_ABOVE_ROOF_M,
  VIRTUAL_SIGN_Y_M,
  type Palette,
  type SceneStation,
  type StationObject,
  type Templates,
} from './site-layout-scene-types';

type StationModelCtx = SceneSlice<
  | 'M'
  | 'addFreeSpots'
  | 'box'
  | 'chargerBody'
  | 'freeHandle'
  | 'layout'
  | 'logoPanel'
  | 'lotPoint'
  | 'placeLargeSpotProp'
  | 'poseOf'
  | 'theme'
  | 'track'
  | 'virtualSignSprite',
  'buildModel' | 'cableGround' | 'signPosts' | 'siteRaisedRects'
>;

export function installStationModel(scn: StationModelCtx): void {
  // Sign posts placed so far in this build, in lot meters: two dual-port
  // pedestals side by side share the post on the line between their pairs
  // (its sign stands adjacent to both stalls).
  const signPosts: Point[] = [];
  scn.signPosts = signPosts;

  // The ground under the station being built (site-layout-ground.ts): every
  // cable built for it rests on it (`cable`), none sunk into a pad, curb or island.
  scn.cableGround = null;
  scn.siteRaisedRects = [];
  function buildModel(s: SceneStation, palette: Palette, t: Templates): StationObject {
    const pose = scn.poseOf(s);
    const dc = s.kind === 'dc';
    const wall = s.wall && !dc;
    const large = s.charger != null && s.charger !== 'standard';
    const local = [
      ...(s.free != null && scn.layout.lot.depot == null
        ? freeStationRaisedRects(s.spots ?? 1, freeSpotTypeOf(s.free))
        : []),
      ...(large ? [] : chargerPadRects(wall ? 'wall' : dc ? 'dc' : 'ac')),
    ];
    scn.cableGround = stationGround(
      scn.layout.lot,
      { x: pose.point.x, z: pose.point.z, turn: pose.turn },
      local,
      scn.siteRaisedRects,
    );
    try {
      return buildStationModel(s, palette, t);
    } finally {
      scn.cableGround = null;
    }
  }
  scn.buildModel = buildModel;
  // Where a driver avatar floats over a car: above the middle of its roof.
  function roofAnchor(car: THREE.Object3D): THREE.Vector3 | null {
    car.updateMatrixWorld(true);
    const roof = new THREE.Box3().setFromObject(car);
    if (roof.isEmpty()) return null;
    const c = roof.getCenter(new THREE.Vector3());
    return new THREE.Vector3(c.x, roof.max.y + AVATAR_ABOVE_ROOF_M, c.z);
  }
  function buildStationModel(s: SceneStation, palette: Palette, t: Templates): StationObject {
    const g = new THREE.Group();
    if (s.free != null) scn.addFreeSpots(g, s, palette);
    const shell = scn.M(palette.shell, { roughness: 0.35, metalness: 0.25 });
    const dark = scn.M(SCENE_COLORS.dark1, { roughness: 0.6 });
    const rubber = scn.M(SCENE_COLORS.rubber, { roughness: 0.9 });
    const glass = scn.M(SCENE_COLORS.glass, {
      roughness: 0.08,
      metalness: 0.3,
      emissive: s.lit ? SCENE_COLORS.screenGlow : '#000000',
      emissiveIntensity: s.lit ? 0.55 : 0,
    });
    const light = scn.M(s.lightColor, {
      emissive: s.lightColor,
      emissiveIntensity: s.lit ? 0.9 : 0.05,
    });
    // The front plate in the company's AC or DC charger color.
    const accent = scn.M(scn.theme.plateColors[s.kind === 'dc' ? 'dc' : 'ac'], { roughness: 0.4 });
    const dc = s.kind === 'dc';
    const wall = s.wall && !dc;
    const large = s.charger != null && s.charger !== 'standard' ? s.charger : null;
    if (!wall && large == null) {
      const pad = scn.box(
        dc ? 1.6 : 1.0,
        0.08,
        dc ? 1.2 : 0.9,
        scn.M(palette.concrete, { roughness: 0.95 }),
      );
      pad.position.y = 0.04;
      g.add(pad);
    }
    // The charger body, its holsters, hangers and idle cables (site-layout-scene-charger-model.ts).
    const { top, labelZ, glow } = scn.chargerBody(g, s, palette, {
      shell,
      dark,
      rubber,
      glass,
      light,
      accent,
    });
    // The wall box hangs on the facade behind its spot (its card readers beside it).
    const w = wallBoxOffset();
    // The logo on the back of a dispenser or pedestal; none on a wall box (owner
    // decision 2026-11-02); the large models carry theirs on their cabinet.
    if (!wall && large == null) g.add(scn.logoPanel(dc ? 'dc' : 'ac', palette));
    // Payment terminals on the front: on the side of their connector, or centered for the station.
    s.terminals.forEach((terminal, i) => {
      const reader = t.terminal(terminal.hasDisplay, terminal.online);
      // Where real installs mount it, its card interface within reach (`readerMount`).
      const at = readerMount(
        dc ? 'dc' : 'ac',
        wall,
        terminal.side,
        i,
        w,
        wall && (s.evseConnectors?.length ?? 1) >= 2 ? 2 : 1,
        s.terminals.filter((o) => o.side === 0).length,
      );
      reader.position.set(at.x, at.y, at.z);
      // A little larger than life, so the reader reads at site scale.
      reader.scale.setScalar(READER_SCENE_SCALE);
      reader.userData['terminalId'] = terminal.id;
      g.add(reader);
    });
    const ringMaterial = scn.track(
      new THREE.MeshBasicMaterial({
        color: scn.theme.primary,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
      }),
    );
    const ring = new THREE.Mesh(scn.track(new THREE.RingGeometry(1.0, 1.12, 48)), ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    // Under a wall box, on the sidewalk in front of it.
    ring.position.set(0, wall ? 0.14 : 0.09, wall ? w + 0.7 : 0);
    ring.userData['ring'] = true;
    g.add(ring);
    // Where a driver avatar floats: above the middle of the car roof, measured
    // on the model in the station's own frame (before the group moves or merges).
    let avatarAnchor: THREE.Vector3 | null = null;
    const curbside = scn.layout.lot.siteType === 'curbside' && isSpot(s.bay, scn.layout.lot);
    // A DC dispenser's cable length (a two-EVSE dispenser's 6 m, `dcDispenserCableOf`).
    const cableM = dcDispenserCableOf(s);
    const largeSpot = s.free != null && freeSpotTypeOf(s.free) !== 'car';
    // A concrete wheel stop in front of each AC spot (WHEEL_STOP, wheelStopMount).
    const stopMount = wheelStopMount({
      siteType: scn.layout.lot.siteType,
      kind: s.kind,
      wall,
      onSpot: isSpot(s.bay, scn.layout.lot),
      largeSpot,
    });
    // The EV charging signs of the stall (site-layout-signs.ts).
    const signMount = stationSignMount({
      siteType: scn.layout.lot.siteType,
      onSpot: isSpot(s.bay, scn.layout.lot),
      wall,
      freeSpots: s.free != null ? (s.spots ?? 1) : null,
      largeSpot,
      california: scn.layout.california === true,
      // The sign's back on the facade (the sign standoff counts from FACADE_Z).
      wallZ: wallBoxOffset() - FACADE_BASE_PROUD_M + FACADE_SIGN_STANDOFF_M,
      wallPorts: wall && (s.evseConnectors?.length ?? 1) >= 2 ? 2 : 1,
    });
    if (signMount != null) {
      // One R7-113 per stall: a pedestal's two stalls put their posts at the
      // outer side lines (clear of the pedestal on the line between them),
      // the accessible space at the side line of its vehicle space.
      const stalls = s.free == null && !wall ? s.stalls : undefined;
      const postXs =
        stalls == null || scn.layout.lot.siteType === 'curbside'
          ? [signMount.x]
          : stallSignPostXs(stalls, s.dispensers != null && s.dispensers.length > 1);
      const pose = scn.poseOf(s);
      for (const x of postXs) {
        // The post in lot meters (the station turns by 0 or a half turn on a grid site).
        const at = {
          x: pose.point.x + x * Math.cos(pose.turn),
          z: pose.point.z - x * Math.sin(pose.turn),
        };
        if (
          s.free == null &&
          signPosts.some((o) => Math.abs(o.x - at.x) < 0.5 && Math.abs(o.z - at.z) < 0.5)
        ) {
          continue;
        }
        signPosts.push(at);
        const signs = t.evSigns(signMount);
        signs.position.set(x, 0, signMount.z);
        g.add(signs);
      }
    }
    if (stopMount != null) {
      const spotXs =
        s.free != null
          ? freeSpotRects(s.spots ?? 1, 'car').map((r) => (r.minX + r.maxX) / 2)
          : (s.stalls?.map((st) => st.x) ?? [0]);
      for (const x of spotXs) {
        const stop = t.wheelStop();
        stop.position.x = x;
        stop.position.z = wheelStopCenterZ(stopMount);
        g.add(stop);
      }
    }
    if (largeSpot && s.free != null) {
      const rects = freeSpotRects(s.spots ?? 1, freeSpotTypeOf(s.free));
      const rect = rects[Math.min(rects.length - 1, s.propSpot ?? 0)] ?? rects[0];
      if (rect != null) {
        const anchor = scn.placeLargeSpotProp(g, s, t, rect, s.charger ?? 'standard', palette);
        if (anchor != null) avatarAnchor = anchor;
      }
    } else if (s.stallCars != null && s.stalls != null && !curbside) {
      // A dual-port pedestal, a dual-outlet DC dispenser or a two-port wall box on the
      // line between its stalls: a vehicle in each stall with a session, each on its
      // own EVSE's cable (a wall box: from its own port's gland, EVSE 1 on the left).
      const stationKinds = s.connectorKinds?.flat() ?? [];
      s.stallCars.forEach((stallLook, i) => {
        const stall = s.stalls?.[i];
        if (stallLook == null || stall == null) return;
        // The car's inlet for the plug of its EVSE (`withVehicleInlet`).
        const look = withVehicleInlet(
          stallLook,
          slotKind(s, i, s.stallPlugged?.[i] ?? 0),
          stationKinds,
        );
        const noseZ =
          stopMount != null && !isLargeBodyType(look.bodyType)
            ? carFrontAtStop(stopMount, look)
            : wall
              ? undefined
              : carFrontWithoutStop(s, look);
        const car = t.car(look, noseZ);
        car.position.x += stall.x;
        if (wall) {
          g.add(
            car,
            t.cable('wall', look, stall.x, noseZ, s.stallFlows?.[i] ?? true, {
              connector: slotKind(s, i, s.stallPlugged?.[i] ?? 0),
              side: i === 0 ? -1 : 1,
              wallPorts: 2,
            }),
          );
          if (avatarAnchor == null) avatarAnchor = roofAnchor(car);
          return;
        }
        const connector = s.stallPlugged?.[i] ?? 0;
        // EVSE i hangs in its own holster: the first left, the second right; a
        // split system's on the side wall of the satellite in that stall.
        const satellite =
          s.dispensers != null && s.dispensers.length > 1 ? s.dispensers[i] : undefined;
        const slot = dispenserHolsters(s.cables?.[i] ?? 1)[connector];
        // A dual-outlet DC dispenser on the line between its stalls: EVSE i's own holster.
        const dcSlot =
          satellite == null && s.kind === 'dc'
            ? holsterSlots(s.evseConnectors ?? [1, 1]).find(
                (h) => h.evse === i && h.connector === connector,
              )
            : undefined;
        const mouth =
          satellite != null && slot != null
            ? holsterPose(satelliteHolsterMount(satellite, slot.side, slot.backM), {
                x: slot.side,
                z: 0,
              }).mouth
            : undefined;
        g.add(
          car,
          t.cable(s.kind, look, stall.x, noseZ, s.stallFlows?.[i] ?? true, {
            connector: slotKind(s, i, connector),
            side: dcSlot?.side ?? (i === 0 ? -1 : 1),
            ...(dcSlot != null ? { backM: dcSlot.backM } : {}),
            // A two-EVSE dispenser's 6 m cable reaches every port in either stall.
            ...(dcSlot != null && cableM != null ? { lengthM: cableM } : {}),
            glandX: acGlandX(2, i === 0 ? -1 : 1),
            // Each stall's cable keeps to its own stall, clear of the other stall and its car.
            bounds: { minX: stall.x - stall.width / 2, maxX: stall.x + stall.width / 2 },
            ...(mouth != null ? { mouth } : {}),
          }),
        );
        if (avatarAnchor == null) avatarAnchor = roofAnchor(car);
      });
    } else if (s.prop === 'car') {
      // The car's own port decides: a car with a rear port backs in (at a wall
      // box its tail to the building). A curb car parks parallel, never backed in,
      // its port mirrored to the curb side (`curbPortOf`).
      const own0 = withAcGland(s, pluggedHolster(s));
      const plugged = !curbside && cableM != null ? { ...own0, lengthM: cableM } : own0;
      const own = withVehicleInlet(
        s.car ?? sceneCar(null),
        plugged.connector,
        s.connectorKinds?.flat() ?? [],
      );
      const look = curbside ? { ...own, port: curbPortOf(carLookPort(own)) } : own;
      // Against the wheel stop where the spot has one (AC spots), else nose (or tail) to the charger.
      const noseZ =
        stopMount != null && !isLargeBodyType(look.bodyType)
          ? carFrontAtStop(stopMount, look)
          : curbside || wall
            ? undefined
            : carFrontWithoutStop(s, look);
      const car = curbside ? t.carParallel(look) : t.car(look, noseZ);
      const offsetX = curbside || wall ? 0 : (s.carOffsetX ?? 0);
      car.position.x += offsetX;
      g.add(
        car,
        t.cable(
          curbside ? `curb-${s.kind}` : wall ? 'wall' : s.kind,
          look,
          offsetX,
          noseZ,
          s.cableFlow ?? true,
          wall && (s.evseConnectors?.length ?? 1) >= 2 ? { ...plugged, wallPorts: 2 } : plugged,
        ),
      );
      car.updateMatrixWorld(true);
      const roof = new THREE.Box3().setFromObject(car);
      if (!roof.isEmpty()) {
        const c = roof.getCenter(new THREE.Vector3());
        avatarAnchor = new THREE.Vector3(c.x, roof.max.y + AVATAR_ABOVE_ROOF_M, c.z);
      }
    }
    if (largeSpot) {
      // Placed with the vehicle above.
    } else if (s.prop === 'cone') {
      const cone = t.cone();
      // At a curb the cone stands in the parking lane in front of the post.
      if (curbside) cone.position.set(2.2, 0, CURB_POST_BACK_M + 1.2);
      else cone.position.x += s.carOffsetX ?? 0;
      g.add(cone);
    }
    // The virtual status sign floats over the spot (a large spot: over its
    // middle; at a curb: over the parking lane), clear of the charger and a car.
    let virtualSign: THREE.Sprite | null = null;
    if (s.virtualSign != null) {
      virtualSign = scn.virtualSignSprite(s.virtualSign, s.id);
      if (largeSpot && s.free != null) {
        const rects = freeSpotRects(s.spots ?? 1, freeSpotTypeOf(s.free));
        const rect = rects[Math.min(rects.length - 1, s.propSpot ?? 0)] ?? rects[0];
        virtualSign.position.set(
          rect != null ? (rect.minX + rect.maxX) / 2 : 0,
          VIRTUAL_SIGN_Y_M + 1.5,
          rect != null ? (rect.minZ + rect.maxZ) / 2 : 2.6,
        );
      } else if (curbside) {
        virtualSign.position.set(2.2, VIRTUAL_SIGN_Y_M, CURB_POST_BACK_M + 1.2);
      } else {
        virtualSign.position.set(
          s.stallCars != null ? 0 : (s.carOffsetX ?? 0),
          VIRTUAL_SIGN_Y_M,
          2.6,
        );
      }
      g.add(virtualSign);
    }
    g.traverse((o) => {
      o.userData['stationId'] = s.id;
    });
    // The rotation handle is picked apart from the station (its own userData).
    const rotateHandle =
      s.free != null && scn.layout.lot.siteType === 'custom'
        ? scn.freeHandle(
            s.id,
            rotationHandleZ(s.spots ?? 1, freeSpotTypeOf(s.free)),
            freeSpotsExtent(s.spots ?? 1, freeSpotTypeOf(s.free)).back,
          )
        : null;
    if (rotateHandle != null) g.add(rotateHandle);
    // A turned row faces the lane before it, a free station turns by its own
    // turn: the charger, its props, card readers and back panel all turn with the group.
    const pose = scn.poseOf(s);
    g.position.copy(scn.lotPoint(pose.point));
    g.rotation.y = pose.turn;
    return {
      group: g,
      ring,
      light,
      glow,
      top,
      labelZ,
      avatarAnchor,
      virtualSign,
      handle: rotateHandle,
      station: s,
    };
  }
}
