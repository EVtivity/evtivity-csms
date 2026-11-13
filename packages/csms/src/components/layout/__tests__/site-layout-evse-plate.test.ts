// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TFunction } from 'i18next';
import { buildIdleChargerModel } from '../site-layout-scene-charger-model';
import {
  EVSE_PLATE,
  acEvsePlate,
  createEvsePlateKit,
  dcEvsePlate,
  drawEvseDigit,
  type DigitContext,
} from '../site-layout-model-evse-plate';
import { DC_HOLSTER, DC_SIDE_OUTLET, DC_SIDE_X } from '../site-layout-model-dc-dispenser';
import { AC_PEDESTAL } from '../site-layout-model-ac-pedestal';
import { BUS_DISPENSER_HOLSTERS } from '../site-layout-model-bus-dispenser';
import { evsePlateHoverKey, parseEvsePlateHoverKey } from '../site-layout-scene-evse-plates';
import { evseLampState, evsePlateLabel } from '../site-layout-evse-lamp';
import en from '@/i18n/locales/en.json';
import de from '@/i18n/locales/de.json';
import es from '@/i18n/locales/es.json';
import ko from '@/i18n/locales/ko.json';
import zh from '@/i18n/locales/zh.json';
import zhTW from '@/i18n/locales/zh-TW.json';

function plates(g: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  g.traverse((o) => {
    if (o.userData['model'] === 'evse-plate') out.push(o);
  });
  return out;
}

describe('EVSE number plates', () => {
  it('puts one plate per EVSE on a dual-port pedestal, port 1 on the left, none on one port', () => {
    const dual = buildIdleChargerModel('ac-pedestal-dual', { plateColor: '#336699', dark: false });
    dual.group.updateMatrixWorld(true);
    const xs = plates(dual.group).map((p) => p.getWorldPosition(new THREE.Vector3()).x);
    expect(xs).toHaveLength(2);
    expect(xs[0]).toBeLessThan(0);
    expect(xs[1]).toBeGreaterThan(0);
    dual.dispose();
    for (const model of ['ac-pedestal', 'curb-post', 'wall-box', 'dc-dispenser'] as const) {
      const one = buildIdleChargerModel(model, { plateColor: '#336699', dark: false });
      expect(plates(one.group), model).toHaveLength(0);
      one.dispose();
    }
  });

  it('puts a plate per outlet on a dual-outlet bus dispenser, outlet 1 on the left, none on one outlet', () => {
    const dual = buildIdleChargerModel('bus-dispenser-dual', {
      plateColor: '#336699',
      dark: false,
    });
    dual.group.updateMatrixWorld(true);
    const at = plates(dual.group).map((p) => p.getWorldPosition(new THREE.Vector3()));
    expect(at.map((v) => Math.sign(v.x))).toEqual([-1, 1]);
    // Over each outlet's holster, inside the 40 to 70 in band of 2010 ADA 703.5.5.
    for (const v of at) {
      expect(v.y).toBeCloseTo(BUS_DISPENSER_HOLSTERS[0]![1] + 0.26, 5);
      expect(v.y).toBeGreaterThan(40 * 0.0254);
      expect(v.y).toBeLessThan(70 * 0.0254);
    }
    dual.dispose();
    for (const model of ['bus-dispenser', 'mcs-dispenser', 'pantograph'] as const) {
      const one = buildIdleChargerModel(model, { plateColor: '#336699', dark: false });
      expect(plates(one.group), model).toHaveLength(0);
      one.dispose();
    }
  });

  it('gives a split satellite its own plate', () => {
    const sat = buildIdleChargerModel('split-satellite', { plateColor: '#336699', dark: false });
    expect(plates(sat.group)).toHaveLength(1);
    sat.dispose();
  });

  it('mounts a DC plate on its side wall over the holsters and under the outlet vent', () => {
    for (const side of [-1, 1] as const) {
      const one = dcEvsePlate(side, [0]);
      expect(one.at[0]).toBeCloseTo(side * DC_SIDE_X);
      expect(one.at[2]).toBeCloseTo(DC_HOLSTER.z);
      const two = dcEvsePlate(side, [0, 0.25]);
      expect(two.at[2]).toBeCloseTo(DC_HOLSTER.z - 0.125);
      expect(two.at[1] - EVSE_PLATE.heightM / 2).toBeGreaterThan(DC_HOLSTER.y + 0.15);
      expect(two.at[1] + EVSE_PLATE.heightM / 2).toBeLessThan(DC_SIDE_OUTLET.yMin);
      // Facing out of its own side wall.
      expect(Math.sin(two.turnY)).toBeCloseTo(side);
    }
    const ac = acEvsePlate(-1);
    expect(ac.at[0]).toBeCloseTo(-AC_PEDESTAL.head.widthM / 2);
    expect(ac.at[1] + EVSE_PLATE.heightM / 2).toBeLessThan(AC_PEDESTAL.head.topM - 0.06);
  });

  it('builds the plate from rounded parts with a bezel, not a box', () => {
    const kit = createEvsePlateKit();
    expect(kit.slotTriangles.plate ?? 0).toBeGreaterThan(12);
    expect(kit.slotTriangles.bezel ?? 0).toBeGreaterThan(40);
  });

  it('draws the EVSE number on the face', () => {
    const texts: string[] = [];
    const ctx: DigitContext = {
      fillStyle: '',
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      fillRect: () => undefined,
      fillText: (t) => texts.push(t),
    };
    drawEvseDigit(ctx, 2, 'sans-serif');
    expect(texts).toEqual(['2']);
  });

  it('round-trips the hover key, station ids with colons included', () => {
    expect(parseEvsePlateHoverKey(evsePlateHoverKey('sta_a:b', 1))).toEqual({
      stationId: 'sta_a:b',
      index: 1,
    });
    expect(parseEvsePlateHoverKey('screen:dc:sta_1')).toBeNull();
    expect(parseEvsePlateHoverKey('evse:sta_1:x')).toBeNull();
  });
});

