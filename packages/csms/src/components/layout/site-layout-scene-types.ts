// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The types and constants the 3D site scene modules share.

import { type FreePlacement, type LayoutBay } from '@evtivity/lib/site-layout';
import * as THREE from 'three';
import { type Point3 } from './site-layout-cable';
import { type SceneCar } from './site-layout-car';
import type { CurbSpot } from './site-layout-curb-cable';
import { SCENE_COLORS } from './site-layout-colors';
import { type ConnectorKind } from './site-layout-connectors';
import type { FreeChargerModel } from './site-layout-free';
import {
  type AlignmentGuide,
  type Lot,
  type Point,
  type StationProp,
  type VirtualSign,
} from './site-layout-grid';
import { type CameraNudge } from './site-layout-keyboard-nav';
import type { LinkKind, LoadLinks } from './site-layout-links';
import { type SignTexts, type StationSigns } from './site-layout-signs';
import type { AccessibleSpaceBoxes, Stall } from './site-layout-stalls';

export type Point3Tuple = readonly [number, number, number];

/** Pixels per meter of the spot texture. */
export const TEXTURE_PX_PER_M = 80;

export interface SceneTerminal {
  id: string;
  /** -1 left connector, 1 right connector, 0 the whole station. */
  side: -1 | 0 | 1;
  /** The model has its own screen (a VP7200 has none). */
  hasDisplay: boolean;
  online: boolean | null;
}

export interface SceneStation {
  id: string;
  kind: 'ac' | 'dc';
  bay: LayoutBay;
  /** The status light color (a CSS color three.js can parse). */
  lightColor: string;
  /** False for an offline station: its screen and light stay dark. */
  lit: boolean;
  /** True while charging: the light pulses unless reduced motion is on. */
  pulsing: boolean;
  /**
   * True while charging: a glowing strip around the screen or the connector,
   * in `lightColor`, pulsing gently (steady with reduced motion).
   */
  glow: boolean;
  /** An AC wall box on the building facade (office or retail with wall mounting), not a pedestal. */
  wall: boolean;
  /** What stands in the spot (`stationProp`): a car on a cable or a cone. */
  prop: StationProp;
  /** The virtual status sign over the spot (`virtualSignOf`): reserved now or in maintenance. */
  virtualSign?: VirtualSign | null | undefined;
  /** The car of a charging station (`sceneCar`); absent draws a grey sedan. */
  car?: SceneCar | undefined;
  /** Payment terminals paired to the station. */
  terminals: readonly SceneTerminal[];
  /**
   * A faulted station: its own status light (in the destructive red state
   * color) blinks, steady with reduced motion. Real chargers carry no beacon.
   */
  blinking: boolean;
  /**
   * Custom site: where the station stands and its turn (its spots lie in
   * front of it). Depot: its bay or lane (`depotSlotPlacement`, with the spot
   * type), drawn the same way but moved by slot.
   */
  free?: FreePlacement | undefined;
  /** Custom site: the parking spots the station has (one per EVSE, 1 or 2). */
  spots?: number | undefined;
  /** Custom site with two car spots: the spot the car stands in, across the station (-1.3 or 1.3 m). */
  carOffsetX?: number | undefined;
  /** Custom site: the spot (0 or 1, EVSE order) the vehicle, sign or cone stands in. */
  propSpot?: number | undefined;
  /** Custom site: the charger model (`freeChargerModel`): a pantograph mast, a bus or truck dispenser, else the standard charger. */
  charger?: FreeChargerModel | undefined;
  /** The active display message, shown on the lit charger screen (null: none). */
  message?: string | null | undefined;
  /**
   * Parking lot or office or retail row: the stalls the station serves, in
   * its own frame (`stationStalls`): two for a dual-port AC pedestal on the
   * line between its spots, one widened vehicle space for the accessible
   * charging space. Absent: its own spot.
   */
  stalls?: readonly Stall[] | undefined;
  /** How far the charger stands from the middle of its spot along the row (a pedestal: on the pair line), in lot meters. */
  shiftX?: number | undefined;
  /** How far behind its spot point the charger stands, in its own z (`stationBackShift`: an AC pedestal behind the stall head). */
  backShift?: number | undefined;
  /**
   * A two-port curb post (`TWO_PORT_CURB_POST`) on the line between its two
   * parallel spots: EVSE 1's car on its left, EVSE 2's on its right
   * (`stallCars`, `CurbSpot`). Absent: a one-port post.
   */
  curbPair?: boolean | undefined;
  /** A dual-port pedestal: the vehicle in each stall (null: empty), EVSE order. */
  stallCars?: ReadonlyArray<SceneCar | null> | undefined;
  /**
   * A DC split system (`splitDispenserCount`, `SPLIT_SYSTEM`): the x of each
   * of its dispensers (satellites) in the station's own frame, EVSE order;
   * its power cabinet stands on the equipment pad (`withSplitCabinets`).
   */
  dispensers?: readonly number[] | undefined;
  /**
   * The connectors (holstered cables) of each dispenser, EVSE order for a
   * split system, else one entry for the station's one dispenser
   * (`dispenserHolsters`). Absent: two.
   */
  cables?: readonly number[] | undefined;
  /**
   * One charger unit (not a split system): the connectors drawn on each of
   * its EVSEs, EVSE order, up to `CHARGER_PORT_LIMITS` (`drawnConnectorCounts`):
   * an AC pedestal draws a socket and a holster per EVSE. Absent: one EVSE.
   */
  evseConnectors?: readonly number[] | undefined;
  /** The cable to the drawn vehicle carries energy now (a connector charging or discharging): it shows the charge flow. */
  cableFlow?: boolean | undefined;
  /** A dual-port pedestal: whether the cable of each stall carries energy, EVSE order. */
  stallFlows?: readonly boolean[] | undefined;
  /** The connector type of each connector, EVSE order (`connectorKindOf`): the holstered handles and the plug in the car. */
  connectorKinds?: ReadonlyArray<readonly ConnectorKind[]> | undefined;
  /** The EVSE and connector the drawn vehicle is plugged into (its holster stands empty). */
  pluggedSlot?: { evse: number; connector: number } | undefined;
  /** Per EVSE, the connector index that is plugged in (dual-port pedestals and split systems). */
  stallPlugged?: readonly number[] | undefined;
  /** Each EVSE's number and own status light, EVSE order: the EVSE plates of a charger with more than one EVSE. */
  evseLamps?: readonly EvseLamp[] | undefined;
  /**
   * A unit charger of a station with units: its box number plate (the unit's
   * 1-based place in the station's unit order, site-layout-model-unit-plate.ts).
   */
  unitPlate?: { number: number } | undefined;
}

