// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Where the EV charging signs of a station stand, without three.js. Each
// charging stall gets the No Parking Except While Charging (R7-113) sign
// adjacent to it (MUTCD 11th Edition, Section 2B.53 paragraph 19), its
// bottom 7 ft above the ground (Section 2A.15): on a post at the head of the
// stall, beside the charger, or flat on the facade above a wall box. Every
// standing sign has its post down to the ground in an anchor post
// (`signSupport`); a facade sign hangs on the wall itself, never in the air
// (owner decision 2026-11-01). An
// offstreet stall of a California site (parking lot, office or retail,
// custom) adds the Vehicle Code 22511(d)(1) tow-away sign below it, as a
// secondary sign 1 ft lower (Section 2A.15 paragraph 06). A curbside stall is
// on a public street, which 22511(d)(2) leaves to the California MUTCD, so it
// keeps the R7-113 sign only
// (https://california.public.law/codes/vehicle_code_section_22511). A depot (a private
// fleet yard closed to the public) gets no public parking signs: the MUTCD
// applies to roads open to public travel, and private lots not open to the
// public do not have to follow it (AFDC, Charging Station Signage,
// https://afdc.energy.gov/fuels/electricity_charging_station_signage.html).
// Sizes and sources: EV_SIGNS in @evtivity/lib/site-layout.

import type { TFunction } from 'i18next';
import {
  EV_SIGNS,
  STANDARD_DIMENSIONS,
  freeSpotRects,
  type SiteType,
} from '@evtivity/lib/site-layout';

/** The signs of one stall, in the station's own frame (the charger at the origin, its front +z). */
export interface StationSigns {
  /** The post or wall point: x along the stall front, z the post line or the facade face. */
  x: number;
  z: number;
  /** On the building facade (a wall box): no post. */
  onWall: boolean;
  /** The bottom of the R7-113 sign above the station's ground, in meters. */
  chargingOnlyBottomM: number;
  /** The bottom of the California tow-away sign below it, or null outside California. */
  towAwayBottomM: number | null;
  /** The top of the post, in meters (null on a wall). */
  postTopM: number | null;
}

/** How far in from a stall's side line the sign post stands, in meters. */
export const SIGN_POST_INSET_M = 0.2;
/** The gap between the two signs on one post, in meters. */
const SIGN_GAP_M = 0.05;

/**
 * Where a station's signs stand, or null where none belong: a depot, a bus
 * bay or truck lane of a custom site, and a station off the layout. A
 * parking lot, an office or retail stall post and a custom car spot put the
 * post at the head of the stall, `SIGN_POST_INSET_M` in from its left side
 * line, clear of the charger in the middle; a wall box puts the sign on the
 * facade beside it; a curb post puts its sign 1 m along the curb from the
 * charger post.
 */
export function stationSignMount(input: {
  siteType: SiteType;
  onSpot: boolean;
  wall: boolean;
  /** Custom site: the station's car spots (one or two); null on a grid site. */
  freeSpots: number | null;
  /** Bus bays or truck lanes on a custom site. */
  largeSpot: boolean;
  california: boolean;
  /** The facade face in the station's own z (an office or retail wall box: `wallBoxOffset`). */
  wallZ?: number | undefined;
}): StationSigns | null {
  if (input.siteType === 'depot' || input.largeSpot) return null;
  let x: number;
  if (input.siteType === 'custom') {
    if (input.freeSpots == null) return null;
    const rects = freeSpotRects(input.freeSpots, 'car');
    x = Math.min(...rects.map((r) => r.minX)) + SIGN_POST_INSET_M;
  } else {
    if (!input.onSpot) return null;
    x =
      input.siteType === 'curbside'
        ? -1
        : input.wall
          ? 0
          : -STANDARD_DIMENSIONS.spotWidthM / 2 + SIGN_POST_INSET_M;
  }
  // 22511(d)(1): offstreet facilities only; (d)(2): street stalls follow the CA MUTCD.
  const towAwayBottomM =
    input.california && input.siteType !== 'curbside' ? EV_SIGNS.secondaryBottomM : null;
  const chargingOnlyBottomM =
    towAwayBottomM == null
      ? EV_SIGNS.mountBottomM
      : Math.max(EV_SIGNS.mountBottomM, towAwayBottomM + EV_SIGNS.towAway.heightM + SIGN_GAP_M);
  const onWall = input.wall && input.siteType === 'office_retail';
  return {
    x,
    // A wall sign hangs on the facade above its wall box, not out over the sidewalk.
    z: onWall ? (input.wallZ ?? 0) : 0,
    onWall,
    chargingOnlyBottomM,
    towAwayBottomM,
    postTopM:
      input.wall && input.siteType === 'office_retail'
        ? null
        : chargingOnlyBottomM + EV_SIGNS.chargingOnly.heightM,
  };
}

