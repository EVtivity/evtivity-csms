// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Edit Layout drags of the power equipment through the real picking and
// dragging code (three.js raycasting, no WebGL): a transformer moves and drops
// by its id, and so does a transformer grabbed by a switchboard standing at it
// (owner report 2026-11-04: "I am not able to drag the transformers now"; the
// switchboards drawn at their transformers took the pointer).

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { installInteraction } from '../site-layout-scene-interaction';

/** A top-down camera over a 100 m square: pixel (px, py) of a 1000 px canvas is lot point (x, z). */
function px(x: number, z: number): { clientX: number; clientY: number } {
  return { clientX: (x / 50 + 1) * 500, clientY: (z / 50 + 1) * 500 };
}

function box(userData: Record<string, unknown>): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
  m.position.y = 1;
  Object.assign(m.userData, userData);
  return m;
}

function scene(editing = true) {
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 500);
  camera.position.set(0, 100, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const site = new THREE.Group();
  const transformer = new THREE.Group();
  transformer.add(box({ transformerId: 'tfm_a' }));
  transformer.position.set(20, 0, 0);
  site.add(transformer);
  // A switchboard of the row at tfm_a, 4 m from it.
  const board = new THREE.Group();
  board.add(box({ panelId: 'pnl_swb', dragTransformerId: 'tfm_a' }));
  // The rebuild marks the whole model (site-layout-scene-rebuild.ts traverses it).
  board.traverse((o) => {
    Object.assign(o.userData, { panelId: 'pnl_swb', dragTransformerId: 'tfm_a' });
  });
  board.position.set(16, 0, 0);
  site.add(board);
  site.updateMatrixWorld(true);
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1000, height: 1000, right: 1000, bottom: 1000 }) as DOMRect;
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
  });
  const onTransformerDrop = vi.fn();
  const scn = {
    applySelection: vi.fn(),
    batteryObjects: new Map<string, THREE.Group>(),
    callbacks: {
      snapTransformer: (p: { x: number; z: number }) => p,
      onTransformerDrop,
      onBatteryDrop: vi.fn(),
      onPick: vi.fn(),
      onDrop: vi.fn(),
      isBayTaken: () => false,
    },
    camera,
    controls: { enabled: true },
    editing,
    energyLabels: new Map(),
    layout: { lot: { siteType: 'parking_lot' }, stations: [], links: { segments: [] } },
    linkLabels: new Map(),
    lotPoint: (p: { x: number; z: number }) => new THREE.Vector3(p.x, 0, p.z),
    objects: new Map(),
    poseOf: vi.fn(),
    renderer: { domElement: canvas },
    showGuides: vi.fn(),
    site,
    solarObjects: new Map<string, THREE.Group>(),
    theme: { primary: '#000', destructive: '#f00' },
    transformerObjects: new Map([['tfm_a', transformer]]),
    virtualSprites: new Map(),
  } as unknown as Parameters<typeof installInteraction>[0];
  installInteraction(scn);
  const fire = (
    name: 'onPointerDown' | 'onPointerMove' | 'onPointerUp',
    at: { clientX: number; clientY: number },
  ): void => {
    const handler = (scn as unknown as Record<string, (e: PointerEvent) => void>)[name];
    handler?.({ ...at, pointerId: 1, pointerType: 'mouse', shiftKey: false } as PointerEvent);
  };
  return { fire, transformer, board, onTransformerDrop };
}

describe('dragging power equipment in Edit Layout', () => {
  it('moves a transformer and drops it by its id, where it was grabbed staying under the pointer', () => {
    const { fire, transformer, onTransformerDrop } = scene();
    fire('onPointerDown', px(20.5, 0.5));
    fire('onPointerMove', px(25.5, 10.5));
    fire('onPointerUp', px(25.5, 10.5));
    expect(transformer.position.x).toBeCloseTo(25, 1);
    expect(transformer.position.z).toBeCloseTo(10, 1);
    expect(onTransformerDrop).toHaveBeenCalledTimes(1);
    const [id, p] = onTransformerDrop.mock.calls[0] as [string, { x: number; z: number }];
    expect(id).toBe('tfm_a');
    expect(p.x).toBeCloseTo(25, 1);
    expect(p.z).toBeCloseTo(10, 1);
  });

  it('drags the transformer by a switchboard standing at it, the switchboard moving along', () => {
    const { fire, transformer, board, onTransformerDrop } = scene();
    fire('onPointerDown', px(16, 0));
    fire('onPointerMove', px(16, -12));
    fire('onPointerUp', px(16, -12));
    expect(onTransformerDrop).toHaveBeenCalledTimes(1);
    const [id, p] = onTransformerDrop.mock.calls[0] as [string, { x: number; z: number }];
    expect(id).toBe('tfm_a');
    expect(p.x).toBeCloseTo(20, 1);
    expect(p.z).toBeCloseTo(-12, 1);
    expect(transformer.position.z).toBeCloseTo(-12, 1);
    expect(board.position.x).toBeCloseTo(16, 1);
    expect(board.position.z).toBeCloseTo(-12, 1);
  });

  it('drags nothing outside Edit Layout', () => {
    const { fire, transformer, onTransformerDrop } = scene(false);
    fire('onPointerDown', px(20, 0));
    fire('onPointerMove', px(30, 10));
    fire('onPointerUp', px(30, 10));
    expect(onTransformerDrop).not.toHaveBeenCalled();
    expect(transformer.position.x).toBe(20);
  });
});