/** The number and status light of one EVSE (`evseLampState`). */
export interface EvseLamp {
  /** The OCPP EVSE id. */
  number: number;
  /** The light color (a CSS color three.js can parse). */
  color: string;
  /** Charging: the light pulses unless reduced motion is on. */
  pulsing: boolean;
  /** Faulted: the light blinks, steady with reduced motion. */
  blinking: boolean;
}

export interface SceneTransformer {
  id: string;
  x: number;
  z: number;
}

/**
 * A load management panel on the grass (site-layout-links.ts, placePanels): a
 * switchboard on the equipment pad, or a panelboard on a rack beside its AC
 * group.
 */
export interface ScenePanel {
  id: string;
  x: number;
  z: number;
  model: 'switchboard' | 'panelboard' | 'wall' | 'cabinet' | 'dry_transformer';
  /** A step-down transformer: its kVA rating (sizes the dry-type model). */
  kva?: number | null | undefined;
  /** A switchboard in the row at a service transformer: dragging it drags that transformer. */
  atTransformerId?: string | undefined;
  /** The turn about the vertical axis, in radians (0: the front faces +z; a row end rack faces the lot edge). */
  turn: number;
}

/**
 * The panelboard on its rack beside an AC group: the nominal NEMA 3R
 * enclosure of a 225 A, 42 space panelboard interior, 20 in (0.51 m) wide,
 * 38 in (0.97 m) high and 6.5 in (0.165 m) deep (Schneider Electric NQ442L2C
 * product data sheet, June 2023,
 * https://cdn.shopify.com/s/files/1/0571/5899/2039/files/NQ442L2C_document.pdf),
 * its top 1.87 m above the pad, so the highest breaker handle stays under the
 * 6 ft 7 in (2.0 m) of NEC 240.24(A) and 404.8(A) (read in Mike Holt forum
 * threads, not the code text). On a building facade (`wallTopM`) it hangs
 * over a sidewalk, a circulation path: an object deeper than 4 in with its
 * leading edge more than 27 in above the ground breaks the protrusion limit
 * of 2010 ADA Standards 307.2
 * (https://www.access-board.gov/ada/chapter/ch03/), so its bottom stands at
 * 0.68 m (under 27 in, 0.686 m) and its top at 1.65 m. The rack and its pad
 * (1.2 by 0.6 m) have no source.
 */
