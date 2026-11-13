// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// What a charger carries in the 3D site scene: the company logo (loaded as a
// canvas, fitted on its panel), the charging glow, the shared charger
// materials and the pipe bollards.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SCENE_COLORS } from '../site-layout-colors';
import { CHARGER_LOGO_PANELS, chargingGlowLevel, logoFit } from '../site-layout-grid';
import { installDressing, loadLogoCanvas, LOGO_PADDING } from '../site-layout-scene-dressing';
import { installKit } from '../site-layout-scene-kit';
import type { SceneStation } from '../site-layout-scene-types';

type Ctx = Parameters<typeof installDressing>[0] & Parameters<typeof installKit>[0];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An image that loads (or fails) as soon as its source is set. */
function stubImage(opts: { width: number; height: number; fail?: boolean }) {
  const made: { crossOrigin: string | null; src: string }[] = [];
  class FakeImage {
    crossOrigin: string | null = null;
    naturalWidth = opts.width;
    naturalHeight = opts.height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(v: string) {
      made.push({ crossOrigin: this.crossOrigin, src: v });
      queueMicrotask(() => {
        if (opts.fail === true) this.onerror?.();
        else this.onload?.();
      });
    }
  }
  vi.stubGlobal('Image', FakeImage);
  return made;
}

function stubContext(ctx: Partial<CanvasRenderingContext2D> | null): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as CanvasRenderingContext2D | null,
  );
}