describe('EVSE lamp state', () => {
  const evse = (status: string, plugged = false) => ({
    connectors: [{ status, isPluggedIn: plugged }],
  });
  it('shows the EVSE its own state, a faulted connector on its EVSE only', () => {
    expect(evseLampState({ status: 'available', state: 'faulted' }, evse('available')).state).toBe(
      'available',
    );
    const faulted = evseLampState({ status: 'available', state: 'faulted' }, evse('faulted'));
    expect(faulted).toEqual({ state: 'faulted', pulsing: false, blinking: true });
    const charging = evseLampState(
      { status: 'charging', state: 'charging' },
      evse('charging', true),
    );
    expect(charging).toEqual({ state: 'charging', pulsing: true, blinking: false });
    // Plugged in, no energy: the charging color, steady.
    expect(
      evseLampState({ status: 'charging', state: 'charging' }, evse('suspended_ev', true)).pulsing,
    ).toBe(false);
  });

  it('shows the station state on every EVSE while the whole station is in it', () => {
    for (const state of ['maintenance', 'unavailable', 'offline'] as const) {
      expect(evseLampState({ status: 'available', state }, evse('charging', true)).state).toBe(
        state,
      );
    }
    expect(evseLampState({ status: 'faulted', state: 'faulted' }, evse('available')).state).toBe(
      'faulted',
    );
  });
});

describe('EVSE plate label', () => {
  const t = ((key: string, o: { n: number; types: string }) =>
    key === 'sites.layoutView.evsePlateHover'
      ? `EVSE ${String(o.n)}, ${o.types}`
      : key) as unknown as TFunction;

  it('names the EVSE and its connector types once each, joined in the viewer language', () => {
    const e = {
      evseId: 1,
      connectors: [
        { connectorType: 'CCS1' },
        { connectorType: 'CHAdeMO' },
        { connectorType: 'CCS1' },
      ],
    };
    expect(evsePlateLabel(t, 'en', e)).toBe('EVSE 1, CCS1 and CHAdeMO');
    expect(evsePlateLabel(t, 'de', e)).toBe('EVSE 1, CCS1 und CHAdeMO');
  });

  it('has the label in all six locales', () => {
    for (const locale of [en, de, es, ko, zh, zhTW]) {
      const text = locale.sites.layoutView.evsePlateHover;
      expect(text).toContain('{{n}}');
      expect(text).toContain('{{types}}');
    }
  });
});