export const PANELBOARD = {
  widthM: 0.51,
  heightM: 0.97,
  depthM: 0.165,
  topM: 1.87,
  wallTopM: 1.65,
  padWM: 1.2,
  padDM: 0.6,
} as const;

/** A battery storage cabinet on the grass (information only). */
export interface SceneBattery {
  id: string;
  x: number;
  z: number;
}

/** A solar carport canopy over one row of the lot, or standing freely on a custom site (information only). */
export interface SceneSolar {
  id: string;
  row: number;
  /** Custom site: the middle of the canopy, its turn and size. */
  free?: (FreePlacement & { lengthM: number; depthM: number }) | undefined;
}

export interface SceneLayout {
  lot: Lot;
  stations: readonly SceneStation[];
  /** Shown on a parking lot only (the caller passes none for the other site types). */
  transformers: readonly SceneTransformer[];
  /** Battery storage on the grass (parking lot only). */
  batteries: readonly SceneBattery[];
  /** Solar canopies (parking lot only). */
  solar: readonly SceneSolar[];
  /** Load management switchboards (parking lot only). */
  panels: readonly ScenePanel[];
  links: LoadLinks;
  /** The site is in California: its stalls add the Vehicle Code 22511 tow-away sign (`site-layout-signs.ts`). */
  california?: boolean;
  /** The accessible charging space: its vehicle space and striped access aisle, in lot meters (null: none). */
  accessible?: AccessibleSpaceBoxes | null;
}

export interface SceneTheme {
  dark: boolean;
  /** The sign texts in the viewer's language (`site-layout-signs.ts` `signTexts`). */
  signs: SignTexts;
  /** The virtual Reserved and Maintenance sign colors (the CSMS state colors, CSS colors). */
  virtualColors: { reserved: string; maintenance: string };
  /** Edit grid and selection ring (a CSS color). */
  primary: string;
  /** A blocked drop (a CSS color). */
  destructive: string;
  /**
   * The front plate colors of AC and DC chargers (`#rrggbb`): the company
   * branding's chargerColorAc and chargerColorDc, the brand color when unset.
   */
  plateColors: { ac: string; dc: string };
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** Normalized depth: smaller is nearer the camera. */
  depth: number;
  /** Distance from the camera in meters. */
  distance: number;
  /** On-screen pixels per world meter at that distance (`pixelsPerMeter`). */
  pxPerMeter: number;
  visible: boolean;
}

export interface SceneCallbacks {
  /** A click or tap on a station (null on the ground). */
  onPick: (stationId: string | null) => void;
  /** A drag in edit mode ended over this spot. */
  onDrop: (stationId: string, bay: LayoutBay) => void;
  /** Whether another station holds the spot. */
  isBayTaken: (bay: LayoutBay, exceptId: string) => boolean;
  /** Where a transformer dragged to a lot point may stand (on the grass). */
  snapTransformer: (p: Point) => Point;
  /** A transformer drag in edit mode ended at this lot point (already snapped). */
  onTransformerDrop: (transformerId: string, p: Point) => void;
  /** A battery drag in edit mode ended at this lot point (on the grass, like a transformer). */
  onBatteryDrop: (batteryId: string, p: Point) => void;
  /** Custom site: a dragged or turned position, snapped (`freeRotation`: Shift, any angle). */
  snapFree?: (p: FreePlacement, freeRotation: boolean) => FreePlacement;
  /** Custom site: whether a station there would stand on another's spots, and the alignment guides to draw. */
  freeDropState?: (
    stationId: string,
    p: FreePlacement,
  ) => { blocked: boolean; guides: AlignmentGuide[] };
  /** Custom site: a station drag or turn ended here (the caller refuses a blocked one). */
  onFreeDrop?: (stationId: string, p: FreePlacement) => void;
  /** Custom site: a solar canopy drag ended at this point (snapped). */
  onSolarDrop?: (solarId: string, p: Point) => void;
  /** Custom site in edit mode: a click on a solar canopy selects it (null: none). */
  onSolarPick?: (solarId: string | null) => void;
  /** A mouse or pen pointer over a station (null when it leaves): the station tooltip. Never on touch. */
  onHover?: (stationId: string | null) => void;
  /**
   * The power equipment whose label shows (no label is always on): a mouse or
   * pen pointer over it, or a tap on it (touch). The key is
   * `transformer:<id>`, `energy:<id>` (a battery or solar canopy) or a link
   * label id (`panel:<id>` for a switchboard or panelboard and the cable into
   * it, `circuit:<id>` for a circuit's cable run, `station:<id>` for a
   * station's branch) or `virtual:<stationId>` for a virtual status sign;
   * null when the pointer leaves it or a tap misses.
   */
  onEquipmentHover?: (key: string | null) => void;
  /** Runs after every rendered frame (labels and popup follow the models). */
  onFrame: () => void;
}

