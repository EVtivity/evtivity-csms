// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The site layout grid, shared by the API placement, the migration test, the
// 2D card view and the 3D view. Positions are pixels on the 2D board; slot
// (c, r) sits at x = 20 + 200 c, y = 20 + 140 r. The 3D view shows slot (c, r)
// as parking spot (c, r) of the paved lot, so both views read and write the
// same positions. The site type decides which spots exist (`layoutRowLengths`):
// the rows of a parking lot, the one row along the building of an office or
// retail site, the two curbs of a street, or the bus bays and truck lanes of a
// depot. Spot sizes are standard real dimensions (`STANDARD_DIMENSIONS`,
// `FREE_SPOT_DIMENSIONS`), not settings.

import type { VehicleBodyType } from './vehicle-appearance.js';
import { stationChargingKind, type ConnectorPowerInput } from './connector-power.js';
import type { ChargingKind } from './station-data-plan.js';
import type { TransformerKind } from './load-allocation.js';
import { DEFAULT_VEHICLE_BODY_TYPE } from './vehicle-appearance.js';

/** Columns of the grid a new station is placed on. */
export const LAYOUT_COLUMNS = 5;
/** Horizontal distance between two slots, in px. */
export const LAYOUT_SPACING_X = 200;
/** Vertical distance between two slots, in px. */
export const LAYOUT_SPACING_Y = 140;
/** Board padding before the first slot, in px. */
export const LAYOUT_PADDING = 20;
/** Snap step of a 2D drag, in px. */
export const LAYOUT_SNAP = 20;
/** Footprint of a station card used for the overlap check, in px. */
export const LAYOUT_CARD_WIDTH = 160;
export const LAYOUT_CARD_HEIGHT = 120;

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutBay {
  col: number;
  row: number;
}

/** The px position of grid slot (col, row). */
export function bayToPosition(bay: LayoutBay): LayoutPoint {
  return {
    x: LAYOUT_PADDING + bay.col * LAYOUT_SPACING_X,
    y: LAYOUT_PADDING + bay.row * LAYOUT_SPACING_Y,
  };
}

/** The grid slot nearest a px position, never negative. */
export function positionToBay(point: LayoutPoint): LayoutBay {
  return {
    col: Math.max(0, Math.round((point.x - LAYOUT_PADDING) / LAYOUT_SPACING_X)),
    row: Math.max(0, Math.round((point.y - LAYOUT_PADDING) / LAYOUT_SPACING_Y)),
  };
}

/** Whether two card footprints at these positions overlap. */
export function cardsOverlap(a: LayoutPoint, b: LayoutPoint): boolean {
  return (
    a.x < b.x + LAYOUT_CARD_WIDTH &&
    b.x < a.x + LAYOUT_CARD_WIDTH &&
    a.y < b.y + LAYOUT_CARD_HEIGHT &&
    b.y < a.y + LAYOUT_CARD_HEIGHT
  );
}

/** The facing directions of the parking spots, in degrees. */
export const LAYOUT_FACINGS = [0, 90, 180, 270] as const;
export type LayoutFacing = (typeof LAYOUT_FACINGS)[number];

/**
 * Standard real dimensions the 3D view draws with (no settings). A
 * perpendicular spot of 2.6 by 5.5 m sits between the common US (8.5 to 9 by
 * 18 ft) and European (2.5 by 5 m) design values. The two-way drive aisle is
 * the US 24 ft (7.3 m) for 90 degree parking (Town of Rolesville, NC, UDO
 * 10.1.4 Parking Bay Dimensional Standards, TA 19-07 (2019): "90 degree
 * parking ... Perpendicular Parking ... 9W x 18L ... Travel Lane Width 24",
 * https://www.rolesvillenc.gov/sites/default/files/uploads/pl_ta_19-07_section_10.1.4_-_parking_space_dimension_standards.pdf,
 * one representative US code); European practice is 6 to 6.5 m. A
 * parallel spot along a curb is 2.4 by 6 m, a street travel lane 3.5 m. A parking lot is double loaded: two rows
 * facing each other share a drive aisle, two rows back to back share a curbed
 * center island of 2.4 m (8 ft back of curb to back of curb, the double-row
 * island of Berwyn, IL and the minimum of Henderson County, NC,
 * https://www.hendersoncountync.gov/code-document/42-173-parking-island) that
 * holds both rows' chargers back to back.
 */
export const STANDARD_DIMENSIONS = {
  spotWidthM: 2.6,
  spotDepthM: 5.5,
  laneWidthM: 7.3,
  islandWidthM: 2.4,
  parallelSpotLengthM: 6,
  parallelSpotWidthM: 2.4,
  travelLaneM: 3.5,
} as const;

/**
 * The precast concrete wheel stop in front of each AC charging spot (the 3D
 * view draws it, no setting): 6 ft (1.83 m) long across the spot, 9 in
 * (0.23 m) deep, 6 in (0.15 m) high, the common precast sizes (City of
 * Wichita standard 6 ft stop with its 9 in base,
 * https://online.wichita.gov/lfwebdocs/home/GetPublicWorksDoc/892132;
 * Oldcastle 6 ft stop, 6 in high, https://oldcastleinfrastructure.com/?p=153584).
 * Where it stands, measured from the stall head line (the curb face of an
 * island, a lot edge or a sidewalk, the front edge of a stall at a wall),
 * never from the charger: `fromStallHeadM`, 2 ft (0.61 m), inside the full
 * 18 ft (5.5 m) stall. Municipal parking standards put the stop at least 2 ft
 * from the end of the stall (South Prairie, WA Municipal Code 17.05.090, "at
 * least two feet from any obstruction or the end of the stall",
 * https://southprairie.municipal.codes/SPMC/17.05.090; Lake Mary, FL: "at
 * least two feet from the end of the space"; Carson, CA Zoning Code 9162.55:
 * 2 ft compact, 3 ft standard, counted in the stall length), so the car's
 * front overhang (0.8 to 1.05 m) reaches about to the stall head and the
 * 5.5 to 7.3 m cable reaches the inlet on the front fender (ChargePoint 5.5
 * or 7 m cords; Tesla Wall Connector 7.3 m). Every AC pedestal stands behind
 * the stall head line (`CHARGER_BEHIND_STALL_HEAD_M`), so the stop never
 * moves into the stall to clear it. A front overhang of up to 2 ft
 * over a sidewalk leaves its 48 in clear path when the sidewalk is wide enough
 * (Tulare, CA parking standards,
 * https://tulare.ca.gov/home/showpublisheddocument/20070/638151633899970000).
 * DC chargers keep their bollards instead (wheel stops and bollards are not
 * combined, Charge Up Fairfax sample design guidelines); parallel spots along a
 * curb and depot bays have none.
 */
export const WHEEL_STOP = {
  lengthM: 1.83,
  depthM: 0.23,
  heightM: 0.15,
  fromStallHeadM: 0.61,
} as const;

/** One inch in meters. */
const INCH_M = 0.0254;

/**
 * The EV charging signs at a charging stall, in meters (US practice).
 *
 * - `chargingOnly`: the No Parking Except While Charging (R7-113) sign, a red
 *   legend and border on white, 12 by 18 in. MUTCD 11th Edition (December
 *   2023), Section 2B.53 paragraph 19 ("Where parking spaces are only
 *   designated for charging of electric vehicles, an R7-113 sign or R7-114
 *   series sign ... should be installed adjacent to the designated spaces"),
 *   paragraph 04 (prohibitive parking signs: red legend and border on white),
 *   Table 2B-1 (R7-113: 12 x 18 in),
 *   https://mutcd.fhwa.dot.gov/pdfs/11th_Edition/Chapter2b.pdf. The R7-113
 *   needs no time limit (the R7-114 series carries one, an operator policy
 *   the layout does not hold).
 * - `mountBottomM`: the bottom of a sign at least 7 ft above the curb top or
 *   the ground where parking or pedestrian movements occur, MUTCD 11th Edition
 *   Section 2A.15 paragraphs 05 and 07,
 *   https://mutcd.fhwa.dot.gov/pdfs/11th_Edition/Chapter2a.pdf.
 * - `secondaryBottomM`: a secondary sign below another may be 1 ft lower,
 *   Section 2A.15 paragraph 06.
 * - `towAway`: California only. Vehicle Code section 22511(d)(1): a sign
 *   immediately adjacent to and visible from the stall, or at each entrance,
 *   at least 17 by 22 in with lettering at least 1 in, stating that
 *   unauthorized vehicles not connected for electric charging purposes will be
 *   towed away at the owner's expense, where towed vehicles can be reclaimed
 *   and the local law enforcement telephone number,
 *   https://california.public.law/codes/vehicle_code_section_22511. The
 *   statute sets no colors; the layout draws a black legend on white.
 * - The International Symbol of Accessibility is not drawn: the US Access
 *   Board's Design Recommendations for Accessible EV Charging Stations (2022)
 *   say ISA signs "are not recommended at accessible EV charging spaces at
 *   this time" unless a state or local code requires them,
 *   https://www.access-board.gov/ta/tad/ev.html.
 * - A standing sign stands on a galvanized steel square tube post, one of
 *   the breakaway post types of PennDOT LTAP Technical Information Sheet #212,
 *   Breakaway Sign Posts (Spring 2021; steel square tube, channel bar or wood;
 *   the MUTCD asks for crashworthy supports in a clear zone, MUTCD 11th
 *   Edition Section 2A.16 paragraph 02; posts and mountings are Section 2A.18),
 *   https://gis.penndot.pa.gov/BPR_PDF_FILES/Documents/LTAP/TechSheets/TS_212_Breakway_Sign_Posts.pdf.
 *   The sign post slides into an anchor post driven at least 3 ft into the
 *   ground, which stands at most 1 in above the ground for a square tube post
 *   (the same sheet, Installation): the post reaches the ground, never a
 *   floating plate. The 2 in tube size is common practice (no MUTCD
 *   dimension); the anchor is drawn one size larger (2.5 in, no source).
 * - A sign of a wall box hangs on the facade above it, its bottom at 1.4 m
 *   (`WALL_SIGN.bottomM` in the CSMS sign module; Section
 *   2A.15 sets 7 ft where parking or pedestrian movements occur under a sign
 *   on a support).
 */
export const EV_SIGNS = {
  chargingOnly: { widthM: 12 * INCH_M, heightM: 18 * INCH_M },
  towAway: { widthM: 17 * INCH_M, heightM: 22 * INCH_M },
  mountBottomM: 7 * 12 * INCH_M,
  secondaryBottomM: 6 * 12 * INCH_M,
  postWidthM: 2 * INCH_M,
  /** The anchor post around the sign post's foot: at most 1 in above the ground (PennDOT TS 212). */
  anchorWidthM: 2.5 * INCH_M,
  anchorAboveGroundM: 1 * INCH_M,
} as const;

/**
 * The paved parking lot of a parking lot site. Positions stay grid slots of
 * the 2D board: slot (c, r) is spot (c, r). Everything outside the lot is
 * grass.
 */
export interface SiteLayoutGrid {
  /** Spots in each row. */
  spotsPerRow: number;
  /** Number of rows. */
  rows: number;
  /** Direction the spots and chargers face, in degrees (0 is the default). */
  facingDeg: LayoutFacing;
}

/**
 * Where a transformer stands on the layout (sites.layout_settings): `id` is a
 * `transformers` row of the site, whose kind, name and rating live in the
 * table (`LayoutPowerEquipment`). `x` and `z` are meters in lot coordinates:
 * spot (0, 0) has its front left corner at (0, 0), columns run along x and
 * rows along z.
 */
export interface LayoutTransformer {
  /** The `transformers.id` of the site. */
  id: string;
  x: number;
  z: number;
}

/**
 * Where an energy asset stands on the layout (sites.layout_settings): `id` is
 * a `site_energy_assets` row of the site, whose type, name and ratings live in
 * the table. A battery stands at `x`, `z`; a solar canopy covers `row` of a
 * parking lot, or stands freely at `x`, `z`, turned `rotationDeg` (a custom
 * site, a depot). Absent fields take the default place of the asset's type
 * (`placePowerEquipment`).
 */
export interface LayoutEnergyAssetPosition {
  /** The `site_energy_assets.id` of the site. */
  id: string;
  x?: number | undefined;
  z?: number | undefined;
  row?: number | undefined;
  rotationDeg?: number | undefined;
}

/**
 * What kind of site the layout shows: `parking_lot`, an outdoor hub (a paved
 * lot on grass, chargers at the curb of paired rows, transformers, batteries,
 * solar canopies and switchboards), `office_retail`, one row of spots in
 * front of a building (chargers on the facade or on a post at each spot),
 * `curbside`, a street with chargers on posts at the curb of one or both
 * sides, `depot`, a paved fleet yard with nose-in bus bays and truck
 * pull-through lanes (`depotLayout`), or `custom`, grass with every station
 * placed and turned freely, each with its own car spots on a paved apron
 * (`FreePlacement`). Only a parking lot, a depot and a custom site show
 * transformers, energy assets and load management panels; the other types
 * keep them stored, hidden.
 */
export const SITE_TYPES = ['parking_lot', 'office_retail', 'curbside', 'depot', 'custom'] as const;
export type SiteType = (typeof SITE_TYPES)[number];
/** The site type of settings that name none (every site before it existed). */
export const DEFAULT_SITE_TYPE: SiteType = 'parking_lot';

/**
 * How the chargers of an office or retail site are mounted: `wall`, a wall
 * box on the facade with its cable across the sidewalk, or `stall`, a post at
 * the head of each spot with its cable straight to the car.
 */
export const CHARGER_MOUNTINGS = ['wall', 'stall'] as const;
export type ChargerMounting = (typeof CHARGER_MOUNTINGS)[number];
export const DEFAULT_CHARGER_MOUNTING: ChargerMounting = 'wall';

/**
 * Where the chargers of a parking lot stand: `islands`, on the curbed islands
 * of rows back to back and at the lot edge rows (every row charges), or
 * `lot_edge`, only along the lot edge: the first and the last row, single
 * loaded, facing the edge curb, the inner rows ordinary parking. Lot Edge is
 * how retrofits usually go: the cost of an install grows with the length of
 * the run from the electrical service, so chargers go where the trench stays
 * short (NYSERDA, Charging Station Host FAQs,
 * https://www.nyserda.ny.gov/All-Programs/Charging-Station-Programs/Charging-Stations-Hosts-FAQs;
 * ChargePoint CP6000 Site Design Guidelines, "minimize electrical
 * infrastructure cost",
 * https://docs.chargepoint.com/cpdocs-sec/content/2-ac/cp6000/sdg/site%20design%20guidelines.htm).
 * The edge row nearest the transformer fills first (`groupedSpotOrder` orders
 * the spots by their distance to it). Parking lot only; absent means islands.
 */
export const CHARGER_PLACEMENTS = ['islands', 'lot_edge'] as const;
export type ChargerPlacement = (typeof CHARGER_PLACEMENTS)[number];
export const DEFAULT_CHARGER_PLACEMENT: ChargerPlacement = 'islands';

/**
 * The layout settings of a site (sites.layout_settings). Every site type's
 * fields are kept, so switching the type back restores its values: the
 * parking lot (`spotsPerRow`, `rows`, `facingDeg`, `transformers`,
 * `energyAssets`), the office or retail row (`chargers`, `mounting`), the
 * street (`chargersLeft`, `chargersRight`) and the depot (`busBays`,
 * `truckLanes`, and the parking lot's `facingDeg`). `siteType` is absent in settings
 * stored before it existed, which read as `parking_lot` (`siteTypeOf`); an
 * absent field of the site type gets its default from the station count
 * (`effectiveLayoutSettings`).
 */
export interface SiteLayoutSettings extends SiteLayoutGrid {
  siteType?: SiteType | undefined;
  /** Office or retail: charger positions, one spot each, in one row along the building. */
  chargers?: number | undefined;
  /** Office or retail: wall boxes on the facade or posts at the spots. */
  mounting?: ChargerMounting | undefined;
  /** Parking lot only: chargers on the islands (every row) or along the lot edge only. */
  chargerPlacement?: ChargerPlacement | undefined;
  /** Curbside: chargers along the left curb (row 0), seen driving along the street. */
  chargersLeft?: number | undefined;
  /** Curbside: chargers along the right curb (row 1). */
  chargersRight?: number | undefined;
  /** Depot: nose-in bus bays (row 0), one station each. */
  busBays?: number | undefined;
  /** Depot: truck pull-through lanes (row 1), one station each. */
  truckLanes?: number | undefined;
  /** Positions of the site's transformers, by id. */
  transformers: LayoutTransformer[];
  /**
   * Positions of the site's batteries and solar canopies, by id. Absent in
   * settings stored before it existed, which read as none (`energyAssetsOf`).
   */
  energyAssets?: LayoutEnergyAssetPosition[] | undefined;
}

/** The kinds of energy asset a layout shows. */
export const ENERGY_ASSET_TYPES = ['battery', 'solar'] as const;
export type EnergyAssetType = (typeof ENERGY_ASSET_TYPES)[number];

