// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The charger itself in the 3D site scene: the body of its model, every
// holster with its handle, the cable hangers and each idle cable from its
// gland over its hanger into the handle. The station model adds the pad,
// signs, props and readers around it; the 2D card pictures build it alone
// (`buildIdleChargerModel`).

import { SPLIT_SYSTEM } from '@evtivity/lib/site-layout';
import * as THREE from 'three';
import { SURFACE_M } from './site-layout-cable-surface';
import {
  DC_HOLSTER,
  acCoilPlace,
  acHangerSpec,
  acHolsterCable,
  dcCoilPlace,
  dcHangerSpec,
  dcHolsterCable,
} from './site-layout-charger-cables';
import { SCENE_COLORS } from './site-layout-colors';
import { CONNECTOR_SPECS, holsterSlots } from './site-layout-connectors';
import { DC_BOLLARD } from './site-layout-dc-bollards';
import { dispenserHolsters, wallBoxOffset } from './site-layout-grid';
import { WALL_BOX_BOTTOM_M, chargerModelTopM, markerY } from './site-layout-marker';
import { AC_PEDESTAL, acGlandX, createAcPedestalKit } from './site-layout-model-ac-pedestal';
import { createCurbPostKit } from './site-layout-model-curb-post';
import { DC_DISPENSER, createDcDispenserKit } from './site-layout-model-dc-dispenser';
import { createSplitSatelliteKit } from './site-layout-model-split-satellite';
import {
  satelliteCoilPlace,
  satelliteGland,
  satelliteHangerSpec,
  satelliteHolster,
  satelliteHolsterCable,
  satelliteSurface,
} from './site-layout-satellite-cables';
import {
  AC_WALL_BOX,
  createAcWallBoxKit,
  wallBoxDisplay,
  wallBoxDock,
  wallBoxFrontZ,
} from './site-layout-model-wall-box';
import {
  WALL_BOX_HANGER,
  wallBoxCoilPlace,
  wallBoxHangerSpec,
  wallBoxIdleCable,
} from './site-layout-wall-box-cable';

import type { SceneCtx } from './site-layout-scene-context';
import {
  AC_HOLSTER_X,
  AC_HOLSTER_Y,
  DC_BOLLARD_Z,
  DC_HOLSTER_X,
  DC_HOLSTER_Y,
  slotInUse,
  slotKind,
} from './site-layout-scene-station-slots';
import { type Palette, type SceneStation, type StationObject } from './site-layout-scene-types';

import { STATUS_COLORS } from '@/lib/chart-theme';
import type { ConnectorKind } from './site-layout-connectors';
import { installCables } from './site-layout-scene-cables';
import { installConnectors } from './site-layout-scene-connectors';
import { installDressing } from './site-layout-scene-dressing';
import { installKit } from './site-layout-scene-kit';
import { installLargeChargers } from './site-layout-scene-large-chargers';
import type { StationMaterials } from './site-layout-scene-types';
import { ENGLISH_SIGN_TEXTS } from './site-layout-signs';

