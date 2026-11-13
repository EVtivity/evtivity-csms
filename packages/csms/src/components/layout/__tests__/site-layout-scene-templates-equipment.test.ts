// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The prop templates of the 3D site scene that stand on their own: the EV
// signs on a post or a wall, the maintenance cone, the power equipment models
// and the card readers. Each is built once per rebuild and cloned.

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { EV_SIGNS } from '@evtivity/lib/site-layout';
import { SCENE_COLORS } from '../site-layout-colors';
import { dryTransformerSize } from '../site-layout-model-dry-transformer';
import { installCables } from '../site-layout-scene-cables';
import { installConnectors } from '../site-layout-scene-connectors';
import type { SceneCtx } from '../site-layout-scene-context';
import { installKit } from '../site-layout-scene-kit';
import { installTemplates } from '../site-layout-scene-templates';
import type { StationSigns } from '../site-layout-signs';

function scene() {
  const scn = {} as SceneCtx;
  scn.theme = { dark: false } as SceneCtx['theme'];
  scn.chargeFlowTextures = [];
  installKit(scn);
  installCables(scn);
  installConnectors(scn);
  installTemplates(scn);
  const evSignTexture = vi.fn(() => new THREE.CanvasTexture(document.createElement('canvas')));
  scn.evSignTexture = evSignTexture;
  scn.warningTexture = () => new THREE.CanvasTexture(document.createElement('canvas'));
  return { scn, t: scn.templates(SCENE_COLORS.light), evSignTexture };
}

const postSigns: StationSigns = {
  x: 0,
  z: 0,
  onWall: false,
  chargingOnlyBottomM: 2.1,
  towAwayBottomM: 1.5,
  towAwayDxM: 0,
  postTopM: 2.6,
};

/** The meshes directly in a group, by their kind of geometry. */
function boxes(g: THREE.Object3D): THREE.Mesh<THREE.BoxGeometry>[] {
  return g.children.filter(
    (c): c is THREE.Mesh<THREE.BoxGeometry> =>
      (c as THREE.Mesh).geometry instanceof THREE.BoxGeometry,
  );
}

describe('EV signs', () => {
  it('stands the R7-113 over the tow-away sign on a galvanized post in its anchor', () => {
    const { t, evSignTexture } = scene();
    const g = t.evSigns(postSigns);
    const planes = g.children.filter(
      (c) => (c as THREE.Mesh).geometry instanceof THREE.PlaneGeometry,
    );
    expect(planes).toHaveLength(2);
    const [top, tow] = planes;
    expect(top?.position.y).toBeCloseTo(2.1 + EV_SIGNS.chargingOnly.heightM / 2);
    expect(tow?.position.y).toBeCloseTo(1.5 + EV_SIGNS.towAway.heightM / 2);
    // In front of the post.
    expect(top?.position.z).toBeCloseTo(0.0325);
    expect(evSignTexture).toHaveBeenCalledWith('chargingOnly', undefined);
    expect(evSignTexture).toHaveBeenCalledWith('towAway');
    const b = boxes(g);
    // Two blanks, the post and its anchor.
    expect(b).toHaveLength(4);
    const post = b[2];
    const anchor = b[3];
    expect(post?.geometry.parameters.height).toBeCloseTo(2.6);
    expect(post?.position.y).toBeCloseTo(1.3);
    expect(anchor?.geometry.parameters.height).toBeCloseTo(EV_SIGNS.anchorAboveGroundM);
    expect(anchor?.geometry.parameters.width).toBeCloseTo(EV_SIGNS.anchorWidthM);
  });

  it('hangs a wall sign flat on the facade with no post, and no tow-away sign outside California', () => {
    const { t } = scene();
    const g = t.evSigns({ ...postSigns, onWall: true, towAwayBottomM: null, postTopM: null });
    const planes = g.children.filter(
      (c) => (c as THREE.Mesh).geometry instanceof THREE.PlaneGeometry,
    );
    expect(planes).toHaveLength(1);
    expect(planes[0]?.position.z).toBeCloseTo(0.0065);
    expect(boxes(g)).toHaveLength(1);
  });

  it('draws the double-headed arrow sign of a two-port curb post and moves the tow-away sign aside', () => {
    const { t, evSignTexture } = scene();
    const g = t.evSigns({ ...postSigns, arrows: 'both', towAwayDxM: 0.4 });
    expect(evSignTexture).toHaveBeenCalledWith('chargingOnly', 'both');
    const planes = g.children.filter(
      (c) => (c as THREE.Mesh).geometry instanceof THREE.PlaneGeometry,
    );
    expect(planes[1]?.position.x).toBeCloseTo(0.4);
  });

  it('builds each sign mount once and hands out clones', () => {
    const { t, evSignTexture } = scene();
    const a = t.evSigns(postSigns);
    const b = t.evSigns(postSigns);
    expect(a).not.toBe(b);
    expect(b.children).toHaveLength(a.children.length);
    expect(evSignTexture).toHaveBeenCalledTimes(2);
  });
});