/**
 * A transformer of the site as the layout labels it: its `transformers` row
 * (kind, name, rated kVA and the computed capacity in kW, null when unrated).
 */
export interface LayoutTransformerInfo {
  id: string;
  kind: TransformerKind;
  name: string;
  ratedKva: number | null;
  maxContinuousKw: number | null;
  /**
   * The stations its load management tree feeds (its panels, their
   * sub-panels and circuits): a transformer without a stored position stands
   * next to them (`groupTransformerPoint`). Absent or empty: none known.
   */
  stationIds?: readonly string[];
}

/**
 * A station where the layout draws it, for the default places of the power
 * equipment: its spot middle in lot meters (`spotCenterM`), on a custom site
 * its charger point.
 */
export interface LayoutStationPlace {
  id: string;
  x: number;
  z: number;
}

/** An energy asset of the site as the layout labels it: its `site_energy_assets` row. */
export interface LayoutEnergyAssetInfo {
  id: string;
  type: EnergyAssetType;
  name: string;
  /** Battery: usable capacity in kWh. */
  capacityKwh: number | null;
  /** Solar: DC peak power in kWp. */
  peakKwp: number | null;
}

/** The power equipment rows of a site the layout places, in their table order. */
export interface LayoutPowerEquipment {
  transformers: readonly LayoutTransformerInfo[];
  energyAssets: readonly LayoutEnergyAssetInfo[];
}

/** No power equipment (a site without rows, or a view before they load). */
export const NO_POWER_EQUIPMENT: LayoutPowerEquipment = { transformers: [], energyAssets: [] };

/** A service transformer of the site at its layout position (`placePowerEquipment`). */
export interface PlacedTransformer extends LayoutTransformer {
  kind: TransformerKind;
  name: string;
  ratedKva: number | null;
  maxContinuousKw: number | null;
}

/**
 * A battery storage cabinet on the grass next to the lot, placed like a
 * transformer (`x`, `z` in lot meters, moved onto the grass by
 * `snapTransformerToGrass`): an energy asset of the site joined with its
 * position (`placePowerEquipment`).
 */
export interface LayoutBattery {
  /** The `site_energy_assets.id` of the site. */
  id: string;
  type: 'battery';
  name: string;
  /** Usable capacity in kWh. */
  capacityKwh: number | null;
  x: number;
  z: number;
}

/**
 * A solar carport canopy over one row of the lot (`row`, 0-based) on a
 * parking lot, or standing freely on a custom site (`x`, `z`, `rotationDeg`;
 * its size follows its peak power, `solarCanopySize`): an energy asset of the
 * site joined with its position (`placePowerEquipment`). Shown on a parking
 * lot and a custom site (`showsSolar`); the other types keep it hidden.
 */
export interface LayoutSolarCanopy {
  /** The `site_energy_assets.id` of the site. */
  id: string;
  type: 'solar';
  name: string;
  /** Peak power in kWp (`site_energy_assets.peak_kwp`). */
  capacityKwp: number | null;
  row: number;
  /** Custom site: the middle of the canopy in meters (absent: over its row of the parking lot grid). */
  x?: number | undefined;
  z?: number | undefined;
  /** Custom site: the turn of the canopy in degrees, clockwise from above (0 to under 360). */
  rotationDeg?: number | undefined;
}

export type LayoutEnergyAsset = LayoutBattery | LayoutSolarCanopy;

/**
 * Layout settings with the power equipment joined in: the site's service
 * transformers and energy assets at their positions (`placePowerEquipment`),
 * what the views draw and label. Assignable to `SiteLayoutSettings`, never
 * stored (the names and ratings live in the tables).
 */
export interface PlacedLayoutSettings extends Omit<
  SiteLayoutSettings,
  'transformers' | 'energyAssets'
> {
  transformers: PlacedTransformer[];
  energyAssets: LayoutEnergyAsset[];
}

/**
 * What decides the spots of a layout: the site type and its counts. A plain
 * parking lot grid is one (its type reads as parking_lot).
 */
export type LayoutShape = SiteLayoutGrid &
  Pick<
    SiteLayoutSettings,
    | 'siteType'
    | 'chargers'
    | 'chargersLeft'
    | 'chargersRight'
    | 'busBays'
    | 'truckLanes'
    | 'chargerPlacement'
  >;

/** The energy asset positions of settings: as stored, else none. */
export function energyAssetsOf(settings: SiteLayoutSettings): LayoutEnergyAssetPosition[] {
  return settings.energyAssets ?? [];
}

/** Whether the site has open ground for its equipment: a parking lot, a depot or a custom site. */
function hasOpenGround(settings: { siteType?: SiteType | undefined }): boolean {
  const type = siteTypeOf(settings);
  return type === 'parking_lot' || type === 'depot' || type === 'custom';
}

/** Whether the layout shows the solar canopies: on a parking lot, a depot and a custom site (they stay stored on the other types). */
export function showsSolar(settings: { siteType?: SiteType | undefined }): boolean {
  return hasOpenGround(settings);
}

/** Whether the layout shows the batteries: on a parking lot, a depot and a custom site (they stay stored on the other types). */
export function showsBatteries(settings: { siteType?: SiteType | undefined }): boolean {
  return hasOpenGround(settings);
}

/**
 * Whether the layout draws the load management panels and their links: on a
 * parking lot, a depot and a custom site; on an office or retail site its AC
 * panelboards on the building facade (the building's switchboard stays
 * inside, out of view). A street keeps its panels in a cabinet out of view;
 * the station popup still shows the allocated limit.
 */
export function showsLoadPanels(settings: { siteType?: SiteType | undefined }): boolean {
  return hasOpenGround(settings) || siteTypeOf(settings) === 'office_retail';
}

/**
 * Whether the stations stand at free positions (`FreePlacement`, meters and a
 * turn) instead of grid spots: only on a custom site. The grid slots stay
 * stored, so switching to another type returns each station to its slot.
 */
export function usesFreePositions(settings: { siteType?: SiteType | undefined }): boolean {
  return siteTypeOf(settings) === 'custom';
}

/** The facing the 3D view turns the site by: a parking lot's or a depot's own, 0 on the other types. */
export function layoutFacingOf(
  settings: SiteLayoutGrid & { siteType?: SiteType | undefined },
): LayoutFacing {
  const type = siteTypeOf(settings);
  return type === 'parking_lot' || type === 'depot' ? settings.facingDeg : 0;
}

/**
 * Whether a site's stations stand in spots with their charger chosen by the
 * spot (a depot): bus bays and truck lanes, drawn with the large chargers.
 */
export function usesDepotSpots(settings: { siteType?: SiteType | undefined }): boolean {
  return siteTypeOf(settings) === 'depot';
}

/** The charger mounting of an office or retail site: as stored, else wall boxes. */
export function chargerMountingOf(settings: {
  mounting?: ChargerMounting | undefined;
}): ChargerMounting {
  return settings.mounting ?? DEFAULT_CHARGER_MOUNTING;
}

/**
 * The spots of each row of the layout, by site type: every row of a parking
 * lot has `spotsPerRow`; an office or retail site has one row of `chargers`;
 * a street has the left curb (row 0) and the right curb (row 1), either of
 * which may have none; a depot has its bus bays (row 0) and its truck lanes
 * (row 1), either of which may have none. Slot (c, r) is a spot when c < lengths[r]. A custom
 * site keeps the parking lot rows for the stored slots (its stations stand at
 * free positions), so switching back finds them.
 */
export function layoutRowLengths(settings: LayoutShape): number[] {
  switch (siteTypeOf(settings)) {
    case 'office_retail':
      return [settings.chargers ?? 1];
    case 'curbside':
      return [settings.chargersLeft ?? 1, settings.chargersRight ?? 0];
    case 'depot':
      return [settings.busBays ?? 1, settings.truckLanes ?? 0];
    case 'parking_lot':
      // Lot Edge: only the first and the last row charge; the inner rows are ordinary parking.
      if (chargerPlacementOf(settings) === 'lot_edge') {
        return Array.from({ length: settings.rows }, (_, r) =>
          r === 0 || r === settings.rows - 1 ? settings.spotsPerRow : 0,
        );
      }
      return Array.from({ length: settings.rows }, () => settings.spotsPerRow);
    default:
      return Array.from({ length: settings.rows }, () => settings.spotsPerRow);
  }
}

/** The charger placement of a parking lot: as stored, else islands. Other site types have none. */
export function chargerPlacementOf(settings: {
  siteType?: SiteType | undefined;
  chargerPlacement?: ChargerPlacement | undefined;
}): ChargerPlacement {
  return siteTypeOf(settings) === 'parking_lot'
    ? (settings.chargerPlacement ?? DEFAULT_CHARGER_PLACEMENT)
    : DEFAULT_CHARGER_PLACEMENT;
}

/** The site type of settings: as stored, else the default (`parking_lot`). */
export function siteTypeOf(settings: { siteType?: SiteType | undefined }): SiteType {
  return settings.siteType ?? DEFAULT_SITE_TYPE;
}

/**
 * Whether the layout shows the transformers: on a parking lot, a depot and a
 * custom site. An office or retail site and a street keep them in their settings,
 * hidden, so switching back shows them again.
 */
export function showsTransformers(settings: { siteType?: SiteType | undefined }): boolean {
  return hasOpenGround(settings);
}

/** The lot of a site that never set one: 20 spots, 10 in each of 2 rows. */
export const DEFAULT_LAYOUT_GRID: SiteLayoutGrid = {
  spotsPerRow: 10,
  rows: 2,
  facingDeg: 0,
};

/** Allowed ranges of the settings (inclusive). */
export const LAYOUT_GRID_LIMITS = {
  spotsPerRow: { min: 1, max: 100 },
  rows: { min: 1, max: 100 },
  /** Office or retail charger positions. */
  chargers: { min: 1, max: 100 },
  /** Curbside chargers on one side (0 allowed; both sides together at least 1). */
  chargersPerSide: { min: 0, max: 100 },
  /** Depot bus bays and truck lanes (0 allowed; both together at least 1). */
  depotSpots: { min: 0, max: 100 },
  /** Transformer positions a layout stores. */
  transformers: { max: 10 },
  /** Battery and solar canopy positions a layout stores. */
  energyAssets: { max: 10 },
  /** How far from the lot a transformer may stand, in meters. */
  transformerReachM: 200,
} as const;

/**
 * Distance from the lot edge to a transformer's center, at least, in meters:
 * its pad (2.9 by 2.5 m) then stands 1.05 to 1.25 m from the curb, more than
 * the 3 ft (0.91 m) a utility keeps clear at the sides and back of a
 * pad-mounted transformer (Omaha Public Power District, "Padmount
 * transformers": 10 ft in front of the padlocked side, three feet on two
 * sides, https://www.oppd.com/residential/customer-service/padmount-transformers;
 * Idaho Power, Construction Clearance Requirements: 10 ft in front of the
 * doors, 3 ft at the back,
 * https://www.idahopower.com/accounts-service/construction-remodeling/construction-clearance-requirements/).
 * Closer than 5 ft to a parking area, bollards guard the pad
 * (`EQUIPMENT_BOLLARD` in the CSMS). New transformers and the default one
 * stand at this distance, at the lot edge next to the DC chargers.
 */
export const TRANSFORMER_CLEARANCE_M = 2.5;

/**
 * What lies after row `after` of a parking lot of `rows` rows: a drive aisle
 * between two rows facing each other, or a curbed center island between two
 * rows back to back (`parkingChargersAtBack`). Rows 0 and 1 face each other
 * across the first aisle, rows 1 and 2 stand back to back on an island, and
 * so on; an odd last row keeps an aisle in front of it (it has no partner to
 * share one with, and a row needs an aisle to drive in), and past the last
 * row (slots off the lot) the spacing is an aisle. The next to last row of an
 * odd lot faces that aisle with its head, so a curbed charger strip lies
 * between its head and the aisle (`parkingHeadStrip`).
 */
export function parkingRowGap(after: number, rows: number): 'aisle' | 'island' {
  if (after < 0 || after + 1 >= rows || after % 2 === 0) return 'aisle';
  if (rows % 2 === 1 && after + 1 === rows - 1) return 'aisle';
  return 'island';
}

/**
 * Whether a curbed charger strip lies at the head of row `after`, before the
 * drive aisle after it: the next to last row of an odd lot, whose head faces
 * the aisle of the odd last row. Its chargers stand on the strip behind the
 * curb face, as on a center island, so no AC pedestal stands in its stall
 * (ChargePoint CPF50 site design guide: the pedestal "against the curb
 * between spaces", https://docs.chargepoint.com/cpdocs-sec/content/2-ac/cpf50/sdg/cvl-and-mchncl-dsgn.htm).
 * The strip has the island width, 8 ft back of curb to back of curb, the
 * minimum parking island of Henderson County, NC
 * (https://www.hendersoncountync.gov/code-document/42-173-parking-island).
 */
export function parkingHeadStrip(after: number, rows: number): boolean {
  return rows % 2 === 1 && rows >= 3 && after === rows - 2;
}

/** The front edge of row `row` of a parking lot of `rows` rows, in lot meters (rows past the lot continue it). */
export function parkingRowZ(row: number, rows: number): number {
  const d = STANDARD_DIMENSIONS;
  let z = 0;
  for (let r = 0; r < row; r++) {
    z += d.spotDepthM + (parkingRowGap(r, rows) === 'island' ? d.islandWidthM : d.laneWidthM);
    if (parkingHeadStrip(r, rows)) z += d.islandWidthM;
  }
  return z;
}

/**
 * Whether the chargers of a parking lot row stand at its back edge (larger z)
 * and face the aisle before it: every odd row, and an odd last row, so the
 * outermost rows have their chargers at the lot edges and rows back to back
 * share their island. Row 0 and slots off the lot are not turned.
 */
export function parkingChargersAtBack(row: number, rows: number): boolean {
  if (row <= 0 || row >= rows) return false;
  return row % 2 === 1 || row === rows - 1;
}

/**
 * How far behind the stall head line (the curb face of an island, a charger
 * strip, a lot edge or a sidewalk; the head of a custom site's car spot) a
 * charger stands that does not stand in its stall, to its center, in meters:
 * an island or strip charger, an AC pedestal of a parking lot row at the lot
 * edge, an office or retail stall post, and a custom site's car spot
 * charger. The ChargePoint CPF50 site design guide places a pedestal
 * "against the curb between spaces", with the wheel stops in the stalls in
 * front of it, and says "Place the station 450 mm (18 in) from the curb"
 * (https://docs.chargepoint.com/cpdocs-sec/content/2-ac/cpf50/sdg/cvl-and-mchncl-dsgn.htm),
 * so the stall keeps its full depth. Derived: 18 in (0.457 m) from the curb
 * face to the pedestal's face plus half the 245 mm deep head of the AC
 * pedestal envelope (0.123 m) is 0.58 m to its center.
 */
export const CHARGER_BEHIND_STALL_HEAD_M = 0.58;

/**
 * Whether the chargers of a parking lot row stand on a center island or a
 * charger strip (the row's charger edge borders one, `parkingHeadStrip`).
 */
export function parkingChargerOnIsland(row: number, rows: number): boolean {
  if (row < 0 || row >= rows) return false;
  return parkingChargersAtBack(row, rows)
    ? parkingRowGap(row, rows) === 'island' || parkingHeadStrip(row, rows)
    : row > 0 && parkingRowGap(row - 1, rows) === 'island';
}

/**
 * Where the chargers of a parking lot row stand across the rows, in lot
 * meters: on the island past the row's edge, else `stationIntoSpotM` into
 * the head of the spot (the lot edge, or a row whose back faces an aisle).
 */
export function parkingChargerZ(row: number, rows: number): number {
  const d = STANDARD_DIMENSIONS;
  const front = parkingRowZ(row, rows);
  const back = parkingChargersAtBack(row, rows);
  if (parkingChargerOnIsland(row, rows)) {
    return back
      ? front + d.spotDepthM + CHARGER_BEHIND_STALL_HEAD_M
      : front - CHARGER_BEHIND_STALL_HEAD_M;
  }
  const into = FREE_LAYOUT.stationIntoSpotM;
  return back ? front + d.spotDepthM - into : front + into;
}

/**
 * The parking lot size in meters (standard spots): the rows with an aisle
 * between rows facing each other and a center island between rows back to
 * back (`parkingRowZ`).
 */
export function lotExtentM(grid: SiteLayoutGrid): { width: number; depth: number } {
  const d = STANDARD_DIMENSIONS;
  const rows = Math.max(1, grid.rows);
  return {
    width: grid.spotsPerRow * d.spotWidthM,
    depth: parkingRowZ(rows - 1, rows) + d.spotDepthM,
  };
}

/** Whether a slot is a spot of the layout (`layoutRowLengths`). */
export function bayInLayout(bay: LayoutBay, settings: LayoutShape): boolean {
  const lengths = layoutRowLengths(settings);
  return bay.row >= 0 && bay.col >= 0 && bay.col < (lengths[bay.row] ?? 0);
}

