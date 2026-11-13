// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The RFID reader pads and wall box ring readers of the 3D site scene: where
// they mount, their tap label (one texture per build and language) and the
// plain face without a 2D canvas.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { RFID_PAD, rfidLabelZ } from '../site-layout-model-rfid-pad';
import { wallBoxRingReaders } from '../site-layout-model-wall-box';
import { installKit } from '../site-layout-scene-kit';
import { installRfidPads } from '../site-layout-scene-rfid';
import { ENGLISH_SIGN_TEXTS } from '../site-layout-signs';

type Ctx = Parameters<typeof installRfidPads>[0] & Parameters<typeof installKit>[0];

let canvases = 0;
let withContext = true;
let texts: string[] = [];

/** A 2D context that records the text drawn and accepts every other call. */
function recordingContext(): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = {
    measureText: (t: string) => ({ width: t.length * 10 }),
    fillText: (t: string) => {
      texts.push(t);
    },
  };
  return new Proxy(state, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  canvases = 0;
  texts = [];
  withContext = true;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    if (!withContext) return null;
    canvases++;
    return recordingContext();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function scene(rfidTap = ENGLISH_SIGN_TEXTS.rfidTap): Ctx {
  const scn = { theme: { signs: { ...ENGLISH_SIGN_TEXTS, rfidTap } } } as unknown as Ctx;
  installKit(scn);
  installRfidPads(scn);
  return scn;
}

describe('addRfidPad', () => {
  it('mounts the pad at its point, turned and tilted, with the tap label on its window', () => {
    const scn = scene();
    const g = new THREE.Group();
    const pad = scn.addRfidPad(g, [0.1, 1.1, 0.2], { tiltX: -0.2, turnY: Math.PI / 2 });
    expect(pad.parent).toBe(g);
    expect(pad.userData['model']).toBe('rfid-pad');
    expect(pad.position.toArray()).toEqual([0.1, 1.1, 0.2]);
    expect(pad.rotation.x).toBeCloseTo(-0.2);
    expect(pad.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(pad.rotation.order).toBe('YXZ');
    const label = pad.children.find((c) => c.userData['rfidLabel'] === true) as THREE.Mesh<
      THREE.PlaneGeometry,
      THREE.MeshBasicMaterial
    >;
    expect(label.geometry.parameters.width).toBeCloseTo(RFID_PAD.windowM * RFID_PAD.labelShare);
    expect(label.position.z).toBeCloseTo(rfidLabelZ());
    expect(label.material.map?.anisotropy).toBe(8);
    expect(texts).toContain('Tap RFID card');
  });

  it('sizes a compact window and keeps one kit per window size', () => {
    const scn = scene();
    const g = new THREE.Group();
    const pad = scn.addRfidPad(g, [0, 0, 0], { windowM: 0.05 });
    scn.addRfidPad(g, [0, 0, 0]);
    scn.addRfidPad(g, [0, 0, 0], { windowM: 0.05 });
    const label = pad.children.find(
      (c) => c.userData['rfidLabel'] === true,
    ) as THREE.Mesh<THREE.PlaneGeometry>;
    expect(label.geometry.parameters.width).toBeCloseTo(0.05 * RFID_PAD.labelShare);
    expect([...scn.modelKits.keys()].sort()).toEqual([
      'rfid-pad:0.05',
      `rfid-pad:${String(RFID_PAD.windowM)}`,
    ]);
    expect(pad.rotation.x).toBe(0);
  });

  it('draws the label once per build and language', () => {
    const scn = scene();
    const g = new THREE.Group();
    scn.addRfidPad(g, [0, 0, 0]);
    scn.addRfidPad(g, [1, 0, 0]);
    expect(canvases).toBe(1);
    (scn as { theme: Ctx['theme'] }).theme = {
      ...scn.theme,
      signs: { ...scn.theme.signs, rfidTap: 'RFID-Karte auflegen' },
    };
    scn.addRfidPad(g, [2, 0, 0]);
    expect(canvases).toBe(2);
    expect(texts).toContain('RFID-Karte auflegen');
    (scn as { built: unknown[] }).built = [];
    scn.addRfidPad(g, [3, 0, 0]);
    expect(canvases).toBe(3);
  });

  it('shows the plain window without a 2D context', () => {
    withContext = false;
    const scn = scene();
    const pad = scn.addRfidPad(new THREE.Group(), [0, 0, 0]);
    expect(pad.children.some((c) => c.userData['rfidLabel'] === true)).toBe(false);
  });
});

describe('addRingReader', () => {
  const reader = wallBoxRingReaders()[0];
  if (reader == null) throw new Error('no ring reader');

  it('puts the pictogram disc in the ring and the tap line below it, moved out by dz', () => {
    const scn = scene();
    const g = new THREE.Group();
    const out = scn.addRingReader(g, reader, 0.01);
    expect(out.parent).toBe(g);
    expect(out.userData['model']).toBe('rfid-ring-reader');
    const disc = out.children.find((c) => c.userData['rfidPictogram'] === true) as THREE.Mesh<
      THREE.CircleGeometry,
      THREE.MeshBasicMaterial
    >;
    expect(disc.geometry.parameters.radius).toBe(reader.disc.radiusM);
    expect(disc.position.z).toBeCloseTo(reader.disc.at[2] + 0.01);
    expect(disc.rotation.x).toBe(reader.disc.tiltX);
    expect(disc.material.map).not.toBeNull();
    const line = out.children.find(
      (c) => c.userData['rfidLabel'] === true,
    ) as THREE.Mesh<THREE.PlaneGeometry>;
    expect(line.geometry.parameters.width).toBe(reader.caption.widthM);
    expect(line.geometry.parameters.height).toBe(reader.caption.heightM);
    expect(line.position.y).toBeCloseTo(reader.caption.at[1]);
    expect(line.position.y).toBeLessThan(disc.position.y);
    expect(texts).toContain('Tap RFID card');
  });

  it('draws the pictogram and the caption once per build and language', () => {
    const scn = scene();
    const g = new THREE.Group();
    scn.addRingReader(g, reader);
    scn.addRingReader(g, reader);
    expect(canvases).toBe(2);
    (scn as { theme: Ctx['theme'] }).theme = {
      ...scn.theme,
      signs: { ...scn.theme.signs, rfidTap: 'Tarjeta' },
    };
    scn.addRingReader(g, reader);
    expect(canvases).toBe(4);
  });

  it('shows plain dark faces without a 2D context', () => {
    withContext = false;
    const scn = scene();
    const out = scn.addRingReader(new THREE.Group(), reader);
    const disc = out.children[0] as THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>;
    const line = out.children[1] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
    expect(disc.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(disc.material.map).toBeNull();
    expect(line.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(out.children[0]?.position.z).toBeCloseTo(reader.disc.at[2]);
  });
});
