// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The RFID card reader pads of the 3D site scene (site-layout-model-rfid-pad.ts):
// the pad model on a charger face and, on its window, the tap label (a card
// and radio waves, "Tap RFID card" in the viewer's language), one label
// texture per build shared by every pad.

import * as THREE from 'three';
import { SCENE_COLORS } from './site-layout-colors';
import type { Vec3 } from './site-layout-model-kit';
import {
  RFID_CAPTION_PX,
  RFID_LABEL_PX,
  RFID_PAD,
  createRfidPadKit,
  drawRfidCaption,
  drawRfidLabel,
  drawRfidPictogram,
  rfidLabelZ,
} from './site-layout-model-rfid-pad';
import type { WallBoxRingReader } from './site-layout-model-wall-box';
import type { SceneSlice } from './site-layout-scene-context';
import { SIGN_FONT_FAMILY } from './site-layout-signs';

type RfidCtx = SceneSlice<
  'M' | 'built' | 'modelKit' | 'modelOf' | 'theme' | 'track',
  'addRfidPad' | 'addRingReader'
>;

export function installRfidPads(scn: RfidCtx): void {
  // Built once per scene build (the build's disposables free them).
  let cached: {
    built: unknown;
    text: string;
    label: THREE.Material | null;
    bezel: THREE.Material;
    window: THREE.Material;
  } | null = null;
  function parts(): NonNullable<typeof cached> {
    const text = scn.theme.signs.rfidTap;
    if (cached?.built === scn.built && cached.text === text) return cached;
    let label: THREE.Material | null = null;
    const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    const ctx = canvas?.getContext('2d') ?? null;
    // fail-open: without a 2D context the pad shows its plain window, no label
    if (canvas != null && ctx != null) {
      canvas.width = RFID_LABEL_PX;
      canvas.height = RFID_LABEL_PX;
      drawRfidLabel(ctx, text, SIGN_FONT_FAMILY);
      const texture = scn.track(new THREE.CanvasTexture(canvas));
      texture.colorSpace = THREE.SRGBColorSpace;
      // Seen at a slant from a standing height (three.js caps it at the GPU maximum).
      texture.anisotropy = 8;
      label = scn.track(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    }
    cached = {
      built: scn.built,
      text,
      label,
      bezel: scn.M(SCENE_COLORS.dark1, { roughness: 0.45, metalness: 0.2 }),
      window: scn.M(SCENE_COLORS.dark1, { roughness: 0.15, metalness: 0.3 }),
    };
    return cached;
  }

  /**
   * An RFID pad on the face through `at` (its mounting point), facing +z of
   * `g` turned `turnY` about y and tilted `tiltX` about x (a curved fascia).
   * `windowM`: its window (a wall box's compact one).
   */
  function addRfidPad(
    g: THREE.Object3D,
    at: Vec3,
    o: { windowM?: number; tiltX?: number; turnY?: number } = {},
  ): THREE.Group {
    const windowM = o.windowM ?? RFID_PAD.windowM;
    const p = parts();
    const pad = scn.modelOf(
      scn.modelKit(`rfid-pad:${String(windowM)}`, () => createRfidPadKit(windowM)),
      'rfid-pad',
      { bezel: p.bezel, window: p.window },
    );
    if (p.label != null) {
      const side = windowM * RFID_PAD.labelShare;
      const plane = new THREE.Mesh(scn.track(new THREE.PlaneGeometry(side, side)), p.label);
      plane.position.z = rfidLabelZ();
      plane.userData['rfidLabel'] = true;
      pad.add(plane);
    }
    pad.position.set(at[0], at[1], at[2]);
    pad.rotation.set(o.tiltX ?? 0, o.turnY ?? 0, 0, 'YXZ');
    g.add(pad);
    return pad;
  }
  scn.addRfidPad = addRfidPad;

  // The ring reader's two textures (the pictogram, the tap line), per build and language.
  let ringCached: {
    built: unknown;
    text: string;
    pictogram: THREE.Material | null;
    caption: THREE.Material | null;
  } | null = null;
  function canvasMaterial(
    w: number,
    h: number,
    draw: (ctx: CanvasRenderingContext2D) => void,
  ): THREE.Material | null {
    const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    const ctx = canvas?.getContext('2d') ?? null;
    // fail-open: without a 2D context the ring shows its plain light, no pictogram
    if (canvas == null || ctx == null) return null;
    canvas.width = w;
    canvas.height = h;
    draw(ctx);
    const texture = scn.track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return scn.track(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  }
  function ringParts(): NonNullable<typeof ringCached> {
    const text = scn.theme.signs.rfidTap;
    if (ringCached?.built === scn.built && ringCached.text === text) return ringCached;
    ringCached = {
      built: scn.built,
      text,
      pictogram: canvasMaterial(RFID_LABEL_PX, RFID_LABEL_PX, (ctx) => {
        drawRfidPictogram(ctx);
      }),
      caption: canvasMaterial(RFID_CAPTION_PX.width, RFID_CAPTION_PX.height, (ctx) => {
        drawRfidCaption(ctx, text, SIGN_FONT_FAMILY);
      }),
    };
    return ringCached;
  }

  /**
   * A wall box port's ring reader (`wallBoxRingReaders`, the ring is the
   * reader): the tap pictogram on a dark disc inside the status ring and the
   * tap line just below it, `dz` added to their z (the facade).
   */
  function addRingReader(g: THREE.Object3D, reader: WallBoxRingReader, dz = 0): THREE.Group {
    const p = ringParts();
    const out = new THREE.Group();
    out.userData['model'] = 'rfid-ring-reader';
    const disc = new THREE.Mesh(
      scn.track(new THREE.CircleGeometry(reader.disc.radiusM, 40)),
      p.pictogram ?? scn.M(SCENE_COLORS.dark1, { roughness: 0.15, metalness: 0.3 }),
    );
    disc.position.set(reader.disc.at[0], reader.disc.at[1], reader.disc.at[2] + dz);
    disc.rotation.x = reader.disc.tiltX;
    disc.userData['rfidPictogram'] = true;
    out.add(disc);
    // The tap line's strip (plain dark where no 2D canvas draws its words).
    const c = reader.caption;
    const line = new THREE.Mesh(
      scn.track(new THREE.PlaneGeometry(c.widthM, c.heightM)),
      p.caption ?? scn.M(SCENE_COLORS.dark1, { roughness: 0.45, metalness: 0.2 }),
    );
    line.position.set(c.at[0], c.at[1], c.at[2] + dz);
    line.rotation.x = c.tiltX;
    line.userData['rfidLabel'] = true;
    out.add(line);
    g.add(out);
    return out;
  }
  scn.addRingReader = addRingReader;
}