/** Spots of the layout; a custom site has no limit (every station brings its own spots). */
export function layoutCapacity(settings: LayoutShape): number {
  if (usesFreePositions(settings)) return Number.POSITIVE_INFINITY;
  return layoutRowLengths(settings).reduce((sum, n) => sum + n, 0);
}

/** Whether two lots are the same settings. */
export function sameLayoutGrid(a: SiteLayoutGrid, b: SiteLayoutGrid): boolean {
  return a.spotsPerRow === b.spotsPerRow && a.rows === b.rows && a.facingDeg === b.facingDeg;
}

function sameEnergyAsset(
  a: LayoutEnergyAssetPosition,
  b: LayoutEnergyAssetPosition | undefined,
): boolean {
  return (
    b != null &&
    a.id === b.id &&
    a.row === b.row &&
    a.x === b.x &&
    a.z === b.z &&
    a.rotationDeg === b.rotationDeg
  );
}

/**
 * Whether two layout settings are the same (site type, lot, and the
 * transformer and energy asset positions by id, in order; absent energy
 * assets equal none).
 */
export function sameLayoutSettings(a: SiteLayoutSettings, b: SiteLayoutSettings): boolean {
  const assetsA = energyAssetsOf(a);
  const assetsB = energyAssetsOf(b);
  return (
    siteTypeOf(a) === siteTypeOf(b) &&
    a.chargers === b.chargers &&
    a.mounting === b.mounting &&
    chargerPlacementOf(a) === chargerPlacementOf(b) &&
    a.chargersLeft === b.chargersLeft &&
    a.chargersRight === b.chargersRight &&
    a.busBays === b.busBays &&
    a.truckLanes === b.truckLanes &&
    assetsA.length === assetsB.length &&
    assetsA.every((asset, i) => sameEnergyAsset(asset, assetsB[i])) &&
    sameLayoutGrid(a, b) &&
    a.transformers.length === b.transformers.length &&
    a.transformers.every((t, i) => {
      const o = b.transformers[i];
      return o != null && o.id === t.id && o.x === t.x && o.z === t.z;
    })
  );
}

/**
 * The paved ground equipment keeps clear of, in meters: the parking lot from
 * its front left corner, or the paved yard of a depot (`depotLayout`).
 */
export function layoutEquipmentGround(settings: LayoutShape): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  if (usesDepotSpots(settings)) return depotLayout(settings).yard;
  const { width, depth } = lotExtentM(settings);
  return { minX: 0, maxX: width, minZ: 0, maxZ: depth };
}

/**
 * Where a transformer may stand: on the grass, at least TRANSFORMER_CLEARANCE_M
 * from the lot (a depot: its paved yard), and within transformerReachM of
 * it. A point on the lot moves to the nearest lot side; positions round to
 * 10 cm.
 */
export function snapTransformerToGrass(
  x: number,
  z: number,
  grid: LayoutShape,
): { x: number; z: number } {
  const g = { ...layoutEquipmentGround(grid) };
  // A depot yard's back edge steps between its areas (`depotLayout` outline):
  // behind the shallower bus area the yard ends sooner, so a pad stands its
  // clearance behind that area's edge, not behind the deeper truck area's.
  if (usesDepotSpots(grid)) {
    const depot = depotLayout(grid);
    // A stepped back edge: eight corners (the front steps too), the bus area's back at 1 and 2.
    if (depot.busHead != null && depot.lanes.length > 0 && depot.outline.length === 8) {
      const step = depot.outline[2]?.x ?? g.maxX;
      if (x < step) g.minZ = depot.outline[1]?.z ?? g.minZ;
    }
  }
  const c = TRANSFORMER_CLEARANCE_M;
  const reach = LAYOUT_GRID_LIMITS.transformerReachM;
  let px = Math.min(g.maxX + reach, Math.max(g.minX - reach, x));
  let pz = Math.min(g.maxZ + reach, Math.max(g.minZ - reach, z));
  if (px > g.minX - c && px < g.maxX + c && pz > g.minZ - c && pz < g.maxZ + c) {
    const toLeft = px - g.minX + c;
    const toRight = g.maxX + c - px;
    const toFront = pz - g.minZ + c;
    const toBack = g.maxZ + c - pz;
    const nearest = Math.min(toLeft, toRight, toFront, toBack);
    if (nearest === toRight) px = g.maxX + c;
    else if (nearest === toLeft) px = g.minX - c;
    else if (nearest === toBack) pz = g.maxZ + c;
    else pz = g.minZ - c;
  }
  const round = (v: number): number => Math.round(v * 10) / 10;
  return { x: round(px), z: round(pz) };
}

/** Where the first transformer of a lot stands by default: at the lot edge right of the first row. */
function firstTransformerRawPoint(grid: SiteLayoutGrid): { x: number; z: number } {
  return {
    x: lotExtentM(grid).width + TRANSFORMER_CLEARANCE_M,
    z: Math.min(STANDARD_DIMENSIONS.spotDepthM / 2, lotExtentM(grid).depth / 2),
  };
}

/** Where the electrical equipment of a lot stands when the site has no transformer position. */
export function defaultTransformerPoint(grid: SiteLayoutGrid): { x: number; z: number } {
  const raw = firstTransformerRawPoint(grid);
  return snapTransformerToGrass(raw.x, raw.z, grid);
}

/** How far apart two default transformer places stand (pads and switchboard rows apart). */
export const DEFAULT_TRANSFORMER_PITCH_M = 6;

/** How far left of the stations a custom site's default equipment stands, in meters. */
const FREE_EQUIPMENT_OFFSET_M = 6;

/**
 * The layout places of stations given by grid position (and, on a custom
 * site, free position): what `placePowerEquipment` puts the equipment next to.
 */
export function layoutStationPlaces(
  stations: ReadonlyArray<{
    id: string;
    positionX: number;
    positionY: number;
    freePosition?: { x: number; z: number } | null | undefined;
  }>,
  settings: LayoutShape,
): LayoutStationPlace[] {
  const free = usesFreePositions(settings);
  return stations.flatMap((st) => {
    if (free) {
      return st.freePosition != null
        ? [{ id: st.id, x: st.freePosition.x, z: st.freePosition.z }]
        : [];
    }
    const bay = positionToBay({ x: st.positionX, y: st.positionY });
    // A depot slot is a bus bay or a truck lane of the yard, not a lot spot.
    if (usesDepotSpots(settings)) {
      const p = depotSlotPlacement(bay, settings);
      return [{ id: st.id, x: p.x, z: p.z }];
    }
    return [{ id: st.id, ...spotCenterM(bay, settings) }];
  });
}

/**
 * Where a transformer without a stored position stands (owner report
 * 2026-11-04: "as close to the site as possible"), next to the stations it
 * feeds (`group`, their places), the rule the demo seed follows
 * (`groupTransformerPoints`, site-layout-standards: 2.5 m center from the
 * lot edge, level with its group): a parking lot on the grass
 * TRANSFORMER_CLEARANCE_M past the right edge, level with the middle of its
 * group (without one, level with the first row); a depot behind its yard,
 * level with the middle of its group (without one, at the yard's left end);
 * a custom site DEFAULT_TRANSFORMER_PITCH_M left of its group's stations
 * (without one, left of all of them). Each steps DEFAULT_TRANSFORMER_PITCH_M
 * along the edge until it is that far from every place in `taken` (the
 * transformers placed before it), so pads never overlap.
 */
export function groupTransformerPoint(
  settings: LayoutShape,
  group: readonly LayoutStationPlace[],
  all: readonly LayoutStationPlace[],
  taken: ReadonlyArray<{ x: number; z: number }>,
): { x: number; z: number } {
  const pitch = DEFAULT_TRANSFORMER_PITCH_M;
  const mean = (vs: number[]): number => vs.reduce((a, b) => a + b, 0) / vs.length;
  const clear = (p: { x: number; z: number }): boolean =>
    taken.every((t) => Math.hypot(t.x - p.x, t.z - p.z) >= pitch - 1e-6);
  // Step along the edge (`step` per try) until the place is clear.
  const firstClear = (
    start: { x: number; z: number },
    step: { x: number; z: number },
    place: (p: { x: number; z: number }) => { x: number; z: number },
  ): { x: number; z: number } => {
    let p = place(start);
    for (let i = 1; i <= 40 && !clear(p); i++) {
      p = place({ x: start.x + step.x * i, z: start.z + step.z * i });
    }
    return p;
  };
  if (usesFreePositions(settings)) {
    const around = group.length > 0 ? group : all;
    if (around.length === 0) {
      return firstClear({ x: -8, z: -4 }, { x: 0, z: -4 }, (p) => clampFreePoint(p.x, p.z));
    }
    const x = Math.min(...around.map((p) => p.x)) - pitch;
    const z = mean(around.map((p) => p.z));
    return firstClear({ x, z }, { x: 0, z: pitch }, (p) => clampFreePoint(p.x, p.z));
  }
  const ground = layoutEquipmentGround(settings);
  const snap = (p: { x: number; z: number }): { x: number; z: number } =>
    snapTransformerToGrass(p.x, p.z, settings);
  if (usesDepotSpots(settings)) {
    const x = group.length > 0 ? mean(group.map((p) => p.x)) : ground.minX + 4;
    return firstClear({ x, z: ground.minZ - TRANSFORMER_CLEARANCE_M }, { x: pitch, z: 0 }, snap);
  }
  const z =
    group.length > 0
      ? mean(group.map((p) => p.z))
      : firstTransformerRawPoint(layoutGridOf(settings)).z;
  return firstClear({ x: ground.maxX + TRANSFORMER_CLEARANCE_M, z }, { x: 0, z: pitch }, snap);
}

/**
 * Where a transformer without a stored position and without known stations
 * stands, `index` the transformers placed before it the same way: the
 * `groupTransformerPoint` place with no group, each one pitch on from the
 * one before.
 */
export function newTransformerPoint(
  settings: LayoutShape,
  index: number,
): { x: number; z: number } {
  const taken: Array<{ x: number; z: number }> = [];
  let at = groupTransformerPoint(settings, [], [], taken);
  for (let i = 0; i < index; i++) {
    taken.push(at);
    at = groupTransformerPoint(settings, [], [], taken);
  }
  return at;
}

/**
 * Where a battery without a stored position stands, `index` the batteries
 * placed before it: on the grass behind the lot (a depot: behind its yard),
 * right of each other; on a custom site in front of the site origin, left of
 * each other.
 */
export function newBatteryPoint(
  settings: LayoutShape,
  index: number,
  stations: readonly LayoutStationPlace[] = [],
): { x: number; z: number } {
  if (usesFreePositions(settings)) {
    // Next to the stations (a custom site's stations can stand anywhere within reach).
    if (stations.length > 0) {
      return clampFreePoint(
        Math.min(...stations.map((p) => p.x)) - FREE_EQUIPMENT_OFFSET_M - 5 * index,
        Math.min(...stations.map((p) => p.z)) - FREE_EQUIPMENT_OFFSET_M,
      );
    }
    return clampFreePoint(-6 - 5 * index, -6);
  }
  const ground = layoutEquipmentGround(settings);
  return snapTransformerToGrass(
    Math.min(ground.maxX, ground.minX + 6 + 5 * index),
    ground.minZ - TRANSFORMER_CLEARANCE_M,
    settings,
  );
}

/**
 * Where a solar canopy without a stored position stands, `covered` the rows
 * the canopies placed before it cover and `index` their count: over the first
 * row without one (else the last row) on a parking lot; standing freely in
 * front of the site origin on a custom site, or over staff parking behind the
 * yard of a depot, below each other.
 */
export function newSolarCanopyPlace(
  settings: LayoutShape,
  covered: ReadonlySet<number>,
  index: number,
  stations: readonly LayoutStationPlace[] = [],
): Pick<LayoutSolarCanopy, 'row' | 'x' | 'z' | 'rotationDeg'> {
  if (usesFreePositions(settings)) {
    // In front of the stations, below each other.
    if (stations.length > 0) {
      const xs = stations.map((p) => p.x);
      const p = clampFreePoint(
        (Math.min(...xs) + Math.max(...xs)) / 2,
        Math.min(...stations.map((q) => q.z)) - 12 - 8 * index,
      );
      return { row: 0, x: p.x, z: p.z, rotationDeg: 0 };
    }
    return { row: 0, x: 0, z: -12 - 8 * index, rotationDeg: 0 };
  }
  if (usesDepotSpots(settings)) {
    const ground = layoutEquipmentGround(settings);
    return {
      row: 0,
      x: Math.round((ground.minX + ground.maxX) / 2),
      z: Math.round(ground.minZ - 9 - 8 * index),
      rotationDeg: 0,
    };
  }
  let row = 0;
  while (covered.has(row) && row < settings.rows - 1) row++;
  return { row };
}

/**
 * The site's power equipment at its layout positions, what the views draw and
 * label: every service transformer and energy asset of `equipment` (in its
 * table order) at its stored position by id, else at the default place of its
 * kind (`newTransformerPoint`, `newBatteryPoint`, `newSolarCanopyPlace`),
 * placed by its type (`placeEnergyAsset`). A stored position whose equipment
 * is gone is left out. Step-down transformers stand beside the panelboard
 * they feed, not on the layout grass, so they are not placed here.
 * `settings` are the effective settings (`effectiveLayoutSettings`).
 */
export function placePowerEquipment(
  settings: SiteLayoutSettings,
  equipment: LayoutPowerEquipment,
  stations?: readonly LayoutStationPlace[],
): PlacedLayoutSettings {
  const txAt = new Map(settings.transformers.map((t) => [t.id, t]));
  const assetAt = new Map(energyAssetsOf(settings).map((a) => [a.id, a]));
  const placeOf = new Map((stations ?? []).map((p) => [p.id, p]));
  const service = equipment.transformers.filter((t) => t.kind === 'service');
  const transformers: PlacedTransformer[] = [];
  // Stored ones first, so a default place keeps clear of every stored one.
  const taken: Array<{ x: number; z: number }> = service.flatMap((t) => {
    const at = txAt.get(t.id);
    return at != null ? [{ x: at.x, z: at.z }] : [];
  });
  for (const info of service) {
    const stored = txAt.get(info.id);
    let at: { x: number; z: number };
    if (stored != null) at = stored;
    else {
      const group = (info.stationIds ?? []).flatMap((id) => {
        const p = placeOf.get(id);
        return p != null ? [p] : [];
      });
      at = groupTransformerPoint(settings, group, stations ?? [], taken);
      taken.push(at);
    }
    transformers.push({
      id: info.id,
      kind: info.kind,
      name: info.name,
      ratedKva: info.ratedKva,
      maxContinuousKw: info.maxContinuousKw,
      x: at.x,
      z: at.z,
    });
  }
  const energyAssets: LayoutEnergyAsset[] = [];
  let batteries = 0;
  let canopies = 0;
  const covered = new Set<number>();
  for (const info of equipment.energyAssets) {
    const at = assetAt.get(info.id);
    if (info.type === 'battery') {
      const point =
        at?.x != null && at.z != null
          ? { x: at.x, z: at.z }
          : newBatteryPoint(settings, batteries, stations);
      batteries++;
      energyAssets.push(
        placeEnergyAsset(
          {
            id: info.id,
            type: 'battery',
            name: info.name,
            capacityKwh: info.capacityKwh,
            ...point,
          },
          settings,
        ),
      );
      continue;
    }
    const place = newSolarCanopyPlace(settings, covered, canopies, stations);
    canopies++;
    const canopy = placeEnergyAsset(
      {
        id: info.id,
        type: 'solar',
        name: info.name,
        capacityKwp: info.peakKwp,
        row: at?.row ?? place.row,
        ...(at?.x != null && at.z != null
          ? { x: at.x, z: at.z, rotationDeg: at.rotationDeg ?? 0 }
          : place.x != null && place.z != null
            ? { x: place.x, z: place.z, rotationDeg: place.rotationDeg ?? 0 }
            : {}),
      },
      settings,
    );
    if (canopy.type === 'solar') covered.add(canopy.row);
    energyAssets.push(canopy);
  }
  return { ...settings, transformers, energyAssets };
}

/**
 * Settings whose energy asset positions follow their type's place rule
 * (`placeEnergyAsset`): a battery on the grass beside the lot (a custom site:
 * within reach), a canopy's row within the lot. `types` are the assets' table
 * types by id; a position of an unknown asset stays as it is. Fills in no
 * default place (positions only, as stored).
 */
export function placeEnergyAssetPositions(
  settings: SiteLayoutSettings,
  types: ReadonlyMap<string, EnergyAssetType>,
): SiteLayoutSettings {
  if (settings.energyAssets == null) return settings;
  return {
    ...settings,
    energyAssets: settings.energyAssets.map((a) => {
      const type = types.get(a.id);
      if (type === 'battery' && a.x != null && a.z != null) {
        const placed = placeEnergyAsset(
          { id: a.id, type, name: '', capacityKwh: null, x: a.x, z: a.z },
          settings,
        );
        return placed.type === 'battery' ? { ...a, x: placed.x, z: placed.z } : a;
      }
      if (type === 'solar' && a.row != null) {
        return { ...a, row: Math.min(settings.rows - 1, Math.max(0, Math.round(a.row))) };
      }
      return a;
    }),
  };
}

