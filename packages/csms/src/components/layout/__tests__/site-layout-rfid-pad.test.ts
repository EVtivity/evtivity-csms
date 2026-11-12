// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildIdleChargerModel, type IdleChargerModel } from '../site-layout-scene-charger-model';
import {
  RFID_CAPTION_PX,
  RFID_LABEL_PX,
  RFID_PAD,
  RFID_PAD_MAX_CENTER_M,
  RFID_PAD_MIN_CENTER_M,
  createRfidPadKit,
  drawRfidCaption,
  drawRfidLabel,
  drawRfidPictogram,
  rfidLabelLines,
  type LabelContext,
} from '../site-layout-model-rfid-pad';
import { ENGLISH_SIGN_TEXTS, SIGN_TEXT_KEYS } from '../site-layout-signs';
import { AC_WALL_BOX, wallBoxRingReaders, wallBoxRings } from '../site-layout-model-wall-box';
import { WALL_BOX_BOTTOM_M } from '../site-layout-marker';
import { SURFACE_M } from '../site-layout-cable-surface';
import en from '@/i18n/locales/en.json';
import de from '@/i18n/locales/de.json';
import es from '@/i18n/locales/es.json';
import ko from '@/i18n/locales/ko.json';
import zh from '@/i18n/locales/zh.json';
import zhTW from '@/i18n/locales/zh-TW.json';

/** How many RFID pads each charger carries (one per AC port, one per satellite, one per DC body). */
const PADS: Record<IdleChargerModel, number | 'per-satellite'> = {
  'dc-dispenser': 1,
  'dc-dispenser-dual': 1,
  'dc-dispenser-dual-four': 1,
  'ac-pedestal': 1,
  'ac-pedestal-dual': 2,
  'curb-post': 1,
  // A wall box has no pad: each port's status ring is its reader (`RING_READERS`).
  'wall-box': 0,
  'wall-box-dual': 0,
  'split-satellite': 'per-satellite',
  'bus-dispenser': 1,
  'bus-dispenser-dual': 1,
  'mcs-dispenser': 1,
  pantograph: 1,
};

/** The wall boxes, whose status ring is the reader of its port (owner decision 2026-11-10). */
const RING_READERS: Partial<Record<IdleChargerModel, number>> = {
  'wall-box': 1,
  'wall-box-dual': 2,
};

function byModel(g: THREE.Object3D, name: string): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  g.traverse((o) => {
    if (o.userData['model'] === name) out.push(o);
  });
  return out;
}

