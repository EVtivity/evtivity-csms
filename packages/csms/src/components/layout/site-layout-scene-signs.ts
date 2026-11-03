// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// EV charging and virtual status sign textures of the 3D site scene.

import * as THREE from 'three';
import { SCENE_COLORS } from './site-layout-colors';
import { VIRTUAL_SIGN_OPACITY, type VirtualSign } from './site-layout-grid';
import { SIGN_FONT_FAMILY, signCanvasSize, signLetterPx, signLines } from './site-layout-signs';

import type { SceneCtx } from './site-layout-scene-context';
import { VIRTUAL_SIGN_WIDTH_M } from './site-layout-scene-types';

export function installSigns(scn: SceneCtx): void {
  // An EV charging sign face, drawn in code at the sign's proportions: the
  // R7-113 (No Parking Except While Charging: red legend and border on white,
  // 12 by 18 in, MUTCD 11th Edition Section 2B.53) or the California
  // tow-away sign of Vehicle Code 22511(d)(1) (17 by 22 in, its required
  // statement; the reclaim place and telephone are the operator's, left blank).
  function evSignTexture(kind: 'chargingOnly' | 'towAway'): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    const ink = kind === 'chargingOnly' ? SCENE_COLORS.signRegulatoryRed : SCENE_COLORS.signInk;
    const face = signCanvasSize(kind);
    canvas.width = face.width;
    canvas.height = face.height;
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = ink;
      ctx.lineWidth = face.border;
      ctx.strokeRect(
        face.inset,
        face.inset,
        canvas.width - 2 * face.inset,
        canvas.height - 2 * face.inset,
      );
      ctx.fillStyle = ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // The legend in the viewer's language (`signTexts`), line by line,
      // each as large as the sign's letter height allows (`signLetterPx`).
      const lines = signLines(
        kind === 'chargingOnly' ? scn.theme.signs.chargingOnly : scn.theme.signs.towAway,
      );
      const step = (canvas.height - 2 * face.marginY) / lines.length;
      const floor = signLetterPx(kind, 0);
      lines.forEach((line, i) => {
        let size = signLetterPx(kind, step);
        ctx.font = `800 ${String(size)}px ${SIGN_FONT_FAMILY}`;
        while (size > floor && ctx.measureText(line).width > canvas.width - 2 * face.marginX) {
          size -= 2;
          ctx.font = `800 ${String(size)}px ${SIGN_FONT_FAMILY}`;
        }
        ctx.fillText(line, canvas.width / 2, face.marginY + step * (i + 0.5));
      });
    }
    const texture = scn.track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = scn.renderer.capabilities.getMaxAnisotropy();
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    return texture;
  }
  scn.evSignTexture = evSignTexture;

  // A virtual status sign (`VirtualSign`): not a physical sign, so it looks
  // like an overlay: a translucent rounded panel in the CSMS state color with
  // a soft glow and a light outline, the word in the viewer's language. The
  // sprite material draws it at VIRTUAL_SIGN_OPACITY, always facing the camera.
  function virtualSignTexture(kind: VirtualSign): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 176;
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      const color = scn.theme.virtualColors[kind];
      const r = 44;
      const path = (inset: number): void => {
        const x = 24 + inset;
        const y = 24 + inset;
        const w = canvas.width - 48 - inset * 2;
        const h = canvas.height - 48 - inset * 2;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r - inset);
      };
      ctx.shadowColor = color;
      ctx.shadowBlur = 22;
      path(0);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.shadowBlur = 0;
      path(4);
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.stroke();
      const text = (
        kind === 'reserved' ? scn.theme.signs.reserved : scn.theme.signs.maintenance
      ).toLocaleUpperCase();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let size = 64;
      ctx.font = `700 ${String(size)}px ${SIGN_FONT_FAMILY}`;
      while (size > 22 && ctx.measureText(text).width > canvas.width - 110) {
        size -= 2;
        ctx.font = `700 ${String(size)}px ${SIGN_FONT_FAMILY}`;
      }
      ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
    }
    const texture = scn.track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  // The virtual status sign of a station: a sprite over its spot (station frame).
  function virtualSignSprite(kind: VirtualSign, stationId: string): THREE.Sprite {
    const material = scn.track(
      new THREE.SpriteMaterial({
        map: virtualSignTexture(kind),
        transparent: true,
        opacity: VIRTUAL_SIGN_OPACITY,
        depthWrite: false,
      }),
    );
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(VIRTUAL_SIGN_WIDTH_M, (VIRTUAL_SIGN_WIDTH_M * 176) / 512, 1);
    sprite.renderOrder = 3;
    sprite.userData['virtualSign'] = stationId;
    scn.virtualSprites.set(stationId, sprite);
    return sprite;
  }
  scn.virtualSignSprite = virtualSignSprite;

  // The transformer warning sign: a yellow plate with a high voltage triangle.
  function warningTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 220;
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = SCENE_COLORS.warning;
      ctx.fillRect(0, 0, 256, 220);
      ctx.strokeStyle = SCENE_COLORS.warningInk;
      ctx.lineWidth = 14;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(128, 24);
      ctx.lineTo(232, 196);
      ctx.lineTo(24, 196);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = SCENE_COLORS.warningInk;
      ctx.beginPath();
      ctx.moveTo(138, 70);
      ctx.lineTo(104, 136);
      ctx.lineTo(130, 136);
      ctx.lineTo(116, 180);
      ctx.lineTo(154, 116);
      ctx.lineTo(128, 116);
      ctx.closePath();
      ctx.fill();
    }
    const texture = scn.track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
  scn.warningTexture = warningTexture;
}
