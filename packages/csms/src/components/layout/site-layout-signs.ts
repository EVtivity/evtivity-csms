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
  /** How far right of `x` the tow-away sign's center stands (0: under the R7-113). */
  towAwayDxM: number;
  /** The top of the post, in meters (null on a wall). */
  postTopM: number | null;
  /**
   * A two-port curb post's one sign for both its spots: the R7-113 legend over
   * a double-headed arrow (`CURB_PAIR_SIGN`). Absent: no arrow.
   */
  arrows?: 'both' | undefined;
}

/**
 * The sign of a two-port curb post (owner decision 2026-11-12): one R7-113
 * with a double-headed arrow under its legend, the parking zone running both
 * ways from the sign (MUTCD 11th Edition, Sections 2B.52 and 2B.53: parking
 * signs for EV charging spaces with a double-headed arrow, as the Joint
 * Office of Energy and Transportation handout "MUTCD 11th Edition: What's
 * New in Signage for Electric Vehicle Charging and Parking", June 2024,
 * shows them); NKL Nederland, Uniform Standards for Charging Stations
 * EN-V1.0, OL3 ("When there are two charge locations, the sign or sub-sign
 * should have two arrows") and OL5 ("placed in a central location in
 * relation to the parking spaces and the charging station"). Its post stands
 * on the post's center line, 0.6 m behind it on the sidewalk (derived: clear
 * of the pedestal head, 1.05 m from the curb, leaving 1.35 m of the 2.4 m
 * sidewalk, over the 90 cm of NKL AR22 and the 36 in of 2010 ADA 403.5.1).
 * The arrow takes the lower 28 percent of the face (derived).
 */
export const CURB_PAIR_SIGN = { z: -0.6, arrowShare: 0.28 } as const;

/**
 * The signs of a two-port wall box (`AC_WALL_BOX.dual`) hang over the box:
 * its two J hooks and cable turns fill the wall on both sides (0.285 to
 * 0.685 m out), where the one-port box keeps its signs beside it
 * (`WALL_SIGN`). Derived: the bottoms at 1.5 m, clear of the cable turns
 * (their hooks top out at 1.24 m) and of the station's status marker over
 * the box (1.33 m), the tow-away sign's top (22 in) at 2.06 m under the
 * 2.25 m window sill; the R7-113 alone in the middle, or with the
 * California tow-away sign side by side, 0.042 m apart.
 */
export const DUAL_WALL_SIGN = { bottomM: 1.5, chargingOnlyX: -0.22, towAwayX: 0.19 } as const;

/** How far in from a stall's side line the sign post stands, in meters. */
export const SIGN_POST_INSET_M = 0.2;
/**
 * The sign posts of a station with several stalls (`Stall`, its own frame):
 * one per stall at the stall's side line farther from its charger,
 * `SIGN_POST_INSET_M` in, so a post never stands at the charger. A dual-port
 * pedestal stands on the line between its stalls (charger at x 0), so its
 * posts go to the two outer lines; a split system has a dispenser in each
 * stall, so each post goes to its stall's left line (the last stall's to its
 * right line).
 */
export function stallSignPostXs(
  stalls: ReadonlyArray<{ x: number; width: number }>,
  dispenserPerStall: boolean,
): number[] {
  return stalls.map((st, i) => {
    const chargerX = dispenserPerStall ? st.x : 0;
    const away = st.x - chargerX;
    const dir =
      away > 0.01 ? 1 : away < -0.01 ? -1 : stalls.length > 1 && i === stalls.length - 1 ? 1 : -1;
    return st.x + dir * (st.width / 2 - SIGN_POST_INSET_M);
  });
}

/**
 * The R7-113 of a wall box hangs flat on the facade beside the box, not on a
 * post: MUTCD 11th Edition Section 2A.15 sets the 7 ft bottom for signs on
 * supports where parking or pedestrian movements occur, so that people pass
 * under them; a sign flat on a wall projects less than 4 in, which the 2010
 * ADA Standards 307.2 allow at any height, so nobody walks under it.
 * Derived: its bottom at 1.4 m puts its 18 in face (0.46 m) between 1.4 and
 * 1.86 m, at eye level and under the ground floor window sill (2.25 m), and
 * a California tow-away sign (22 in) fits under it at 0.79 m on solid wall;
 * it stands 0.75 m left of the box center, past the box's left edge and a
 * second card reader above the box (its left edge at 0.32 m, `WALL_READER`)
 * with the 17 in tow-away sign's half width.
 */
