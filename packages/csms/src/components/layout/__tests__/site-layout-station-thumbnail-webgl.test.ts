// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The offscreen renderer of the 2D card station pictures, with the WebGL
// parts replaced (the test DOM has no WebGL): it frames the idle charger so it
// fills the card height from the front three-quarter view, renders once per
// request, cleans the charger up and disposes its context.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

const webgl = vi.hoisted(() => ({ available: true, throwOnCreate: false }));
const calls = vi.hoisted(() => ({
  render: [] as { scene: unknown; camera: unknown }[],
  setSize: [] as unknown[],
  disposed: 0,
  lost: 0,
  chargerDisposed: 0,
  models: [] as unknown[],
}));

vi.mock('@/lib/webgl', () => ({ webglAvailable: () => webgl.available }));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeRenderer {
    constructor() {
      if (webgl.throwOnCreate) throw new Error('no context');
    }
    setPixelRatio(): void {}
    setSize(...a: unknown[]): void {
      calls.setSize.push(a);
    }
    setClearColor(): void {}
    render(scene: unknown, camera: unknown): void {
      const cam = camera as InstanceType<typeof actual.PerspectiveCamera>;
      calls.render.push({ scene, camera: cam.clone() });
    }
    dispose(): void {
      calls.disposed++;
    }
    forceContextLoss(): void {
      calls.lost++;
    }
  }
  class FakePmrem {
    fromScene(): { texture: InstanceType<typeof actual.Texture> } {
      return { texture: new actual.Texture() };
    }
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer, PMREMGenerator: FakePmrem };
});

vi.mock('../site-layout-scene-charger-model', () => ({
  buildIdleChargerModel: (model: unknown) => {
    calls.models.push(model);
    const group = new THREE.Group();
    // A 0.6 m wide, 1.8 m tall, 0.4 m deep body standing on the ground.
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 1.8, 0.4),
      new THREE.MeshBasicMaterial(),
    );
    body.position.y = 0.9;
    group.add(body);
    return {
      group,
      dispose: () => {
        calls.chargerDisposed++;
      },
    };
  },
}));

import { createWebGlThumbnailRenderer } from '../site-layout-station-thumbnail-webgl';
import { THUMBNAIL_PIXEL_RATIO, THUMBNAIL_SIZE } from '../site-layout-station-thumbnail';

beforeEach(() => {
  webgl.available = true;
  webgl.throwOnCreate = false;
  calls.render = [];
  calls.setSize = [];
  calls.disposed = 0;
  calls.lost = 0;
  calls.chargerDisposed = 0;
  calls.models = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AA');
});

const request = {
  model: { kind: 'ac' },
  plateColor: '#336699',
  dark: false,
} as unknown as Parameters<
  NonNullable<ReturnType<typeof createWebGlThumbnailRenderer>>['render']
>[0];

describe('createWebGlThumbnailRenderer', () => {
  it('gives no renderer without WebGL', () => {
    webgl.available = false;
    expect(createWebGlThumbnailRenderer()).toBeNull();
  });

  it('gives no renderer when the context cannot be created, with a warning', () => {
    webgl.throwOnCreate = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(createWebGlThumbnailRenderer()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sizes the canvas to the card picture at its pixel ratio', () => {
    createWebGlThumbnailRenderer();
    expect(calls.setSize).toEqual([
      [
        THUMBNAIL_SIZE.width * THUMBNAIL_PIXEL_RATIO,
        THUMBNAIL_SIZE.height * THUMBNAIL_PIXEL_RATIO,
        false,
      ],
    ]);
  });

  it('frames the charger to fill the card from the front three-quarter view', () => {
    const r = createWebGlThumbnailRenderer();
    expect(r?.render(request)).toBe('data:image/png;base64,AA');
    expect(calls.models).toEqual([request.model]);
    expect(calls.render).toHaveLength(1);
    const camera = calls.render[0]?.camera as THREE.PerspectiveCamera;
    camera.updateMatrixWorld();
    const box = new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.2), new THREE.Vector3(0.3, 1.8, 0.2));
    // In front, to the right and above the middle of the charger.
    const center = box.getCenter(new THREE.Vector3());
    const dir = camera.position.clone().sub(center).normalize();
    const expected = new THREE.Vector3(0.62, 0.32, 1).normalize();
    expect(dir.x).toBeCloseTo(expected.x, 3);
    expect(dir.y).toBeCloseTo(expected.y, 3);
    expect(dir.z).toBeCloseTo(expected.z, 3);
    // Its tallest corner reaches about 97 percent of the frame height, and no corner leaves it.
    let ex = 0;
    let ey = 0;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ).project(camera);
      ex = Math.max(ex, Math.abs(p.x));
      ey = Math.max(ey, Math.abs(p.y));
    }
    expect(ey).toBeCloseTo(0.97, 2);
    expect(ex).toBeLessThanOrEqual(0.98);
    // The clip planes hold the whole charger.
    const distance = camera.position.distanceTo(center);
    expect(camera.near).toBeLessThan(distance - 1);
    expect(camera.far).toBeGreaterThan(distance + 1);
  });

  it('removes and disposes the charger after each render, also when rendering fails', () => {
    const r = createWebGlThumbnailRenderer();
    r?.render(request);
    const scene = calls.render[0]?.scene as THREE.Scene;
    expect(scene.children.filter((c) => c.type === 'Group')).toHaveLength(0);
    expect(calls.chargerDisposed).toBe(1);
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(() => {
      throw new Error('lost');
    });
    expect(() => r?.render(request)).toThrow('lost');
    expect(calls.chargerDisposed).toBe(2);
    expect(scene.children.filter((c) => c.type === 'Group')).toHaveLength(0);
  });

  it('dims the room light in the dark theme', () => {
    const r = createWebGlThumbnailRenderer();
    r?.render({ ...request, dark: true });
    expect((calls.render[0]?.scene as THREE.Scene).environmentIntensity).toBe(0.25);
    r?.render(request);
    expect((calls.render[1]?.scene as THREE.Scene).environmentIntensity).toBe(0.6);
  });

  it('releases the WebGL context on dispose', () => {
    const r = createWebGlThumbnailRenderer();
    r?.dispose();
    expect(calls.disposed).toBe(1);
    expect(calls.lost).toBe(1);
  });
});