/**
 * The positions of placed settings, as `sites.layout_settings` holds them:
 * each transformer `{ id, x, z }` and each energy asset by id with the fields
 * of its place (a battery `x`, `z`; a canopy `row`, and `x`, `z`,
 * `rotationDeg` when it stands freely).
 */
export function layoutPositionsOf(settings: PlacedLayoutSettings): SiteLayoutSettings {
  return {
    ...settings,
    transformers: settings.transformers.map((t) => ({ id: t.id, x: t.x, z: t.z })),
    energyAssets: settings.energyAssets.map((a) =>
      a.type === 'battery'
        ? { id: a.id, x: a.x, z: a.z }
        : {
            id: a.id,
            row: a.row,
            ...(a.x != null && a.z != null
              ? { x: a.x, z: a.z, ...(a.rotationDeg != null ? { rotationDeg: a.rotationDeg } : {}) }
              : {}),
          },
    ),
  };
}

/**
 * An energy asset where the lot lets it stand: a battery on the grass (the
 * transformer rule), a solar canopy over a row of the lot (clamped into it).
 */
export function placeEnergyAsset(asset: LayoutEnergyAsset, grid: LayoutShape): LayoutEnergyAsset {
  // A custom site has no lot: a battery stands where it was put (within reach).
  if (asset.type === 'battery') {
    const spot = usesFreePositions(grid)
      ? clampFreePoint(asset.x, asset.z)
      : snapTransformerToGrass(asset.x, asset.z, grid);
    return { ...asset, ...spot };
  }
  return { ...asset, row: Math.min(grid.rows - 1, Math.max(0, Math.round(asset.row))) };
}

/**
 * The stations at a site, for the defaults of the site type's counts: all of
 * them, and for a depot how many charge buses and how many trucks
 * (`depotStationKind`). A plain number counts every station as a bus station.
 */
export interface LayoutStationCounts {
  total: number;
  bus: number;
  truck: number;
  /** Parking lot spots the stations take (a dual-port AC pedestal two); absent: one each. */
  spots?: number;
}

/** Station counts from a plain number (every station a bus station) or as given. */
export function layoutStationCounts(counts: number | LayoutStationCounts): LayoutStationCounts {
  return typeof counts === 'number' ? { total: counts, bus: counts, truck: 0 } : counts;
}

/**
 * Which depot spot a station takes, from its connectors: a truck pull-through
 * lane for a Megawatt Charging System connector (`MCS`, `cMCS`, any case), a
 * bus bay for any other DC station (pantograph `OppCharge` and `Pan`, plug-in
 * CCS dispensers; a truck charging over CCS takes a truck lane by moving it
 * there), and none for an AC station: a depot charges DC only, so an AC
 * station stands off the layout, below it (`firstFreeDepotSlot`).
 */
export function depotStationKind(
  connectors: readonly ConnectorPowerInput[],
): 'bus' | 'truck' | null {
  if (connectors.some((c) => c.connectorType != null && /mcs/i.test(c.connectorType))) {
    return 'truck';
  }
  return stationChargingKind(connectors) === 'dc' ? 'bus' : null;
}

/** What decides where a station goes: AC or DC (`stationChargingKind`), and its depot spot (`depotStationKind`). */
export interface LayoutStationKind {
  charging: ChargingKind;
  depot: 'bus' | 'truck' | null;
  /** In-service EVSEs (charging ports); absent counts as one. */
  ports?: number | undefined;
}

/**
 * The layout kind of a station from the connectors of its in-service EVSEs,
 * and how many EVSEs it has (`ports`, for a dual-port AC pedestal).
 */
export function layoutStationKind(
  connectors: readonly ConnectorPowerInput[],
  ports?: number,
): LayoutStationKind {
  return {
    charging: stationChargingKind(connectors),
    depot: depotStationKind(connectors),
    ...(ports != null ? { ports } : {}),
  };
}

/**
 * The station counts of the layout defaults from the stations' kinds: an AC
 * station takes no depot spot, a station whose connectors are not known yet
 * (undefined) counts as a bus station.
 */
export function layoutStationCountsOfKinds(
  kinds: ReadonlyArray<LayoutStationKind | undefined>,
): LayoutStationCounts {
  return {
    total: kinds.length,
    bus: kinds.filter((k) => k == null || k.depot === 'bus').length,
    truck: kinds.filter((k) => k?.depot === 'truck').length,
    // A dual-port AC pedestal takes two spots, a DC split system one per dispenser.
    spots: kinds.reduce(
      (n, k) =>
        n +
        (k?.charging === 'ac' && (k.ports ?? 1) >= 2
          ? 2
          : k?.charging === 'dc' && (k.ports ?? 1) >= SPLIT_SYSTEM.minDispensers
            ? Math.min(SPLIT_SYSTEM.maxDispensers, k.ports ?? 1)
            : 1),
      0,
    ),
  };
}

/**
 * The fields of a site type filled in where absent, from the stations at the
 * site: an office or retail site gets one charger position per station (at
 * least 1) and wall boxes; a street splits the stations over both curbs (the
 * left one takes the odd one), at least 1 in all; a depot gets one bus bay per
 * bus station and one truck lane per truck station (one bus bay when it has
 * neither). Stored values stay as they are.
 */
function withTypeDefaults(
  settings: SiteLayoutSettings,
  stations: number | LayoutStationCounts,
): SiteLayoutSettings {
  const counts = layoutStationCounts(stations);
  const n = Math.max(1, Math.min(LAYOUT_GRID_LIMITS.chargers.max, Math.round(counts.total)));
  switch (siteTypeOf(settings)) {
    case 'depot': {
      const max = LAYOUT_GRID_LIMITS.depotSpots.max;
      const clamp = (v: number): number => Math.max(0, Math.min(max, Math.round(v)));
      let bus = settings.busBays;
      let truck = settings.truckLanes;
      if (bus == null && truck == null) {
        bus = clamp(counts.bus);
        truck = clamp(counts.truck);
        if (bus === 0 && truck === 0) bus = 1;
      } else if (bus == null) {
        bus = truck === 0 ? Math.max(1, clamp(counts.bus)) : clamp(counts.bus);
      } else if (truck == null) {
        truck = bus === 0 ? Math.max(1, clamp(counts.truck)) : clamp(counts.truck);
      }
      return { ...settings, busBays: bus, truckLanes: truck };
    }
    case 'office_retail':
      return {
        ...settings,
        chargers: settings.chargers ?? n,
        mounting: chargerMountingOf(settings),
      };
    case 'curbside': {
      const side = LAYOUT_GRID_LIMITS.chargersPerSide.max;
      let left = settings.chargersLeft;
      let right = settings.chargersRight;
      if (left == null && right == null) {
        left = Math.min(side, Math.ceil(n / 2));
        right = Math.min(side, n - left);
      } else if (left == null) {
        left = Math.min(side, Math.max(right === 0 ? 1 : 0, n - (right ?? 0)));
      } else if (right == null) {
        right = Math.min(side, Math.max(left === 0 ? 1 : 0, n - left));
      }
      return { ...settings, chargersLeft: left, chargersRight: right };
    }
    default:
      return settings;
  }
}

/** Copies the known fields only, so keys of earlier builds (the spot and lane sizes) drop out. */
function knownFields(stored: SiteLayoutSettings): SiteLayoutSettings {
  return {
    ...(stored.siteType != null ? { siteType: stored.siteType } : {}),
    spotsPerRow: stored.spotsPerRow,
    rows: stored.rows,
    facingDeg: stored.facingDeg,
    ...(stored.chargers != null ? { chargers: stored.chargers } : {}),
    ...(stored.mounting != null ? { mounting: stored.mounting } : {}),
    // A charger placement belongs to a parking lot only.
    ...(stored.chargerPlacement != null && siteTypeOf(stored) === 'parking_lot'
      ? { chargerPlacement: stored.chargerPlacement }
      : {}),
    ...(stored.chargersLeft != null ? { chargersLeft: stored.chargersLeft } : {}),
    ...(stored.chargersRight != null ? { chargersRight: stored.chargersRight } : {}),
    ...(stored.busBays != null ? { busBays: stored.busBays } : {}),
    ...(stored.truckLanes != null ? { truckLanes: stored.truckLanes } : {}),
    transformers: stored.transformers,
    ...(stored.energyAssets != null ? { energyAssets: stored.energyAssets } : {}),
  };
}

/**
 * The layout settings the views and the placement use. Stored settings as
 * stored (the site type filled in, the fields of that type filled in from
 * `stationCount` where absent, transformer positions moved onto the grass,
 * solar canopy rows clamped into the lot's rows, energy assets filled in as
 * none when absent, unknown keys dropped); a site that never saved any gets
 * a parking lot: the default 10 by 2 lot, grown to hold the stations it
 * already has (`bays`), with no equipment positions. Positions only: the
 * equipment itself joins in through `placePowerEquipment`.
 * `stationCount` is the stations at the site (`bays` counted when not given;
 * a depot reads the bus and truck stations of `LayoutStationCounts`).
 */
export function effectiveLayoutSettings(
  stored: SiteLayoutSettings | null | undefined,
  bays: Iterable<LayoutBay> = [],
  stationCount?: number | LayoutStationCounts,
): SiteLayoutSettings {
  const bayList = [...bays];
  const count = stationCount ?? bayList.length;
  if (stored != null) {
    // The type's counts first: a depot's yard, which equipment keeps clear of, follows them.
    const known = withTypeDefaults({ ...knownFields(stored), siteType: siteTypeOf(stored) }, count);
    const free = usesFreePositions(known);
    return {
      ...known,
      transformers: known.transformers.map((t) => ({
        id: t.id,
        ...(free ? clampFreePoint(t.x, t.z) : snapTransformerToGrass(t.x, t.z, known)),
      })),
      // The type of an asset lives in its table row, so its place follows
      // there (`placePowerEquipment`); a canopy's row stays within the lot.
      energyAssets: energyAssetsOf(known).map((a) =>
        a.row == null ? a : { ...a, row: Math.min(known.rows - 1, Math.max(0, Math.round(a.row))) },
      ),
    };
  }
  let spotsPerRow = DEFAULT_LAYOUT_GRID.spotsPerRow;
  // Without stored settings the lot holds every station (and the access
  // aisle of the accessible space), so automatic placement puts each one in
  // its charging kind's group (`firstFreeSlotFor`) instead of in rows below
  // the lot in creation order, where AC and DC would interleave. Rows come in
  // pairs (double-loaded, back to back on an island), with one row to spare:
  // the two groups fill from opposite ends and pedestals take spot pairs.
  const spots = typeof count === 'number' ? count : (count.spots ?? count.total);
  const needed = Math.ceil((spots + 1) / spotsPerRow) + 1;
  let rows = Math.min(
    LAYOUT_GRID_LIMITS.rows.max,
    Math.max(DEFAULT_LAYOUT_GRID.rows, needed + (needed % 2)),
  );
  for (const b of bayList) {
    spotsPerRow = Math.min(LAYOUT_GRID_LIMITS.spotsPerRow.max, Math.max(spotsPerRow, b.col + 1));
    rows = Math.min(LAYOUT_GRID_LIMITS.rows.max, Math.max(rows, b.row + 1));
  }
  const grid = { ...DEFAULT_LAYOUT_GRID, spotsPerRow, rows };
  return {
    siteType: DEFAULT_SITE_TYPE,
    ...grid,
    transformers: [],
    energyAssets: [],
  };
}

/**
 * The settings with another site type: the type set and its fields filled in
 * from `stationCount` where absent; every other field kept, so switching back
 * restores it.
 */
export function withSiteType(
  settings: SiteLayoutSettings,
  siteType: SiteType,
  stationCount: number | LayoutStationCounts,
): SiteLayoutSettings {
  return withTypeDefaults({ ...settings, siteType }, stationCount);
}

/** The lot fields of the settings. */
export function layoutGridOf(settings: SiteLayoutGrid): SiteLayoutGrid {
  return {
    spotsPerRow: settings.spotsPerRow,
    rows: settings.rows,
    facingDeg: settings.facingDeg,
  };
}

/**
 * The first slot whose card overlaps none of `placed`: row by row through the
 * spots of the layout, then the rows below it (a station placed there stands
 * off the layout until it moves or the layout grows).
 */
export function firstFreeSlot(
  placed: readonly LayoutPoint[],
  settings: LayoutShape = DEFAULT_LAYOUT_GRID,
): LayoutPoint {
  const lengths = layoutRowLengths(settings);
  const beyond = Math.max(1, ...lengths);
  for (let row = 0; ; row++) {
    const cols = lengths[row] ?? beyond;
    for (let col = 0; col < cols; col++) {
      const slot = bayToPosition({ col, row });
      if (!placed.some((p) => cardsOverlap(p, slot))) return slot;
    }
  }
}

/**
 * The first slot below the layout (row by row from the first row past it)
 * whose card overlaps none of `placed`: where a station with no spot of its
 * kind stands, off the layout.
 */
export function firstFreeSlotBelowLayout(
  placed: readonly LayoutPoint[],
  settings: LayoutShape,
): LayoutPoint {
  const lengths = layoutRowLengths(settings);
  const cols = Math.max(1, ...lengths);
  for (let row = lengths.length; ; row++) {
    for (let col = 0; col < cols; col++) {
      const slot = bayToPosition({ col, row });
      if (!placed.some((p) => cardsOverlap(p, slot))) return slot;
    }
  }
}

/**
 * Where the electrical equipment of a site stands, in lot meters: its first
 * transformer, else where the default transformer goes (right of the first
 * row). The DC chargers group next to it, so their heavy feeders stay short.
 */
export function layoutEquipmentPoint(
  settings: LayoutShape & { transformers?: readonly LayoutTransformer[] },
): { x: number; z: number } {
  const first = settings.transformers?.[0];
  if (first != null) return { x: first.x, z: first.z };
  return defaultTransformerPoint(layoutGridOf(settings));
}

/** The middle of spot (c, r) in lot meters (standard dimensions), for the grouping order. */
export function spotCenterM(bay: LayoutBay, settings: LayoutShape): { x: number; z: number } {
  const d = STANDARD_DIMENSIONS;
  switch (siteTypeOf(settings)) {
    case 'curbside': {
      const depth = 2 * d.parallelSpotWidthM + 2 * d.travelLaneM;
      return {
        x: d.parallelSpotLengthM * (bay.col + 0.5),
        z: bay.row === 0 ? d.parallelSpotWidthM / 2 : depth - d.parallelSpotWidthM / 2,
      };
    }
    case 'office_retail':
      return { x: d.spotWidthM * (bay.col + 0.5), z: d.spotDepthM / 2 };
    default:
      return {
        x: d.spotWidthM * (bay.col + 0.5),
        z: parkingRowZ(bay.row, settings.rows) + d.spotDepthM / 2,
      };
  }
}

/**
 * The spots of a parking lot, an office or retail row or a street in the
 * order a station of this charging kind takes them: DC from the spot nearest
 * the equipment (`layoutEquipmentPoint`) outward, AC from the farthest spot
 * inward, so the two groups fill from opposite ends and never interleave.
 * Ties go row by row, then by column.
 */
export function groupedSpotOrder(settings: LayoutShape, charging: ChargingKind): LayoutBay[] {
  const lengths = layoutRowLengths(settings);
  const e = layoutEquipmentPoint(settings);
  const spots: Array<{ bay: LayoutBay; d: number }> = [];
  lengths.forEach((n, row) => {
    for (let col = 0; col < n; col++) {
      const c = spotCenterM({ col, row }, settings);
      spots.push({ bay: { col, row }, d: Math.round(Math.hypot(c.x - e.x, c.z - e.z) * 1000) });
    }
  });
  const sign = charging === 'dc' ? 1 : -1;
  spots.sort((a, b) => sign * (a.d - b.d) || a.bay.row - b.bay.row || a.bay.col - b.bay.col);
  return spots.map((s) => s.bay);
}

/**
 * A placed station's slot and, when known, its charging kind: placement
 * reads the kind to keep the AC and DC groups apart.
 */
export type PlacedSlot = LayoutPoint & {
  charging?: ChargingKind | null | undefined;
  /** A dual-port AC pedestal standing between its spot and the partner spot (`sharesSpotPair`). */
  pair?: boolean | undefined;
  /**
   * A DC split system's dispensers (`splitDispenserCount`): the spots it holds
   * along its row from its slot, one per dispenser (absent or 1: its own spot).
   */
  span?: number | undefined;
};