export const WALL_SIGN = { x: -0.75, bottomM: 1.4 } as const;

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
  /** A wall box's ports: a two-port box hangs its signs over it (`DUAL_WALL_SIGN`). */
  wallPorts?: 1 | 2 | undefined;
  /** A curb post's ports: a two-port post has one sign with two arrows (`CURB_PAIR_SIGN`). */
  curbPorts?: 1 | 2 | undefined;
}): StationSigns | null {
  if (input.siteType === 'depot' || input.largeSpot) return null;
  const onWallDual =
    input.wall && input.siteType === 'office_retail' && input.wallPorts === 2 && input.onSpot;
  if (onWallDual) {
    const ca = input.california;
    return {
      x: ca ? DUAL_WALL_SIGN.chargingOnlyX : 0,
      z: input.wallZ ?? 0,
      onWall: true,
      chargingOnlyBottomM: DUAL_WALL_SIGN.bottomM,
      towAwayBottomM: ca ? DUAL_WALL_SIGN.bottomM : null,
      towAwayDxM: ca ? DUAL_WALL_SIGN.towAwayX - DUAL_WALL_SIGN.chargingOnlyX : 0,
      postTopM: null,
    };
  }
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
          ? input.siteType === 'office_retail'
            ? WALL_SIGN.x
            : 0
          : -STANDARD_DIMENSIONS.spotWidthM / 2 + SIGN_POST_INSET_M;
  }
  const onWall = input.wall && input.siteType === 'office_retail';
  // 22511(d)(1): offstreet facilities only; (d)(2): street stalls follow the CA MUTCD.
  const california = input.california && input.siteType !== 'curbside';
  // A flat sign on the facade: the R7-113 at `WALL_SIGN.bottomM`, the tow-away sign below it.
  const towAwayBottomM = !california
    ? null
    : onWall
      ? WALL_SIGN.bottomM - SIGN_GAP_M - EV_SIGNS.towAway.heightM
      : EV_SIGNS.secondaryBottomM;
  const chargingOnlyBottomM = onWall
    ? WALL_SIGN.bottomM
    : towAwayBottomM == null
      ? EV_SIGNS.mountBottomM
      : Math.max(EV_SIGNS.mountBottomM, towAwayBottomM + EV_SIGNS.towAway.heightM + SIGN_GAP_M);
  const curbPair = input.siteType === 'curbside' && input.curbPorts === 2;
  return {
    x: curbPair ? 0 : x,
    // A wall sign hangs on the facade above its wall box, not out over the sidewalk.
    z: onWall ? (input.wallZ ?? 0) : curbPair ? CURB_PAIR_SIGN.z : 0,
    ...(curbPair ? { arrows: 'both' as const } : {}),
    onWall,
    chargingOnlyBottomM,
    towAwayBottomM,
    towAwayDxM: 0,
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
 * Real US signs are in English in practice (the MUTCD legends and the
 * California Vehicle Code 22511 statement are English); the view shows their meaning in the viewer's
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
  /** The line on every charger's RFID reader pad (site-layout-model-rfid-pad.ts). */
  rfidTap: string;
}

/** The i18n keys of the sign texts (every one exists in all six CSMS locales). */
export const SIGN_TEXT_KEYS = {
  chargingOnly: 'sites.layoutSigns.chargingOnly',
  towAway: 'sites.layoutSigns.towAway',
  reserved: 'sites.layoutSigns.reserved',
  maintenance: 'sites.layoutSigns.maintenance',
  rfidTap: 'sites.layoutSigns.rfidTap',
} as const satisfies Record<keyof SignTexts, string>;

/** The English texts, the legends of the real signs (the scene's default before a language loads). */
export const ENGLISH_SIGN_TEXTS: SignTexts = {
  chargingOnly: 'NO\nPARKING\nEXCEPT\nWHILE\nCHARGING',
  towAway:
    "UNAUTHORIZED\nVEHICLES NOT\nCONNECTED FOR\nELECTRIC CHARGING\nPURPOSES WILL BE\nTOWED AWAY AT\nOWNER'S EXPENSE",
  reserved: 'Reserved',
  maintenance: 'Maintenance',
  rfidTap: 'Tap RFID card',
};

/** The sign texts in the viewer's language (`t` of react-i18next). */
export function signTexts(t: TFunction): SignTexts {
  return {
    chargingOnly: t('sites.layoutSigns.chargingOnly'),
    towAway: t('sites.layoutSigns.towAway'),
    reserved: t('sites.layoutSigns.reserved'),
    maintenance: t('sites.layoutSigns.maintenance'),
    rfidTap: t('sites.layoutSigns.rfidTap'),
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
 * Canvas px per sign inch. At 20 px per inch the legend blurred to an
 * unreadable smear once the texture was minified at a normal overview zoom;
 * 80 px per inch keeps sharp mip levels down to the size a sign shows at
 * (owner report 2026-11-01, sign text readability).
 */
export const SIGN_PX_PER_INCH = 80;
const SIGN_CANVAS_SCALE = SIGN_PX_PER_INCH / 20;

/** The canvas of a sign face: 12 by 18 in (R7-113) or 17 by 22 in (tow-away) at `SIGN_PX_PER_INCH`. */
export function signCanvasSize(kind: 'chargingOnly' | 'towAway'): {
  width: number;
  height: number;
  /** Border inset, border line width and the legend's top and side margins, in canvas px. */
  inset: number;
  border: number;
  marginY: number;
  marginX: number;
} {
  const [w, h] = kind === 'chargingOnly' ? [12, 18] : [17, 22];
  return {
    width: w * SIGN_PX_PER_INCH,
    height: h * SIGN_PX_PER_INCH,
    inset: 12 * SIGN_CANVAS_SCALE,
    border: 10 * SIGN_CANVAS_SCALE,
    marginY: 35 * SIGN_CANVAS_SCALE,
    marginX: 25 * SIGN_CANVAS_SCALE,
  };
}

/**
 * The letter size of a sign legend line, in px of its canvas
 * (`SIGN_PX_PER_INCH`): at most the English legend's size (about 2.6 in on
 * the R7-113, 1.7 in on the tow-away sign) and at most 80 percent of the line
 * pitch, so a language with more lines keeps them apart. The caller shrinks a
 * line further until it fits the width inside the border.
 */
export function signLetterPx(kind: 'chargingOnly' | 'towAway', pitchPx: number): number {
  const english = (kind === 'chargingOnly' ? 52 : 34) * SIGN_CANVAS_SCALE;
  return Math.max(12 * SIGN_CANVAS_SCALE, Math.floor(Math.min(english, pitchPx * 0.8)));
}