describe('loadLogoCanvas', () => {
  it('draws a wide logo 512 px wide, keeping its shape, without CORS for a data URL', async () => {
    const made = stubImage({ width: 1024, height: 256 });
    const drawImage = vi.fn();
    stubContext({ drawImage, getImageData: vi.fn() });
    const canvas = await loadLogoCanvas('data:image/png;base64,AA');
    expect(canvas?.width).toBe(512);
    expect(canvas?.height).toBe(128);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 512, 128);
    expect(made[0]?.crossOrigin).toBeNull();
  });

  it('asks for CORS on another origin and sizes an SVG without a natural size at 512 px', async () => {
    const made = stubImage({ width: 0, height: 0 });
    stubContext({ drawImage: vi.fn(), getImageData: vi.fn() });
    const canvas = await loadLogoCanvas('https://cdn.example/logo.svg');
    expect(made[0]?.crossOrigin).toBe('anonymous');
    expect(canvas?.width).toBe(512);
    expect(canvas?.height).toBe(512);
  });

  it('gives no canvas for a tainted logo, with a warning', async () => {
    stubImage({ width: 100, height: 100 });
    stubContext({
      drawImage: vi.fn(),
      getImageData: vi.fn(() => {
        throw new Error('tainted');
      }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await loadLogoCanvas('https://cdn.example/logo.png')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('gives no canvas without a 2D context or when the logo fails to load', async () => {
    stubImage({ width: 100, height: 100 });
    stubContext(null);
    expect(await loadLogoCanvas('data:x')).toBeNull();
    stubImage({ width: 100, height: 100, fail: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await loadLogoCanvas('https://cdn.example/missing.png')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

function scene(
  opts: { dark?: boolean; logo?: { width: number; height: number } | null } = {},
): Ctx {
  const scn = {
    theme: { dark: opts.dark ?? false },
    logo:
      opts.logo == null
        ? null
        : { texture: new THREE.CanvasTexture(document.createElement('canvas')), ...opts.logo },
    glowTexture: () => new THREE.Texture(),
  } as unknown as Ctx;
  installKit(scn);
  installDressing(scn);
  return scn;
}

function sceneStation(over: Partial<SceneStation> = {}): SceneStation {
  return { glow: true, lightColor: '#22c55e', ...over } as unknown as SceneStation;
}

describe('logoPanel', () => {
  it('puts the plain plate of a back panel at its spec, without a logo', () => {
    const scn = scene();
    const spec = CHARGER_LOGO_PANELS.dc;
    const g = scn.logoPanel('dc', SCENE_COLORS.light);
    expect(g.userData['logoPanel']).toBe('dc');
    expect(g.position.x).toBeCloseTo(spec.x);
    expect(g.position.z).toBeCloseTo(spec.z);
    expect(g.rotation.y).toBe(0);
    expect(g.children).toHaveLength(1);
    const plate = g.children[0] as THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
    expect(plate.geometry.parameters.width).toBe(spec.width);
    expect(plate.geometry.parameters.height).toBe(spec.height);
    expect(plate.position.y).toBe(spec.y);
    expect(plate.material.color.getHexString()).toBe(SCENE_COLORS.light.signPlate.slice(1));
  });

  it('fits the logo on a back panel, padded and turned to face the back', () => {
    const scn = scene({ logo: { width: 400, height: 100 } });
    const spec = CHARGER_LOGO_PANELS.ac;
    const g = scn.logoPanel('ac', SCENE_COLORS.dark, { x: 1, z: 2 });
    expect(g.position.x).toBeCloseTo(1 + spec.x);
    expect(g.position.z).toBeCloseTo(2 + spec.z);
    const face = g.children.find((c) => c.userData['logo'] === true) as THREE.Mesh<
      THREE.PlaneGeometry,
      THREE.MeshStandardMaterial
    >;
    const size = logoFit(spec, { width: 400, height: 100 }, LOGO_PADDING);
    expect(face.geometry.parameters.width).toBeCloseTo(size.width);
    expect(face.geometry.parameters.height).toBeCloseTo(size.height);
    expect(face.rotation.y).toBe(Math.PI);
    expect(face.position.z).toBeCloseTo(-0.008);
    expect(face.material.map).toBe(scn.logo?.texture);
  });

  it('turns a side panel about the model center, the logo facing out', () => {
    const scn = scene({ logo: { width: 100, height: 100 } });
    const spec = CHARGER_LOGO_PANELS.pantograph_down;
    const turn = spec.turn ?? 0;
    const g = scn.logoPanel('pantograph_down', SCENE_COLORS.light);
    expect(g.rotation.y).toBe(turn);
    expect(g.position.x).toBeCloseTo(spec.x * Math.cos(turn) + spec.z * Math.sin(turn));
    expect(g.position.z).toBeCloseTo(-spec.x * Math.sin(turn) + spec.z * Math.cos(turn));
    const face = g.children.find((c) => c.userData['logo'] === true);
    expect(face?.rotation.y).toBe(0);
    expect(face?.position.z).toBeCloseTo(0.008);
  });

  it('draws no logo face for a logo without a size', () => {
    const scn = scene({ logo: { width: 0, height: 0 } });
    const g = scn.logoPanel('dc', SCENE_COLORS.light);
    expect(g.children.some((c) => c.userData['logo'] === true)).toBe(false);
  });
});

describe('charging glow', () => {
  it('adds nothing while the station does not glow', () => {
    const scn = scene();
    const g = new THREE.Group();
    expect(
      scn.addGlow(g, sceneStation({ glow: false }), [], { size: 1, position: [0, 0, 0] }),
    ).toBeNull();
    expect(g.children).toHaveLength(0);
  });

  it('lights the strips and a halo the pointer passes through, in the state color', () => {
    const scn = scene();
    const g = new THREE.Group();
    const glow = scn.addGlow(
      g,
      sceneStation(),
      [{ geometry: new THREE.BoxGeometry(1, 0.02, 0.01), position: [0, 1, 0.1] }],
      { size: 0.8, position: [0, 1, 0.12] },
    );
    const level = chargingGlowLevel(null);
    expect(glow?.strip.emissive.getHexString()).toBe('22c55e');
    expect(glow?.strip.emissiveIntensity).toBe(level.intensity);
    expect(glow?.halo.opacity).toBe(level.halo);
    expect(glow?.halo.blending).toBe(THREE.AdditiveBlending);
    expect(glow?.halo.depthWrite).toBe(false);
    expect(g.children).toHaveLength(2);
    const halo = g.children[1] as THREE.Mesh;
    expect(halo.position.toArray()).toEqual([0, 1, 0.12]);
    expect(halo.renderOrder).toBe(3);
    const hits: THREE.Intersection[] = [];
    halo.raycast(
      new THREE.Raycaster(new THREE.Vector3(0, 1, 5), new THREE.Vector3(0, 0, -1)),
      hits,
    );
    expect(hits).toHaveLength(0);
  });

  it('frames a cabinet screen with four strips around its center', () => {
    const scn = scene();
    const g = new THREE.Group();
    scn.cabinetGlow(g, sceneStation(), [1, 2, 3]);
    const strips = g.children
      .slice(0, 4)
      .map((c) => c.position.toArray().map((v) => Math.round(v * 1000) / 1000));
    expect(strips).toEqual([
      [1, 2.225, 3],
      [1, 1.775, 3],
      [0.723, 2, 3],
      [1.277, 2, 3],
    ]);
    expect(g.children[4]?.position.toArray()).toEqual([1, 2, 3.01]);
  });

  it('makes a socket ring of the given radius', () => {
    const scn = scene();
    expect(scn.socketRing(0.05).parameters).toMatchObject({ radius: 0.05, tube: 0.012 });
  });
});

describe('charger materials and bollards', () => {
  it('shares the metal, rubber, stop and warning materials within a rebuild', () => {
    const scn = scene();
    const own = () => new THREE.MeshBasicMaterial();
    const a = scn.chargerMaterials(own(), own(), own(), own(), own());
    const b = scn.chargerMaterials(own(), own(), own(), own(), own());
    expect(b.metal).toBe(a.metal);
    expect(b.rubber).toBe(a.rubber);
    expect(b.shell).not.toBe(a.shell);
    scn.chargerShared = null;
    expect(scn.chargerMaterials(own(), own(), own(), own(), own()).metal).not.toBe(a.metal);
  });

  it('stands a bollard at its point and base, one kit per height', () => {
    const scn = scene({ dark: true });
    const g = scn.pipeBollard(2, 3, 1.2, 0.15);
    expect(g.position.toArray()).toEqual([2, 0.15, 3]);
    expect(g.userData['model']).toBe('bollard');
    scn.pipeBollard(0, 0, 1.2);
    scn.pipeBollard(0, 0);
    expect([...scn.modelKits.keys()].sort()).toEqual(['bollard:1.2', 'bollard:default']);
    const concrete = scn.bollardMaterials?.concrete as THREE.MeshStandardMaterial;
    expect(concrete.color.getHexString()).toBe(SCENE_COLORS.dark.concrete.slice(1));
  });
});