export interface SiteScene {
  setLayout: (layout: SceneLayout) => void;
  setTheme: (theme: SceneTheme) => void;
  setEditing: (editing: boolean) => void;
  setSelected: (stationId: string | null) => void;
  /** Custom site in edit mode: the selected solar canopy (outlined), or null. */
  setSelectedSolar: (solarId: string | null) => void;
  /** The company logo (a data or http(s) URL) for the back panels; null for plain panels. */
  setLogo: (url: string | null) => void;
  /**
   * The live power on the load management links, 0 to 1 by segment id
   * (`loadFlows`): brighter and thicker with more power. No rebuild.
   */
  setLinkFlow: (flow: ReadonlyMap<string, number>) => void;
  /** Where the label of a battery or solar canopy goes. */
  energyLabelPoint: (id: string) => ScreenPoint | null;
  /** Draw calls and triangles of the last frame (the large site benchmark). */
  stats: () => { calls: number; triangles: number };
  /** How far the camera stands from the point it looks at, in meters. */
  viewDistance: () => number;
  /** Turns the view to a station (keeps the camera's angle and distance). */
  focus: (stationId: string) => void;
  /** Where a driver avatar floats: above the car of a charging station, else above the charger. */
  avatarPoint: (stationId: string) => ScreenPoint | null;
  /**
   * Fit to View. `toggle`: the Fit to View button; on a narrow stage it
   * alternates the densest part of a wide site and the whole site.
   */
  fit: (toggle?: boolean) => void;
  /** Moves the camera by one keyboard, wheel or trackpad step (applied at once, then clamped). */
  nudgeCamera: (n: CameraNudge) => void;
  /**
   * Zooms by `zoom` (positive: closer) toward the point under the pointer at
   * `at` (client px), the orbit center following it, like a map
   * (`zoomTowardPoint`); above the horizon, toward the orbit center.
   */
  zoomAt: (zoom: number, at: { clientX: number; clientY: number }) => void;
  /**
   * Renders while true. False stops the frame loop (the view is off screen or
   * the tab is hidden); true starts it again.
   */
  setActive: (active: boolean) => void;
  /** Where above a station its label goes, in px of the container. */
  labelPoint: (stationId: string) => ScreenPoint | null;
  /** Where above a transformer its label goes. */
  transformerLabelPoint: (transformerId: string) => ScreenPoint | null;
  /** Where a link label goes. */
  linkLabelPoint: (labelId: string) => ScreenPoint | null;
  /** Where the time window of a station's virtual status sign goes (null: none). */
  virtualSignPoint: (stationId: string) => ScreenPoint | null;
  /** Where the label of a station's EVSE plate goes (EVSE order; null: no such plate). */
  evsePlatePoint: (stationId: string, index: number) => ScreenPoint | null;
  /** Where the label of a unit charger's box number plate goes (null: no plate). */
  unitPlatePoint: (stationId: string) => ScreenPoint | null;
  dispose: () => void;
}

export type Disposable = { dispose: () => void };

export interface StationObject {
  group: THREE.Group;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  light: THREE.MeshStandardMaterial;
  /** The charging glow: the strip and its halo (null when not charging). */
  glow: { strip: THREE.MeshStandardMaterial; halo: THREE.MeshBasicMaterial } | null;
  top: number;
  /** Where the label goes along the station's own z (a wall box hangs behind its spot). */
  labelZ: number;
  /** Above the middle of the car roof (station frame), or null without a car. */
  avatarAnchor: THREE.Vector3 | null;
  /** The virtual status sign (a sprite facing the camera), or null. */
  virtualSign: THREE.Sprite | null;
  /** Custom site: the rotation handle in front of the spots (shown on the selected station in Edit Layout). */
  handle: THREE.Group | null;
  station: SceneStation;
}

/** The meshes of one load management cable run, restyled by its live flow. */
export interface LinkMeshes {
  core: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  halo: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  /** The center line, its turns bent (`linkPolyline`). */
  line: THREE.Vector3[];
  /** The core radius it is drawn at. */
  radius: number;
  kind: LinkKind;
  /** The load it carries (`LinkSegment.flowId`). */
  flowId: string;
  /** The flow step it is drawn at (0 to 10), -1 before the first style. */
  step: number;
}

