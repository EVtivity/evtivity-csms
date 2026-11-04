// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Builds the whole 3D site scene from the layout and applies the selection.

import {
  FREE_LAYOUT,
  SPLIT_SYSTEM,
  freeFootprint,
  freeSpotTypeOf,
} from '@evtivity/lib/site-layout';
import * as THREE from 'three';
import { SCENE_COLORS } from './site-layout-colors';
import {
  CURB_M,
  bayToWorld as bayToLot,
  buildingFramePoints,
  customSceneBox,
  groundBox,
  layoutGroundBox,
  panBox,
  pointsBox,
  rotateBox,
  sceneBox,
  spotRect,
  type Box,
  type Point,
} from './site-layout-grid';
import { lotRaisedRects } from './site-layout-ground';
import { linkPolyline } from './site-layout-link-curve';
import { dryTransformerPad, dryTransformerSize } from './site-layout-model-dry-transformer';
import { equipmentBollards, equipmentPadBox, type EquipmentGround } from './site-layout-links';
import { carportFrame, carportTopY } from './site-layout-solar';

import type { SceneSlice } from './site-layout-scene-context';
import { mergesStations } from './site-layout-scene-merge';
import { LINK_Y, PANELBOARD, PANEL_LABEL_Y } from './site-layout-scene-types';

/** The charge flow along a battery or solar run sits around its 0.05 m feeder tube. */
const SUPPLY_FLOW_RADIUS_M = 0.05;

type RebuildCtx = SceneSlice<
  | 'M'
  | 'addAccessibleSpace'
  | 'batteryObjects'
  | 'box'
  | 'buildBuilding'
  | 'buildDepotYard'
  | 'buildFreeSolarCanopy'
  | 'buildLink'
  | 'buildModel'
  | 'buildParkingRows'
  | 'buildSolarCanopy'
  | 'chargeFlowPath'
  | 'buildStreet'
  | 'chargeFlowTextures'
  | 'editGrid'
  | 'editing'
  | 'energyLabels'
  | 'flowTextures'
  | 'fog'
  | 'grassTexture'
  | 'ground'
  | 'guideGroup'
  | 'guideMaterial'
  | 'handleTemplates'
  | 'layout'
  | 'linkLabels'
  | 'linkMeshes'
  | 'lotPoint'
  | 'mergeStations'
  | 'objects'
  | 'pipeBollard'
  | 'poseOf'
  | 'rowCenterZ'
  | 'scene'
  | 'screenScrolls'
  | 'selected'
  | 'selectedSolar'
  | 'showGuides'
  | 'signPosts'
  | 'site'
  | 'solarObjects'
  | 'solarRowCarport'
  | 'spotTexture'
  | 'sun'
  | 'templates'
  | 'theme'
  | 'track'
  | 'transformerObjects'
  | 'virtualSprites',
  | 'applySelection'
  | 'bollardMaterials'
  | 'built'
  | 'chargerShared'
  | 'connectorMaterialSet'
  | 'frameBox'
  | 'haloTexture'
  | 'lotBox'
  | 'pan'
  | 'rebuild'
  | 'siteBox'
  | 'siteRaisedRects'
  | 'solarTextureCache'
>;

