// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// What a charger carries in the 3D site scene: logo, charging glow, materials and bollards.

import * as THREE from 'three';
import { SCENE_COLORS } from './site-layout-colors';
import {
  CHARGER_LOGO_PANELS,
  chargingGlowLevel,
  logoFit,
  type ChargerLogoModel,
} from './site-layout-grid';
import { createSiteBollardKit } from './site-layout-model-bollard';
import type { ChargerSlot } from './site-layout-model-charger-parts';

import type { SceneCtx } from './site-layout-scene-context';
import { type Palette, type SceneStation, type StationObject } from './site-layout-scene-types';

export const LOGO_PADDING = 0.03;

/** Loads a logo as a canvas (SVG rasterized), or null when it cannot load. */
export function loadLogoCanvas(url: string): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    // A logo on another origin needs CORS, or the canvas could not feed WebGL.
    if (!url.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload = () => {
      const w = img.naturalWidth || 512;
      const h = img.naturalHeight || 512;
      const scale = 512 / Math.max(w, h);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      if (ctx == null) {
        resolve(null);
        return;
      }
      try {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        // Reading a pixel throws on a tainted canvas (a cross-origin logo without CORS).
        ctx.getImageData(0, 0, 1, 1);
        resolve(canvas);
      } catch (err) {
        console.warn('The company logo cannot be drawn on the 3D chargers', err);
        resolve(null);
      }
    };
    img.onerror = () => {
      console.warn('The company logo did not load for the 3D chargers');
      resolve(null);
    };
    img.src = url;
  });
}