/**
 * A DC split system: one power cabinet that feeds several dispensers
 * (satellites), each at its own parking spot, the way manufacturers build
 * multi-outlet DC sites. Kempower S-Series Charging Satellite, Technical
 * Datasheet North America (2022): "One C-Series CPU can be connected to up to
 * 8 charging outputs: 4 double satellites or 8 single satellites"; a single
 * satellite 300 x 1518 x 300 mm (W x H x D) with one charging output;
 * "recommended cabling distance between C-Series charging power unit and
 * S-Series charging satellite is up to 262 feet / 80 meters",
 * https://www.nee.ca/wp-content/uploads/2023/08/Kempower-S-Series-ETL-Datasheet-Rev-2.2-0622.pdf.
 * Kempower C-Series Power Unit datasheet (2022): single cabinet 650 x 2195 x
 * 841 mm, double 1250 x 2195 x 841 mm, triple 1850 x 2195 x 841 mm (W x H x
 * D), https://www.nee.ca/wp-content/uploads/2023/08/Kempower-C-Series-Power-Units.pdf.
 * In OCPP the system is one charging station with one EVSE per output: a DC
 * station with three or more EVSEs is drawn as one cabinet on its group's
 * equipment pad and one dispenser per EVSE, each at its own spot, contiguous
 * in the DC group (owner decision 2026-11-01). A DC station with one or two
 * EVSEs is one dispenser with a cable per connector (a dual-outlet
 * dispenser, or a multi-standard one such as the ABB Terra 54 CJG with CCS,
 * CHAdeMO and an AC Type 2 cable, which charges one vehicle on DC at a time:
 * ABB Terra 54 manual, "simultaneous DC charging is never possible",
 * https://www.manualslib.com/manual/2092694/Abb-Terra-54.html?page=9).
 */
export const SPLIT_SYSTEM = {
  /** EVSEs from which a DC station is a split system. */
  minDispensers: 3,
  /** Outputs one power unit feeds at most (8 single satellites). */
  maxDispensers: 8,
  /** The double power cabinet (1250 x 2195 x 841 mm). */
  cabinet: { widthM: 1.25, heightM: 2.195, depthM: 0.841 },
  /** A single satellite (300 x 1518 x 300 mm). */
  dispenser: { widthM: 0.3, heightM: 1.518, depthM: 0.3 },
  /** Recommended cable run from the power unit to a satellite, at most (80 m). */
  maxCableM: 80,
} as const;

/**
 * The most EVSEs and connectors one charger unit is drawn with (owner
 * decision 2026-11-02, items checked against manufacturer datasheets):
 * - AC Level 2 pedestal or wall box: at most 2 EVSEs (ports), one connector
 *   each (owner's number; ChargePoint CPF50 is sold single or dual port, one
 *   J1772 or J3400 cable per port, https://www.chargepoint.com/products/stations/cpf50/specs).
 * - DC dispenser: at most 2 EVSEs charging at once (ABB Terra 124/184 NA Data
 *   Sheet J: "2 x 90 kW for two" EVs; Tritium PKM150 CSv6 datasheet: 2 x 75 kW),
 *   each with up to 2 connectors of which one charges at a time (Kempower
 *   Satellite v2 NA datasheet Rev 1.70, code "Y": CCS1 or J3400-NACS, two
 *   cables, one vehicle at a time); a dispenser of one EVSE up to 3 (ABB Terra
 *   54 CJG: CCS, CHAdeMO and an AC Type 2 cable, one vehicle at a time); at
 *   most 4 cables in all (Alpitronic HYC400UL Product Data Sheet V1-2: up to 4
 *   outputs). Alpitronic sells up to 4 simultaneous outputs per cabinet,
 *   so 2 EVSEs is a modelling choice for one dispenser, not an industry limit;
 *   a DC station with more EVSEs is a split system (`SPLIT_SYSTEM`).
 * The API never refuses a station with more (stations report their own over
 * OCPP); the 3D view draws the first EVSEs and connectors up to these limits.
 */
export const CHARGER_PORT_LIMITS = {
  ac: { evses: 2, connectorsPerEvse: 1, cables: 2 },
  dc: { evses: 2, connectorsPerEvse: 2, cables: 4, singleEvseConnectors: 3 },
} as const;

/**
 * The connectors drawn on each EVSE of one charger unit, EVSE order: the
 * first `CHARGER_PORT_LIMITS[kind].evses` EVSEs, each with at most
 * `connectorsPerEvse` (a one-EVSE DC unit `singleEvseConnectors`) and at least
 * one, and no more than `cables` in all.
 */
export function drawnConnectorCounts(
  kind: 'ac' | 'dc',
  connectorsPerEvse: readonly number[],
): number[] {
  const limit = CHARGER_PORT_LIMITS[kind];
  const out: number[] = [];
  let left: number = limit.cables;
  const evses = connectorsPerEvse.slice(0, limit.evses);
  // A one-EVSE DC unit may carry a third cable (a multi-standard dispenser).
  const perEvse =
    kind === 'dc' && evses.length === 1
      ? CHARGER_PORT_LIMITS.dc.singleEvseConnectors
      : limit.connectorsPerEvse;
  for (const n of evses) {
    if (left <= 0) break;
    const drawn = Math.min(Math.max(1, Math.round(n)), perEvse, left);
    out.push(drawn);
    left -= drawn;
  }
  return out.length > 0 ? out : [1];
}

/**
 * How many dispensers a station stands at separate spots (`SPLIT_SYSTEM`):
 * its EVSEs for a DC station with three or more (up to eight) on a parking
 * lot or an office or retail row; else 1. A custom site gives such a station
 * one car spot per EVSE, up to four (`freeSpotCount`); a depot keeps one bus
 * bay or truck lane per station (each depot slot is one vehicle's bay), and a
 * street one curb post per station (no source: a decision for the street
 * type, whose posts stand on a public sidewalk).
 */
export function splitDispenserCount(
  kind: Pick<LayoutStationKind, 'charging' | 'ports'> | null | undefined,
  settings: LayoutShape,
): number {
  if (kind == null || kind.charging !== 'dc') return 1;
  const ports = kind.ports ?? 1;
  if (ports < SPLIT_SYSTEM.minDispensers) return 1;
  const type = siteTypeOf(settings);
  if (type !== 'parking_lot' && type !== 'office_retail') return 1;
  return Math.min(SPLIT_SYSTEM.maxDispensers, ports);
}

/** The spots a station of `span` dispensers holds from `bay` along its row; null when they leave the layout. */
export function spanSpots(bay: LayoutBay, span: number, settings: LayoutShape): LayoutBay[] | null {
  const out: LayoutBay[] = [];
  for (let i = 0; i < Math.max(1, span); i++) {
    const b = { col: bay.col + i, row: bay.row };
    if (!bayInLayout(b, settings)) return null;
    out.push(b);
  }
  return out;
}

/**
 * Whether a station of this kind is a dual-port AC pedestal that serves two
 * spots on a parking lot: an AC station with two or more EVSEs. It stands on
 * the line between its spot and the partner spot (`spotPairPartner`), one
 * port per spot, as ChargePoint lays out its dual-port CPF50 pedestals ("two
 * stations back to back centered on four spaces", CPF50 Site Design Guide,
 * Civil and Mechanical Design,
 * https://docs.chargepoint.com/cpdocs-sec/content/2-ac/cpf50/sdg/cvl-and-mchncl-dsgn.htm).
 * A DC dispenser keeps one spot (its cables reach the next stall's inlet
 * from its own spot); other site types keep one spot per station.
 */
export function sharesSpotPair(
  kind: Pick<LayoutStationKind, 'charging' | 'ports'> | null | undefined,
  settings: LayoutShape,
): boolean {
  return (
    kind != null &&
    kind.charging === 'ac' &&
    (kind.ports ?? 1) >= 2 &&
    siteTypeOf(settings) === 'parking_lot'
  );
}

/**
 * The partner spot of a parking lot spot: spots pair up along each row from
 * its first spot (columns 0 and 1, 2 and 3, ...). Null for the last spot of
 * a row of odd length, a slot off the layout and the other site types.
 */
export function spotPairPartner(bay: LayoutBay, settings: LayoutShape): LayoutBay | null {
  if (siteTypeOf(settings) !== 'parking_lot' || !bayInLayout(bay, settings)) return null;
  const partner = { col: bay.col % 2 === 0 ? bay.col + 1 : bay.col - 1, row: bay.row };
  return bayInLayout(partner, settings) ? partner : null;
}

/**
 * An accessible EV charging space, after the US Access Board, Design
 * Recommendations for Accessible Electric Vehicle Charging Stations (2022),
 * https://www.access-board.gov/tad/ev/: a vehicle space "with a minimum width
 * of at least 132 inches (11 feet)" and "a minimum length of at least 240
 * inches (20 feet)", and beside it "an access aisle that is at least 60 inches
 * (5 feet) wide", marked "to discourage parking in them" where the spaces are
 * marked. "Signs displaying the ISA are not recommended at accessible EV
 * charging spaces at this time, unless required by a state or local code", so
 * the layout draws no International Symbol of Accessibility. The space takes
 * two standard spots: the station's spot widened into the next one (2.6 +
 * 2.6 - 1.52 = 3.68 m, wider than 11 ft) and the striped aisle. Its length
 * stays the row's 5.5 m spot depth, shorter than the recommended 20 ft (the
 * rows keep one depth). The Access Board recommends at least two spaces with
 * accessible mobility features; the owner chose at least one per public site.
 */
export const ACCESSIBLE_SPACE = {
  vehicleMinWidthM: 3.35,
  aisleWidthM: 1.52,
  recommendedLengthM: 6.1,
} as const;

/** Whether a site type models an accessible charging space (public parking lots and office or retail rows). */
export function modelsAccessibleSpace(settings: LayoutShape): boolean {
  const type = siteTypeOf(settings);
  return type === 'parking_lot' || type === 'office_retail';
}

const bayKey = (b: LayoutBay): string => `${String(b.col)}:${String(b.row)}`;

/**
 * The accessible charging space of a site (`ACCESSIBLE_SPACE`): the station
 * spot nearest the electrical equipment (`groupedSpotOrder` for DC, so
 * usually a DC charger, whose cables reach either side of a car) whose
 * neighbor spot in its row (the next column, else the one before) holds no
 * station and is no dual-port pedestal's partner: that neighbor becomes the
 * striped access aisle. A dual-port pedestal serves two spots and is passed
 * over. Null on a depot, a street, a custom site, and when no station spot
 * has a free neighbor.
 */
export function accessibleChargingSpace(
  placed: readonly PlacedSlot[],
  settings: LayoutShape,
): { stall: LayoutBay; aisle: LayoutBay } | null {
  if (!modelsAccessibleSpace(settings)) return null;
  const held = new Set<string>();
  const single = new Set<string>();
  for (const p of placed) {
    const bay = positionToBay(p);
    if (!bayInLayout(bay, settings)) continue;
    held.add(bayKey(bay));
    const span = p.span ?? 1;
    if (span > 1) {
      for (const b of spanSpots(bay, span, settings) ?? [bay]) held.add(bayKey(b));
      continue;
    }
    const partner = p.pair === true ? spotPairPartner(bay, settings) : null;
    if (partner != null) held.add(bayKey(partner));
    else single.add(bayKey(bay));
  }
  for (const bay of groupedSpotOrder(settings, 'dc')) {
    if (!single.has(bayKey(bay))) continue;
    for (const col of [bay.col + 1, bay.col - 1]) {
      const aisle = { col, row: bay.row };
      if (bayInLayout(aisle, settings) && !held.has(bayKey(aisle))) return { stall: bay, aisle };
    }
  }
  return null;
}

/**
 * The spots of the layout no new station may take, with the charging kind
 * of the station holding each (null when unknown): every placed station's
 * spot, a dual-port pedestal's partner spot, and the access aisle of the
 * accessible charging space (held by that space's station). `withAisle`
 * false leaves the aisle out: automatic placement continues a group's run
 * through it, and the accessible space moves to the run's new end
 * (`accessibleChargingSpace`), so no charger-free spot stays inside a run.
 */
export function heldSpots(
  placed: readonly PlacedSlot[],
  settings: LayoutShape,
  withAisle = true,
): Map<string, ChargingKind | null> {
  const held = new Map<string, ChargingKind | null>();
  for (const p of placed) {
    const bay = positionToBay(p);
    held.set(bayKey(bay), p.charging ?? null);
    const partner = p.pair === true ? spotPairPartner(bay, settings) : null;
    if (partner != null) held.set(bayKey(partner), p.charging ?? null);
    // A split system's dispensers, one spot each (`splitDispenserCount`).
    const span = p.span ?? 1;
    if (span > 1) {
      for (const b of spanSpots(bay, span, settings) ?? []) held.set(bayKey(b), p.charging ?? null);
    }
  }
  if (!withAisle) return held;
  const access = accessibleChargingSpace(placed, settings);
  if (access != null) held.set(bayKey(access.aisle), held.get(bayKey(access.stall)) ?? null);
  return held;
}

/**
 * The first free slot for a new station of this kind: on a depot a bay or
 * lane of its area (`firstFreeDepotSlot`; an AC station below the layout); on
 * a parking lot, an office or retail row or a street the first free spot of
 * its charging kind's group (`groupedSpotOrder`). The walk stops at the first
 * spot a station of the other kind holds: past it lies that kind's range, so
 * the groups never interleave. Without a free spot in its own range the
 * station stands below the layout, like any station without a spot
 * (`firstFreeSlotBelowLayout`). Without a kind (a station whose connectors
 * are not known yet) it takes the first free slot row by row
 * (`firstFreeSlot`). A custom site places its stations freely, so its slot is
 * the plain first free one.
 */
export function firstFreeSlotFor(
  placed: readonly PlacedSlot[],
  settings: LayoutShape,
  kind?: LayoutStationKind,
): LayoutPoint {
  if (kind == null || usesFreePositions(settings)) return firstFreeSlot(placed, settings);
  if (usesDepotSpots(settings)) return firstFreeDepotSlot(placed, settings, kind.depot);
  const held = heldSpots(placed, settings, false);
  const other = (b: LayoutBay): boolean => {
    const k = held.get(bayKey(b));
    return k != null && k !== kind.charging;
  };
  const pair = sharesSpotPair(kind, settings);
  const span = splitDispenserCount(kind, settings);
  for (const bay of groupedSpotOrder(settings, kind.charging)) {
    // The other kind's range starts here.
    if (other(bay)) break;
    if (held.has(bayKey(bay))) continue;
    if (span > 1) {
      // A split system needs a free spot for every dispenser, contiguous in its row.
      const spots = spanSpots(bay, span, settings);
      if (spots == null || spots.some((b) => held.has(bayKey(b)))) continue;
      return bayToPosition(bay);
    }
    if (!pair) return bayToPosition(bay);
    // A dual-port pedestal needs its partner spot free too.
    const partner = spotPairPartner(bay, settings);
    if (partner == null || held.has(bayKey(partner))) continue;
    return bayToPosition(bay);
  }
  return firstFreeSlotBelowLayout(placed, settings);
}

/**
 * Free slots for stations without a stored position, in the order given: each
 * takes the first slot free of `placed` and of the slots handed out before it
 * (`firstFreeSlotFor` with its kind; a plain count places without kinds).
 */
export function freeSlotsFor(
  stations: number | ReadonlyArray<LayoutStationKind | undefined>,
  placed: readonly PlacedSlot[],
  settings: LayoutShape = DEFAULT_LAYOUT_GRID,
): LayoutPoint[] {
  const kinds: Array<LayoutStationKind | undefined> =
    typeof stations === 'number'
      ? Array.from({ length: stations }, () => undefined)
      : [...stations];
  const taken: PlacedSlot[] = [...placed];
  const out: LayoutPoint[] = [];
  for (const kind of kinds) {
    const slot = firstFreeSlotFor(taken, settings, kind);
    taken.push({
      ...slot,
      charging: kind?.charging ?? null,
      pair: sharesSpotPair(kind, settings),
      span: splitDispenserCount(kind, settings),
    });
    out.push(slot);
  }
  return out;
}

/**
 * Regroups the stations of a site that turns into a parking lot, an office or
 * retail row or a street: the DC stations take the spots nearest the
 * equipment and the AC stations the rest, from the far end
 * (`groupedSpotOrder`), so the two never interleave. A station already in a
 * spot of its group keeps it; any other takes the free spot of its group
 * nearest its slot, else any free spot, else is listed in `unfit` and keeps
 * its position (off the layout). A depot uses `fitDepotPositions`; a custom
 * site moves nothing.
 */