describe('cone', () => {
  it('stands the cone on its base in the spot with two reflective bands', () => {
    const { t } = scene();
    const g = t.cone();
    expect(g.position.toArray()).toEqual([0.15, 0, 2.2]);
    const cone = g.children.find(
      (c) => (c as THREE.Mesh).geometry instanceof THREE.ConeGeometry,
    ) as THREE.Mesh<THREE.ConeGeometry> | undefined;
    expect(cone?.geometry.parameters.height).toBeCloseTo(0.62);
    expect(cone?.position.y).toBeCloseTo(0.04 + 0.31);
    const bands = g.children.filter(
      (c) =>
        (c as THREE.Mesh).geometry instanceof THREE.CylinderGeometry &&
        !((c as THREE.Mesh).geometry instanceof THREE.ConeGeometry),
    ) as THREE.Mesh<THREE.CylinderGeometry>[];
    expect(bands).toHaveLength(2);
    // Each band sits just outside the cone surface at its height.
    for (const band of bands) {
      const f = (band.position.y - 0.04) / 0.62;
      const p = band.geometry.parameters;
      expect((p.radiusTop + p.radiusBottom) / 2).toBeCloseTo(0.17 * (1 - f) + 0.004, 3);
      expect(p.openEnded).toBe(true);
    }
  });
});

describe('power equipment and card readers', () => {
  it('tags every equipment model with its name', () => {
    const { t } = scene();
    expect(t.battery().userData['model']).toBe('battery');
    expect(t.transformer().userData['model']).toBe('transformer');
    expect(t.switchboard().userData['model']).toBe('switchboard');
    expect(t.powerCabinet().userData['model']).toBe('power-cabinet');
    expect(t.panelboard().userData['model']).toBe('rack-panelboard');
    expect(t.wallPanelboard().userData['model']).toBe('wall-panelboard');
    expect(t.dryTransformer(45).userData['model']).toBe('dry-transformer');
  });

  it('puts the textured warning label on the panel doors', () => {
    const { t } = scene();
    for (const g of [t.powerCabinet(), t.panelboard(), t.wallPanelboard()]) {
      const label = g.children.find(
        (c) =>
          Array.isArray((c as THREE.Mesh).material) &&
          ((c as THREE.Mesh).material as THREE.MeshStandardMaterial[])[4]?.map != null,
      );
      expect(label).toBeDefined();
    }
  });

  it('builds one dry transformer kit per standard size', () => {
    const { scn, t } = scene();
    t.dryTransformer(40);
    t.dryTransformer(dryTransformerSize(40).kva);
    t.dryTransformer(null);
    const keys = [...scn.modelKits.keys()].filter((k) => k.startsWith('dry-transformer:'));
    expect(keys.sort()).toEqual(
      [...new Set([dryTransformerSize(40).kva, dryTransformerSize(null).kva])]
        .map((k) => `dry-transformer:${String(k)}`)
        .sort(),
    );
  });

  it('lights a card reader screen and status only while it is online', () => {
    const { t } = scene();
    const materialsOf = (g: THREE.Object3D): THREE.MeshStandardMaterial[] => {
      const out = new Set<THREE.MeshStandardMaterial>();
      g.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m instanceof THREE.MeshStandardMaterial) out.add(m);
      });
      return [...out];
    };
    const online = t.terminal(true, true);
    expect(online.userData['model']).toBe('reader-screen');
    const lit = materialsOf(online).filter((m) => m.emissiveIntensity > 0.5);
    expect(lit.map((m) => m.emissive.getHexString())).toContain(
      SCENE_COLORS.terminalScreen.slice(1).toLowerCase(),
    );
    const screen = SCENE_COLORS.terminalScreen.slice(1).toLowerCase();
    const onlineLight = SCENE_COLORS.terminalOnline.slice(1).toLowerCase();
    expect(
      materialsOf(online).find((m) => m.emissive.getHexString() === onlineLight)?.emissiveIntensity,
    ).toBe(1);
    const offline = t.terminal(true, false);
    const offMats = materialsOf(offline);
    expect(offMats.some((m) => m.emissive.getHexString() === screen)).toBe(false);
    const offLight = SCENE_COLORS.terminalOffline.slice(1).toLowerCase();
    expect(offMats.find((m) => m.emissive.getHexString() === offLight)?.emissiveIntensity).toBe(
      0.1,
    );
    expect(t.terminal(false, true).userData['model']).toBe('reader-contactless');
  });
});