export function installDressing(scn: SceneCtx): void {
  // The logo panel of a charger model (`CHARGER_LOGO_PANELS`): a plain plate
  // with the logo fitted on it, padded, never stretched. `at`: the cabinet
  // center of a large model, the wall box offset of a wall box.
  function logoPanel(
    model: ChargerLogoModel,
    palette: Palette,
    at: { x: number; z: number } = { x: 0, z: 0 },
  ): THREE.Group {
    const spec = CHARGER_LOGO_PANELS[model];
    const g = new THREE.Group();
    // A side panel: its face frame turned about the model center `at`.
    const turn = spec.turn ?? 0;
    g.position.set(
      at.x + spec.x * Math.cos(turn) + spec.z * Math.sin(turn),
      0,
      at.z - spec.x * Math.sin(turn) + spec.z * Math.cos(turn),
    );
    g.rotation.y = turn;
    g.userData['logoPanel'] = model;
    const plate = scn.box(
      spec.width,
      spec.height,
      0.012,
      scn.M(palette.signPlate, { roughness: 0.4 }),
    );
    plate.position.set(0, spec.y, 0);
    g.add(plate);
    if (scn.logo != null) {
      const size = logoFit(spec, { width: scn.logo.width, height: scn.logo.height }, LOGO_PADDING);
      if (size.width > 0) {
        const face = new THREE.Mesh(
          scn.track(new THREE.PlaneGeometry(size.width, size.height)),
          scn.track(
            new THREE.MeshStandardMaterial({
              map: scn.logo.texture,
              transparent: true,
              roughness: 0.5,
            }),
          ),
        );
        // The plane faces +z: turned to the back for a back panel.
        if (spec.facing < 0) face.rotation.y = Math.PI;
        face.position.set(0, spec.y, spec.facing * 0.008);
        face.userData['logo'] = true;
        g.add(face);
      }
    }
    return g;
  }
  scn.logoPanel = logoPanel;

  // The charging glow of a station front: an emissive strip (the frame or
  // ring meshes given) and a soft halo in front of it, both in the state color.
  function addGlow(
    g: THREE.Group,
    s: SceneStation,
    strips: Array<{ geometry: THREE.BufferGeometry; position: [number, number, number] }>,
    halo: { size: number; position: [number, number, number] },
  ): StationObject['glow'] {
    if (!s.glow) return null;
    const level = chargingGlowLevel(null);
    const strip = scn.M(s.lightColor, {
      emissive: s.lightColor,
      emissiveIntensity: level.intensity,
      roughness: 0.3,
    });
    for (const part of strips) {
      const mesh = new THREE.Mesh(scn.track(part.geometry), strip);
      mesh.position.set(...part.position);
      g.add(mesh);
    }
    const haloMaterial = scn.track(
      new THREE.MeshBasicMaterial({
        color: s.lightColor,
        map: scn.glowTexture(),
        transparent: true,
        opacity: level.halo,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const glowPlane = new THREE.Mesh(
      scn.track(new THREE.PlaneGeometry(halo.size, halo.size)),
      haloMaterial,
    );
    glowPlane.position.set(...halo.position);
    glowPlane.raycast = () => undefined;
    glowPlane.renderOrder = 3;
    g.add(glowPlane);
    return { strip, halo: haloMaterial };
  }
  scn.addGlow = addGlow;

  // A ring around a round socket, facing +z.
  const socketRing = (radius: number) => new THREE.TorusGeometry(radius, 0.012, 8, 32);
  scn.socketRing = socketRing;

  // The glow frame around a cabinet screen.
  function cabinetGlow(
    g: THREE.Group,
    s: SceneStation,
    c: [number, number, number],
  ): StationObject['glow'] {
    const [x, y, z] = c;
    return addGlow(
      g,
      s,
      [
        { geometry: new THREE.BoxGeometry(0.58, 0.026, 0.012), position: [x, y + 0.225, z] },
        { geometry: new THREE.BoxGeometry(0.58, 0.026, 0.012), position: [x, y - 0.225, z] },
        { geometry: new THREE.BoxGeometry(0.026, 0.476, 0.012), position: [x - 0.277, y, z] },
        { geometry: new THREE.BoxGeometry(0.026, 0.476, 0.012), position: [x + 0.277, y, z] },
      ],
      { size: 1.0, position: [x, y, z + 0.01] },
    );
  }
  scn.cabinetGlow = cabinetGlow;

  // The materials of a charger kit (site-layout-model-charger-parts.ts) for one station.
  // The shared ones are made once per rebuild (reset in `rebuild`).
  scn.chargerShared = null;
  function chargerMaterials(
    shell: THREE.Material,
    trim: THREE.Material,
    accent: THREE.Material,
    glass: THREE.Material,
    light: THREE.Material,
  ): Record<ChargerSlot, THREE.Material> {
    scn.chargerShared ??= {
      metal: scn.M(SCENE_COLORS.chargerMetal, { roughness: 0.35, metalness: 0.8 }),
      rubber: scn.M(SCENE_COLORS.rubber, { roughness: 0.9 }),
      stop: scn.M(SCENE_COLORS.emergencyStop, { roughness: 0.35 }),
      warn: scn.M(SCENE_COLORS.warning, { roughness: 0.5 }),
    };
    return { shell, trim, accent, glass, light, ...scn.chargerShared };
  }
  scn.chargerMaterials = chargerMaterials;

  // A pipe bollard standing on y = 0 (site-layout-model-bollard.ts), `heightM` above its base.
  scn.bollardMaterials = null;
  function pipeBollard(x: number, z: number, heightM?: number, baseY = 0): THREE.Group {
    const palette = scn.theme.dark ? SCENE_COLORS.dark : SCENE_COLORS.light;
    scn.bollardMaterials ??= {
      paint: scn.M(SCENE_COLORS.bollard, { roughness: 0.5 }),
      band: scn.M(SCENE_COLORS.reflectiveBand, { roughness: 0.3, metalness: 0.2 }),
      concrete: scn.M(palette.concrete, { roughness: 0.95 }),
      sleeve: scn.M(SCENE_COLORS.dark1, { roughness: 0.8 }),
    };
    const kit = scn.modelKit(`bollard:${String(heightM ?? 'default')}`, () =>
      createSiteBollardKit(heightM),
    );
    const g = scn.modelOf(kit, 'bollard', scn.bollardMaterials);
    g.position.set(x, baseY, z);
    return g;
  }
  scn.pipeBollard = pipeBollard;
}
