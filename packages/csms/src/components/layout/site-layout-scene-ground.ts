// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The ground of the 3D site scene: grass, parking rows, the building, the depot yard and the street.

import { type DepotLayout } from '@evtivity/lib/site-layout';
import * as THREE from 'three';
import { SCENE_COLORS } from './site-layout-colors';
import { FACADE_LAYOUT, canopySoffitM, entranceX } from './site-layout-facade-openings';
import {
  BAY_LINE_GAP,
  BUILDING_HEIGHT_M,
  CURB_M,
  FACADE_Z,
  SIDEWALK_M,
  buildingBox,
  parkingRowGaps,
  rowFrontZ,
  type Box,
} from './site-layout-grid';
import { createFacadeCanopyKit } from './site-layout-model-facade-canopy';
import { createFacadeCorniceKit } from './site-layout-model-facade-cornice';
import { createFacadeDoorKit, facadeDoorSize } from './site-layout-model-facade-door';
import { createFacadeWindowKit } from './site-layout-model-facade-window';

import type { SceneSlice } from './site-layout-scene-context';
import { TEXTURE_PX_PER_M, type Palette } from './site-layout-scene-types';

type GroundCtx = SceneSlice<
  | 'M'
  | 'arrowGeometry'
  | 'box'
  | 'layout'
  | 'modelKit'
  | 'modelOf'
  | 'pipeBollard'
  | 'renderer'
  | 'site'
  | 'theme'
  | 'track',
  | 'addAccessibleSpace'
  | 'buildBuilding'
  | 'buildDepotYard'
  | 'buildParkingRows'
  | 'buildStreet'
  | 'flowTexture'
  | 'glowTexture'
  | 'grassTexture'
  | 'haloTexture'
  | 'spotTexture'
>;