export function installRebuild(scn: RebuildCtx): void {
  function rebuild(): void {
    for (const item of scn.built) item.dispose();
    scn.built = [];
    scn.haloTexture = null;
    scn.solarTextureCache = null;
    scn.flowTextures.length = 0;
    scn.chargeFlowTextures.length = 0;
    scn.handleTemplates.clear();
    scn.connectorMaterialSet = null;
    scn.chargerShared = null;
    scn.bollardMaterials = null;
    scn.linkMeshes.clear();
    scn.screenScrolls.length = 0;
    scn.objects.clear();
    scn.transformerObjects.clear();
    scn.batteryObjects.clear();
    scn.solarObjects.clear();
    scn.energyLabels.clear();
    scn.linkLabels.clear();
    scn.virtualSprites.clear();
    scn.ground.clear();
    scn.site.clear();
    scn.editGrid.clear();
    const { lot } = scn.layout;
    scn.site.rotation.y = lot.facing;
    scn.site.add(scn.editGrid);
    scn.showGuides([]);
    scn.guideMaterial.color.set(scn.theme.primary);
    scn.site.add(scn.guideGroup);
    const palette = scn.theme.dark ? SCENE_COLORS.dark : SCENE_COLORS.light;
    // The fog and the background are the grass haze: the ground fades into
    // itself toward the horizon and fills the whole stage at any zoom and angle.
    scn.scene.background = new THREE.Color(palette.haze);
    // The room light reads as daylight on a light theme, as a dim glow at night.
    scn.scene.environmentIntensity = scn.theme.dark ? 0.25 : 0.6;
    scn.fog.color.set(palette.haze);

    const office = lot.siteType === 'office_retail';
    const street = lot.siteType === 'curbside';
    const custom = lot.siteType === 'custom';
    const outside: Point[] = [
      ...scn.layout.transformers.map((tr) => ({ x: tr.x, z: tr.z })),
      ...scn.layout.batteries.map((b) => ({ x: b.x, z: b.z })),
      ...scn.layout.solar.flatMap((pv) =>
        pv.free != null ? [{ x: pv.free.x, z: pv.free.z }] : [],
      ),
      ...scn.layout.stations.map((s) => scn.poseOf(s).point),
      ...scn.layout.panels.map((p) => ({ x: p.x, z: p.z })),
      ...(office ? buildingFramePoints(lot) : []),
    ];
    if (custom) {
      // No lot: the ground is the spots of every station and what stands beside them.
      const freeStations = scn.layout.stations.flatMap((s) =>
        s.free != null ? [{ placement: s.free, spots: s.spots ?? 1 }] : [],
      );
      scn.siteBox = customSceneBox(freeStations, outside);
      scn.lotBox = customSceneBox(freeStations, []);
    } else {
      scn.siteBox = sceneBox(lot, outside);
      scn.lotBox = sceneBox(
        lot,
        scn.layout.stations.map((s) => bayToLot(s.bay, lot)),
      );
    }
    scn.frameBox = rotateBox(scn.siteBox, lot.facing);
    scn.pan = panBox(scn.frameBox);

    // Grass under everything, far past the fog.
    const gb = groundBox(scn.frameBox, scn.pan);
    const grass = scn.grassTexture(palette);
    grass.repeat.set((gb.maxX - gb.minX) / 6, (gb.maxZ - gb.minZ) / 6);
    const grassGeometry = scn.track(new THREE.PlaneGeometry(gb.maxX - gb.minX, gb.maxZ - gb.minZ));
    grassGeometry.rotateX(-Math.PI / 2);
    const grassMesh = new THREE.Mesh(
      grassGeometry,
      scn.M('#ffffff', {
        map: grass,
        roughness: 1,
        metalness: 0,
        // The bottom layer: drawn first and without depth, so the lot, its paint
        // and every model always draw over it at any distance.
        depthWrite: false,
      }),
    );
    grassMesh.position.set((gb.minX + gb.maxX) / 2, 0, (gb.minZ + gb.maxZ) / 2);
    grassMesh.receiveShadow = true;
    grassMesh.renderOrder = -1;
    scn.ground.add(grassMesh);

    if (street) {
      scn.buildStreet(palette, gb);
    } else if (custom) {
      // Grass only: each station brings its own apron and spots (addFreeSpots).
    } else if (lot.depot != null) {
      scn.buildDepotYard(palette, lot.depot);
    } else {
      if (lot.siteType === 'parking_lot') {
        // Its rows, aisles and islands cover the whole lot.
        scn.buildParkingRows(palette);
        scn.addAccessibleSpace(palette);
      } else {
        // The paved row of an office or retail site with its aisle: one plane,
        // its spot tile repeated once per spot.
        const paving = scn.spotTexture(palette.asphalt, palette.paint);
        // One tile per spot and lane; the last row has no lane behind it, so the
        // tiles start at the front edge (v = 1) and end part way into a tile.
        const tileRows = lot.depth / lot.pitch;
        paving.repeat.set(lot.cols, tileRows);
        paving.offset.set(0, Math.ceil(tileRows - 1e-9) - tileRows);
        const lotGeometry = scn.track(new THREE.PlaneGeometry(lot.width, lot.depth));
        lotGeometry.rotateX(-Math.PI / 2);
        const lotMesh = new THREE.Mesh(
          lotGeometry,
          scn.M('#ffffff', { map: paving, roughness: 0.95, metalness: 0 }),
        );
        lotMesh.position.set(lot.width / 2, 0.012, lot.depth / 2);
        lotMesh.receiveShadow = true;
        lotMesh.frustumCulled = false;
        scn.site.add(lotMesh);
        scn.addAccessibleSpace(palette);
      }
      // The curb around the lot.
      const curb = scn.M(palette.curb, { roughness: 0.9 });
      const c = CURB_M;
      for (const [w, d, x, z] of [
        [lot.width + 2 * c, c, lot.width / 2, -c / 2],
        [lot.width + 2 * c, c, lot.width / 2, lot.depth + c / 2],
        [c, lot.depth, -c / 2, lot.depth / 2],
        [c, lot.depth, lot.width + c / 2, lot.depth / 2],
      ] as const) {
        const strip = scn.box(w, 0.14, d, curb);
        strip.position.set(x, 0.07, z);
        scn.site.add(strip);
      }
    }

    // The edit grid: one outline per spot, in one geometry (a custom site
    // shows each station's own spots instead).
    const outline: number[] = [];
    for (let r = 0; r < (custom ? 0 : lot.rows); r++) {
      for (let col = 0; col < (lot.rowLengths[r] ?? 0); col++) {
        const rect = spotRect({ col, row: r }, lot);
        const x0 = rect.minX + 0.08;
        const z0 = rect.minZ + 0.08;
        const x1 = rect.maxX - 0.08;
        const z1 = rect.maxZ - 0.08;
        outline.push(x0, 0.03, z0, x1, 0.03, z0, x1, 0.03, z0, x1, 0.03, z1);
        outline.push(x1, 0.03, z1, x0, 0.03, z1, x0, 0.03, z1, x0, 0.03, z0);
      }
    }
    const outlineGeometry = scn.track(new THREE.BufferGeometry());
    outlineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(outline, 3));
    const gridMaterial = scn.track(
      new THREE.LineBasicMaterial({ color: scn.theme.primary, transparent: true, opacity: 0.55 }),
    );
    scn.editGrid.add(new THREE.LineSegments(outlineGeometry, gridMaterial));
    scn.editGrid.visible = scn.editing;

    // Shadows cover the site.
    const cx = (scn.frameBox.minX + scn.frameBox.maxX) / 2;
    const cz = (scn.frameBox.minZ + scn.frameBox.maxZ) / 2;
    scn.sun.target.position.set(cx, 0, cz);
    scn.sun.position.set(cx - 14, 26, cz + 18);
    const extent =
      Math.max(scn.frameBox.maxX - scn.frameBox.minX, scn.frameBox.maxZ - scn.frameBox.minZ) / 2 +
      6;
    Object.assign(scn.sun.shadow.camera, {
      left: -extent,
      right: extent,
      top: extent,
      bottom: -extent,
      near: 1,
      far: 160,
    });
    scn.sun.shadow.camera.updateProjectionMatrix();

    const t = scn.templates(palette);
    scn.siteRaisedRects = lotRaisedRects(scn.layout.lot);
    if (office) scn.buildBuilding(palette);
    scn.signPosts.length = 0;
    for (const s of scn.layout.stations) {
      const obj = scn.buildModel(s, palette, t);
      scn.site.add(obj.group);
      scn.objects.set(s.id, obj);
    }
    // A large site draws its stations' fixed parts as a few merged meshes
    // (one per look), outside Edit Layout, where stations move one by one.
    if (!scn.editing && mergesStations(scn.layout.stations.length)) scn.mergeStations();
    for (const tr of scn.layout.transformers) {
      const g = t.transformer();
      g.position.set(tr.x, 0, tr.z);
      g.traverse((o) => {
        o.userData['transformerId'] = tr.id;
      });
      scn.site.add(g);
      scn.transformerObjects.set(tr.id, g);
    }
    // Transformers, batteries and switchboards stand behind bollards where a
    // vehicle could hit them (equipmentBollards, EWEB ED5-1.0800): a depot
    // yard has no curb (bollards on every side facing it); a parking lot is
    // curbed (bollards on a side closer than 5 ft to it); a custom site's
    // station aprons are curbed except the open lane ends of a truck
    // pull-through. Office or retail and curbside sites show no equipment.
    const equipmentGrounds: EquipmentGround[] =
      lot.depot != null
        ? [{ box: layoutGroundBox(lot), curbed: false }]
        : lot.siteType === 'parking_lot'
          ? [{ box: layoutGroundBox(lot), curbed: true }]
          : custom
            ? scn.layout.stations.flatMap((s) => {
                if (s.free == null) return [];
                const footprint = pointsBox(
                  freeFootprint(s.free, s.spots ?? 1),
                  FREE_LAYOUT.apronM,
                );
                return footprint == null
                  ? []
                  : [{ box: footprint, curbed: freeSpotTypeOf(s.free) !== 'truck_pull_through' }];
              })
            : [];
    if (equipmentGrounds.length > 0) {
      const pad = (x: number, z: number, w: number, d: number): Box => ({
        minX: x - w / 2,
        maxX: x + w / 2,
        minZ: z - d / 2,
        maxZ: z + d / 2,
      });
      const equipmentPads: Box[] = [
        ...scn.layout.transformers.map((tr) => equipmentPadBox(tr, 'transformer')),
        ...scn.layout.batteries.map((b) => equipmentPadBox(b, 'battery')),
        ...scn.layout.panels.flatMap((p) =>
          p.model === 'wall'
            ? []
            : p.model === 'panelboard'
              ? // A quarter turn swaps the pad's sides.
                Math.abs(Math.sin(p.turn)) > 0.5
                ? [pad(p.x, p.z, PANELBOARD.padDM, PANELBOARD.padWM)]
                : [pad(p.x, p.z, PANELBOARD.padWM, PANELBOARD.padDM)]
              : p.model === 'cabinet'
                ? [
                    pad(
                      p.x,
                      p.z,
                      SPLIT_SYSTEM.cabinet.widthM + 0.4,
                      SPLIT_SYSTEM.cabinet.depthM + 0.6,
                    ),
                  ]
                : p.model === 'dry_transformer'
                  ? (() => {
                      const { w, d } = dryTransformerPad(dryTransformerSize(p.kva ?? null));
                      // A quarter turn swaps the pad's sides.
                      return Math.abs(Math.sin(p.turn)) > 0.5
                        ? [pad(p.x, p.z, d, w)]
                        : [pad(p.x, p.z, w, d)];
                    })()
                  : [pad(p.x, p.z, 2.3, 1.5)],
        ),
      ];
      for (const padBox of equipmentPads) {
        for (const p of equipmentBollards(padBox, equipmentGrounds)) {
          const post = scn.pipeBollard(p.x, p.z);
          post.traverse((o) => {
            o.raycast = () => undefined;
          });
          scn.site.add(post);
        }
      }
    }
    for (const b of scn.layout.batteries) {
      const g = t.battery();
      g.position.set(b.x, 0, b.z);
      g.traverse((o) => {
        o.userData['batteryId'] = b.id;
      });
      scn.site.add(g);
      scn.batteryObjects.set(b.id, g);
      scn.energyLabels.set(b.id, scn.lotPoint({ x: b.x, z: b.z }, 3.1));
    }
    const builtRowCanopies = new Set<string>();
    for (const pv of scn.layout.solar) {
      if (pv.free != null) {
        const g = scn.buildFreeSolarCanopy(pv.free, palette);
        g.traverse((o) => {
          o.userData['solarId'] = pv.id;
        });
        scn.site.add(g);
        scn.solarObjects.set(pv.id, g);
        const top = carportTopY(carportFrame(0, pv.free.lengthM, pv.free.depthM, []));
        scn.energyLabels.set(pv.id, scn.lotPoint({ x: pv.free.x, z: pv.free.z }, top + 0.6));
        continue;
      }
      // Both rows of an island share one double cantilever: two canopies on
      // them build it once, each keeps its label over its own row.
      const carport = scn.solarRowCarport(pv.row);
      const key = carport.rows.join(':');
      if (!builtRowCanopies.has(key)) {
        builtRowCanopies.add(key);
        const canopy = scn.buildSolarCanopy(carport, palette);
        // Its label: the canopy of the row nearest the pointer (`pickEquipment`).
        const ids = scn.layout.solar
          .filter((o) => o.free == null && scn.solarRowCarport(o.row).rows.join(':') === key)
          .map((o) => o.id);
        canopy.traverse((o) => {
          o.userData['solarRowIds'] = ids;
        });
        scn.site.add(canopy);
      }
      const top = carportTopY(carport.frame);
      const middle = scn.lotPoint({ x: lot.width / 2, z: scn.rowCenterZ(pv.row) }, top + 0.6);
      scn.energyLabels.set(pv.id, middle);
    }
    // Panels: switchboards in a row beside the transformer, AC panelboards on
    // racks beside their AC group (site-layout-links.ts).
    for (const p of scn.layout.panels) {
      const g =
        p.model === 'wall'
          ? t.wallPanelboard()
          : p.model === 'panelboard'
            ? t.panelboard()
            : p.model === 'cabinet'
              ? t.powerCabinet()
              : p.model === 'dry_transformer'
                ? t.dryTransformer(p.kva ?? null)
                : t.switchboard();
      g.position.set(p.x, 0, p.z);
      g.rotation.y = p.turn;
      g.traverse((o) => {
        o.userData['panelId'] = p.id;
        if (p.atTransformerId != null) o.userData['dragTransformerId'] = p.atTransformerId;
      });
      scn.site.add(g);
    }
    // Links: cable runs on the ground from the transformer to the
    // switchboards, from a switchboard along its circuit's lane and row to a
    // short branch at the back of each charger.
    const nodeY = 1.0;
    for (const seg of scn.layout.links.segments) {
      const points = seg.points.map((p: Point) => scn.lotPoint(p, LINK_Y));
      scn.site.add(scn.buildLink(points, seg.kind, seg.id, seg.flowId));
      // A battery or solar run that gives supply now: the green charge flow
      // along it, from the asset toward the equipment it feeds.
      if (seg.kind === 'supply' && seg.flowing === true) {
        const line = linkPolyline(points).map((v): [number, number, number] => [v.x, v.y, v.z]);
        scn.site.add(scn.chargeFlowPath(line, SUPPLY_FLOW_RADIUS_M));
      }
    }
    for (const label of scn.layout.links.labels) {
      const y =
        label.kind === 'station' ? 1.6 : label.kind === 'panel' ? PANEL_LABEL_Y : nodeY + 0.5;
      scn.linkLabels.set(label.id, scn.lotPoint(label.point, y));
    }
    applySelection();
  }
  scn.rebuild = rebuild;

  function applySelection(): void {
    for (const [id, obj] of scn.objects) {
      obj.ring.material.color.set(scn.theme.primary);
      obj.ring.material.opacity = id === scn.selected ? 0.9 : 0;
      // An unselected ring costs a draw call for nothing.
      obj.ring.visible = id === scn.selected || scn.editing;
      if (obj.handle != null) obj.handle.visible = scn.editing && id === scn.selected;
    }
    for (const [id, g] of scn.solarObjects) {
      // A selected canopy (Edit Layout) shows in the edit color.
      g.traverse((o) => {
        if (o instanceof THREE.Mesh && o.userData['solarOutline'] === true) {
          o.visible = scn.editing && id === scn.selectedSolar;
        }
      });
      if (
        scn.editing &&
        id === scn.selectedSolar &&
        !g.children.some((c) => c.userData['solarOutline'])
      ) {
        const box3 = new THREE.Box3().setFromObject(g);
        const size = box3.getSize(new THREE.Vector3());
        const outline = new THREE.Mesh(
          scn.track(new THREE.RingGeometry(0.98, 1, 4, 1)),
          scn.track(
            new THREE.MeshBasicMaterial({
              color: scn.theme.primary,
              transparent: true,
              opacity: 0.9,
              side: THREE.DoubleSide,
            }),
          ),
        );
        outline.rotation.x = -Math.PI / 2;
        outline.rotation.z = Math.PI / 4;
        const local = Math.max(size.x, size.z);
        outline.scale.set(local * 0.75, local * 0.75, 1);
        outline.position.y = 0.05;
        outline.userData['solarOutline'] = true;
        outline.raycast = () => undefined;
        g.add(outline);
      }
    }
  }
  scn.applySelection = applySelection;
}
