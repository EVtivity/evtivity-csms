// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { EV_SIGNS, STANDARD_DIMENSIONS, freeSpotRects } from '@evtivity/lib/site-layout';
import {
  ENGLISH_SIGN_TEXTS,
  SIGN_POST_INSET_M,
  SIGN_TEXT_KEYS,
  isCaliforniaSite,
  SIGN_PX_PER_INCH,
  signCanvasSize,
  signLetterPx,
  signLines,
  signTexts,
  stationSignMount,
  signSupport,
} from '../site-layout-signs';
import { CURB_PAIR_SIGN, WALL_SIGN } from '../site-layout-signs';
import en from '@/i18n/locales/en.json';
import de from '@/i18n/locales/de.json';
import es from '@/i18n/locales/es.json';
import ko from '@/i18n/locales/ko.json';
import zh from '@/i18n/locales/zh.json';
import zhTW from '@/i18n/locales/zh-TW.json';
import { CAR_PROFILES } from '../site-layout-car';
import {
  carNoseAtStop,
  wallBoxOffset,
  wheelStopNearZ,
  type WheelStopMount,
} from '../site-layout-grid';

const base = {
  onSpot: true,
  wall: false,
  freeSpots: null,
  largeSpot: false,
  california: false,
} as const;

describe('EV charging sign placement', () => {
  it('uses the MUTCD sizes and the 7 ft mounting height', () => {
    // 12 by 18 in (R7-113, Table 2B-1), bottom 7 ft (Section 2A.15).
    expect(EV_SIGNS.chargingOnly.widthM).toBeCloseTo(0.3048, 4);
    expect(EV_SIGNS.chargingOnly.heightM).toBeCloseTo(0.4572, 4);
    expect(EV_SIGNS.mountBottomM).toBeCloseTo(2.1336, 4);
    // California tow-away: 17 by 22 in (Vehicle Code 22511(d)(1)).
    expect(EV_SIGNS.towAway.widthM).toBeCloseTo(0.4318, 4);
    expect(EV_SIGNS.towAway.heightM).toBeCloseTo(0.5588, 4);
  });

  it('gives a two-port curb post one sign with a double-headed arrow, central behind it', () => {
    const pair = stationSignMount({ ...base, siteType: 'curbside', curbPorts: 2 });
    // MUTCD 11th Edition 2B.52 and 2B.53; NKL OL3 (two arrows) and OL5 (central).
    expect(pair).toMatchObject({ x: 0, z: CURB_PAIR_SIGN.z, arrows: 'both', towAwayBottomM: null });
    expect(pair?.chargingOnlyBottomM).toBeCloseTo(EV_SIGNS.mountBottomM);
    // A one-port post keeps its sign 1 m along the curb, without an arrow.
    const one = stationSignMount({ ...base, siteType: 'curbside', curbPorts: 1 });
    expect(one).toMatchObject({ x: -1, z: 0 });
    expect(one?.arrows).toBeUndefined();
    // The sign post leaves the NKL AR22 90 cm of the sidewalk free behind it.
    expect(2.4 - (0.45 - CURB_PAIR_SIGN.z) - EV_SIGNS.postWidthM / 2).toBeGreaterThan(0.9);
  });

  it('stands a post at the head of each parking lot and office stall, beside the charger', () => {
    for (const siteType of ['parking_lot', 'office_retail'] as const) {
      const mount = stationSignMount({ ...base, siteType });
      expect(mount).toMatchObject({ z: 0, onWall: false, towAwayBottomM: null });
      expect(mount?.x).toBeCloseTo(-STANDARD_DIMENSIONS.spotWidthM / 2 + SIGN_POST_INSET_M);
      expect(mount?.chargingOnlyBottomM).toBeCloseTo(EV_SIGNS.mountBottomM);
      expect(mount?.postTopM).toBeCloseTo(EV_SIGNS.mountBottomM + EV_SIGNS.chargingOnly.heightM);
    }
  });

  it('puts the sign of a wall box flat on the facade beside it, under the window sill', () => {
    for (const california of [false, true]) {
      const mount = stationSignMount({
        ...base,
        siteType: 'office_retail',
        wall: true,
        california,
        wallZ: wallBoxOffset(),
      });
      // Beside the wall box, on the facade face, not out over the sidewalk.
      expect(mount).toMatchObject({
        x: WALL_SIGN.x,
        z: wallBoxOffset(),
        onWall: true,
        postTopM: null,
      });
      expect(mount?.chargingOnlyBottomM).toBe(WALL_SIGN.bottomM);
      // Its top under the ground floor window sill (the strip from 2.3 m, its sill 2.25 m).
      expect(WALL_SIGN.bottomM + EV_SIGNS.chargingOnly.heightM).toBeLessThan(2.25);
      // The tow-away sign under it stays on the wall above the ground.
      if (california) expect(mount?.towAwayBottomM).toBeGreaterThan(0.5);
      expect(signSupport(mount!)).toEqual({ kind: 'wall', z: wallBoxOffset() });
    }
  });

  it('stands every standing sign on a post that reaches the ground', () => {
    const cases = [
      { siteType: 'parking_lot' as const },
      { siteType: 'parking_lot' as const, california: true },
      { siteType: 'office_retail' as const },
      { siteType: 'office_retail' as const, california: true },
      { siteType: 'curbside' as const },
      { siteType: 'custom' as const, freeSpots: 1 },
      { siteType: 'custom' as const, freeSpots: 2, california: true },
    ];
    for (const c of cases) {
      const mount = stationSignMount({ ...base, ...c, wallZ: wallBoxOffset() })!;
      const support = signSupport(mount);
      expect(support.kind, JSON.stringify(c)).toBe('post');
      if (support.kind !== 'post') continue;
      // From the ground (in its anchor post) to the top of the highest sign.
      expect(support.bottomM).toBe(0);
      expect(support.anchorTopM).toBeGreaterThan(0);
      expect(support.anchorTopM).toBeLessThanOrEqual(0.0254 + 1e-9);
      expect(support.topM).toBeCloseTo(mount.chargingOnlyBottomM + EV_SIGNS.chargingOnly.heightM);
      if (mount.towAwayBottomM != null) {
        expect(support.topM).toBeGreaterThan(mount.towAwayBottomM + EV_SIGNS.towAway.heightM);
      }
    }
    // Office or retail: Stall mounting gets a post, Wall mounting the facade.
    const wall = stationSignMount({ ...base, siteType: 'office_retail', wall: true, wallZ: -3.6 });
    expect(signSupport(wall!).kind).toBe('wall');
  });

  it('puts a curbside sign on its own post along the curb', () => {
    const mount = stationSignMount({ ...base, siteType: 'curbside' });
    expect(mount).toMatchObject({ x: -1, onWall: false });
  });

  it('places the post of a custom site station at the outer side of its car spots', () => {
    const mount = stationSignMount({ ...base, siteType: 'custom', freeSpots: 2 });
    const left = Math.min(...freeSpotRects(2, 'car').map((r) => r.minX));
    expect(mount?.x).toBeCloseTo(left + SIGN_POST_INSET_M);
  });

  it('places no public parking signs at a depot, in a bus bay or truck lane, or off the layout', () => {
    expect(stationSignMount({ ...base, siteType: 'depot' })).toBeNull();
    expect(
      stationSignMount({ ...base, siteType: 'custom', freeSpots: 1, largeSpot: true }),
    ).toBeNull();
    expect(stationSignMount({ ...base, siteType: 'parking_lot', onSpot: false })).toBeNull();
  });

  it('adds the California tow-away sign below, 1 ft lower, keeping the charging sign at 7 ft or more', () => {
    const mount = stationSignMount({ ...base, siteType: 'parking_lot', california: true });
    expect(mount?.towAwayBottomM).toBeCloseTo(EV_SIGNS.secondaryBottomM);
    expect(mount!.chargingOnlyBottomM).toBeGreaterThanOrEqual(
      mount!.towAwayBottomM! + EV_SIGNS.towAway.heightM,
    );
    expect(mount!.chargingOnlyBottomM).toBeGreaterThanOrEqual(EV_SIGNS.mountBottomM);
  });

  it('adds no tow-away sign at a California curbside stall (22511(d)(2) defers to the CA MUTCD)', () => {
    const mount = stationSignMount({ ...base, siteType: 'curbside', california: true });
    expect(mount?.towAwayBottomM).toBeNull();
    expect(mount?.chargingOnlyBottomM).toBeCloseTo(EV_SIGNS.mountBottomM);
  });

  it('recognizes a California site by its state and country', () => {
    expect(isCaliforniaSite({ state: 'CA', country: 'US' })).toBe(true);
    expect(isCaliforniaSite({ state: 'California', country: null })).toBe(true);
    expect(isCaliforniaSite({ state: 'NY', country: 'US' })).toBe(false);
    expect(isCaliforniaSite({ state: 'CA', country: 'Canada' })).toBe(false);
    expect(isCaliforniaSite({ state: null, country: 'US' })).toBe(false);
  });

  it('keeps the post at the stall head behind the wheel stop, clear of every parked car body', () => {
    // MUTCD 11th Edition 2B.53: the R7-113 stands adjacent to the stall. The
    // post stands at the head (station z 0), behind the wheel stop line, so a
    // car parked against the stop never reaches it, whatever its overhang.
    const postHalfM = (2 * 0.0254) / 2;
    const mount = stationSignMount({ ...base, siteType: 'parking_lot' });
    const postX = Math.abs(mount!.x);
    for (const stop of ['curb'] as WheelStopMount[]) {
      expect(mount!.z + postHalfM).toBeLessThan(wheelStopNearZ(stop));
      for (const profile of Object.values(CAR_PROFILES)) {
        const noseZ = carNoseAtStop(stop, profile);
        // Along the stall: the nose stops past the post.
        expect(noseZ).toBeGreaterThan(mount!.z + postHalfM);
        // Across the stall: the body stays inside the side line the post stands in from.
        expect(profile.width / 2).toBeLessThan(postX - postHalfM);
      }
    }
  });
});