export function fitGroupedPositions<K>(
  stations: ReadonlyArray<{ key: K; position: LayoutPoint; kind?: LayoutStationKind | undefined }>,
  settings: LayoutShape,
): GridFit<K> {
  if (usesFreePositions(settings)) return { moved: new Map(), unfit: [] };
  if (usesDepotSpots(settings)) return fitDepotPositions(stations, settings);
  // No station's connectors known yet: nothing to group (the positions rule).
  if (stations.every((s) => s.kind == null)) return fitPositionsToGrid(stations, settings);
  const lengths = layoutRowLengths(settings);
  // The DC group's spots: one per dispenser (a split system holds several).
  const dcCount = stations
    .filter((s) => s.kind?.charging === 'dc')
    .reduce((n, s) => n + splitDispenserCount(s.kind, settings), 0);
  const spotKey = (b: LayoutBay): string => `${String(b.col)}:${String(b.row)}`;
  const dcSpots = new Set(groupedSpotOrder(settings, 'dc').slice(0, dcCount).map(spotKey));
  const groupOf = (b: LayoutBay): ChargingKind | null =>
    !bayInLayout(b, settings) ? null : dcSpots.has(spotKey(b)) ? 'dc' : 'ac';
  const isTaken = (occupied: readonly LayoutBay[], b: LayoutBay): boolean =>
    occupied.some((o) => o.col === b.col && o.row === b.row);
  const moved = new Map<K, LayoutPoint>();
  const unfit: K[] = [];
  const occupied: LayoutBay[] = [];
  const rest: Array<{
    key: K;
    bay: LayoutBay;
    charging: ChargingKind | null;
    pair: boolean;
    span: number;
  }> = [];
  // A dual-port pedestal holds its spot and the partner spot (`sharesSpotPair`),
  // a split system a spot per dispenser along its row (`splitDispenserCount`).
  const freeWith = (b: LayoutBay, pair: boolean, span = 1): LayoutBay[] | null => {
    if (isTaken(occupied, b)) return null;
    if (span > 1) {
      const spots = spanSpots(b, span, settings);
      return spots == null || spots.some((o) => isTaken(occupied, o)) ? null : spots;
    }
    if (!pair) return [b];
    const partner = spotPairPartner(b, settings);
    return partner == null || isTaken(occupied, partner) ? null : [b, partner];
  };
  for (const s of stations) {
    const bay = positionToBay(s.position);
    const charging = s.kind?.charging ?? null;
    const pair = sharesSpotPair(s.kind, settings);
    const span = splitDispenserCount(s.kind, settings);
    // An unknown station keeps any spot; a known one a spot of its group
    // (a pedestal: both spots of its pair; a split system: a spot per dispenser).
    const spots = freeWith(bay, pair, span);
    const fits =
      spots != null &&
      (charging == null ? bayInLayout(bay, settings) : spots.every((b) => groupOf(b) === charging));
    if (fits) occupied.push(...spots);
    else rest.push({ key: s.key, bay, charging, pair, span });
  }
  for (const s of rest) {
    // The free spot (a pedestal: free pair) of the station's group nearest
    // its slot, else any free spot or pair.
    const pick: {
      target: LayoutBay[] | null;
      fallback: LayoutBay[] | null;
      best: number;
      bestAny: number;
    } = { target: null, fallback: null, best: Infinity, bestAny: Infinity };
    lengths.forEach((n, row) => {
      for (let col = 0; col < n; col++) {
        const spots = freeWith({ col, row }, s.pair, s.span);
        if (spots == null) continue;
        const dist = (col - s.bay.col) ** 2 + (row - s.bay.row) ** 2;
        if (dist < pick.bestAny) {
          pick.bestAny = dist;
          pick.fallback = spots;
        }
        if (s.charging == null || !spots.every((b) => groupOf(b) === s.charging)) continue;
        if (dist < pick.best) {
          pick.best = dist;
          pick.target = spots;
        }
      }
    });
    const chosen = pick.target ?? pick.fallback;
    if (chosen == null) {
      unfit.push(s.key);
      continue;
    }
    occupied.push(...chosen);
    const [first] = chosen;
    if (first != null && (first.col !== s.bay.col || first.row !== s.bay.row)) {
      moved.set(s.key, bayToPosition(first));
    }
  }
  return { moved, unfit };
}

export interface GridFit<K> {
  /** Stations that move into the lot, with their new position. */
  moved: Map<K, LayoutPoint>;
  /** Stations outside the lot with no free spot left inside it. */
  unfit: K[];
}

/**
 * Fits stations into the layout: a station whose slot is a spot keeps its
 * position; any other moves to the nearest free spot (in the order given), or
 * is listed in `unfit` when no spot is free. Positions are the px positions
 * of the 2D board.
 */
export function fitPositionsToGrid<K>(
  stations: ReadonlyArray<{ key: K; position: LayoutPoint; kind?: LayoutStationKind | undefined }>,
  settings: LayoutShape,
): GridFit<K> {
  const moved = new Map<K, LayoutPoint>();
  const unfit: K[] = [];
  // A custom site places its stations freely: the stored slots stay as they are.
  if (usesFreePositions(settings)) return { moved, unfit };
  const lengths = layoutRowLengths(settings);
  // A depot charges DC only: an AC station never keeps a bay or lane.
  const depot = usesDepotSpots(settings);
  const bays = stations.map((s) => ({
    key: s.key,
    bay: positionToBay(s.position),
    off: depot && s.kind != null && s.kind.depot == null,
  }));
  const occupied = bays.filter((b) => !b.off && bayInLayout(b.bay, settings)).map((b) => b.bay);
  const below = bays.filter((b) => !bayInLayout(b.bay, settings)).map((b) => bayToPosition(b.bay));
  for (const { key, bay, off } of bays) {
    if (off) {
      if (!bayInLayout(bay, settings)) continue;
      const slot = firstFreeSlotBelowLayout(below, settings);
      below.push(slot);
      moved.set(key, slot);
      continue;
    }
    if (bayInLayout(bay, settings)) continue;
    const target = nearestFreeBay(bay, occupied, lengths);
    if (target == null) {
      unfit.push(key);
      continue;
    }
    occupied.push(target);
    moved.set(key, bayToPosition(target));
  }
  return { moved, unfit };
}

/** The 2D board area of the layout: the card of the last spot of the longest and of the last row ends inside it. */
export function gridBoardExtent(settings: LayoutShape): { width: number; height: number } {
  const lengths = layoutRowLengths(settings);
  const cols = Math.max(1, ...lengths);
  return {
    width: LAYOUT_PADDING + (cols - 1) * LAYOUT_SPACING_X + LAYOUT_CARD_WIDTH,
    height: LAYOUT_PADDING + (lengths.length - 1) * LAYOUT_SPACING_Y + LAYOUT_CARD_HEIGHT,
  };
}

export interface LayoutBounds {
  /** Board width in px (the card must end inside it). */
  width: number;
  /** Board height in px. */
  height: number;
}

function snap(value: number): number {
  return Math.round(value / LAYOUT_SNAP) * LAYOUT_SNAP;
}

/**
 * Where a 2D card dropped at `target` lands: snapped to the 20 px grid, inside
 * the board, and on no other card. When the snapped spot overlaps another card,
 * the nearest free grid point (by distance from the drop) wins; when the board
 * has no free point, the card stays at `fallback`.
 */
export function resolveCardDrop(
  target: LayoutPoint,
  others: readonly LayoutPoint[],
  bounds: LayoutBounds,
  fallback: LayoutPoint,
): LayoutPoint {
  const maxX = Math.max(
    0,
    Math.floor((bounds.width - LAYOUT_CARD_WIDTH) / LAYOUT_SNAP) * LAYOUT_SNAP,
  );
  const maxY = Math.max(
    0,
    Math.floor((bounds.height - LAYOUT_CARD_HEIGHT) / LAYOUT_SNAP) * LAYOUT_SNAP,
  );
  const clamp = (p: LayoutPoint): LayoutPoint => ({
    x: Math.min(maxX, Math.max(0, snap(p.x))),
    y: Math.min(maxY, Math.max(0, snap(p.y))),
  });
  const start = clamp(target);
  const free = (p: LayoutPoint): boolean => !others.some((o) => cardsOverlap(o, p));
  if (free(start)) return start;
  let best: LayoutPoint | null = null;
  let bestDistance = Infinity;
  for (let y = 0; y <= maxY; y += LAYOUT_SNAP) {
    for (let x = 0; x <= maxX; x += LAYOUT_SNAP) {
      const p = { x, y };
      const d = (x - start.x) ** 2 + (y - start.y) ** 2;
      if (d < bestDistance && free(p)) {
        best = p;
        bestDistance = d;
      }
    }
  }
  return best ?? fallback;
}

/**
 * The bay each station shows in, in the order given: its own bay when no
 * earlier station holds it, else the nearest free bay within `columns`.
 */
export function assignBays(positions: readonly LayoutPoint[], columns: number): LayoutBay[] {
  const taken = new Set<string>();
  const key = (b: LayoutBay): string => `${String(b.col)}:${String(b.row)}`;
  return positions.map((p) => {
    const own = positionToBay(p);
    const wanted = { col: Math.min(own.col, columns - 1), row: own.row };
    if (!taken.has(key(wanted))) {
      taken.add(key(wanted));
      return wanted;
    }
    for (let radius = 1; ; radius++) {
      let best: LayoutBay | null = null;
      let bestDistance = Infinity;
      for (let row = Math.max(0, wanted.row - radius); row <= wanted.row + radius; row++) {
        for (
          let col = Math.max(0, wanted.col - radius);
          col <= Math.min(columns - 1, wanted.col + radius);
          col++
        ) {
          const bay = { col, row };
          if (taken.has(key(bay))) continue;
          const d = (col - wanted.col) ** 2 + (row - wanted.row) ** 2;
          if (d < bestDistance) {
            best = bay;
            bestDistance = d;
          }
        }
      }
      if (best != null) {
        taken.add(key(best));
        return best;
      }
    }
  });
}

/**
 * The bay a 3D drop lands in: the bay under the pointer when it is a free
 * spot, else the nearest free spot of the layout (`rowLengths`, the spots of
 * each row). `occupied` holds the bays of the other stations. Returns null
 * when the layout has no free spot.
 */
export function nearestFreeBay(
  target: LayoutBay,
  occupied: readonly LayoutBay[],
  rowLengths: readonly number[],
): LayoutBay | null {
  const isTaken = (b: LayoutBay): boolean =>
    occupied.some((o) => o.col === b.col && o.row === b.row);
  const isSpot = (b: LayoutBay): boolean =>
    b.row >= 0 && b.col >= 0 && b.col < (rowLengths[b.row] ?? 0);
  if (isSpot(target) && !isTaken(target)) return target;
  let best: LayoutBay | null = null;
  let bestDistance = Infinity;
  for (let row = 0; row < rowLengths.length; row++) {
    for (let col = 0; col < (rowLengths[row] ?? 0); col++) {
      const bay = { col, row };
      if (isTaken(bay)) continue;
      const d = (col - target.col) ** 2 + (row - target.row) ** 2;
      if (d < bestDistance) {
        best = bay;
        bestDistance = d;
      }
    }
  }
  return best;
}

// Free positions (custom sites). A station stands at `x`, `z` meters in site
// coordinates (the lot coordinates of the other types: x along the rows, z
// across them), turned by `rotationDeg` clockwise from above. In its own
// frame the charger stands at the origin facing +z, and its spots lie in
// front of it: each 2.6 by 5.5 m, the charger `CHARGER_BEHIND_STALL_HEAD_M`
// behind the head of the spot (a bus bay: `stationIntoSpotM` into its head);
// a station with two or more EVSEs has two spots side by side with the
// charger on the line between them. Stations never overlap
// (`freeFootprintsOverlap`); positions snap to `snapM`, turns to
// `rotationSnapDeg` (a free turn keeps one decimal).

/** A station's free position on a custom site. */
export interface FreePlacement {
  /** Meters along the site's x axis. */
  x: number;
  /** Meters along the site's z axis. */
  z: number;
  /** Turn in degrees, clockwise from above, 0 to under 360 (0: the spots lie toward +z). */
  rotationDeg: number;
  /**
   * The kind of spots the station stands at (absent: car spots). Never
   * stored: a custom site has car spots only, and a depot gives each slot its
   * kind (`depotSlotPlacement`).
   */
  spotType?: FreeSpotType | undefined;
}

/**
 * The kinds of spots a station stands at: standard car spots (every site type
 * but a depot), a bus bay (a depot's bus area: a bus drives in nose first) or
 * a truck pull-through lane (a depot's truck area: a tractor-trailer drives
 * through and never reverses).
 */
export const FREE_SPOT_TYPES = ['car', 'bus_bay', 'truck_pull_through'] as const;
export type FreeSpotType = (typeof FREE_SPOT_TYPES)[number];
export const DEFAULT_FREE_SPOT_TYPE: FreeSpotType = 'car';

export function isFreeSpotType(value: unknown): value is FreeSpotType {
  return typeof value === 'string' && (FREE_SPOT_TYPES as readonly string[]).includes(value);
}

/** The spot type of a free position (car when absent or unknown). */
export function freeSpotTypeOf(
  p: { spotType?: string | null | undefined } | null | undefined,
): FreeSpotType {
  return isFreeSpotType(p?.spotType) ? p.spotType : DEFAULT_FREE_SPOT_TYPE;
}

/**
 * Standard real dimensions of each spot type, in meters (no settings): the
 * width across the spot and its length along the vehicle. Car: the standard
 * spot. Bus bay: a straight depot bay for a 12 m city bus (2.55 m wide), 4.3 m
 * wide as transit garage guidelines lay out parked buses, 14 m long. Truck
 * pull-through: a drive-through lane 5 m wide (CharIN charging site
 * recommendations: 4.7 to 5.05 m, at least 19 m long, charger on the left of
 * the bay) and 25 m long for a tractor with a 53 ft trailer (about 22 to 23 m).
 */
export const FREE_SPOT_DIMENSIONS: Record<FreeSpotType, { widthM: number; lengthM: number }> = {
  car: { widthM: STANDARD_DIMENSIONS.spotWidthM, lengthM: STANDARD_DIMENSIONS.spotDepthM },
  bus_bay: { widthM: 4.3, lengthM: 14 },
  truck_pull_through: { widthM: 5, lengthM: 25 },
};

/**
 * The vehicle drawn on a spot whose session names no vehicle: a sedan on car
 * spots, a bus in a bus bay, a semi truck in a truck pull-through lane.
 */
export const FREE_SPOT_DEFAULT_BODY_TYPE: Record<FreeSpotType, VehicleBodyType> = {
  car: DEFAULT_VEHICLE_BODY_TYPE,
  bus_bay: 'bus',
  truck_pull_through: 'semi_truck',
};

/**
 * The vehicles a large spot holds: a 14 m bus bay a bus or a box truck (a
 * tractor-trailer is far longer), a 25 m truck lane a semi truck, a box truck
 * or a bus. A car never stands in either.
 */
const LARGE_SPOT_VEHICLES: Record<Exclude<FreeSpotType, 'car'>, readonly VehicleBodyType[]> = {
  bus_bay: ['bus', 'box_truck'],
  truck_pull_through: ['semi_truck', 'box_truck', 'bus'],
};

/**
 * The vehicle drawn in a spot: the session's own when it fits the spot, else
 * the spot's default (a bus in a bus bay, a semi truck in a truck lane, a
 * sedan in a car spot without a vehicle). Car spots draw any vehicle.
 */
export function spotVehicleBodyType(
  spotType: FreeSpotType,
  bodyType: VehicleBodyType | null | undefined,
): VehicleBodyType {
  if (bodyType == null) return FREE_SPOT_DEFAULT_BODY_TYPE[spotType];
  if (spotType === 'car') return bodyType;
  return LARGE_SPOT_VEHICLES[spotType].includes(bodyType)
    ? bodyType
    : FREE_SPOT_DEFAULT_BODY_TYPE[spotType];
}

export const FREE_LAYOUT = {
  /** Positions snap to this step, in meters. */
  snapM: 0.5,
  /** Turns snap to this step, in degrees (a free turn keeps one decimal). */
  rotationSnapDeg: 15,
  /**
   * How far into the head of its spot a charger stands that stands in it, in
   * meters: a DC dispenser of a Lot Edge row and a bus bay dispenser (AC
   * pedestals and custom car spot chargers stand behind the head,
   * `CHARGER_BEHIND_STALL_HEAD_M`).
   */
  stationIntoSpotM: 0.9,
  /** The paved apron around a station and its spots, in meters. */
  apronM: 0.4,
  /**
   * Spots a station has at most (one per EVSE): two for a dual-outlet charger
   * or pedestal, up to four for a DC split system's dispensers (`SPLIT_SYSTEM`).
   */
  maxSpots: 4,
  /** A free position stays within this distance of the site origin on each axis, in meters. */
  reachM: 400,
  /** The curbed island a truck dispenser stands on beside its pull-through lane, in meters. */
  truckIslandM: 2,
  /**
   * How far a truck pull-through lane runs ahead of its dispenser, in meters:
   * the truck's charge inlet sits behind its cab (2 to 4.8 m from the front,
   * CharIN MCS), so the cab stops just past the dispenser and the trailer
   * fills the lane behind it.
   */
  truckLaneAheadM: 5,
} as const;

/** The spots a station gets on a custom site: one per EVSE, 1 to `maxSpots`. */
export function freeSpotCount(evseCount: number): number {
  return Math.max(1, Math.min(FREE_LAYOUT.maxSpots, Math.round(evseCount)));
}

/** An angle as degrees from 0 to under 360, one decimal. */
export function normalizeRotationDeg(deg: number): number {
  const d = Math.round((((deg % 360) + 360) % 360) * 10) / 10;
  return d >= 360 ? 0 : d + 0;
}

/** A point clamped within the free layout reach and rounded to 10 cm. */
export function clampFreePoint(x: number, z: number): { x: number; z: number } {
  const r = FREE_LAYOUT.reachM;
  const round = (v: number): number => Math.round(Math.min(r, Math.max(-r, v)) * 10) / 10 + 0;
  return { x: round(x), z: round(z) };
}