export function installChargerModel(scn: SceneCtx): void {
  function chargerBody(
    g: THREE.Group,
    s: SceneStation,
    palette: Palette,
    m: StationMaterials,
  ): { top: number; labelZ: number; glow: StationObject['glow'] } {
    const { shell, dark, rubber, glass, light, accent } = m;
    const dc = s.kind === 'dc';
    const wall = s.wall && !dc;
    const large = s.charger != null && s.charger !== 'standard' ? s.charger : null;
    let top: number;
    let labelZ = 0;
    let glow: StationObject['glow'] = null;
    // The wall box hangs on the facade behind its spot.
    const w = wallBoxOffset();
    if (large != null) {
      const built = scn.buildLargeCharger(g, s, large, palette, {
        shell,
        dark,
        rubber,
        glass,
        light,
        accent,
      });
      top = built.top;
      glow = built.glow;
    } else if (wall) {
      // The wall box on the facade (site-layout-model-wall-box.ts), its back on the wall.
      const wallKind = slotKind(s, 0, 0);
      const wallCable = CONNECTOR_SPECS[wallKind].cableDiameterM;
      const wb = AC_WALL_BOX;
      const box3 = new THREE.Group();
      box3.position.z = w;
      box3.add(
        scn.modelOf(
          scn.modelKit(`wall-box:${String(wallCable)}`, () =>
            createAcWallBoxKit(WALL_BOX_BOTTOM_M, wallCable),
          ),
          'ac-wall-box',
          {
            body: shell,
            plate: accent,
            bezel: dark,
            screen: glass,
            light,
            metal: scn.M(SCENE_COLORS.chargerMetal, { roughness: 0.4, metalness: 0.7 }),
            rubber,
          },
        ),
      );
      g.add(box3);
      const display = wallBoxDisplay(WALL_BOX_BOTTOM_M);
      scn.addScreenMessage(g, s, 'wallbox', [
        display.center[0],
        display.center[1],
        w + display.center[2],
      ]);
      // The dock in the front middle of the box, its connector seated unless plugged into the car.
      const wallPlugged = slotInUse(s, 0, 0);
      const dock = wallBoxDock(WALL_BOX_BOTTOM_M);
      const wallEntry = scn.holsteredConnector(
        g,
        wallKind,
        { x: dock.x, y: dock.y, z: w + dock.z },
        { x: 0, z: 1 },
        wallPlugged,
      );
      // The cable hanger beside the box (a peg, site-layout-model-cable-hanger.ts).
      const coil = wallBoxCoilPlace(w, wallCable);
      g.add(
        scn.cableHanger(wallBoxHangerSpec(wallCable), [WALL_BOX_HANGER.x, coil.cy, w], 0, rubber),
      );
      // Its cable out of the gland under the box, coiled over the hanger, into the docked handle.
      if (!wallPlugged) {
        const idle = wallBoxIdleCable({
          wallZ: w,
          boxBottomM: WALL_BOX_BOTTOM_M,
          cableDiameterM: wallCable,
          dock: { lead: wallEntry.lead, end: wallEntry.end },
          sidewalkY: SURFACE_M.sidewalk,
        });
        g.add(
          scn.cable(
            idle.points.map((p) => [p[0], p[1], p[2]] as [number, number, number]),
            rubber,
            wallCable / 2,
          ),
        );
      }
      // The charging glow: a ring around the status light ring.
      const ringT = wb.ring.centerFromBottomM;
      glow = scn.addGlow(
        g,
        s,
        [
          {
            geometry: scn.socketRing(wb.ring.radiusM + 0.012),
            position: [0, WALL_BOX_BOTTOM_M + ringT, w + wallBoxFrontZ(ringT) + 0.008],
          },
        ],
        { size: 0.45, position: [0, WALL_BOX_BOTTOM_M + ringT, w + wallBoxFrontZ(ringT) + 0.02] },
      );
      // The status marker floats just above the wall box, in front of the facade.
      top = markerY(chargerModelTopM('wall'));
      labelZ = w + 0.2;
    } else if (dc && s.dispensers != null && s.dispensers.length > 0) {
      // A DC split system: a slim satellite dispenser in the head of each of
      // its stalls (Kempower S-Series: 300 x 1518 x 300 mm), one holstered
      // cable per connector of its EVSE; the power cabinet that feeds them
      // stands on the equipment pad. The screen message and the glow are on
      // the first; status and power are the station's.
      const sat = SPLIT_SYSTEM.dispenser;
      s.dispensers.forEach((dx, i) => {
        const unit = new THREE.Group();
        unit.position.x = dx;
        const holsters = dispenserHolsters(s.cables?.[i] ?? 1).map((h, k) => ({
          ...h,
          k,
          kind: slotKind(s, i, k),
          // Its place on its side's hanger peg: the front holster first.
          slot: dispenserHolsters(s.cables?.[i] ?? 1)
            .slice(0, k)
            .filter((o) => o.side === h.side).length,
        }));
        const sideKinds = (side: -1 | 1): ConnectorKind[] =>
          holsters.filter((h) => h.side === side).map((h) => h.kind);
        const glands = holsters.map((h) => ({
          ...satelliteGland(h.side, h.slot),
          cableDiameterM: CONNECTOR_SPECS[h.kind].cableDiameterM,
        }));
        const kit = scn.modelKit(
          `split-satellite:${glands.map((gl) => `${gl.at.join(':')}:${String(gl.cableDiameterM)}`).join(',')}`,
          () => createSplitSatelliteKit(glands),
        );
        unit.add(
          scn.modelOf(kit, 'split-satellite', {
            body: shell,
            door: shell,
            plate: accent,
            trim: dark,
            metal: scn.M(SCENE_COLORS.chargerMetal, { roughness: 0.4, metalness: 0.7 }),
            concrete: scn.M(palette.concrete, { roughness: 0.95 }),
            glass,
            light,
            label: scn.M(palette.signPlate, { roughness: 0.4 }),
            conduit: scn.M(SCENE_COLORS.signPost, { roughness: 0.5, metalness: 0.6 }),
          }),
        );
        if (i === 0) scn.addScreenMessage(unit, s, 'ac', [0, 1.3, sat.depthM / 2 + 0.017]);
        // The ground under this satellite, in its own frame.
        const ground = scn.cableGround;
        const surface =
          ground != null ? (x: number, z: number) => ground(x + dx, z) : satelliteSurface;
        // One hanger peg on each side wall that holds a cable (empty while its cables are plugged in).
        for (const side of [-1, 1] as const) {
          const kinds = sideKinds(side);
          if (kinds.length === 0) continue;
          unit.add(
            scn.cableHanger(
              satelliteHangerSpec(kinds),
              satelliteCoilPlace(side, kinds, 0).mount,
              (side * Math.PI) / 2,
              rubber,
            ),
          );
        }
        for (const { side, backM, k, kind, slot } of holsters) {
          // The holster on the satellite's side wall, the plug's nose in it and its grip out to the side.
          const [hx, hy, hz] = satelliteHolster(side, backM);
          // Satellite i is EVSE i; a handle plugged into its stall's car leaves the holster empty.
          const plugged = slotInUse(s, i, k);
          scn.holsteredConnector(unit, kind, { x: hx, y: hy, z: hz }, { x: side, z: 0 }, plugged);
          // Out of its gland, looped over the peg, up into the handle.
          if (!plugged) {
            unit.add(
              scn.cable(
                satelliteHolsterCable(side, sideKinds(side), slot, backM, surface).map(
                  (p) => [p[0], p[1], p[2]] as [number, number, number],
                ),
                rubber,
                CONNECTOR_SPECS[kind].cableDiameterM / 2,
              ),
            );
          }
        }
        for (const bx of [-0.45, 0.45]) unit.add(scn.pipeBollard(bx, 0.5));
        g.add(unit);
      });
      const first = s.dispensers[0] ?? 0;
      glow = scn.addGlow(
        g,
        s,
        [
          {
            geometry: new THREE.BoxGeometry(0.26, 0.02, 0.012),
            position: [first, 1.39, sat.depthM / 2 + 0.012],
          },
          {
            geometry: new THREE.BoxGeometry(0.26, 0.02, 0.012),
            position: [first, 1.21, sat.depthM / 2 + 0.012],
          },
        ],
        { size: 0.7, position: [first, 1.3, sat.depthM / 2 + 0.03] },
      );
      top = markerY(chargerModelTopM('satellite'));
    } else if (dc) {
      const slots = holsterSlots(s.evseConnectors ?? [s.cables?.[0] ?? 2]);
      const glands = slots.map((h) => ({
        side: h.side,
        backM: h.backM,
        cableDiameterM: CONNECTOR_SPECS[slotKind(s, h.evse, h.connector)].cableDiameterM,
      }));
      const kit = scn.chargerKit(
        `dc:${glands.map((h) => `${String(h.side)}${String(h.backM)}:${String(h.cableDiameterM)}`).join(',')}`,
        () => createDcDispenserKit(glands),
      );
      g.add(
        scn.modelOf(kit, 'dc-dispenser', scn.chargerMaterials(shell, dark, accent, glass, light)),
      );
      const sc = DC_DISPENSER.screen;
      const front = DC_DISPENSER.frontZ;
      scn.addScreenMessage(g, s, 'dc7in', [0, sc.y, front + 0.0225]);
      // The charging glow: a frame around the screen bezel.
      const fw = sc.widthM + 0.1;
      const fh = sc.heightM + 0.1;
      glow = scn.addGlow(
        g,
        s,
        [
          {
            geometry: new THREE.BoxGeometry(fw, 0.02, 0.01),
            position: [0, sc.y + fh / 2, front + 0.02],
          },
          {
            geometry: new THREE.BoxGeometry(fw, 0.02, 0.01),
            position: [0, sc.y - fh / 2, front + 0.02],
          },
          {
            geometry: new THREE.BoxGeometry(0.02, fh, 0.01),
            position: [-fw / 2, sc.y, front + 0.02],
          },
          {
            geometry: new THREE.BoxGeometry(0.02, fh, 0.01),
            position: [fw / 2, sc.y, front + 0.02],
          },
        ],
        { size: 0.8, position: [0, sc.y, front + 0.03] },
      );
      // One holstered cable per connector (`dispenserHolsters`): a CCS and
      // CHAdeMO dispenser two, a one-EVSE triple-outlet one three.
      // Two EVSEs: the first on the left, the second on the right (`holsterSlots`).
      for (const slot of holsterSlots(s.evseConnectors ?? [s.cables?.[0] ?? 2])) {
        const { side, backM } = slot;
        // The holster on the cabinet's side wall, the plug's nose in it and its grip out to the side.
        const x = side * DC_HOLSTER_X;
        const kind = slotKind(s, slot.evse, slot.connector);
        const plugged = slotInUse(s, slot.evse, slot.connector);
        scn.holsteredConnector(
          g,
          kind,
          { x, y: DC_HOLSTER_Y, z: DC_HOLSTER.z - backM },
          { x: side, z: 0 },
          plugged,
        );
        // Its cable hanger on the side wall (empty while the cable is plugged in).
        g.add(
          scn.cableHanger(
            dcHangerSpec(kind),
            dcCoilPlace(side, backM, kind).mount,
            (side * Math.PI) / 2,
            rubber,
          ),
        );
        // Out of its gland, looped over the hanger, up into the handle (site-layout-charger-cables.ts).
        if (!plugged) {
          g.add(
            scn.cable(
              dcHolsterCable(side, backM, kind, scn.cableGround ?? undefined).map(
                (p) => [p[0], p[1], p[2]] as [number, number, number],
              ),
              rubber,
              CONNECTOR_SPECS[kind].cableDiameterM / 2,
            ),
          );
        }
      }
      for (const bx of [-DC_BOLLARD.x, DC_BOLLARD.x]) g.add(scn.pipeBollard(bx, DC_BOLLARD_Z));
      top = markerY(chargerModelTopM('dc'));
    } else {
      // Ports per EVSE (CHARGER_PORT_LIMITS.ac: at most two).
      const ports = Math.min(2, s.evseConnectors?.length ?? 1) === 2 ? 2 : 1;
      const curbPost = scn.layout.lot.siteType === 'curbside' && ports === 1;
      const acCable = CONNECTOR_SPECS[slotKind(s, 0, 0)].cableDiameterM;
      const kit = curbPost
        ? scn.chargerKit(`curb-post:${String(acCable)}`, () => createCurbPostKit(acCable))
        : scn.chargerKit(`ac:${String(ports)}:${String(acCable)}`, () =>
            createAcPedestalKit(ports, acCable),
          );
      g.add(
        scn.modelOf(
          kit,
          curbPost ? 'curb-post' : 'ac-pedestal',
          scn.chargerMaterials(shell, dark, accent, glass, light),
        ),
      );
      const coilAt = acCoilPlace(-1, acCable).center;
      g.add(scn.marker('coil', [coilAt[0], coilAt[1] - 0.14, coilAt[2]]));
      const ap = AC_PEDESTAL;
      scn.addScreenMessage(g, s, 'ac57in', [0, ap.screen.y, ap.frontZ + 0.0145]);
      // The charging glow: a ring around the first port's status lens.
      const lensX = ports === 2 ? -0.075 : 0;
      glow = scn.addGlow(
        g,
        s,
        [
          {
            geometry: scn.socketRing(ap.lensR + 0.018),
            position: [lensX, ap.lensY, ap.frontZ + 0.016],
          },
        ],
        { size: 0.55, position: [0, ap.lensY + 0.06, ap.frontZ + 0.03] },
      );
      // A holster and its connector on each side of the head, one per port, each
      // with a cable hanger peg on the column under it (empty while plugged in).
      for (const slot of holsterSlots(ports === 2 ? [1, 1] : [1])) {
        const kind = slotKind(s, slot.evse, 0);
        const plugged = slotInUse(s, slot.evse, 0);
        const d = CONNECTOR_SPECS[kind].cableDiameterM;
        const end = scn.holsteredConnector(
          g,
          kind,
          { x: slot.side * AC_HOLSTER_X, y: AC_HOLSTER_Y, z: 0 },
          { x: slot.side, z: 0 },
          plugged,
        );
        g.add(
          scn.cableHanger(
            acHangerSpec(d),
            acCoilPlace(slot.side, d).mount,
            (slot.side * Math.PI) / 2,
            rubber,
          ),
        );
        // Out of its gland, looped over the hanger, up into the handle (site-layout-charger-cables.ts).
        if (!plugged) {
          g.add(
            scn.cable(
              acHolsterCable(
                acGlandX(ports, slot.side),
                slot.side,
                d,
                end,
                scn.cableGround ?? undefined,
              ).map((p) => [p[0], p[1], p[2]] as [number, number, number]),
              rubber,
              d / 2,
            ),
          );
        }
      }
      top = markerY(chargerModelTopM('ac'));
    }
    return { top, labelZ, glow };
  }
  scn.chargerBody = chargerBody;
}

