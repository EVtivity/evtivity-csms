// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  UNIT_NUMBER_CANVAS,
  UNIT_PLATE,
  acPedestalUnitPlate,
  createUnitPlateKit,
  dcDispenserUnitPlate,
  drawUnitNumber,
  plateUnderScreen,
  unitPlateEvseList,
  wallBoxUnitPlate,
} from '../site-layout-model-unit-plate';
import type { DigitContext } from '../site-layout-model-evse-plate';
import { AC_PEDESTAL } from '../site-layout-model-ac-pedestal';
import { DC_DISPENSER } from '../site-layout-model-dc-dispenser';
import { AC_WALL_BOX } from '../site-layout-model-wall-box';
import { parseUnitPlateHoverKey, unitPlateHoverKey } from '../site-layout-scene-unit-plates';
import en from '@/i18n/locales/en.json';
import de from '@/i18n/locales/de.json';
import es from '@/i18n/locales/es.json';
import ko from '@/i18n/locales/ko.json';
import zh from '@/i18n/locales/zh.json';
import zhTW from '@/i18n/locales/zh-TW.json';

describe('box number plate model', () => {
  it('builds the plate body and the recessed face within the plate size', () => {
    const kit = createUnitPlateKit();
    const m = new THREE.MeshBasicMaterial();
    const g = kit.build({ plate: m, face: m });
    expect(g.children.map((c) => c.name).sort()).toEqual(['face', 'plate']);
    const box = new THREE.Box3().setFromObject(g);
    const size = box.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(UNIT_PLATE.widthM, 3);
    expect(size.y).toBeCloseTo(UNIT_PLATE.heightM, 3);
    expect(size.z).toBeLessThanOrEqual(UNIT_PLATE.depthM + 1e-6);
  });

  it('fits the AC pedestal head front between the screen and the lens glow', () => {
    const at = acPedestalUnitPlate().at;
    const a = AC_PEDESTAL;
    expect(at[1] + UNIT_PLATE.heightM / 2).toBeLessThan(a.screen.y - a.screen.heightM / 2);
    expect(at[1] - UNIT_PLATE.heightM / 2).toBeGreaterThan(a.lensY + a.lensR + 0.018);
    expect(UNIT_PLATE.widthM).toBeLessThan(a.head.widthM);
    expect(at[2]).toBeGreaterThan(a.frontZ);
  });

  it('stands above the DC screen under the dispenser top, and over a wall box on the facade', () => {
    const dc = dcDispenserUnitPlate().at;
    const d = DC_DISPENSER;
    expect(dc[1] - UNIT_PLATE.heightM / 2).toBeGreaterThan(d.screen.y + d.screen.heightM / 2);
    expect(dc[1] + UNIT_PLATE.heightM / 2).toBeLessThan(d.heightM);
    const wall = wallBoxUnitPlate(0.68, 0.2).at;
    expect(wall[1] - UNIT_PLATE.heightM / 2).toBeGreaterThan(0.68 + AC_WALL_BOX.heightM);
    expect(wall[2]).toBe(0.2);
    // 6 mm off the wall: inside the 4 in an object may stand out (2010 ADA Standards 307.2).
    expect(UNIT_PLATE.depthM).toBeLessThan(0.1);
  });

  it('draws the box number white on the dark face, 30 of 40 mm high', () => {
    const calls: string[] = [];
    const ctx: DigitContext = {
      fillStyle: '',
      font: '',
      textAlign: 'start',
      textBaseline: 'alphabetic',
      fillRect: () => {
        calls.push('rect');
      },
      fillText: (text: string) => {
        calls.push(`text:${text}`);
      },
    };
    drawUnitNumber(ctx, 12, 'sans-serif');
    expect(calls).toEqual(['rect', 'text:12']);
    expect(ctx.fillStyle).toBe('#f9fafb');
    const px = Number(/(\d+)px/.exec(ctx.font)?.[1]);
    expect(px / UNIT_NUMBER_CANVAS.height).toBeCloseTo(0.75 / 0.72, 1);
  });

  it('names the EVSEs of the plate label and keys its hover', () => {
    expect(unitPlateEvseList([6, 5], 'and')).toBe('5 and 6');
    expect(unitPlateEvseList([3], 'and')).toBe('3');
    expect(unitPlateEvseList([1, 2, 3], 'und')).toBe('1, 2 und 3');
    expect(parseUnitPlateHoverKey(unitPlateHoverKey('sta_1#u3'))).toBe('sta_1#u3');
    expect(parseUnitPlateHoverKey('evse:sta_1:0')).toBeNull();
  });

  it('has the plate label in every locale', () => {
    for (const locale of [en, de, es, ko, zh, zhTW]) {
      expect(locale.layout.units.plateLabel).toContain('{{unit}}');
      expect(locale.layout.units.plateLabel).toContain('{{evses}}');
      expect(locale.layout.units.and.length).toBeGreaterThan(0);
    }
  });

  it('stands under a depot charger screen, clear of it', () => {
    const mount = plateUnderScreen([0, 1.75, 0.4], 0.34);
    expect(mount.at[1] + UNIT_PLATE.heightM / 2).toBeLessThan(1.75 - 0.34 / 2);
    expect(mount.at[2]).toBe(0.4);
  });
});