export function installGround(scn: GroundCtx): void {
  // One spot of asphalt with its painted line on each side edge (half on each
  // side of the tile, so repeated tiles share one line) from the front gap to
  // the back gap, then the lane with a dashed center line.
  // `withLane` false: the spot alone (a parking lot row; its aisles and
  // islands are drawn apart, aisleTexture).
  function spotTexture(asphalt: string, paint: string, withLane = true): THREE.CanvasTexture {
    const { spotW, spotD, pitch } = scn.layout.lot;
    const lane = withLane ? scn.layout.lot.lane : 0;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(spotW * TEXTURE_PX_PER_M);
    canvas.height = Math.round((withLane ? pitch : spotD) * TEXTURE_PX_PER_M);
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = asphalt;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = paint;
      const half = Math.round(0.05 * TEXTURE_PX_PER_M);
      const gap = Math.round(Math.min(BAY_LINE_GAP, spotD / 6) * TEXTURE_PX_PER_M);
      const lineEnd = Math.round(spotD * TEXTURE_PX_PER_M) - gap;
      ctx.fillRect(0, gap, half, lineEnd - gap);
      ctx.fillRect(canvas.width - half, gap, half, lineEnd - gap);
      if (lane >= 3) {
        const y = Math.round((spotD + lane / 2) * TEXTURE_PX_PER_M);
        const dash = Math.round(Math.min(1.5, spotW / 2) * TEXTURE_PX_PER_M);
        ctx.globalAlpha = 0.7;
        ctx.fillRect(Math.round((canvas.width - dash) / 2), y - half, dash, half * 2);
        ctx.globalAlpha = 1;
      }
    }
    const texture = scn.track(new THREE.CanvasTexture(canvas));
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = scn.renderer.capabilities.getMaxAnisotropy();
    return texture;
  }
  scn.spotTexture = spotTexture;

  // A drive aisle of a parking lot: asphalt with a dashed center line, one tile per spot width.
  function aisleTexture(asphalt: string, paint: string): THREE.CanvasTexture {
    const { spotW, lane } = scn.layout.lot;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(spotW * TEXTURE_PX_PER_M);
    canvas.height = Math.round(lane * TEXTURE_PX_PER_M);
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = asphalt;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = paint;
      const half = Math.round(0.05 * TEXTURE_PX_PER_M);
      const dash = Math.round(Math.min(1.5, spotW / 2) * TEXTURE_PX_PER_M);
      ctx.globalAlpha = 0.7;
      ctx.fillRect(
        Math.round((canvas.width - dash) / 2),
        Math.round(canvas.height / 2) - half,
        dash,
        half * 2,
      );
      ctx.globalAlpha = 1;
    }
    const texture = scn.track(new THREE.CanvasTexture(canvas));
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = scn.renderer.capabilities.getMaxAnisotropy();
    return texture;
  }

  // A parking lot: each row of spots with its painted lines, the drive aisles
  // between rows facing each other with a dashed center line, and a raised
  // curbed concrete island between rows back to back, where both rows'
  // chargers stand (parkingRowGaps).
  function buildParkingRows(palette: Palette): void {
    const lot = scn.layout.lot;
    const plane = (w: number, d: number, material: THREE.Material, x: number, z: number) => {
      const geometry = scn.track(new THREE.PlaneGeometry(w, d));
      geometry.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, 0.012, z);
      mesh.receiveShadow = true;
      scn.site.add(mesh);
    };
    const rows = spotTexture(palette.asphalt, palette.paint, false);
    rows.repeat.set(lot.cols, 1);
    const rowMaterial = scn.M('#ffffff', { map: rows, roughness: 0.95, metalness: 0 });
    for (let r = 0; r < lot.rows; r++) {
      plane(lot.width, lot.spotD, rowMaterial, lot.width / 2, rowFrontZ(r, lot) + lot.spotD / 2);
    }
    const aisles = aisleTexture(palette.asphalt, palette.paint);
    aisles.repeat.set(lot.cols, 1);
    const aisleMaterial = scn.M('#ffffff', { map: aisles, roughness: 0.95, metalness: 0 });
    const curb = scn.M(palette.curb, { roughness: 0.9 });
    const top = scn.M(palette.concrete, { roughness: 0.95 });
    const ISLAND_H = 0.15;
    for (const gap of parkingRowGaps(lot)) {
      const depth = gap.maxZ - gap.minZ;
      const z = (gap.minZ + gap.maxZ) / 2;
      if (gap.kind === 'aisle') {
        plane(lot.width, depth, aisleMaterial, lot.width / 2, z);
        continue;
      }
      // The island: 6 in curbs on its four sides around a concrete top.
      const body = scn.box(lot.width, ISLAND_H, depth, top);
      body.position.set(lot.width / 2, ISLAND_H / 2, z);
      body.receiveShadow = true;
      scn.site.add(body);
      for (const [w, d, x, cz] of [
        [lot.width, CURB_M / 2, lot.width / 2, gap.minZ + CURB_M / 4],
        [lot.width, CURB_M / 2, lot.width / 2, gap.maxZ - CURB_M / 4],
        [CURB_M / 2, depth, CURB_M / 4, z],
        [CURB_M / 2, depth, lot.width - CURB_M / 4, z],
      ] as const) {
        const edge = scn.box(w, ISLAND_H + 0.01, d, curb);
        edge.position.set(x, (ISLAND_H + 0.01) / 2, cz);
        scn.site.add(edge);
      }
    }
  }
  scn.buildParkingRows = buildParkingRows;

  // The accessible charging space (`ACCESSIBLE_SPACE`, US Access Board EV
  // charging guidance): paint over its two spots, the widened vehicle space
  // and beside it the access aisle, its side lines and diagonal hatching
  // "to discourage parking". No International Symbol of Accessibility: the
  // Access Board recommends against it at EV spaces unless a state or local
  // code requires one. Hatch spacing and line width follow the spot lines
  // (no source gives one).
  function addAccessibleSpace(palette: Palette): void {
    const space = scn.layout.accessible;
    if (space == null) return;
    const minX = Math.min(space.vehicle.minX, space.aisle.minX);
    const maxX = Math.max(space.vehicle.maxX, space.aisle.maxX);
    const { minZ, maxZ } = space.vehicle;
    const w = maxX - minX;
    const d = maxZ - minZ;
    const px = (m: number): number => Math.round(m * TEXTURE_PX_PER_M);
    const canvas = document.createElement('canvas');
    canvas.width = px(w);
    canvas.height = px(d);
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = palette.asphalt;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = palette.paint;
      ctx.strokeStyle = palette.paint;
      const line = px(0.1);
      const gap = px(Math.min(BAY_LINE_GAP, d / 6));
      const lineAt = (m: number): void => {
        const x = Math.min(canvas.width - line, Math.max(0, px(m - minX) - line / 2));
        ctx.fillRect(x, gap, line, canvas.height - 2 * gap);
      };
      for (const edge of new Set([minX, maxX, space.aisle.minX, space.aisle.maxX])) lineAt(edge);
      // Diagonal hatching across the aisle.
      ctx.save();
      ctx.beginPath();
      ctx.rect(
        px(space.aisle.minX - minX),
        gap,
        px(space.aisle.maxX - space.aisle.minX),
        canvas.height - 2 * gap,
      );
      ctx.clip();
      ctx.lineWidth = line;
      const step = px(0.6);
      for (let y = -canvas.width; y < canvas.height + canvas.width; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y + canvas.width);
        ctx.stroke();
      }
      ctx.restore();
    }
    const texture = scn.track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = scn.renderer.capabilities.getMaxAnisotropy();
    const geometry = scn.track(new THREE.PlaneGeometry(w, d));
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(
      geometry,
      scn.M('#ffffff', { map: texture, roughness: 0.95, metalness: 0 }),
    );
    mesh.position.set((minX + maxX) / 2, 0.014, (minZ + maxZ) / 2);
    mesh.receiveShadow = true;
    scn.site.add(mesh);
  }
  scn.addAccessibleSpace = addAccessibleSpace;

  // Grass: speckles of lighter and darker blades on the base color, from a
  // fixed seed so it never flickers between rebuilds.
  function grassTexture(palette: Palette): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = palette.grass;
      ctx.fillRect(0, 0, 256, 256);
      let seed = 1234567;
      const rand = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };
      for (let i = 0; i < 2600; i++) {
        ctx.fillStyle = rand() < 0.5 ? palette.grassDark : palette.grassLight;
        ctx.globalAlpha = 0.35 + rand() * 0.4;
        ctx.fillRect(rand() * 256, rand() * 256, 1 + rand() * 2, 2 + rand() * 4);
      }
      ctx.globalAlpha = 1;
    }
    const texture = scn.track(new THREE.CanvasTexture(canvas));
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = scn.renderer.capabilities.getMaxAnisotropy();
    return texture;
  }
  scn.grassTexture = grassTexture;

  // A soft pulse that runs along a link (its u coordinate), offset every frame.
  function flowTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 4;
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      const g = ctx.createLinearGradient(0, 0, 128, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.35)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.35)');
      g.addColorStop(0.7, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0.35)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 4);
    }
    const texture = scn.track(new THREE.CanvasTexture(canvas));
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }
  scn.flowTexture = flowTexture;

  // A soft round glow, white in the middle and clear at the edge, tinted by its material.
  scn.haloTexture = null;
  function glowTexture(): THREE.CanvasTexture {
    if (scn.haloTexture != null) return scn.haloTexture;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
    }
    scn.haloTexture = scn.track(new THREE.CanvasTexture(canvas));
    return scn.haloTexture;
  }
  scn.glowTexture = glowTexture;

  // The building of an office or retail site along the front of the lot: a
  // solid ground floor with a high window strip above the wall boxes, a
  // window band with mullions on the upper floor, a cornice, the entrance with
  // glass doors and a canopy on the part right of the lot, and the sidewalk
  // with its curb in front of it.
  function buildBuilding(palette: Palette): void {
    const b = buildingBox(scn.layout.lot);
    const width = b.maxX - b.minX;
    const depth = b.maxZ - b.minZ;
    const cx = (b.minX + b.maxX) / 2;
    const H = BUILDING_HEIGHT_M;
    const wallMaterial = scn.M(palette.building, { roughness: 0.85 });
    const baseMaterial = scn.M(palette.buildingBase, { roughness: 0.8 });
    const trim = scn.M(palette.buildingTrim, { roughness: 0.6, metalness: 0.2 });
    const glassMaterial = scn.M(palette.window, {
      roughness: 0.1,
      metalness: 0.5,
      emissive: scn.theme.dark ? SCENE_COLORS.windowLight : '#000000',
      emissiveIntensity: scn.theme.dark ? 0.35 : 0,
    });
    const concrete = scn.M(palette.sidewalk, { roughness: 0.95 });
    const mass = scn.box(width, H, depth, wallMaterial);
    mass.position.set(cx, H / 2, b.minZ + depth / 2);
    scn.site.add(mass);
    const base = scn.box(width, 3.2, 0.06, baseMaterial);
    base.position.set(cx, 1.6, FACADE_Z + 0.03);
    scn.site.add(base);
    // The facade parts (site-layout-model-facade-*.ts), each standing on the wall face.
    const facade = {
      frame: trim,
      glass: glassMaterial,
      sill: scn.M(palette.concrete, { roughness: 0.9 }),
      // The fascia band in the brand color.
      fascia: scn.M(scn.theme.primary, { roughness: 0.4 }),
      metal: scn.M(SCENE_COLORS.chargerMetal, { roughness: 0.4, metalness: 0.7 }),
      light: scn.M(SCENE_COLORS.headlight, {
        emissive: SCENE_COLORS.headlight,
        emissiveIntensity: scn.theme.dark ? 1 : 0.2,
      }),
    };
    // `face`: the wall face it stands on (the ground floor's stone base stands 0.06 m proud).
    const onFacade = (part: THREE.Group, x: number, y: number, face = FACADE_Z + 0.06): void => {
      part.position.set(x, y, face);
      part.traverse((o) => {
        o.raycast = () => undefined;
      });
      scn.site.add(part);
    };
    const fl = FACADE_LAYOUT;
    const bandW = Math.max(1, width - 2 * fl.insetM);
    // The high window strip of the ground floor, above the wall boxes and their signs.
    onFacade(
      scn.modelOf(
        scn.modelKit(`facade-window:${bandW.toFixed(2)}:${String(fl.strip.heightM)}`, () =>
          createFacadeWindowKit({ widthM: bandW, heightM: fl.strip.heightM }),
        ),
        'facade-window',
        facade,
      ),
      b.minX + fl.insetM,
      fl.strip.bottomM,
    );
    const slab = scn.box(width, 0.26, 0.3, trim);
    slab.position.set(cx, 3.4, FACADE_Z + 0.15);
    scn.site.add(slab);
    // The upper floor window band with its mullions and a transom rail.
    onFacade(
      scn.modelOf(
        scn.modelKit(`facade-window:${bandW.toFixed(2)}:${String(fl.band.heightM)}`, () =>
          createFacadeWindowKit({
            widthM: bandW,
            heightM: fl.band.heightM,
            railM: fl.band.railM,
          }),
        ),
        'facade-window',
        facade,
      ),
      b.minX + fl.insetM,
      fl.band.bottomM,
      FACADE_Z,
    );
    // The cornice along the top.
    onFacade(
      scn.modelOf(
        scn.modelKit(`facade-cornice:${(width + 0.4).toFixed(2)}`, () =>
          createFacadeCorniceKit(width + 0.4),
        ),
        'facade-cornice',
        facade,
      ),
      b.minX - 0.2,
      H - 0.34,
      FACADE_Z,
    );
    // The entrance, on the building part right of the lot: a pair of glass doors under a canopy.
    const ex = entranceX(scn.layout.lot);
    const door = facadeDoorSize(2);
    onFacade(
      scn.modelOf(
        scn.modelKit('facade-door:2', () => createFacadeDoorKit(2)),
        'facade-door',
        facade,
      ),
      ex - door.widthM / 2,
      0,
    );
    // The soffit 0.25 m over the door head, above the 7 ft (2.134 m) awning clearance.
    onFacade(
      scn.modelOf(
        scn.modelKit('facade-canopy', () =>
          createFacadeCanopyKit({ widthM: fl.canopy.widthM, depthM: fl.canopy.depthM }),
        ),
        'facade-canopy',
        facade,
      ),
      ex - fl.canopy.widthM / 2,
      canopySoffitM(),
    );
    // The sidewalk from the facade to the front curb of the lot.
    const walk = scn.box(width, 0.12, -CURB_M - FACADE_Z, concrete);
    walk.position.set(cx, 0.06, (FACADE_Z - CURB_M) / 2);
    scn.site.add(walk);
  }
  scn.buildBuilding = buildBuilding;

  // A depot yard (`depotLayout`): the paved yard, the concrete
  // strip behind the bus bay heads, the bay lines, the truck lanes with their
  // edge lines and entry and exit arrows (trucks drive through in +x), the
  // raised dispenser islands with bollards, the one-way arrows of the truck
  // entry road (away from the drive lane) and exit road (back to it), the
  // dashed center line of the two-way drive lane and the curbed median
  // between the areas.
  function buildDepotYard(palette: Palette, depot: DepotLayout): void {
    const shape = new THREE.Shape();
    depot.outline.forEach((p, i) => {
      // The shape lies in x, y; turned flat, y becomes -z.
      if (i === 0) shape.moveTo(p.x, -p.z);
      else shape.lineTo(p.x, -p.z);
    });
    const yardGeometry = scn.track(new THREE.ShapeGeometry(shape));
    yardGeometry.rotateX(-Math.PI / 2);
    const yard = new THREE.Mesh(
      yardGeometry,
      scn.M(palette.asphalt, { roughness: 0.95, metalness: 0 }),
    );
    yard.position.y = 0.012;
    yard.receiveShadow = true;
    scn.site.add(yard);
    const paint = scn.M(palette.paint, { roughness: 0.6 });
    const concrete = scn.M(palette.concrete, { roughness: 0.95 });
    const curb = scn.M(palette.curb, { roughness: 0.9 });
    const line = (w: number, d: number, x: number, z: number): void => {
      const m = new THREE.Mesh(scn.track(new THREE.BoxGeometry(w, 0.006, d)), paint);
      m.position.set(x, 0.026, z);
      m.receiveShadow = true;
      scn.site.add(m);
    };
    const arrow = scn.arrowGeometry();
    // An arrow on the ground pointing along `turn` (0: +x; three.js turn about y).
    const mark = (x: number, z: number, turn: number): void => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(arrow, paint);
      m.rotation.x = -Math.PI / 2;
      g.add(m);
      g.position.set(x, 0.027, z);
      g.rotation.y = turn;
      scn.site.add(g);
    };
    if (depot.busHead != null) {
      const h = depot.busHead;
      const strip = scn.box(h.maxX - h.minX, 0.04, h.maxZ - h.minZ, concrete);
      strip.position.set((h.minX + h.maxX) / 2, 0.02, (h.minZ + h.maxZ) / 2);
      strip.receiveShadow = true;
      scn.site.add(strip);
      const edge = scn.box(h.maxX - h.minX, 0.14, 0.2, curb);
      edge.position.set((h.minX + h.maxX) / 2, 0.07, h.maxZ - 0.1);
      scn.site.add(edge);
    }
    // A line on each side of each bus bay.
    const bayXs = new Set<number>();
    for (const b of depot.bays) {
      bayXs.add(b.minX);
      bayXs.add(b.maxX);
    }
    for (const x of bayXs) line(0.12, 13.2, x, 0.3 + 6.6);
    depot.lanes.forEach((lane, i) => {
      const cz = (lane.minZ + lane.maxZ) / 2;
      const length = lane.maxX - lane.minX;
      // The edge line on the drive lane side of the first lane; the others meet an island.
      if (i === 0) line(length - 0.6, 0.12, (lane.minX + lane.maxX) / 2, lane.maxZ - 0.15);
      mark(lane.minX + 3.5, cz, 0);
      mark(lane.maxX - 2.2, cz, 0);
    });
    for (const island of depot.islands) {
      const cz = (island.minZ + island.maxZ) / 2;
      const length = island.maxX - island.minX - 2;
      const slab = scn.box(length, 0.15, island.maxZ - island.minZ - 0.3, concrete);
      slab.position.set((island.minX + island.maxX) / 2, 0.075, cz);
      scn.site.add(slab);
      for (const bx of [island.minX + 1.3, island.maxX - 1.3]) {
        scn.site.add(scn.pipeBollard(bx, cz, undefined, 0.15));
      }
    }
    if (depot.entryRoad != null) {
      const r = depot.entryRoad;
      const cx = (r.minX + r.maxX) / 2;
      for (let z = r.maxZ - 4; z > r.minZ + 2; z -= 12) mark(cx, z, Math.PI / 2);
    }
    if (depot.exitRoad != null) {
      const r = depot.exitRoad;
      const cx = (r.minX + r.maxX) / 2;
      for (let z = r.minZ + 4; z < r.maxZ - 2; z += 12) mark(cx, z, -Math.PI / 2);
    }
    // The drive lane: a dashed center line (3 m dashes every 6 m), two-way,
    // on each stretch (the truck stretch is wider).
    for (const lane of depot.driveLanes) {
      const centerZ = (lane.minZ + lane.maxZ) / 2;
      for (let x = lane.minX + 3; x + 3 <= lane.maxX; x += 6) line(3, 0.12, x + 1.5, centerZ);
    }
    if (depot.median != null) {
      const m = depot.median;
      const kerb = scn.box(m.maxX - m.minX, 0.15, m.maxZ - m.minZ, curb);
      kerb.position.set((m.minX + m.maxX) / 2, 0.075, (m.minZ + m.maxZ) / 2);
      const planting = scn.box(
        m.maxX - m.minX - 0.3,
        0.02,
        m.maxZ - m.minZ - 0.3,
        scn.M(palette.grass),
      );
      planting.position.set((m.minX + m.maxX) / 2, 0.16, (m.minZ + m.maxZ) / 2);
      scn.site.add(kerb, planting);
    }
  }
  scn.buildDepotYard = buildDepotYard;

  // A street (curbside): a parallel parking lane along each curb around two
  // travel lanes, edge lines, a dashed center line and the spot marks, curbs
  // and sidewalks on both sides. It runs far past the chargers both ways, so
  // its ends fade into the haze.
  function buildStreet(palette: Palette, along: Box): void {
    const lot = scn.layout.lot;
    const tile = lot.spotW;
    const minX = Math.floor(along.minX / tile) * tile;
    const maxX = Math.ceil(along.maxX / tile) * tile;
    const length = maxX - minX;
    const cx = (minX + maxX) / 2;
    const marks = streetTexture(palette.asphalt, palette.paint);
    marks.repeat.set(length / tile, 1);
    const roadGeometry = scn.track(new THREE.PlaneGeometry(length, lot.depth));
    roadGeometry.rotateX(-Math.PI / 2);
    const road = new THREE.Mesh(roadGeometry, scn.M('#ffffff', { map: marks, roughness: 0.95 }));
    road.position.set(cx, 0.012, lot.depth / 2);
    road.receiveShadow = true;
    road.frustumCulled = false;
    scn.site.add(road);
    const curb = scn.M(palette.curb, { roughness: 0.9 });
    const concrete = scn.M(palette.sidewalk, { roughness: 0.95 });
    for (const [curbZ, walkZ] of [
      [-CURB_M / 2, -CURB_M - SIDEWALK_M / 2],
      [lot.depth + CURB_M / 2, lot.depth + CURB_M + SIDEWALK_M / 2],
    ] as const) {
      const strip = scn.box(length, 0.14, CURB_M, curb);
      strip.position.set(cx, 0.07, curbZ);
      const walk = scn.box(length, 0.12, SIDEWALK_M, concrete);
      walk.position.set(cx, 0.06, walkZ);
      scn.site.add(strip, walk);
    }
  }
  scn.buildStreet = buildStreet;

  // One parallel spot length of the street, curb to curb: the parking lane
  // edge lines, a tick at the spot boundary in each parking lane, and the
  // dashed center line (a 3 m dash every 6 m).
  function streetTexture(asphalt: string, paint: string): THREE.CanvasTexture {
    const { spotW, spotD, depth } = scn.layout.lot;
    const px = TEXTURE_PX_PER_M;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(spotW * px);
    canvas.height = Math.round(depth * px);
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = asphalt;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = paint;
      const line = Math.round(0.12 * px);
      for (const z of [spotD, depth - spotD]) {
        ctx.fillRect(0, Math.round(z * px - line / 2), canvas.width, line);
      }
      const tick = Math.round(0.1 * px);
      ctx.fillRect(0, 0, tick, Math.round(spotD * px));
      ctx.fillRect(0, Math.round((depth - spotD) * px), tick, Math.round(spotD * px));
      ctx.globalAlpha = 0.85;
      const center = Math.round((depth / 2) * px);
      ctx.fillRect(
        Math.round(spotW * 0.25 * px),
        center - line / 2,
        Math.round(spotW * 0.5 * px),
        line,
      );
      ctx.globalAlpha = 1;
    }
    const texture = scn.track(new THREE.CanvasTexture(canvas));
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = scn.renderer.capabilities.getMaxAnisotropy();
    return texture;
  }
}