describe('sign texts in the viewer language', () => {
  const locales = { en, de, es, ko, zh, 'zh-TW': zhTW } as const;
  const lookup = (bundle: unknown, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => {
      if (node == null || typeof node !== 'object') return undefined;
      return (node as Record<string, unknown>)[part];
    }, bundle);
  const tOf = (bundle: unknown) => ((key: string) => String(lookup(bundle, key))) as never;

  it('has every sign text and virtual sign tooltip in all six locales', () => {
    const keys = [
      ...Object.values(SIGN_TEXT_KEYS),
      ...['Now', 'Until', 'Window'].flatMap((s) => [
        `sites.layoutSigns.reserved${s}`,
        `sites.layoutSigns.maintenance${s}`,
      ]),
      'sites.layoutView.connectionWifi',
      'sites.layoutView.connectionWired',
    ];
    for (const [lang, bundle] of Object.entries(locales)) {
      for (const key of keys) {
        const value = lookup(bundle, key);
        expect(typeof value === 'string' && value.trim() !== '', `${lang} ${key}`).toBe(true);
      }
    }
  });

  it('keeps the English legends of the real signs', () => {
    expect(signTexts(tOf(en))).toEqual(ENGLISH_SIGN_TEXTS);
  });

  it('draws the texture lines from the language, upper case and within a few lines', () => {
    expect(signLines(ENGLISH_SIGN_TEXTS.chargingOnly)).toEqual([
      'NO',
      'PARKING',
      'EXCEPT',
      'WHILE',
      'CHARGING',
    ]);
    expect(signLines(signTexts(tOf(ko)).chargingOnly)).toEqual([
      '충전 중인',
      '차량 외',
      '주차 금지',
    ]);
    expect(signLines(signTexts(tOf(zh)).reserved)).toEqual(['已预约']);
    expect(signLines(signTexts(tOf(de)).chargingOnly, 'de')[0]).toBe('PARKEN');
    for (const bundle of Object.values(locales)) {
      expect(signLines(signTexts(tOf(bundle)).chargingOnly).length).toBeLessThanOrEqual(6);
      expect(signLines(signTexts(tOf(bundle)).towAway).length).toBeLessThanOrEqual(9);
    }
  });

  it('sizes a legend line by the sign letter height and the line pitch', () => {
    // The English R7-113 legend: 5 lines of 232 px pitch on a 1440 px face (80 px per inch).
    expect(signLetterPx('chargingOnly', 232)).toBe(185);
    expect(signLetterPx('chargingOnly', 800)).toBe(208);
    expect(signLetterPx('towAway', 208)).toBe(136);
    expect(signLetterPx('towAway', 40)).toBe(48);
  });

  it('draws the sign faces at 80 px per inch so the legend stays sharp at overview zoom', () => {
    expect(SIGN_PX_PER_INCH).toBe(80);
    expect(signCanvasSize('chargingOnly')).toMatchObject({ width: 960, height: 1440 });
    expect(signCanvasSize('towAway')).toMatchObject({ width: 1360, height: 1760 });
  });
});