/** What holds a station's signs up: a post from the ground, or the facade. */
export type SignSupport =
  | {
      kind: 'post';
      /** The post's foot (the ground: it is set in an anchor post) and its top, in meters. */
      bottomM: number;
      topM: number;
      /** The top of the anchor post around its foot. */
      anchorTopM: number;
    }
  | { kind: 'wall'; z: number };

/**
 * The support of a station's signs: a post from the ground (bottom 0, in its
 * anchor post) to the top of the highest sign, or the facade for a wall box.
 */
export function signSupport(mount: StationSigns): SignSupport {
  if (mount.onWall || mount.postTopM == null) return { kind: 'wall', z: mount.z };
  return {
    kind: 'post',
    bottomM: 0,
    topM: mount.postTopM,
    anchorTopM: EV_SIGNS.anchorAboveGroundM,
  };
}

/**
 * Whether a site is in California (its state and country): the tow-away sign
 * of Vehicle Code 22511 applies there only.
 */
export function isCaliforniaSite(site: {
  state?: string | null | undefined;
  country?: string | null | undefined;
}): boolean {
  const state = site.state?.trim().toLowerCase() ?? '';
  const country = site.country?.trim().toLowerCase() ?? '';
  const us =
    country === '' || ['us', 'usa', 'united states', 'united states of america'].includes(country);
  return us && (state === 'ca' || state === 'california');
}

/**
 * The texts of the signs the 3D view draws, in the viewer's CSMS language.
 * Real US signs are in English (the MUTCD legends and the California Vehicle
 * Code 22511 statement); the view shows their meaning in the viewer's
 * language, line breaks marked with a newline in the locale files.
 * `reserved` and `maintenance` are the virtual status signs (overlays, not
 * physical signs).
 */
export interface SignTexts {
  /** R7-113 legend (MUTCD 11th Edition, Section 2B.53). */
  chargingOnly: string;
  /** California tow-away statement (Vehicle Code 22511(d)(1)). */
  towAway: string;
  reserved: string;
  maintenance: string;
}

/** The i18n keys of the sign texts (every one exists in all six CSMS locales). */
export const SIGN_TEXT_KEYS = {
  chargingOnly: 'sites.layoutSigns.chargingOnly',
  towAway: 'sites.layoutSigns.towAway',
  reserved: 'sites.layoutSigns.reserved',
  maintenance: 'sites.layoutSigns.maintenance',
} as const satisfies Record<keyof SignTexts, string>;

/** The English texts, the legends of the real signs (the scene's default before a language loads). */
export const ENGLISH_SIGN_TEXTS: SignTexts = {
  chargingOnly: 'NO\nPARKING\nEXCEPT\nWHILE\nCHARGING',
  towAway:
    "UNAUTHORIZED\nVEHICLES NOT\nCONNECTED FOR\nELECTRIC CHARGING\nPURPOSES WILL BE\nTOWED AWAY AT\nOWNER'S EXPENSE",
  reserved: 'Reserved',
  maintenance: 'Maintenance',
};

/** The sign texts in the viewer's language (`t` of react-i18next). */
export function signTexts(t: TFunction): SignTexts {
  return {
    chargingOnly: t('sites.layoutSigns.chargingOnly'),
    towAway: t('sites.layoutSigns.towAway'),
    reserved: t('sites.layoutSigns.reserved'),
    maintenance: t('sites.layoutSigns.maintenance'),
  };
}

/** The lines of a sign legend, upper case in the viewer's locale, empty lines dropped. */
export function signLines(text: string, locale?: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim().toLocaleUpperCase(locale))
    .filter((l) => l !== '');
}

/**
 * The font of the sign faces: the CSMS UI font stack, then fonts that hold
 * Korean and Chinese (the canvas falls back through the list per glyph).
 */
export const SIGN_FONT_FAMILY =
  'Inter, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "PingFang TC", "Hiragino Sans", "Apple SD Gothic Neo", "Malgun Gothic", "Microsoft YaHei", "Microsoft JhengHei", "Noto Sans CJK SC", "Noto Sans CJK KR", sans-serif';

/**
 * The letter size of a sign legend line, in px of its canvas (20 px per inch:
 * the R7-113 canvas is 240 by 360 px for 12 by 18 in, the tow-away sign 340
 * by 440 px for 17 by 22 in): at most the English legend's size (52 px,
 * about 2.6 in, on the R7-113; 34 px on the tow-away sign) and at most 80
 * percent of the line pitch, so a language with more lines keeps them apart.
 * The caller shrinks a line further until it fits the width inside the border.
 */
export function signLetterPx(kind: 'chargingOnly' | 'towAway', pitchPx: number): number {
  const english = kind === 'chargingOnly' ? 52 : 34;
  return Math.max(12, Math.floor(Math.min(english, pitchPx * 0.8)));
}