/** The charger models a 2D card pictures. */
export type IdleChargerModel =
  | 'dc-dispenser'
  | 'ac-pedestal'
  | 'ac-pedestal-dual'
  | 'curb-post'
  | 'wall-box'
  | 'split-satellite'
  | 'bus-dispenser'
  | 'mcs-dispenser'
  | 'pantograph';

/** The idle, lit station of each model (the scene's defaults: CCS1 and CHAdeMO for DC, J1772 for AC). */
function idleStation(model: IdleChargerModel, lightColor: string): SceneStation {
  const base: Omit<SceneStation, 'kind'> = {
    id: `idle:${model}`,
    bay: { col: 0, row: 0 },
    lightColor,
    lit: true,
    pulsing: false,
    glow: false,
    wall: false,
    prop: null,
    terminals: [],
    blinking: false,
  };
  const dcKinds: ConnectorKind[] = ['ccs1', 'chademo'];
  switch (model) {
    case 'dc-dispenser':
      return { ...base, kind: 'dc', cables: [2], evseConnectors: [2], connectorKinds: [dcKinds] };
    case 'split-satellite':
      return { ...base, kind: 'dc', dispensers: [0], cables: [2], connectorKinds: [dcKinds] };
    case 'ac-pedestal':
    case 'curb-post':
      return { ...base, kind: 'ac', cables: [1], evseConnectors: [1], connectorKinds: [['type1']] };
    case 'ac-pedestal-dual':
      return {
        ...base,
        kind: 'ac',
        cables: [2],
        evseConnectors: [1, 1],
        connectorKinds: [['type1'], ['type1']],
      };
    case 'wall-box':
      return {
        ...base,
        kind: 'ac',
        wall: true,
        cables: [1],
        evseConnectors: [1],
        connectorKinds: [['type1']],
      };
    case 'bus-dispenser':
      return {
        ...base,
        kind: 'dc',
        charger: 'bus_dispenser',
        free: { x: 0, z: 0, rotationDeg: 0, spotType: 'bus_bay' },
        connectorKinds: [['ccs1']],
      };
    case 'pantograph':
      return {
        ...base,
        kind: 'dc',
        charger: 'pantograph_down',
        free: { x: 0, z: 0, rotationDeg: 0, spotType: 'bus_bay' },
        connectorKinds: [['ccs1']],
      };
    case 'mcs-dispenser':
      return {
        ...base,
        kind: 'dc',
        charger: 'truck_mcs',
        free: { x: 0, z: 0, rotationDeg: 0, spotType: 'truck_pull_through' },
        connectorKinds: [['mcs']],
      };
  }
}