describe('RFID reader pads', () => {
  // One test per charger model: all models in one test came close to the 5 s
  // limit on a loaded CI runner with coverage on.
  it.each(Object.entries(PADS) as Array<[IdleChargerModel, number | string]>)(
    'puts the pads on the %s inside the 15 to 48 in reach range',
    (model, want) => {
      const built = buildIdleChargerModel(model, { plateColor: '#336699', dark: false });
      built.group.updateMatrixWorld(true);
      const pads = byModel(built.group, 'rfid-pad');
      const expected: number =
        want === 'per-satellite' ? byModel(built.group, 'split-satellite').length : Number(want);
      expect(expected + (RING_READERS[model] ?? 0), model).toBeGreaterThan(0);
      expect(pads.length, model).toBe(expected);
      for (const pad of pads) {
        const y = pad.getWorldPosition(new THREE.Vector3()).y;
        expect(y, model).toBeGreaterThanOrEqual(RFID_PAD_MIN_CENTER_M);
        expect(y, model).toBeLessThanOrEqual(RFID_PAD_MAX_CENTER_M);
      }
      built.dispose();
    },
  );

  it('makes each wall box status ring its port reader, centered and in reach, nothing proud of the ring', () => {
    for (const [model, want] of Object.entries(RING_READERS) as Array<[IdleChargerModel, number]>) {
      const built = buildIdleChargerModel(model, { plateColor: '#336699', dark: false });
      built.group.updateMatrixWorld(true);
      const readers = byModel(built.group, 'rfid-ring-reader');
      expect(readers.length, model).toBe(want);
      const rings = wallBoxRings(WALL_BOX_BOTTOM_M, want === 2 ? 2 : 1);
      readers.forEach((reader, i) => {
        const parts: THREE.Object3D[] = [];
        reader.traverse((o) => {
          if (o.userData['rfidPictogram'] === true || o.userData['rfidLabel'] === true)
            parts.push(o);
        });
        const disc = parts.find((o) => o.userData['rfidPictogram'] === true);
        const line = parts.find((o) => o.userData['rfidLabel'] === true);
        expect(disc, model).toBeDefined();
        expect(line, model).toBeDefined();
        const ring = rings[i];
        if (disc == null || line == null || ring == null) return;
        const d = disc.position;
        // The pictogram on the ring's center, the tap line under it on the same line.
        expect(d.x, model).toBeCloseTo(ring.at[0], 6);
        expect(d.y, model).toBeCloseTo(ring.at[1], 6);
        expect(line.position.x, model).toBeCloseTo(ring.at[0], 6);
        expect(line.position.y, model).toBeLessThan(
          ring.at[1] - AC_WALL_BOX.ring.radiusM - AC_WALL_BOX.ring.tubeM,
        );
        // The reader inside the 15 to 48 in reach range above the sidewalk (2010 ADA 308).
        const y = disc.getWorldPosition(new THREE.Vector3()).y - SURFACE_M.sidewalk;
        expect(y, model).toBeGreaterThanOrEqual(15 * 0.0254);
        expect(y, model).toBeLessThanOrEqual(48 * 0.0254);
      });
      // One port: everything on the box's center line.
      if (want === 1) expect(readers[0]?.children[0]?.position.x).toBeCloseTo(0, 6);
      built.dispose();
    }
    // Flat on the fascia behind the ring's front: nothing protrudes past it (2010 ADA 307.2).
    for (const ports of [1, 2] as const) {
      const readers = wallBoxRingReaders(WALL_BOX_BOTTOM_M, ports);
      wallBoxRings(WALL_BOX_BOTTOM_M, ports).forEach((ring, i) => {
        const r = readers[i];
        expect(r?.disc.at[2] ?? Infinity).toBeLessThan(ring.at[2] + AC_WALL_BOX.ring.tubeM);
        expect(r?.caption.at[2] ?? Infinity).toBeLessThan(ring.at[2] + AC_WALL_BOX.ring.tubeM);
        expect(r?.disc.radiusM ?? 1).toBeLessThan(
          AC_WALL_BOX.ring.radiusM - AC_WALL_BOX.ring.tubeM,
        );
      });
    }
  });

  it('draws the pictogram card and waves, and the tap line on one line', () => {
    const calls: string[] = [];
    const ctx: LabelContext = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      fillRect: () => calls.push('fillRect'),
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      arc: () => calls.push('arc'),
      arcTo: () => undefined,
      closePath: () => undefined,
      stroke: () => calls.push('stroke'),
      fill: () => calls.push('fill'),
      fillText: (t) => calls.push(`text:${t}`),
      measureText: (t) => ({ width: t.length * 40 }),
    };
    drawRfidPictogram(ctx);
    expect(calls.filter((c) => c === 'arc')).toHaveLength(3);
    expect(calls.some((c) => c.startsWith('text:'))).toBe(false);
    calls.length = 0;
    drawRfidCaption(ctx, ENGLISH_SIGN_TEXTS.rfidTap, 'sans-serif');
    expect(calls.filter((c) => c.startsWith('text:'))).toEqual([
      `text:${ENGLISH_SIGN_TEXTS.rfidTap}`,
    ]);
    // The font shrinks until the line fits the strip.
    expect(Number(/(\d+)px/.exec(ctx.font)?.[1])).toBeLessThan(RFID_CAPTION_PX.height * 0.62);
  });

  it('keeps the two pads of a dual-port pedestal apart, one per port side', () => {
    const built = buildIdleChargerModel('ac-pedestal-dual', { plateColor: '#336699', dark: false });
    built.group.updateMatrixWorld(true);
    const xs = byModel(built.group, 'rfid-pad')
      .map((p) => p.getWorldPosition(new THREE.Vector3()).x)
      .sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(0);
    expect(xs[1]).toBeGreaterThan(0);
    expect((xs[1] ?? 0) - (xs[0] ?? 0)).toBeGreaterThan(RFID_PAD.windowM + 2 * RFID_PAD.bezelM);
    built.dispose();
  });

  it('builds the pad as a bezel round a recessed window, not a plain box', () => {
    const kit = createRfidPadKit();
    // Rounded outlines with an opening, far more than the 12 triangles of a box.
    expect(kit.slotTriangles.bezel ?? 0).toBeGreaterThan(40);
    expect(kit.slotTriangles.window ?? 0).toBeGreaterThan(12);
  });

  it('splits a long tap line into two balanced lines', () => {
    const measure = (s: string): number => s.length * 10;
    expect(rfidLabelLines('Tap RFID card', measure, 200)).toEqual(['Tap RFID card']);
    expect(rfidLabelLines('Acerque la tarjeta RFID', measure, 150)).toEqual([
      'Acerque la',
      'tarjeta RFID',
    ]);
    expect(rfidLabelLines('  ', measure, 100)).toEqual([]);
  });

  it('draws the card, the waves and the words on the label', () => {
    const calls: string[] = [];
    const ctx: LabelContext = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      fillRect: () => calls.push('fillRect'),
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      arc: () => calls.push('arc'),
      arcTo: () => undefined,
      closePath: () => undefined,
      stroke: () => calls.push('stroke'),
      fill: () => undefined,
      fillText: (t) => calls.push(`text:${t}`),
      measureText: (t) => ({ width: t.length * 14 }),
    };
    drawRfidLabel(ctx, ENGLISH_SIGN_TEXTS.rfidTap, 'sans-serif');
    expect(calls.filter((c) => c === 'arc')).toHaveLength(3);
    expect(calls.filter((c) => c.startsWith('text:')).join(' ')).toContain('Tap RFID card');
    expect(RFID_LABEL_PX).toBeGreaterThanOrEqual(128);
  });

  it('has the tap line in all six locales', () => {
    expect(SIGN_TEXT_KEYS.rfidTap).toBe('sites.layoutSigns.rfidTap');
    for (const locale of [en, de, es, ko, zh, zhTW]) {
      const text = locale.sites.layoutSigns.rfidTap;
      expect(typeof text).toBe('string');
      expect(text.trim().length).toBeGreaterThan(0);
    }
    expect(en.sites.layoutSigns.rfidTap).toBe(ENGLISH_SIGN_TEXTS.rfidTap);
  });
});