/**
 * A free position as stored: x and z snapped to `snapM` (within reach), the
 * turn snapped to `rotationSnapDeg` unless `freeRotation` (then one decimal).
 */
export function snapFreePlacement(
  p: FreePlacement,
  options: { freeRotation?: boolean } = {},
): FreePlacement {
  const r = FREE_LAYOUT.reachM;
  const step = FREE_LAYOUT.snapM;
  // `+ 0` turns -0 into 0.
  const snap = (v: number): number => Math.min(r, Math.max(-r, Math.round(v / step) * step)) + 0;
  const turn =
    options.freeRotation === true
      ? p.rotationDeg
      : Math.round(p.rotationDeg / FREE_LAYOUT.rotationSnapDeg) * FREE_LAYOUT.rotationSnapDeg;
  const out: FreePlacement = {
    x: snap(p.x),
    z: snap(p.z),
    rotationDeg: normalizeRotationDeg(turn),
  };
  if (p.spotType != null) out.spotType = p.spotType;
  return out;
}

/**
 * A point in a station's own frame (x across its spots, z into them) in site
 * coordinates. The same turn as the 3D view (three.js about y by
 * -rotationDeg): x' = x cos + z sin, z' = -x sin + z cos.
 */
export function freeToSite(p: FreePlacement, lx: number, lz: number): { x: number; z: number } {
  const a = (-p.rotationDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c };
}

/**
 * The spots of a station in its own frame: from `minX` to `maxX` across, and
 * the front (charger side) and back along z. Car spots and bus bays lie side
 * by side in front of the charger (on the line between two), which stands
 * `CHARGER_BEHIND_STALL_HEAD_M` behind the head of car spots and
 * `stationIntoSpotM` into the head of bus bays. Truck pull-through lanes run along x past
 * the dispenser island, every lane the same way (+x): the first one in front
 * of the station's dispenser, a second one beyond the next island with its
 * own dispenser (a satellite of the same station), so each truck has its
 * dispenser on its left (`truckLaneAheadM` of each lane lies ahead of it).
 */
export function freeSpotsExtent(
  spots: number,
  spotType: FreeSpotType = DEFAULT_FREE_SPOT_TYPE,
): {
  minX: number;
  maxX: number;
  front: number;
  back: number;
} {
  const rects = freeSpotRects(spots, spotType);
  // The charger and its base: a truck island, or the strip behind the head of car spots.
  const behind =
    spotType === 'truck_pull_through'
      ? FREE_LAYOUT.truckIslandM / 2
      : spotType === 'car'
        ? CHARGER_BEHIND_STALL_HEAD_M
        : 0;
  return {
    minX: Math.min(...rects.map((r) => r.minX)),
    maxX: Math.max(...rects.map((r) => r.maxX)),
    front: Math.min(-behind, ...rects.map((r) => r.minZ)),
    back: Math.max(...rects.map((r) => r.maxZ)),
  };
}

/** One spot of a station in its own frame, with the way its vehicle faces. */
export interface FreeSpotRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /**
   * The direction the parked vehicle's nose points, in the station frame:
   * `-z` (nose to the charger: car spots and bus bays) or `+x` (a truck
   * driving through, its left side to its dispenser).
   */
  heading: '-z' | '+x';
  /** Where the dispenser of this spot stands, in the station frame (truck lanes: one per lane). */
  chargerX: number;
  chargerZ: number;
}

/** The spots of a station in its own frame, in EVSE order. */
export function freeSpotRects(
  spots: number,
  spotType: FreeSpotType = DEFAULT_FREE_SPOT_TYPE,
): FreeSpotRect[] {
  const n = freeSpotCount(spots);
  const dim = FREE_SPOT_DIMENSIONS[spotType];
  if (spotType === 'truck_pull_through') {
    const island = FREE_LAYOUT.truckIslandM;
    const ahead = FREE_LAYOUT.truckLaneAheadM;
    return Array.from({ length: n }, (_, i) => {
      const chargerZ = i * (dim.widthM + island);
      return {
        minX: ahead - dim.lengthM,
        maxX: ahead,
        minZ: chargerZ + island / 2,
        maxZ: chargerZ + island / 2 + dim.widthM,
        heading: '+x' as const,
        chargerX: 0,
        chargerZ,
      };
    });
  }
  const half = (n * dim.widthM) / 2;
  // A car spot's head lies in front of the charger; a bus bay's dispenser stands in its head.
  const head = spotType === 'car' ? CHARGER_BEHIND_STALL_HEAD_M : -FREE_LAYOUT.stationIntoSpotM;
  return Array.from({ length: n }, (_, i) => ({
    minX: -half + i * dim.widthM,
    maxX: -half + (i + 1) * dim.widthM,
    minZ: head,
    maxZ: head + dim.lengthM,
    heading: '-z' as const,
    chargerX: 0,
    chargerZ: 0,
  }));
}

/**
 * The corners of a station's spots in site coordinates (front left, front
 * right, back right, back left), shrunk by `inset` meters on every side.
 */
export function freeFootprint(
  p: FreePlacement,
  spots: number,
  inset = 0,
): Array<{ x: number; z: number }> {
  const e = freeSpotsExtent(spots, freeSpotTypeOf(p));
  const l = e.minX + inset;
  const r = e.maxX - inset;
  const f = e.front + inset;
  const b = e.back - inset;
  return [freeToSite(p, l, f), freeToSite(p, r, f), freeToSite(p, r, b), freeToSite(p, l, b)];
}

/** Whether two convex polygons overlap (separating axis test; touching edges do not). */
function polygonsOverlap(
  a: ReadonlyArray<{ x: number; z: number }>,
  b: ReadonlyArray<{ x: number; z: number }>,
): boolean {
  const range = (
    poly: ReadonlyArray<{ x: number; z: number }>,
    nx: number,
    nz: number,
  ): [number, number] => {
    let min = Infinity;
    let max = -Infinity;
    for (const q of poly) {
      const v = q.x * nx + q.z * nz;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    return [min, max];
  };
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      if (p1 == null || p2 == null) continue;
      const nx = p2.z - p1.z;
      const nz = p1.x - p2.x;
      const [minA, maxA] = range(a, nx, nz);
      const [minB, maxB] = range(b, nx, nz);
      if (maxA <= minB || maxB <= minA) return false;
    }
  }
  return true;
}

/** Whether the spots of two stations overlap (spots that only touch, side by side, do not). */
export function freeFootprintsOverlap(
  a: { placement: FreePlacement; spots: number },
  b: { placement: FreePlacement; spots: number },
): boolean {
  return polygonsOverlap(
    freeFootprint(a.placement, a.spots, 0.01),
    freeFootprint(b.placement, b.spots, 0.01),
  );
}

export interface FreeStation<K> {
  key: K;
  placement: FreePlacement;
  spots: number;
}

/** The keys of stations whose spots overlap another station's, in the order given. */
export function overlappingFreeStations<K>(stations: ReadonlyArray<FreeStation<K>>): K[] {
  const out: K[] = [];
  stations.forEach((s, i) => {
    if (stations.some((o, j) => j !== i && freeFootprintsOverlap(s, o))) out.push(s.key);
  });
  return out;
}

/**
 * The positions after moving every station whose spots overlap an earlier
 * station's: it slides along its own row (local x) in `snapM` steps,
 * alternately right and left, else back and forth along its spots (local z),
 * until it overlaps nothing. With `nearest`, it takes the shortest such slide
 * on either axis (along the row on a tie), so a station keeps as near its
 * stored place as it can. Stations that overlap nothing keep their
 * positions. Returns the moved stations only.
 */
export function resolveFreeOverlaps<K>(
  stations: ReadonlyArray<FreeStation<K>>,
  options: { nearest?: boolean } = {},
): Map<K, FreePlacement> {
  const moved = new Map<K, FreePlacement>();
  const placed: Array<{ placement: FreePlacement; spots: number }> = [];
  const isFree = (p: FreePlacement, spots: number): boolean =>
    !placed.some((o) => freeFootprintsOverlap({ placement: p, spots }, o));
  const slide = (s: FreeStation<K>, axis: 'x' | 'z'): { at: FreePlacement; k: number } | null => {
    for (let k = 1; k <= 400; k++) {
      const d = Math.ceil(k / 2) * FREE_LAYOUT.snapM * (k % 2 === 1 ? 1 : -1);
      const shifted = axis === 'x' ? freeToSite(s.placement, d, 0) : freeToSite(s.placement, 0, d);
      // The shift is whole snap steps; the position keeps its own centimeters.
      const candidate = {
        ...s.placement,
        x: Math.round(shifted.x * 100) / 100 + 0,
        z: Math.round(shifted.z * 100) / 100 + 0,
      };
      if (isFree(candidate, s.spots)) return { at: candidate, k };
    }
    return null;
  };
  for (const s of stations) {
    let target = s.placement;
    if (!isFree(target, s.spots)) {
      let found: FreePlacement | null = null;
      if (options.nearest === true) {
        const alongRow = slide(s, 'x');
        const alongSpots = slide(s, 'z');
        found =
          alongSpots != null && (alongRow == null || alongSpots.k < alongRow.k)
            ? alongSpots.at
            : (alongRow?.at ?? null);
      } else {
        found = slide(s, 'x')?.at ?? slide(s, 'z')?.at ?? null;
      }
      if (found != null) {
        target = found;
        moved.set(s.key, found);
      }
    }
    placed.push({ placement: target, spots: s.spots });
  }
  return moved;
}

/**
 * The positions after bringing every station whose charger point lies beyond
 * `reachM` on an axis back within reach (the stored range, so a switch of a
 * large layout to Custom never stores a point out of it). Stations within
 * reach keep their positions. The others, in the order given, are packed row
 * by row from the corner (-reachM, -reachM) into the first places where their
 * spots stay clear of every other station's, turns kept. A station that finds
 * no such place stands at its point clamped into reach. Returns the moved
 * stations only.
 */
export function fitFreePlacementsInReach<K>(
  stations: ReadonlyArray<FreeStation<K>>,
): Map<K, FreePlacement> {
  const r = FREE_LAYOUT.reachM;
  const moved = new Map<K, FreePlacement>();
  const inReach = (p: FreePlacement): boolean => Math.abs(p.x) <= r && Math.abs(p.z) <= r;
  const outside = stations.filter((s) => !inReach(s.placement));
  if (outside.length === 0) return moved;
  interface Box {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  }
  // The spots and the charger point (a truck dispenser stands beside its lane).
  const boxOf = (p: FreePlacement, spots: number): Box => {
    const box = { minX: p.x, maxX: p.x, minZ: p.z, maxZ: p.z };
    for (const c of freeFootprint(p, spots)) {
      box.minX = Math.min(box.minX, c.x);
      box.maxX = Math.max(box.maxX, c.x);
      box.minZ = Math.min(box.minZ, c.z);
      box.maxZ = Math.max(box.maxZ, c.z);
    }
    return box;
  };
  const gap = 2 * FREE_LAYOUT.apronM;
  const taken = stations
    .filter((s) => inReach(s.placement))
    .map((s) => boxOf(s.placement, s.spots));
  const hit = (b: Box): Box | undefined =>
    taken.find(
      (t) =>
        b.minX < t.maxX + gap &&
        t.minX < b.maxX + gap &&
        b.minZ < t.maxZ + gap &&
        t.minZ < b.maxZ + gap,
    );
  const cm = (v: number): number => Math.round(v * 100) / 100 + 0;
  let cursorX = -r;
  let rowZ = -r;
  let rowDepth = 0;
  for (const s of outside) {
    // The station's box relative to its charger point.
    const rel = boxOf({ ...s.placement, x: 0, z: 0 }, s.spots);
    const width = rel.maxX - rel.minX;
    const depth = rel.maxZ - rel.minZ;
    let placed: FreePlacement | null = null;
    while (placed == null && rowZ + depth <= r) {
      if (cursorX + width > r) {
        rowZ += rowDepth + gap;
        cursorX = -r;
        rowDepth = 0;
        continue;
      }
      const box = { minX: cursorX, maxX: cursorX + width, minZ: rowZ, maxZ: rowZ + depth };
      const blocker = hit(box);
      if (blocker != null) {
        cursorX = blocker.maxX + gap;
        continue;
      }
      placed = { ...s.placement, x: cm(cursorX - rel.minX), z: cm(rowZ - rel.minZ) };
      taken.push(box);
      cursorX = box.maxX + gap;
      rowDepth = Math.max(rowDepth, depth);
    }
    if (placed == null) {
      const clamp = (v: number): number => Math.min(r, Math.max(-r, cm(v)));
      placed = { ...s.placement, x: clamp(s.placement.x), z: clamp(s.placement.z) };
    }
    moved.set(s.key, placed);
  }
  return moved;
}