/**
 * The charger of `model` as the scene builds it for an idle, lit station:
 * its body, every holster with its handle seated, the cable hangers and each
 * idle cable looped over its hanger into the handle (the MCS dispenser with
 * its cable management arm stowed). No pad, signs, wheel stops, bollards,
 * vehicles, glow, logo, card readers or screen text. Station frame at the
 * origin, facing +z. `dispose` frees every geometry, material and texture it made.
 */
export function buildIdleChargerModel(
  model: IdleChargerModel,
  options: { plateColor: string; dark: boolean },
): { group: THREE.Group; dispose: () => void } {
  // The status light in the available color, as an idle station shows it.
  const lightColor = STATUS_COLORS['available'] ?? options.plateColor;
  const scn = {} as SceneCtx;
  // No sign, ring or overlay is drawn here: the theme colors are never read.
  scn.theme = {
    dark: options.dark,
    signs: ENGLISH_SIGN_TEXTS,
    virtualColors: { reserved: lightColor, maintenance: lightColor },
    plateColors: { ac: options.plateColor, dc: options.plateColor },
    primary: lightColor,
    destructive: lightColor,
  };
  scn.layout = {
    lot: {
      siteType: model === 'curb-post' ? 'curbside' : 'parking_lot',
      rowLengths: [1],
      cols: 1,
      rows: 1,
      spotW: 2.6,
      spotD: 5.5,
      lane: 7,
      pitch: 12.5,
      width: 2.6,
      depth: 5.5,
      facing: 0,
      mounting: 'wall',
      depot: null,
    },
    stations: [],
    transformers: [],
    batteries: [],
    solar: [],
    panels: [],
    links: { segments: [], labels: [] },
  };
  scn.logo = null;
  scn.chargeFlowTextures = [];
  installKit(scn);
  installCables(scn);
  installConnectors(scn);
  installDressing(scn);
  installLargeChargers(scn);
  installChargerModel(scn);
  scn.cableGround = null;
  // Only the charger: no screen text, glow, logo or bollards.
  scn.addScreenMessage = () => undefined;
  scn.addGlow = () => null;
  scn.cabinetGlow = () => null;
  scn.logoPanel = () => new THREE.Group();
  scn.pipeBollard = () => new THREE.Group();
  const palette = options.dark ? SCENE_COLORS.dark : SCENE_COLORS.light;
  const s = idleStation(model, lightColor);
  const g = new THREE.Group();
  scn.chargerBody(g, s, palette, {
    shell: scn.M(palette.shell, { roughness: 0.35, metalness: 0.25 }),
    dark: scn.M(SCENE_COLORS.dark1, { roughness: 0.6 }),
    rubber: scn.M(SCENE_COLORS.rubber, { roughness: 0.9 }),
    glass: scn.M(SCENE_COLORS.glass, {
      roughness: 0.08,
      metalness: 0.3,
      emissive: SCENE_COLORS.screenGlow,
      emissiveIntensity: 0.55,
    }),
    light: scn.M(s.lightColor, { emissive: s.lightColor, emissiveIntensity: 0.9 }),
    accent: scn.M(options.plateColor, { roughness: 0.4 }),
  });
  return {
    group: g,
    dispose: () => {
      for (const item of scn.built) item.dispose();
      for (const kit of scn.carKits.values()) for (const geo of kit.geometries) geo.dispose();
      for (const kit of scn.connectorKits.values()) for (const geo of kit.geometries) geo.dispose();
      for (const kit of scn.modelKits.values()) for (const geo of kit.geometries) geo.dispose();
      for (const t of scn.chargeFlowTextures) t.dispose();
      scn.built = [];
    },
  };
}