/** The virtual status sign: how wide and how high its middle floats, in meters (its opacity: VIRTUAL_SIGN_OPACITY). */
export const VIRTUAL_SIGN_WIDTH_M = 2.3;
export const VIRTUAL_SIGN_Y_M = 2.4;

/** How far above the car roof a driver avatar floats, in meters. */
export const AVATAR_ABOVE_ROOF_M = 0.5;

/**
 * Height of the load management cable runs above the ground, in meters: just
 * above the paving and its markings, so they never z-fight with them.
 */
export const LINK_Y = 0.08;
/** Height of a panel label, in meters. */
export const PANEL_LABEL_Y = 2.75;

/**
 * Where Fit to View puts the camera: `overview` looks down on the site from
 * the front right of the view (the Layout tab), `front` stands lower in front
 * of the chargers, turned with the facing (the dashboard widget, frontCamera),
 * still above the lowest orbit (MAX_POLAR_ANGLE).
 */
export type SceneCameraView = 'overview' | 'front';
export type Palette = (typeof SCENE_COLORS)['light'] | (typeof SCENE_COLORS)['dark'];
// Where a charging cable runs: from a DC charger, an AC pedestal or a wall
// box to a car parked nose in, or from a curbside post to a car parked
// parallel along the curb.
export type CableKind = 'ac' | 'dc' | 'wall' | 'curb-ac' | 'curb-dc';
// The props and the transformer, built once per rebuild on first use and
// cloned per station: the clones share their geometries and materials.
export interface Templates {
  /**
   * A car of its body type in its color, nose to the charger, or backed in
   * when its port is at the rear (`parksBackedIn`); the end toward the
   * charger `frontZ` in front of it (against a wheel stop where the spot has one).
   */
  car: (look: SceneCar, frontZ?: number) => THREE.Group;
  /** The car parallel parked along a curb, in front of a curbside post. */
  carParallel: (look: SceneCar, spot?: CurbSpot) => THREE.Group;
  /** A vehicle of its body type in its color in its own frame (nose at the origin facing -z). */
  vehicle: (look: SceneCar) => THREE.Group;
  /**
   * The cable to the charge port of a car of this (drawn) body type; `offsetX`
   * moves the car across the station (the right spot of a two-spot station
   * on a custom site takes the right holster).
   */
  cable: (
    kind: CableKind,
    look: SceneCar,
    offsetX?: number,
    frontZ?: number,
    /** The cable carries energy: the charge flow runs along it (default true). */
    flowing?: boolean,
    /** The plugged connector's type and its holster (`holsterSlots` side and drop). */
    plug?: {
      connector?: ConnectorKind;
      side?: -1 | 1;
      backM?: number;
      mouth?: Point3;
      /** An AC pedestal's gland x under the head (`acGlandX`). */
      glandX?: number;
      /** A dual-port pedestal's stall: the x range its cable keeps to (`plugRoute` bounds). */
      bounds?: { minX: number; maxX: number };
      /** A wall box's ports: two ports run the cable of `side` from that port's gland. */
      wallPorts?: 1 | 2;
      /** The cable's length (default: the charger class's, a DC dispenser's 3.6 m). */
      lengthM?: number;
      /** A two-port curb post: the spot of the car this cable reaches (`CurbSpot`). */
      curbSpot?: CurbSpot;
    },
  ) => THREE.Group;
  /** A precast concrete wheel stop (WHEEL_STOP), centered on the origin, across x. */
  wheelStop: () => THREE.Group;
  /** The EV charging signs of a stall (R7-113, and the California tow-away sign), on a post or a wall. */
  evSigns: (mount: StationSigns) => THREE.Group;
  cone: () => THREE.Group;
  transformer: () => THREE.Group;
  battery: () => THREE.Group;
  switchboard: () => THREE.Group;
  /** A DC split system's power cabinet on a pad (`SPLIT_SYSTEM.cabinet`), its doors toward +z. */
  powerCabinet: () => THREE.Group;
  panelboard: () => THREE.Group;
  wallPanelboard: () => THREE.Group;
  /** A step-down dry-type transformer on its pad, sized by its kVA class, its front toward +z. */
  dryTransformer: (kva: number | null) => THREE.Group;
  terminal: (hasDisplay: boolean, online: boolean | null) => THREE.Group;
}
export interface StationMaterials {
  shell: THREE.Material;
  dark: THREE.Material;
  rubber: THREE.Material;
  glass: THREE.Material;
  light: THREE.Material;
  accent: THREE.Material;
}
export type PickKind = 'station' | 'transformer' | 'battery' | 'solar' | 'handle';