/** The box around the spots of the stations, in site coordinates (null without stations). */
export function freeStationsBox(
  stations: ReadonlyArray<{ placement: FreePlacement; spots: number }>,
): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  if (stations.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const s of stations) {
    for (const c of freeFootprint(s.placement, s.spots)) {
      minX = Math.min(minX, c.x);
      maxX = Math.max(maxX, c.x);
      minZ = Math.min(minZ, c.z);
      maxZ = Math.max(maxZ, c.z);
    }
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * Where a new station of a custom site stands: at the origin on an empty
 * site, else unturned right of every placed station, its spots level with the
 * frontmost ones, moved right until it overlaps nothing. A new station counts
 * with two spots until its EVSEs are known.
 */
export function firstFreePlacement(
  placed: ReadonlyArray<{ placement: FreePlacement; spots: number }>,
  spots = 2,
): FreePlacement {
  const box = freeStationsBox(placed);
  if (box == null) return { x: 0, z: 0, rotationDeg: 0 };
  const e = freeSpotsExtent(spots);
  let candidate = snapFreePlacement({
    x: box.maxX - e.minX + 1,
    z: box.minZ - e.front,
    rotationDeg: 0,
  });
  for (let i = 0; i < 400; i++) {
    const c = candidate;
    if (!placed.some((o) => freeFootprintsOverlap({ placement: c, spots }, o))) break;
    candidate = { ...candidate, x: candidate.x + FREE_LAYOUT.snapM };
  }
  return candidate;
}

/**
 * Whether the chargers of a grid row stand at its back edge (the row is
 * turned): the rule of the 3D view for a parking lot (every odd row and an
 * odd last row) and a street (the right curb).
 */
function rowTurned(row: number, settings: LayoutShape): boolean {
  const type = siteTypeOf(settings);
  if (type === 'curbside') return row === 1;
  if (type !== 'parking_lot') return false;
  return parkingChargersAtBack(row, settings.rows);
}

/**
 * Where a station on grid slot `bay` of a layout of another type stands as a
 * free position, so switching to Custom keeps its spots in place: a parking
 * lot or office or retail spot keeps its stall head and turn, the charger
 * `CHARGER_BEHIND_STALL_HEAD_M` behind it (a turned row faces the other
 * way); a curb post becomes a charger behind the curb of its parallel spot
 * facing the street, the right curb turned; a depot bay or lane keeps its
 * charger point and turn, with car spots. Not snapped (`resolveFreeOverlaps`
 * then moves stations whose spots overlap).
 */
export function freePlacementFromSlot(bay: LayoutBay, settings: LayoutShape): FreePlacement {
  const d = STANDARD_DIMENSIONS;
  const behind = CHARGER_BEHIND_STALL_HEAD_M;
  const cm = (v: number): number => Math.round(v * 100) / 100;
  if (usesDepotSpots(settings)) {
    const at = depotSlotPlacement(bay, settings);
    return { x: cm(at.x), z: cm(at.z), rotationDeg: at.rotationDeg };
  }
  if (siteTypeOf(settings) === 'curbside') {
    const x = d.parallelSpotLengthM * (bay.col + 0.5);
    const depth = 2 * d.spotDepthM + 2 * d.travelLaneM;
    if (bay.row === 0) return { x, z: -behind, rotationDeg: 0 };
    if (bay.row === 1) return { x, z: cm(depth + behind), rotationDeg: 180 };
    return { x, z: cm(depth + 3 + (bay.row - 2) * (d.spotDepthM + 1)), rotationDeg: 0 };
  }
  const turned = rowTurned(bay.row, settings);
  // The stall head: a parking lot row's charger edge (an island curb too); an office or retail row has one row.
  const front =
    siteTypeOf(settings) === 'parking_lot'
      ? parkingRowZ(bay.row, settings.rows)
      : (d.spotDepthM + d.laneWidthM) * bay.row;
  const z = turned ? front + d.spotDepthM + behind : front - behind;
  return {
    x: cm(d.spotWidthM * (bay.col + 0.5)),
    z: cm(z),
    rotationDeg: turned ? 180 : 0,
  };
}

/** A free-standing solar carport canopy: one spot deep plus overhang, its length from its peak power. */
export const SOLAR_CANOPY = {
  /** Peak power per square meter of canopy, in kWp (about 200 W per square meter of modules). */
  kwpPerM2: 0.2,
  depthM: 6,
  /** Length of a canopy without a peak power: four spots. */
  defaultLengthM: 4 * STANDARD_DIMENSIONS.spotWidthM,
  minLengthM: 2 * STANDARD_DIMENSIONS.spotWidthM,
  maxLengthM: 60,
} as const;

/** The length and depth of a free-standing solar canopy, in meters: its modules' area from its peak power, in whole spots. */
export function solarCanopySize(capacityKwp: number | null): { lengthM: number; depthM: number } {
  const c = SOLAR_CANOPY;
  if (capacityKwp == null) return { lengthM: c.defaultLengthM, depthM: c.depthM };
  const spot = STANDARD_DIMENSIONS.spotWidthM;
  const raw = capacityKwp / c.kwpPerM2 / c.depthM;
  const length = Math.min(c.maxLengthM, Math.max(c.minLengthM, Math.round(raw / spot) * spot));
  return { lengthM: Math.round(length * 10) / 10, depthM: c.depthM };
}

/**
 * Where a solar canopy stands on a custom site or a depot: its stored
 * position, else (custom) over the middle of its row of the parking lot grid,
 * or (depot) over staff parking on the grass behind the yard, unturned.
 */
export function freeSolarPlacement(asset: LayoutSolarCanopy, grid: LayoutShape): FreePlacement {
  if (asset.x != null && asset.z != null) {
    return { x: asset.x, z: asset.z, rotationDeg: normalizeRotationDeg(asset.rotationDeg ?? 0) };
  }
  if (usesDepotSpots(grid)) {
    const yard = depotLayout(grid).yard;
    return {
      x: Math.round((yard.minX + yard.maxX) / 2),
      z: Math.round(yard.minZ - SOLAR_CANOPY.depthM / 2 - 3),
      rotationDeg: 0,
    };
  }
  const d = STANDARD_DIMENSIONS;
  const row = Math.min(grid.rows - 1, Math.max(0, asset.row));
  return {
    x: lotExtentM(grid).width / 2,
    z: parkingRowZ(row, grid.rows) + d.spotDepthM / 2,
    rotationDeg: 0,
  };
}

// Depot (siteType depot): a paved fleet yard, in lot coordinates (meters, x
// to the right, z toward the front; the yard turns by the facing). The bus
// area is a row of `busBays` straight nose-in bays, 4.3 by 14 m, their heads
// at z = 0 along a strip where the pantograph poles and dispensers stand, the
// buses' tails at z = 14 on the yard's two-way drive lane (`depotDriveLaneM`). The
// truck area stands right of it past a curbed median: a one-way entry road
// from the drive lane, `truckLanes` pull-through lanes of 5 by 25 m stacked
// back from the drive lane, each with its dispenser island on the truck's
// left (the `freeSpotRects` of a truck station unturned), and a one-way exit
// road back to the drive lane, so a tractor-trailer never reverses. Grid slot
// (c, 0) is bus bay c, slot (c, 1) truck lane c, one station each.

/** A rectangle in meters. */
export interface LayoutRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Standard real dimensions of a depot yard, in meters (no settings). The yard
 * is sized to its bays and lanes plus the turning space of the design
 * vehicles, not to a round number: the AASHTO design vehicle turning radii as
 * the Texas Department of Transportation Roadway Design Manual reproduces
 * them (Section 4.3.3, Control Vehicles, Table 4-1, Minimum Turning Radii of
 * Design Vehicles,
 * https://www.txdot.gov/manuals/des/rdw/chapter-4--basic-design-criteria/4-3-traffic-characteristics/4-3-3-control-vehicles.html):
 * CITY-BUS 41.6 ft (12.68 m) minimum design turning radius, 24.5 ft inside;
 * WB-62 and WB-67 tractor-trailers 44.8 ft (13.66 m). The table gives turning
 * radii, not lane widths: no source read gives a drive lane or bus aisle width
 * for nose-in bays or truck yards. The lane and road widths here are a floor
 * derived from it (a design decision): a lane a design vehicle turns 90
 * degrees into or out of is as wide as its design turning radius, so the
 * outside of the swept path stays on the pavement. Each stretch takes the
 * radius of the vehicle that turns there: the bus value in front of the bus
 * bays, the truck value only in front of the truck roads.
 */
export const DEPOT_LAYOUT = {
  /** The strip behind the bus bay heads where the pantograph poles and dispensers stand. */
  busHeadM: 3,
  /**
   * The drive lane in front of the bus bays: the CITY-BUS design turning
   * radius, 41.6 ft (TxDOT Table 4-1), rounded up to 10 cm, a derived floor
   * (no cited lane width). A bus turns 90 degrees from it into a nose-in bay
   * and back out.
   */
  busDriveLaneM: 12.7,
  /**
   * The drive lane in front of the truck area, where tractor-trailers turn
   * into the entry road and out of the exit road: the WB-62/WB-67 design
   * turning radius, 44.8 ft (TxDOT Table 4-1), rounded up to 10 cm, a derived
   * floor (no cited lane width).
   */
  driveLaneM: 13.7,
  /**
   * The one-way roads into and out of the truck lanes: the WB-62/WB-67 design
   * turning radius, 44.8 ft (TxDOT Table 4-1), so a tractor-trailer turns 90
   * degrees into a pull-through lane and out of it.
   */
  truckRoadM: 13.7,
  /** The curbed median between the bus area and the truck entry road. */
  medianM: 2,
  /**
   * Paved yard between the markings and the yard edge: a curb strip only
   * (no source; it keeps the outermost markings and islands off the edge).
   */
  marginM: 0.6,
} as const;

/** The widest drive lane of a depot yard: the truck one in front of truck lanes, else the bus one. */
export function depotDriveLaneM(truckLanes: number): number {
  return truckLanes > 0 ? DEPOT_LAYOUT.driveLaneM : DEPOT_LAYOUT.busDriveLaneM;
}

/** The grid rows of a depot: bus bays (row 0) and truck lanes (row 1). */
export const DEPOT_ROWS = { bus: 0, truck: 1 } as const;

/** The geometry of a depot yard, in lot coordinates (before the facing). */
export interface DepotLayout {
  busBays: number;
  truckLanes: number;
  /** Each bus bay, in slot order (col 0 at the left). */
  bays: LayoutRect[];
  /** Each truck lane, in slot order (col 0 next to the drive lane). */
  lanes: LayoutRect[];
  /** The dispenser island of each truck lane, on the truck's left (toward -z). */
  islands: LayoutRect[];
  /** The strip behind the bus bay heads (poles and dispensers), null without bus bays. */
  busHead: LayoutRect | null;
  /**
   * The drive lane along the front, one stretch per area in x order: in front
   * of the bus area as wide as a bus turns (`busDriveLaneM`), in front of the
   * truck area as wide as a tractor-trailer turns (`driveLaneM`).
   */
  driveLanes: LayoutRect[];
  /** The truck entry and exit roads, null without truck lanes. */
  entryRoad: LayoutRect | null;
  exitRoad: LayoutRect | null;
  /** The curbed median between the two areas, null unless the depot has both. */
  median: LayoutRect | null;
  /**
   * The edge of the paved yard, corners in order: the back stepping down
   * with each area's depth, the front stepping out where the wider truck
   * stretch of the drive lane begins.
   */
  outline: Array<{ x: number; z: number }>;
  /** The box around the yard. */
  yard: LayoutRect;
}

/** The bus bays and truck lanes of a depot (its settings, 1 bus bay and no truck lane where absent). */
function depotCounts(settings: LayoutShape): { bus: number; truck: number } {
  return { bus: settings.busBays ?? 1, truck: settings.truckLanes ?? 0 };
}

/** The yard of a depot: bays, lanes, islands, roads and the yard edge (`DEPOT_LAYOUT`, `FREE_SPOT_DIMENSIONS`). */
export function depotLayout(settings: LayoutShape): DepotLayout {
  const d = DEPOT_LAYOUT;
  const bus = FREE_SPOT_DIMENSIONS.bus_bay;
  const truck = FREE_SPOT_DIMENSIONS.truck_pull_through;
  const island = FREE_LAYOUT.truckIslandM;
  const { bus: busBays, truck: truckLanes } = depotCounts(settings);
  // Centimeters, so sums of the dimensions stay exact.
  const cm = (v: number): number => Math.round(v * 100) / 100 + 0;
  const front = bus.lengthM;
  const busRight = cm(busBays * bus.widthM);
  const bays = Array.from({ length: busBays }, (_, i) => ({
    minX: cm(i * bus.widthM),
    maxX: cm((i + 1) * bus.widthM),
    minZ: 0,
    maxZ: front,
  }));
  const busHead = busBays > 0 ? { minX: 0, maxX: busRight, minZ: -d.busHeadM, maxZ: 0 } : null;
  const truckLeft = busBays > 0 ? cm(busRight + d.medianM) : 0;
  const pitch = truck.widthM + island;
  const lanesLeft = cm(truckLeft + d.truckRoadM);
  const lanesRight = cm(lanesLeft + truck.lengthM);
  const lanes = Array.from({ length: truckLanes }, (_, k) => ({
    minX: lanesLeft,
    maxX: lanesRight,
    minZ: front - truck.widthM - k * pitch,
    maxZ: front - k * pitch,
  }));
  const islands = lanes.map((l) => ({
    minX: lanesLeft,
    maxX: lanesRight,
    minZ: l.minZ - island,
    maxZ: l.minZ,
  }));
  const truckBack = front - truckLanes * pitch;
  const truckRight = cm(lanesRight + d.truckRoadM);
  const entryRoad =
    truckLanes > 0 ? { minX: truckLeft, maxX: lanesLeft, minZ: truckBack, maxZ: front } : null;
  const exitRoad =
    truckLanes > 0 ? { minX: lanesRight, maxX: truckRight, minZ: truckBack, maxZ: front } : null;
  const median =
    busBays > 0 && truckLanes > 0
      ? { minX: busRight, maxX: truckLeft, minZ: Math.max(-d.busHeadM, truckBack), maxZ: front }
      : null;
  const m = d.marginM;
  const minX = -m;
  const maxX = cm((truckLanes > 0 ? truckRight : busRight) + m);
  const busBackZ = cm(-d.busHeadM - m);
  const truckBackZ = cm(truckBack - m);
  const busFrontZ = cm(front + d.busDriveLaneM + m);
  const truckFrontZ = cm(front + d.driveLaneM + m);
  let outline: Array<{ x: number; z: number }>;
  let driveLanes: LayoutRect[];
  if (busBays > 0 && truckLanes > 0) {
    // The steps sit in the median, between the areas: the back with each
    // area's depth, the front where the truck stretch of the drive lane begins.
    const step = cm((busRight + truckLeft) / 2);
    driveLanes = [
      { minX, maxX: step, minZ: front, maxZ: front + d.busDriveLaneM },
      { minX: step, maxX, minZ: front, maxZ: front + d.driveLaneM },
    ];
    const back =
      busBackZ !== truckBackZ
        ? [
            { x: minX, z: busBackZ },
            { x: step, z: busBackZ },
            { x: step, z: truckBackZ },
            { x: maxX, z: truckBackZ },
          ]
        : [
            { x: minX, z: busBackZ },
            { x: maxX, z: busBackZ },
          ];
    outline = [
      { x: minX, z: busFrontZ },
      ...back,
      { x: maxX, z: truckFrontZ },
      { x: step, z: truckFrontZ },
      { x: step, z: busFrontZ },
    ];
  } else {
    const back = truckLanes > 0 ? truckBackZ : busBackZ;
    const lane = depotDriveLaneM(truckLanes);
    const frontZ = cm(front + lane + m);
    driveLanes = [{ minX, maxX, minZ: front, maxZ: front + lane }];
    outline = [
      { x: minX, z: frontZ },
      { x: minX, z: back },
      { x: maxX, z: back },
      { x: maxX, z: frontZ },
    ];
  }
  const minZ = Math.min(...outline.map((p) => p.z));
  const frontZ = Math.max(...outline.map((p) => p.z));
  return {
    busBays,
    truckLanes,
    bays,
    lanes,
    islands,
    busHead,
    driveLanes,
    entryRoad,
    exitRoad,
    median,
    outline,
    yard: { minX, maxX, minZ, maxZ: frontZ },
  };
}

/**
 * Where the station of a depot slot stands: in a bus bay, the charger point
 * at the middle of the bay's head facing into it (the bus noses in toward
 * it); in a truck lane, the dispenser on the lane's island, the lane on its
 * +z side (`freeSpotRects`: the truck drives through in +x with the
 * dispenser on its left). A slot outside the layout stands on the grass
 * behind the yard, with car spots.
 */
export function depotSlotPlacement(bay: LayoutBay, settings: LayoutShape): FreePlacement {
  const layout = depotLayout(settings);
  if (bay.row === DEPOT_ROWS.bus) {
    const r = layout.bays[bay.col];
    if (r != null) {
      return {
        x: Math.round(((r.minX + r.maxX) / 2) * 100) / 100,
        z: r.minZ + FREE_LAYOUT.stationIntoSpotM,
        rotationDeg: 0,
        spotType: 'bus_bay',
      };
    }
  }
  if (bay.row === DEPOT_ROWS.truck) {
    const lane = layout.lanes[bay.col];
    if (lane != null) {
      return {
        x: lane.maxX - FREE_LAYOUT.truckLaneAheadM,
        z: lane.minZ - FREE_LAYOUT.truckIslandM / 2,
        rotationDeg: 0,
        spotType: 'truck_pull_through',
      };
    }
  }
  const d = STANDARD_DIMENSIONS;
  return {
    x: layout.yard.minX + d.spotWidthM * (Math.max(0, bay.col) + 0.5),
    z: layout.yard.minZ - 4 - d.spotDepthM - Math.max(0, bay.row) * (d.spotDepthM + 1),
    rotationDeg: 0,
  };
}

/**
 * The first free spot of a depot for a new station of this kind: a free bay
 * or lane of its own area (`depotStationKind`), else of the other area, else
 * the first free slot below the layout (`firstFreeSlot`). An AC station
 * (kind null) takes no bay or lane: it stands below the layout
 * (`firstFreeSlotBelowLayout`).
 */
export function firstFreeDepotSlot(
  placed: readonly LayoutPoint[],
  settings: LayoutShape,
  kind: 'bus' | 'truck' | null,
): LayoutPoint {
  if (kind == null) return firstFreeSlotBelowLayout(placed, settings);
  const lengths = layoutRowLengths(settings);
  for (const row of [DEPOT_ROWS[kind], 1 - DEPOT_ROWS[kind]]) {
    for (let col = 0; col < (lengths[row] ?? 0); col++) {
      const slot = bayToPosition({ col, row });
      if (!placed.some((p) => cardsOverlap(p, slot))) return slot;
    }
  }
  return firstFreeSlot(placed, settings);
}

/**
 * Sorts the stations of a site that turns into a depot into its areas: a
 * station already in a spot of its own kind (`depotStationKind`) keeps it;
 * any other takes the free spot of its own area nearest its slot, else of the
 * other area, else is listed in `unfit` and keeps its position (off the
 * layout). Bus stations land in bus bays and truck stations in truck lanes.
 */
export function fitDepotPositions<K>(
  stations: ReadonlyArray<{ key: K; position: LayoutPoint; kind?: LayoutStationKind | undefined }>,
  settings: LayoutShape,
): GridFit<K> {
  const lengths = layoutRowLengths(settings);
  const moved = new Map<K, LayoutPoint>();
  const unfit: K[] = [];
  const occupied: LayoutBay[] = [];
  const rest: Array<{ key: K; bay: LayoutBay; kind: 'bus' | 'truck' }> = [];
  // AC stations take no bay or lane: those inside the layout move below it.
  const below = stations
    .map((s) => positionToBay(s.position))
    .filter((b) => !bayInLayout(b, settings))
    .map((b) => bayToPosition(b));
  for (const s of stations) {
    const bay = positionToBay(s.position);
    // A station whose connectors are not known yet counts as a bus station.
    const depot = s.kind == null ? 'bus' : s.kind.depot;
    if (depot == null) {
      if (bayInLayout(bay, settings)) {
        const slot = firstFreeSlotBelowLayout(below, settings);
        below.push(slot);
        moved.set(s.key, slot);
      }
      continue;
    }
    const own = DEPOT_ROWS[depot];
    const taken = occupied.some((o) => o.col === bay.col && o.row === bay.row);
    if (bay.row === own && bay.col < (lengths[own] ?? 0) && !taken) occupied.push(bay);
    else rest.push({ key: s.key, bay, kind: depot });
  }
  for (const s of rest) {
    const own = DEPOT_ROWS[s.kind];
    const ownOnly = lengths.map((n, r) => (r === own ? n : 0));
    const target =
      nearestFreeBay({ col: s.bay.col, row: own }, occupied, ownOnly) ??
      nearestFreeBay({ col: s.bay.col, row: 1 - own }, occupied, lengths);
    if (target == null) {
      unfit.push(s.key);
      continue;
    }
    occupied.push(target);
    if (target.col !== s.bay.col || target.row !== s.bay.row) {
      moved.set(s.key, bayToPosition(target));
    }
  }
  return { moved, unfit };
}
