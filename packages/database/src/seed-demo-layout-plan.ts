// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The site layout demo as plain data (no database import), so the seed, its
// tests and the docs screenshot fixtures read one plan. Four sites, one per
// site type and charger mounting, as on real sites: Harbor Point Charging Hub,
// a parking lot (an outdoor hub of DC fast chargers, 2 rows of 6 spots, two
// transformers and a battery on the grass, a solar carport over the back row,
// one faulted station without a simulator, switchboards with load management
// links); Lakeside Retail Park, an office or retail site with 12 charger
// positions along the building front and AC wall boxes on the facade;
// Riverside Medical Offices, an office or retail site with AC posts at the
// head of 6 spots (stall mounting); Maple Street, a curbside site with AC
// posts at the curb, 4 on each side of the street; and Willow Creek Park and
// Ride, a custom site whose stations stand along a curved access road, each
// turned to face it with its own parking spots (three DC fast chargers with
// two spots each, five AC pedestals, three of them in a row under a solar
// carport), with a transformer and a battery placed freely and an active
// display message on the DC charger at the apex of the curve; and Northgate
// Fleet Depot, a depot with nose-in bus bays under pantograph poles and at
// plug-in dispensers, and truck pull-through lanes with megawatt dispensers.
// Every site is load managed, so the station popups show the allocated limit;
// the parking lot and the custom site draw their panels and links.
//
// Earlier releases of the demo mixed DC and AC chargers on both sites. A rerun
// moves the stations of the earlier plan (`movedFrom`), renames its panels and
// circuits (`renamedFrom`) and replaces the layout settings it seeded
// (`LAYOUT_DEMO_PREVIOUS_SETTINGS`), each only while the row still holds what
// that plan wrote, so an operator's own change stays.

import {
  bayToPosition,
  freeSlotsFor,
  groupedSpotOrder,
  positionToBay,
} from '@evtivity/lib/site-layout';
import type { FreePlacement, LayoutBay, SiteLayoutSettings } from '@evtivity/lib/site-layout';
import { circuitConductorPhases, computeMaxContinuousKw } from '@evtivity/lib/load-allocation';
import type { VehicleBodyType, VehicleColor } from '@evtivity/lib/vehicle-appearance';

export interface LayoutDemoStation {
  id: string;
  stationId: string;
  kind: 'ac' | 'dc';
  col: number;
  row: number;
  /** The circuit the station hangs on. */
  circuitId: string;
  /** Cellular data plan (the 4G badge). */
  cellular?: boolean;
  /** No simulator: the station stays offline. */
  offline?: boolean;
  /** Covered by the demo maintenance event (the traffic cone). */
  maintenance?: boolean;
  /** No simulator, a faulted connector and an open AI insight on it (the faulted state). */
  faulted?: boolean;
  /** Where the earlier plan seeded the station (a rerun moves it from there). */
  movedFrom?: { siteId: string; circuitId: string };
  /**
   * The circuit the plan before the per-charger circuits hung the station on
   * at this site: a rerun moves it to its own circuit only while it is still there.
   */
  circuitFrom?: string;
  /** Custom site: where the station stands and its turn. */
  free?: FreePlacement;
  /**
   * Where the earlier plan stood the station (grid slot and, on a custom site,
   * free position). A rerun moves it to this plan's position only while every
   * station of the site with one still stands there (an operator's own edit
   * stays).
   */
  before?: { col: number; row: number; free?: FreePlacement };
  /** An active display message the station accepted (shown on its screen in 3D). */
  message?: string;
  /** The connector type of every EVSE (default CCS2 for DC, Type2 for AC). */
  connectorType?: string;
  /** The maximum power of every connector, in kW (default 150 DC, 22 AC). */
  maxPowerKw?: number;
  /** The EVSEs of the station (default 2 for DC, 1 for AC). */
  evses?: number;
}

export interface LayoutDemoPanel {
  id: string;
  parentPanelId: string | null;
  name: string;
  breakerRatingAmps: number;
  voltageV: number;
  phases: number;
  maxContinuousKw: number;
  /**
   * The panel as earlier plans seeded it, newest first: a rerun gives it this
   * plan's name, ratings and parent only while its row still has one of these
   * names and, where given, its breaker rating (an operator's change stays).
   */
  renamedFrom?: ReadonlyArray<{ name: string; amps?: number }>;
  circuits: LayoutDemoCircuit[];
}

export interface LayoutDemoCircuit {
  id: string;
  name: string;
  breakerRatingAmps: number;
  maxContinuousKw: number;
  /** The phases of a three-phase panel the circuit uses (a 2-pole Level 2 circuit: two of them); null for all. */
  phaseConnections: string | null;
  /**
   * The circuit as earlier plans seeded it, newest first: a rerun renames it,
   * rates it and moves it to this panel only while its row still holds one of
   * these (name, panel and, where given, breaker rating).
   */
  renamedFrom?: ReadonlyArray<{ name: string; panelId: string; amps?: number }>;
}

export interface LayoutDemoSite {
  id: string;
  name: string;
  address: string;
  city: string;
  latitude: string;
  longitude: string;
  settings: SiteLayoutSettings;
  panels: LayoutDemoPanel[];
  stations: LayoutDemoStation[];
}

type StationExtra = Pick<
  LayoutDemoStation,
  | 'cellular'
  | 'offline'
  | 'maintenance'
  | 'faulted'
  | 'movedFrom'
  | 'free'
  | 'before'
  | 'message'
  | 'connectorType'
  | 'maxPowerKw'
  | 'evses'
>;

/**
 * A DC demo station `n` (CS-30nn). `circuitFrom` is the circuit the plan before
 * the per-charger circuits hung it on; the station gets its own circuit
 * (`evseCircuitId`), and a rerun moves it there from `circuitFrom`.
 */
const dc = (
  n: number,
  col: number,
  row: number,
  circuitFrom: string,
  extra: StationExtra = {},
): LayoutDemoStation => {
  const circuitId = evseCircuitId(n);
  return {
    id: `sta_demolayout${String(n).padStart(2, '0')}`,
    stationId: `CS-${String(3000 + n)}`,
    kind: 'dc' as const,
    col,
    row,
    circuitId,
    ...(circuitFrom !== circuitId ? { circuitFrom } : {}),
    ...extra,
  };
};
const ac = (
  n: number,
  col: number,
  row: number,
  circuitId: string,
  extra: StationExtra = {},
): LayoutDemoStation => ({
  ...dc(n, col, row, circuitId, extra),
  kind: 'ac' as const,
});

export interface LayoutDemoTerminal {
  providerDeviceId: string;
  label: string;
  vendor: string;
  model: string;
  serialNumber: string;
  firmwareVersion: string;
  stationId: string;
  /** OCPP EVSE number of the paired connector; null for the whole station. */
  evseNumber: number | null;
  online: boolean;
  /** The station the earlier plan paired the reader to (a rerun pairs it again here). */
  pairedBefore?: string;
  /**
   * The EVSE number the earlier plan paired the reader to on this station (a
   * rerun pairs it to the whole station while it is still there).
   */
  evseBefore?: number;
}

// The electrical trees, as an engineer designs them (the site layout standards
// rules):
//
// - Utility transformer, then a main switchboard. Each DC fast charger or DC
//   power cabinet on its own breaker of a switchboard, never on a branch
//   panelboard; AC Level 2 chargers on panelboards, each on its own circuit
//   (NFPA 70 (NEC) 2023, 625.40: an individual branch circuit for each outlet).
// - A breaker of at least 125 percent of the charger's maximum load, rounded up
//   to the next standard rating (NEC 625.41; 210.19 and 210.20 for continuous
//   loads; 240.6(A) standard ratings).
// - No panel loaded past its continuous capacity (80 percent of its rating,
//   `computeMaxContinuousKw`): the panel's supply is a feeder, whose
//   overcurrent device and conductors are at least 125 percent of the
//   continuous load (NEC 215.3 and 215.2(A)(1), read through EC&M "NEC
//   Requirements for Feeders",
//   https://ecmweb.com/national-electrical-code/code-basics/article/55292492/nec-requirements-for-feeders;
//   210.19 and 210.20 are the branch circuit rules). Many AC chargers need
//   several panelboards.
//
// DC services are 480Y/277 V three-phase (voltage stored phase to neutral, 277);
// AC panelboards are 208Y/120 V three-phase (stored 120), each Level 2 charger
// on a 2-pole 208 V circuit, the phase pairs rotated for balance. Where a
// 208Y/120 V panelboard hangs under a 480 V switchboard (Patroon Creek, Willow
// Creek), a real site feeds it through a 480 to 208Y/120 V step-down
// transformer. The load management model has no transformer node (panels and
// circuits only), so the panelboard hangs directly under the switchboard and
// the layout draws no step-down transformer.

/** Standard ampere ratings of breakers (NEC 2023, 240.6(A)), up to 6000 A. */
const STANDARD_BREAKER_AMPS = [
  15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 225, 250, 300, 350,
  400, 450, 500, 600, 700, 800, 1000, 1200, 1600, 2000, 2500, 3000, 4000, 5000, 6000,
] as const;

/** The smallest standard breaker of at least 125 percent of a continuous load (NEC 625.41). */
export function evseBreakerAmps(loadAmps: number): number {
  const needed = loadAmps * 1.25;
  const found = STANDARD_BREAKER_AMPS.find((a) => a >= needed - 1e-9);
  if (found == null) throw new Error(`No standard breaker for ${String(loadAmps)} A`);
  return found;
}

/**
 * The input current of a 480 V three-phase DC charger of `kw` output, in A:
 * output over efficiency and power factor (0.96 and 0.96, the ABB Terra 184 NA
 * datasheet), over sqrt(3) x 480 V. For the Terra 184 itself the datasheet
 * gives 230 A and a 300 A breaker (`TERRA_184_INPUT_AMPS`), which this matches.
 * Only for models without a datasheet input value: a model with one uses it
 * (`TERRA_184_INPUT_AMPS`, `KEMPOWER_C502P200_INPUT_AMPS`).
 */
export function dcInputAmps(kw: number): number {
  return (kw * 1000) / (0.96 * 0.96 * Math.sqrt(3) * 480);
}

/** ABB Terra 184 (NA): 230 A nominal input at 480Y/277 V (product leaflet, Specifications). */
export const TERRA_184_INPUT_AMPS = 230;
/**
 * Kempower C-Series double cabinet C502P200 in continuous operation (200 kW):
 * 231 kVA input, 278 A at 480 V AC, recommended grid fuse 400 A; power factor
 * 0.92 and efficiency 94 percent at full load. Kempower C-Series Power Unit
 * datasheet (2022), "General electric specifications" and "Continuous
 * operation, 40 kW output / power module",
 * https://www.nee.ca/wp-content/uploads/2023/08/Kempower-C-Series-Power-Units.pdf
 * (re-read 2026-11-01).
 */
export const KEMPOWER_C502P200_INPUT_AMPS = 278;
export const KEMPOWER_C502P200_FUSE_AMPS = 400;
/** ABB Terra 184 (NA): the 300 A breaker of its product leaflet. */
export const TERRA_184_BREAKER_AMPS = 300;
/** A Level 2 charger's continuous current in the demo (32 A at 208 V). */
export const LEVEL_2_AMPS = 32;

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** 480Y/277 V and 208Y/120 V three-phase services, stored phase to neutral. */
const V480 = 277;
const V208 = 120;

function panelOf(
  id: string,
  parentPanelId: string | null,
  name: string,
  amps: number,
  voltageV: number,
  circuits: LayoutDemoCircuit[],
  renamedFrom?: LayoutDemoPanel['renamedFrom'],
): LayoutDemoPanel {
  return {
    id,
    parentPanelId,
    name,
    breakerRatingAmps: amps,
    voltageV,
    phases: 3,
    maxContinuousKw: round2(computeMaxContinuousKw(amps, voltageV, 3)),
    ...(renamedFrom != null ? { renamedFrom } : {}),
    circuits,
  };
}

/**
 * The circuits each demo station had in the plan before the per-charger
 * circuits; a station listed in `REUSED_CIRCUITS` keeps that circuit (renamed
 * and rated for it), every other gets its own.
 */
const REUSED_CIRCUITS: Readonly<Record<number, string>> = {
  1: 'cir_demolayout01',
  13: 'cir_demolayout02',
  7: 'cir_demolayout03',
  17: 'cir_demolayout04',
  22: 'cir_demolayout05',
  26: 'cir_demolayout06',
  34: 'cir_demolayout07',
  35: 'cir_demolayout08',
  42: 'cir_demolayout09',
  45: 'cir_demolayout10',
  47: 'cir_demolayout11',
  49: 'cir_demolayout12',
};

/** The circuit of demo station `n` (CS-30nn): its own breaker. */
export function evseCircuitId(n: number): string {
  return REUSED_CIRCUITS[n] ?? `cir_demoevse${String(n).padStart(2, '0')}`;
}

/** A DC charger's own switchboard breaker (all three phases of a 480Y/277 V service). */
function dcCircuit(
  n: number,
  inputAmps: number,
  renamedFrom?: LayoutDemoCircuit['renamedFrom'],
): LayoutDemoCircuit {
  const amps = evseBreakerAmps(inputAmps);
  return {
    id: evseCircuitId(n),
    name: `Charger CS-${String(3000 + n)}`,
    breakerRatingAmps: amps,
    maxContinuousKw: round2(computeMaxContinuousKw(amps, V480, 3)),
    phaseConnections: null,
    ...(renamedFrom != null ? { renamedFrom } : {}),
  };
}

const PHASE_PAIRS = ['L1L2', 'L2L3', 'L1L3'] as const;

/** A Level 2 charger's own 2-pole 208 V circuit on a 208Y/120 V panelboard (the `i`th, rotating phase pairs). */
function acCircuit(
  n: number,
  i: number,
  renamedFrom?: LayoutDemoCircuit['renamedFrom'],
): LayoutDemoCircuit {
  const amps = evseBreakerAmps(LEVEL_2_AMPS);
  const phaseConnections = PHASE_PAIRS[i % PHASE_PAIRS.length] ?? 'L1L2';
  return {
    id: evseCircuitId(n),
    name: `Charger CS-${String(3000 + n)}`,
    breakerRatingAmps: amps,
    maxContinuousKw: round2(
      computeMaxContinuousKw(amps, V208, circuitConductorPhases(phaseConnections, 3)),
    ),
    phaseConnections,
    ...(renamedFrom != null ? { renamedFrom } : {}),
  };
}

const acCircuits = (
  stations: readonly number[],
  reused: Record<number, LayoutDemoCircuit['renamedFrom']> = {},
) => stations.map((n, i) => acCircuit(n, i, reused[n]));

/**
 * Northgate Fleet Depot's layout. The bus group (3 x 450 kW + 2 x 150 kW, about
 * 1.8 MVA of input) on a 2500 kVA transformer, the truck group (2 x 1 MW +
 * 240 kW, about 2.4 MVA) on a 3750 kVA one. Both are ratings of the
 * three-phase pad-mounted kVA list of IEEE C57.12.34 (45, 75, 112.5, 150, 225,
 * 300, 500, 750, 1000, 1500, 2000, 2500, 3000, 3750, 5000 to 10,000 kVA), read
 * in Eaton Consulting Application Guide, Section 17 Pad-Mounted Transformers
 * (April 2016), page 17.0-2, "Nominal impedance per IEEE C57.12.34",
 * https://content.voltimum.com/tr/39129/section_17_-_pad-mounted_transformers_.pdf.
 * 2500 kVA would carry the truck group at about 96 percent; 3750 kVA leaves
 * margin.
 */
const DEPOT_SETTINGS_FAR_EQUIPMENT: SiteLayoutSettings = {
  siteType: 'depot',
  spotsPerRow: 8,
  rows: 1,
  facingDeg: 0,
  busBays: 6,
  truckLanes: 3,
  transformers: [
    { id: 'tx-1', name: 'Bus Charging Transformer', ratedKva: 2500, x: 8, z: -16 },
    { id: 'tx-2', name: 'Truck Charging Transformer', ratedKva: 3750, x: 89, z: 1 },
  ],
  energyAssets: [
    {
      id: 'bat-1',
      type: 'battery',
      name: 'Depot Battery Storage',
      capacityKwh: 2000,
      x: 20,
      z: -16,
    },
  ],
};
/**
 * Each equipment pad stands next to the group it feeds,
 * `TRANSFORMER_CLEARANCE_M` (2.5 m) behind the yard edge (`depotLayout`: the
 * bus area's back at z -3.6, the truck area's at z -7.6): the bus transformer
 * behind the first bus bay heads, its switchboards beside it at the bay row's
 * end, the battery 2 m past its pad; the truck transformer behind the truck
 * lanes at their dispenser end (the dispensers stand 5 m from the lanes'
 * end, x 61.5), so the circuits run along the lane ends and islands, never
 * around the drive lane.
 */
const DEPOT_SETTINGS: SiteLayoutSettings = {
  ...DEPOT_SETTINGS_FAR_EQUIPMENT,
  transformers: [
    { id: 'tx-1', name: 'Bus Charging Transformer', ratedKva: 2500, x: 0, z: -6.1 },
    { id: 'tx-2', name: 'Truck Charging Transformer', ratedKva: 3750, x: 68, z: -10.1 },
  ],
  energyAssets: [
    {
      id: 'bat-1',
      type: 'battery',
      name: 'Depot Battery Storage',
      capacityKwh: 2000,
      x: 5.5,
      z: -6.1,
    },
  ],
};

const HARBOR = 'sit_demolayout01';

/** Harbor Point's layout before the solar carport moved to the front edge row (over the middle row). */
const HARBOR_SETTINGS_MIDDLE_CARPORT: SiteLayoutSettings = {
  siteType: 'parking_lot',
  spotsPerRow: 6,
  rows: 3,
  facingDeg: 0,
  chargerPlacement: 'lot_edge',
  transformers: [
    { id: 'tx-1', name: 'Utility Transformer', ratedKva: 2500, x: -14, z: 2.5 },
    { id: 'tx-2', name: 'Solar Carport Tie-In', ratedKva: 750, x: -14, z: 16 },
  ],
  energyAssets: [
    { id: 'bat-1', type: 'battery', name: 'Battery Storage', capacityKwh: 1000, x: 25, z: 4 },
    { id: 'pv-1', type: 'solar', name: 'Solar Carport', capacityKwp: 180, row: 1 },
  ],
};

/** Willow Creek's layout with its solar carport at `canopyZ`. */
const willowSettings = (
  canopyZ: number,
  battery: { x: number; z: number } = { x: 30, z: -24 },
  transformer: { x: number; z: number } = { x: -30, z: -26 },
): SiteLayoutSettings => ({
  siteType: 'custom',
  spotsPerRow: 10,
  rows: 2,
  facingDeg: 0,
  transformers: [{ id: 'tx-1', name: 'Pad Transformer', ratedKva: 1000, ...transformer }],
  energyAssets: [
    { id: 'bat-1', type: 'battery', name: 'Battery Storage', capacityKwh: 500, ...battery },
    // Over the three AC pedestals in a row (z -24, their spots toward +z):
    // the canopy's back edge 2 m behind them, so its column line stands
    // behind the chargers, past the head of the spots.
    {
      id: 'pv-1',
      type: 'solar',
      name: 'Solar Carport',
      capacityKwp: 10,
      row: 0,
      x: 4.5,
      z: canopyZ,
      rotationDeg: 0,
    },
  ],
});
/**
 * The transformer stands beside the DC group it feeds (the three DC
 * dispensers at the west end), and the battery on the same equipment pad
 * behind it, not alone at the far end of the stations, where it stood in the
 * way of the panelboard feeders (owner rule 2026-11-01: every equipment item
 * next to the group it feeds).
 */
const WILLOW_TRANSFORMER = { x: -26.5, z: -21 };
const WILLOW_SETTINGS = willowSettings(-23, { x: -26.5, z: -25.5 }, WILLOW_TRANSFORMER);

/** Harbor Point's layout with its equipment 14 m out on the grass, before the pad moved to the lot edge. */
const HARBOR_SETTINGS_FAR_EQUIPMENT: SiteLayoutSettings = {
  ...HARBOR_SETTINGS_MIDDLE_CARPORT,
  energyAssets: [
    { id: 'bat-1', type: 'battery', name: 'Battery Storage', capacityKwh: 1000, x: 25, z: 4 },
    { id: 'pv-1', type: 'solar', name: 'Solar Carport', capacityKwp: 180, row: 0 },
  ],
};

/**
 * Harbor Point's layout: the equipment pad at the lot edge next to the front
 * row of fast chargers it feeds. The utility transformer stands
 * `TRANSFORMER_CLEARANCE_M` (2.5 m) from the lot edge beside the first spot,
 * its pad 1.05 m from the curb (more than the 3 ft a utility keeps clear at a
 * pad side; bollards guard the side within 5 ft of the lot), the switchboards
 * in line beyond it (`placePanels`); the solar carport tie-in transformer and
 * the battery in front of the carport's column line, clear of the cable lanes.
 */
const HARBOR_SETTINGS: SiteLayoutSettings = {
  ...HARBOR_SETTINGS_MIDDLE_CARPORT,
  transformers: [
    { id: 'tx-1', name: 'Utility Transformer', ratedKva: 2500, x: -2.5, z: 2.5 },
    { id: 'tx-2', name: 'Solar Carport Tie-In', ratedKva: 750, x: -2.5, z: -3.5 },
  ],
  energyAssets: [
    { id: 'bat-1', type: 'battery', name: 'Battery Storage', capacityKwh: 1000, x: -7.5, z: -3.5 },
    { id: 'pv-1', type: 'solar', name: 'Solar Carport', capacityKwp: 180, row: 0 },
  ],
};
const LAKESIDE = 'sit_demolayout02';
const RIVERSIDE = 'sit_demolayout03';
const MAPLE = 'sit_demolayout04';
const WILLOW = 'sit_demolayout05';
const DEPOT = 'sit_demolayout06';
const PATROON = 'sit_demolayout07';

/**
 * Patroon Creek Charging Plaza: a parking lot of 4 rows of 8 spots with the
 * chargers on islands (rows 1 and 2 back to back on one island), its
 * transformer on the grass left of the first row. Four DC fast chargers take
 * the spots nearest the transformer (`groupedSpotOrder`), and eight dual-port
 * Level 2 pedestals the far end, each standing on the line between two spots
 * and serving both (`sharesSpotPair`, ChargePoint CPF50 Site Design Guide:
 * "two stations back to back centered on four spaces"), in the slots the
 * placement gives them after the DC group (`freeSlotsFor`).
 */
const PATROON_SETTINGS: SiteLayoutSettings = {
  siteType: 'parking_lot',
  spotsPerRow: 8,
  rows: 4,
  facingDeg: 0,
  chargerPlacement: 'islands',
  transformers: [{ id: 'tx-1', name: 'Utility Transformer', ratedKva: 1000, x: -2.5, z: 2.5 }],
  energyAssets: [],
};
/** Patroon Creek's layout before its transformer moved to the lot edge (5 m out). */
const PATROON_SETTINGS_FAR_TRANSFORMER: SiteLayoutSettings = {
  ...PATROON_SETTINGS,
  transformers: [{ id: 'tx-1', name: 'Utility Transformer', ratedKva: 1000, x: -5, z: 2.5 }],
};
const PATROON_DC: readonly number[] = [50, 51, 52, 53];
const PATROON_AC: readonly number[] = [54, 55, 56, 57, 58, 59, 60, 61];
/** The ports (EVSEs) of each Patroon Creek Level 2 pedestal. */
export const PATROON_AC_PORTS = 2;
const PATROON_DC_SPOTS: readonly LayoutBay[] = groupedSpotOrder(PATROON_SETTINGS, 'dc').slice(
  0,
  PATROON_DC.length,
);
const PATROON_AC_SPOTS: readonly LayoutBay[] = freeSlotsFor(
  PATROON_AC.map(() => ({ charging: 'ac' as const, depot: null, ports: PATROON_AC_PORTS })),
  PATROON_DC_SPOTS.map((b) => ({ ...bayToPosition(b), charging: 'dc' as const })),
  PATROON_SETTINGS,
).map(positionToBay);
/** Where the plan before the dual-port pedestals stood the single-port ones (one spot each). */
const PATROON_AC_SPOTS_SINGLE: readonly LayoutBay[] = groupedSpotOrder(
  PATROON_SETTINGS,
  'ac',
).slice(0, PATROON_AC.length);

/**
 * A demo card reader: simulated device `sim_term_<seq>` (its serial number
 * carries sequence `seq + 12`, as the simulated provider reports it), on the
 * whole station `CS-30nn`.
 */
function demoReader(seq: number, model: 'VP6825' | 'VP7200', n: number): LayoutDemoTerminal {
  return {
    providerDeviceId: `sim_term_${String(seq)}`,
    label: `Reader CS-${String(3000 + n)}`,
    vendor: 'ID TECH',
    model,
    serialNumber: `${model.slice(2)}SIM${String(seq + 12).padStart(6, '0')}`,
    firmwareVersion: model === 'VP6825' ? '1.01.106' : '1.00.042',
    stationId: `sta_demolayout${String(n).padStart(2, '0')}`,
    evseNumber: null,
    online: true,
  };
}

/** A driver of the fleet depot demo and the one vehicle it drives (its body type decides what the layout draws). */
export interface LayoutDemoFleetDriver {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  /** The RFID card the driver charges with (ISO14443). */
  idToken: string;
  vehicle: {
    id: string;
    make: string;
    model: string;
    year: string;
    licensePlate: string;
    bodyType: VehicleBodyType;
    color: VehicleColor;
  };
}

/** The fleet of the depot: its drivers charge only at the depot's stations (fleet_stations). */
export interface LayoutDemoFleet {
  id: string;
  name: string;
  description: string;
  siteId: string;
  drivers: LayoutDemoFleetDriver[];
}

const depotDriver = (
  n: number,
  firstName: string,
  lastName: string,
  vehicle: Omit<LayoutDemoFleetDriver['vehicle'], 'id' | 'licensePlate'>,
): LayoutDemoFleetDriver => {
  const nn = String(n).padStart(2, '0');
  return {
    id: `drv_demodepot${nn}`,
    firstName,
    lastName,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@northgate-fleet.example`,
    idToken: `RFID-DEPOT-${nn}`,
    vehicle: { id: `veh_demodepot${nn}`, licensePlate: `NGF-${String(100 + n)}`, ...vehicle },
  };
};

/** The fixed id of the demo display message on each station that has one (OCPP message id). */
export const LAYOUT_DEMO_MESSAGE_ID = 9001;

export const LAYOUT_DEMO: {
  sites: LayoutDemoSite[];
  maintenanceEventId: string;
  faultInsightId: string;
  terminals: LayoutDemoTerminal[];
  fleet: LayoutDemoFleet;
} = {
  sites: [
    {
      id: HARBOR,
      name: 'Harbor Point Charging Hub',
      address: '200 Harbor Point Blvd',
      city: 'Albany',
      latitude: '42.646200',
      longitude: '-73.752800',
      // Lot Edge: the chargers stand only along the front and back edge rows,
      // the middle row is ordinary parking. The solar carport covers the
      // front edge row of fast chargers: its columns stand on the grass past
      // the lot edge, behind the chargers, and the drive aisles stay open.
      settings: HARBOR_SETTINGS,
      // 480Y/277 V service from the utility transformer. Every DC fast charger
      // (ABB Terra 184, 230 A input) on its own 300 A switchboard breaker: the
      // front row on the main switchboard, the back row on a distribution
      // switchboard under it.
      panels: [
        panelOf(
          'pnl_demolayout01',
          null,
          'Main Switchboard',
          4000,
          V480,
          [1, 2, 3, 4, 5, 6].map((n) =>
            dcCircuit(
              n,
              TERRA_184_INPUT_AMPS,
              n === 1
                ? [
                    { name: 'DC Bank A', panelId: 'pnl_demolayout01', amps: 600 },
                    { name: 'DC Bank', panelId: 'pnl_demolayout01' },
                  ]
                : undefined,
            ),
          ),
          [{ name: 'Main Switchboard', amps: 800 }],
        ),
        panelOf(
          'pnl_demolayout02',
          'pnl_demolayout01',
          'Distribution Switchboard B',
          1600,
          V480,
          [13, 14, 15, 16, 21].map((n) =>
            dcCircuit(
              n,
              TERRA_184_INPUT_AMPS,
              n === 13
                ? [
                    { name: 'DC Bank B', panelId: 'pnl_demolayout02', amps: 300 },
                    { name: 'Level 2 Circuit', panelId: 'pnl_demolayout02' },
                  ]
                : undefined,
            ),
          ),
          [{ name: 'DC Bank B Switchboard', amps: 400 }, { name: 'Level 2 Panel' }],
        ),
      ],
      stations: [
        dc(1, 0, 0, 'cir_demolayout01'),
        dc(2, 1, 0, 'cir_demolayout01', { cellular: true }),
        dc(3, 2, 0, 'cir_demolayout01'),
        dc(4, 3, 0, 'cir_demolayout01', { maintenance: true }),
        dc(5, 4, 0, 'cir_demolayout01'),
        dc(6, 5, 0, 'cir_demolayout01'),
        dc(13, 1, 2, 'cir_demolayout02', {
          movedFrom: { siteId: LAKESIDE, circuitId: 'cir_demolayout03' },
        }),
        dc(14, 2, 2, 'cir_demolayout02', {
          movedFrom: { siteId: LAKESIDE, circuitId: 'cir_demolayout03' },
        }),
        dc(15, 3, 2, 'cir_demolayout02', {
          movedFrom: { siteId: LAKESIDE, circuitId: 'cir_demolayout03' },
        }),
        dc(16, 4, 2, 'cir_demolayout02', {
          movedFrom: { siteId: LAKESIDE, circuitId: 'cir_demolayout03' },
        }),
        dc(21, 0, 2, 'cir_demolayout02', { offline: true, faulted: true }),
      ],
    },
    {
      id: LAKESIDE,
      name: 'Lakeside Retail Park',
      address: '15 Lakeside Drive',
      city: 'Saratoga Springs',
      latitude: '43.071700',
      longitude: '-73.784400',
      settings: {
        siteType: 'office_retail',
        spotsPerRow: 12,
        rows: 1,
        facingDeg: 0,
        chargers: 12,
        mounting: 'wall',
        transformers: [],
      },
      // The building's main switchboard (208Y/120 V) feeds two 225 A, 42-space
      // panelboards, five Level 2 chargers each, every charger on its own
      // 2-pole 40 A circuit (32 A charger, NEC 625.41).
      panels: [
        panelOf(
          'pnl_demolayout03',
          null,
          'Main Switchboard',
          800,
          V208,
          [],
          [{ name: 'Retail Panel', amps: 400 }],
        ),
        panelOf(
          'pnl_demolayout04',
          'pnl_demolayout03',
          'Panelboard LP-1',
          225,
          V208,
          acCircuits([7, 8, 9, 10, 11], {
            7: [
              { name: 'Level 2 Circuit A', panelId: 'pnl_demolayout03', amps: 200 },
              { name: 'Fast Charge Circuit', panelId: 'pnl_demolayout03' },
            ],
          }),
          [{ name: 'Level 2 Sub-Panel', amps: 225 }],
        ),
        panelOf(
          'pnl_demolayout10',
          'pnl_demolayout03',
          'Panelboard LP-2',
          225,
          V208,
          acCircuits([12, 17, 18, 19, 20], {
            17: [
              { name: 'Level 2 Circuit B', panelId: 'pnl_demolayout04', amps: 100 },
              { name: 'Level 2 Circuit', panelId: 'pnl_demolayout03' },
            ],
          }),
        ),
      ],
      stations: [
        ac(7, 0, 0, 'cir_demolayout03', {
          movedFrom: { siteId: HARBOR, circuitId: 'cir_demolayout02' },
        }),
        ac(8, 1, 0, 'cir_demolayout03', {
          offline: true,
          movedFrom: { siteId: HARBOR, circuitId: 'cir_demolayout02' },
        }),
        ac(9, 2, 0, 'cir_demolayout03', {
          movedFrom: { siteId: HARBOR, circuitId: 'cir_demolayout02' },
        }),
        ac(10, 3, 0, 'cir_demolayout03', {
          cellular: true,
          movedFrom: { siteId: HARBOR, circuitId: 'cir_demolayout02' },
        }),
        ac(11, 4, 0, 'cir_demolayout03', {
          movedFrom: { siteId: HARBOR, circuitId: 'cir_demolayout02' },
        }),
        ac(12, 5, 0, 'cir_demolayout03', {
          movedFrom: { siteId: HARBOR, circuitId: 'cir_demolayout02' },
        }),
        ac(17, 6, 0, 'cir_demolayout04'),
        ac(18, 7, 0, 'cir_demolayout04'),
        ac(19, 8, 0, 'cir_demolayout04'),
        ac(20, 9, 0, 'cir_demolayout04'),
      ],
    },
    {
      id: RIVERSIDE,
      name: 'Riverside Medical Offices',
      address: '40 River Street',
      city: 'Troy',
      latitude: '42.728400',
      longitude: '-73.691800',
      settings: {
        siteType: 'office_retail',
        spotsPerRow: 10,
        rows: 2,
        facingDeg: 0,
        chargers: 6,
        mounting: 'stall',
        transformers: [],
      },
      // Main switchboard (208Y/120 V), one 225 A panelboard with the four posts,
      // each on its own 2-pole 40 A circuit.
      panels: [
        panelOf(
          'pnl_demolayout05',
          null,
          'Main Switchboard',
          400,
          V208,
          [],
          [{ name: 'Parking Panel', amps: 200 }],
        ),
        panelOf(
          'pnl_demolayout11',
          'pnl_demolayout05',
          'Panelboard LP-1',
          225,
          V208,
          acCircuits([22, 23, 24, 25], {
            22: [{ name: 'Level 2 Posts', panelId: 'pnl_demolayout05', amps: 125 }],
          }),
        ),
      ],
      stations: [
        ac(22, 0, 0, 'cir_demolayout05'),
        ac(23, 1, 0, 'cir_demolayout05'),
        ac(24, 2, 0, 'cir_demolayout05', { cellular: true }),
        // The four posts in one run (the plan before left spot 3 empty between them).
        ac(25, 3, 0, 'cir_demolayout05', { before: { col: 4, row: 0 } }),
      ],
    },
    {
      id: MAPLE,
      name: 'Maple Street Curbside',
      address: '120 Maple Street',
      city: 'Schenectady',
      latitude: '42.812500',
      longitude: '-73.939600',
      settings: {
        siteType: 'curbside',
        spotsPerRow: 10,
        rows: 2,
        facingDeg: 0,
        chargersLeft: 4,
        chargersRight: 4,
        transformers: [],
      },
      // A street service cabinet (208Y/120 V) with one 225 A panelboard for each
      // curb, each post on its own 2-pole 40 A circuit.
      panels: [
        panelOf(
          'pnl_demolayout06',
          null,
          'Service Cabinet',
          400,
          V208,
          [],
          [{ name: 'Street Cabinet', amps: 225 }],
        ),
        panelOf(
          'pnl_demolayout12',
          'pnl_demolayout06',
          'Panelboard LP-1',
          225,
          V208,
          acCircuits([26, 27, 28, 29], {
            26: [{ name: 'Curb Posts', panelId: 'pnl_demolayout06', amps: 175 }],
          }),
        ),
        panelOf(
          'pnl_demolayout13',
          'pnl_demolayout06',
          'Panelboard LP-2',
          225,
          V208,
          acCircuits([30, 31, 32, 33]),
        ),
      ],
      stations: [
        ac(26, 0, 0, 'cir_demolayout06'),
        ac(27, 1, 0, 'cir_demolayout06'),
        ac(28, 2, 0, 'cir_demolayout06', { cellular: true }),
        ac(29, 3, 0, 'cir_demolayout06'),
        ac(30, 0, 1, 'cir_demolayout06'),
        ac(31, 1, 1, 'cir_demolayout06'),
        ac(32, 2, 1, 'cir_demolayout06', { cellular: true }),
        ac(33, 3, 1, 'cir_demolayout06', { offline: true }),
      ],
    },
    {
      id: WILLOW,
      name: 'Willow Creek Park and Ride',
      address: '75 Willow Creek Road',
      city: 'Clifton Park',
      latitude: '42.865600',
      longitude: '-73.770900',
      settings: WILLOW_SETTINGS,
      // 480Y/277 V main switchboard: the three DC fast chargers (ABB Terra 184)
      // on their own 300 A breakers, and a 225 A panelboard (208Y/120 V, fed
      // through a step-down transformer) for the five Level 2 pedestals.
      panels: [
        panelOf(
          'pnl_demolayout07',
          null,
          'Main Switchboard',
          1200,
          V480,
          [34, 37, 41].map((n) =>
            dcCircuit(
              n,
              TERRA_184_INPUT_AMPS,
              n === 34
                ? [{ name: 'Fast Charge Circuit', panelId: 'pnl_demolayout07', amps: 400 }]
                : undefined,
            ),
          ),
          [{ name: 'Park and Ride Switchboard', amps: 600 }],
        ),
        panelOf(
          'pnl_demolayout14',
          'pnl_demolayout07',
          'Panelboard LP-1',
          225,
          V208,
          acCircuits([35, 36, 38, 39, 40], {
            35: [{ name: 'Level 2 Circuit', panelId: 'pnl_demolayout07', amps: 200 }],
          }),
        ),
      ],
      // Along the curve of the access road, each turned to face the road: the
      // three DC chargers together at the start of the curve, nearest the pad
      // transformer and the switchboard (short DC feeders), then the AC
      // pedestals, three of them in a straight row under the solar carport.
      stations: [
        dc(34, 0, 0, 'cir_demolayout07', { free: { x: -21.5, z: -11, rotationDeg: 297 } }),
        ac(35, 3, 0, 'cir_demolayout08', {
          free: { x: -4, z: -24, rotationDeg: 0 },
          before: { col: 1, row: 0, free: { x: -17.5, z: -17.5, rotationDeg: 315 } },
        }),
        ac(36, 7, 0, 'cir_demolayout08', {
          cellular: true,
          free: { x: 16, z: -19, rotationDeg: 40 },
          before: { col: 2, row: 0, free: { x: -11.5, z: -21, rotationDeg: 332 } },
        }),
        dc(37, 1, 0, 'cir_demolayout07', {
          free: { x: -17.5, z: -17.5, rotationDeg: 315 },
          before: { col: 3, row: 0, free: { x: -4, z: -24, rotationDeg: 0 } },
          message: 'Welcome to Willow Creek. Idle fees apply 15 minutes after charging ends.',
        }),
        ac(38, 4, 0, 'cir_demolayout08', { free: { x: 1.5, z: -24, rotationDeg: 0 } }),
        ac(39, 5, 0, 'cir_demolayout08', { free: { x: 4.5, z: -24, rotationDeg: 0 } }),
        ac(40, 6, 0, 'cir_demolayout08', { free: { x: 7.5, z: -24, rotationDeg: 0 } }),
        dc(41, 2, 0, 'cir_demolayout07', {
          free: { x: -11.5, z: -21, rotationDeg: 332 },
          before: { col: 7, row: 0, free: { x: 16, z: -19, rotationDeg: 40 } },
        }),
      ],
    },
    {
      id: DEPOT,
      name: 'Northgate Fleet Depot',
      address: '1200 Northgate Industrial Parkway',
      city: 'Latham',
      latitude: '42.747800',
      longitude: '-73.758900',
      // Six bus bays (one free) and three truck lanes. One equipment pad per
      // charger group, as large depots build them: the bus transformer and the
      // battery on the grass behind the bus bays, the truck transformer beside
      // the truck lanes. Each transformer feeds its group's switchboard.
      settings: DEPOT_SETTINGS,
      // DC only. Each charger group's transformer feeds its own 480Y/277 V
      // switchboard (bus and truck), each power cabinet on its own
      // breaker: 450 kW pantograph cabinets on 800 A, 150 kW plug-in on 250 A,
      // 1 MW megawatt cabinets on 2000 A, the 240 kW box truck cabinet on 400 A.
      panels: [
        panelOf(
          'pnl_demolayout08',
          null,
          'Bus Charging Switchboard',
          4000,
          V480,
          [
            dcCircuit(42, dcInputAmps(450), [
              { name: 'Bus Pantograph Circuit', panelId: 'pnl_demolayout08', amps: 2000 },
            ]),
            dcCircuit(43, dcInputAmps(450)),
            dcCircuit(44, dcInputAmps(450)),
            dcCircuit(45, dcInputAmps(150), [
              { name: 'Bus Plug-In Circuit', panelId: 'pnl_demolayout08', amps: 800 },
            ]),
            dcCircuit(46, dcInputAmps(150)),
          ],
          [{ name: 'Depot Main Switchboard', amps: 4000 }],
        ),
        panelOf(
          'pnl_demolayout09',
          null,
          'Truck Charging Switchboard',
          4000,
          V480,
          [
            dcCircuit(47, dcInputAmps(1000), [
              { name: 'Megawatt Charging Circuit', panelId: 'pnl_demolayout09', amps: 2000 },
            ]),
            dcCircuit(48, dcInputAmps(1000)),
            dcCircuit(49, dcInputAmps(240), [
              { name: 'Box Truck Circuit', panelId: 'pnl_demolayout09', amps: 600 },
            ]),
          ],
          [{ name: 'Truck Charging Switchboard', amps: 2500 }],
        ),
      ],
      // The bus bays (row 0): three depot pantograph poles and two plug-in
      // dispensers, one bay each. The truck lanes (row 1): two megawatt
      // dispensers and a box truck dispenser, one lane each.
      stations: [
        dc(42, 0, 0, 'cir_demolayout09', {
          connectorType: 'OppCharge',
          maxPowerKw: 450,
          message: 'Depot charging: buses leave at 05:30. Park nose in under the pantograph.',
        }),
        dc(43, 1, 0, 'cir_demolayout09', {
          connectorType: 'OppCharge',
          maxPowerKw: 450,
        }),
        dc(44, 2, 0, 'cir_demolayout09', {
          connectorType: 'OppCharge',
          maxPowerKw: 450,
        }),
        dc(45, 3, 0, 'cir_demolayout10', {
          connectorType: 'CCS1',
          maxPowerKw: 150,
        }),
        dc(46, 4, 0, 'cir_demolayout10', {
          connectorType: 'CCS1',
          maxPowerKw: 150,
        }),
        dc(47, 0, 1, 'cir_demolayout11', {
          connectorType: 'cMCS',
          maxPowerKw: 1000,
        }),
        dc(48, 1, 1, 'cir_demolayout11', {
          connectorType: 'cMCS',
          maxPowerKw: 1000,
        }),
        dc(49, 2, 1, 'cir_demolayout12', {
          connectorType: 'CCS1',
          maxPowerKw: 240,
        }),
      ],
    },
    {
      id: PATROON,
      name: 'Patroon Creek Charging Plaza',
      address: '75 Patroon Creek Blvd',
      city: 'Albany',
      latitude: '42.688400',
      longitude: '-73.817900',
      settings: PATROON_SETTINGS,
      // 480Y/277 V main switchboard: each DC fast charger (ABB Terra 184, 230 A
      // input) on its own 300 A breaker, and through a step-down transformer two
      // 225 A 208Y/120 V panelboards for the eight dual-port Level 2 pedestals,
      // four each. Each pedestal is one station with two ports on one 2-pole
      // 40 A circuit with power sharing: 32 A continuous shared by both ports,
      // one car up to 32 A, two cars sharing it. ChargePoint CT4000 datasheet
      // (October 2026), General Specifications, Electrical Input, dual port
      // "Standard Power Share": input current 32 A, "One 40 A branch circuit",
      // "40 A dual pole" breaker (without Power Share a dual-port station
      // needs two 40 A circuits). NFPA 70 (NEC) 2023, 625.42(A): with an
      // automatic load management system the maximum equipment load on a
      // service and feeder is the load the system permits; 625.42(B): adjusted
      // ratings with restricted access (read through EC&M, "NEC Requirements
      // for EV Equipment"). Load management holds each pedestal to its
      // circuit (32 A) and the station shares that limit between its ports.
      // Panel loading: four 32 A two-pole circuits on rotated phase pairs put
      // at most 3 x 32 = 96 A on a phase of a 225 A panelboard, 43 percent of
      // its rating and under the 80 percent continuous limit (180 A); eight
      // on one would put 192 A on a phase, past it. The panelboard nearer the
      // lot feeds the nearer half of the AC group (`PATROON_AC` runs from the
      // far end inward), so the feeder runs never cross.
      panels: [
        panelOf(
          'pnl_demolayout15',
          null,
          'Main Switchboard',
          1600,
          V480,
          PATROON_DC.map((n) => dcCircuit(n, TERRA_184_INPUT_AMPS)),
        ),
        panelOf(
          'pnl_demolayout16',
          'pnl_demolayout15',
          'Panelboard LP-1',
          225,
          V208,
          acCircuits(PATROON_AC.slice(4)),
        ),
        panelOf(
          'pnl_demolayout17',
          'pnl_demolayout15',
          'Panelboard LP-2',
          225,
          V208,
          acCircuits(PATROON_AC.slice(0, 4)),
        ),
      ],
      stations: [
        ...PATROON_DC.map((n, i) => {
          const spot = PATROON_DC_SPOTS[i] ?? { col: 0, row: 0 };
          return dc(n, spot.col, spot.row, evseCircuitId(n));
        }),
        ...PATROON_AC.map((n, i) => {
          const spot = PATROON_AC_SPOTS[i] ?? { col: 0, row: 0 };
          const single = PATROON_AC_SPOTS_SINGLE[i] ?? spot;
          return ac(n, spot.col, spot.row, evseCircuitId(n), {
            evses: PATROON_AC_PORTS,
            before: { col: single.col, row: single.row },
          });
        }),
      ],
    },
  ],
  /**
   * The fleet of Northgate Fleet Depot: transit buses, semi trucks and box
   * trucks, one vehicle per driver, in the colors such fleets run. The depot's
   * stations are the fleet's stations, so the simulator charges them with
   * these drivers' cards and the layout draws their vehicles.
   */
  fleet: {
    id: 'flt_demodepot01',
    name: 'Northgate Transit and Freight',
    description: 'Transit buses, semi trucks and box trucks charging at Northgate Fleet Depot',
    siteId: DEPOT,
    drivers: [
      depotDriver(1, 'Daniel', 'Reyes', {
        make: 'New Flyer',
        model: 'Xcelsior CHARGE NG',
        year: '2025',
        bodyType: 'bus',
        color: 'white',
      }),
      depotDriver(2, 'Grace', 'Okafor', {
        make: 'New Flyer',
        model: 'Xcelsior CHARGE NG',
        year: '2025',
        bodyType: 'bus',
        color: 'blue',
      }),
      depotDriver(3, 'Hector', 'Alvarez', {
        make: 'Gillig',
        model: 'Low Floor Battery Electric',
        year: '2024',
        bodyType: 'bus',
        color: 'green',
      }),
      depotDriver(4, 'Priya', 'Nair', {
        make: 'Gillig',
        model: 'Low Floor Battery Electric',
        year: '2024',
        bodyType: 'bus',
        color: 'yellow_orange',
      }),
      depotDriver(5, 'Samuel', 'Brooks', {
        make: 'New Flyer',
        model: 'Xcelsior CHARGE NG',
        year: '2023',
        bodyType: 'bus',
        color: 'red',
      }),
      depotDriver(6, 'Lena', 'Fischer', {
        make: 'Nova Bus',
        model: 'LFSe+',
        year: '2024',
        bodyType: 'bus',
        color: 'silver',
      }),
      depotDriver(7, 'Marcus', 'Hill', {
        make: 'Freightliner',
        model: 'eCascadia',
        year: '2025',
        bodyType: 'semi_truck',
        color: 'white',
      }),
      depotDriver(8, 'Elena', 'Petrova', {
        make: 'Volvo',
        model: 'VNR Electric',
        year: '2025',
        bodyType: 'semi_truck',
        color: 'blue',
      }),
      depotDriver(9, 'Tom', 'Becker', {
        make: 'Freightliner',
        model: 'eCascadia',
        year: '2024',
        bodyType: 'semi_truck',
        color: 'red',
      }),
      depotDriver(10, 'Aisha', 'Bello', {
        make: 'Tesla',
        model: 'Semi',
        year: '2025',
        bodyType: 'semi_truck',
        color: 'black',
      }),
      depotDriver(11, 'Kevin', 'Tran', {
        make: 'Freightliner',
        model: 'eM2',
        year: '2024',
        bodyType: 'box_truck',
        color: 'white',
      }),
      depotDriver(12, 'Rosa', 'Medina', {
        make: 'Freightliner',
        model: 'eM2',
        year: '2025',
        bodyType: 'box_truck',
        color: 'yellow_orange',
      }),
    ],
  },
  /** The demo maintenance event of Harbor Point (one station). */
  maintenanceEventId: 'mev_demolayout01',
  /** The open AI insight on the faulted station (seed-ai-insights.ts `seedStationFaultInsight`). */
  faultInsightId: 'ain_aidemo000020',
  /** Two more simulated card readers on DC chargers at Harbor Point: one online with a screen, one offline without. */
  // Card readers in whole groups. Demo choice: every DC fast charger of the
  // public demo sites (Harbor Point, Willow Creek, Patroon Creek) has a reader
  // of its own, paired to the whole dispenser; the Level 2 chargers and the
  // private fleet depot have none. The rules allow other designs:
  // - 23 CFR 680.106(f)(1) applies to chargers funded under Title 23 (NEVI and
  //   other publicly accessible chargers, any level, 680.100) unless charging
  //   is free: "a contactless payment method that accepts major debit and
  //   credit cards, and either an automated toll-free phone number or a short
  //   message/messaging system (SMS)". It does not require a reader built into
  //   each dispenser (eCFR, 23 CFR 680.106, read 2026-11-01).
  // - California (13 CCR 2360 and following): the payment hardware "must be
  //   installed on individual EVSE or kiosk" (CARB, EVSE Standards Regulation
  //   Background and FAQs,
  //   https://ww2.arb.ca.gov/resources/documents/electric-vehicle-supply-equipment-standards-regulation-background-and-faqs).
  terminals: [
    {
      providerDeviceId: 'sim_term_6',
      label: 'Hub DC Reader',
      vendor: 'ID TECH',
      model: 'VP6825',
      serialNumber: '6825SIM000006',
      firmwareVersion: '1.01.106',
      stationId: 'sta_demolayout06',
      // The whole dispenser: both EVSEs take card payment (an earlier plan
      // paired it to EVSE 2 only).
      evseNumber: null,
      evseBefore: 2,
      online: true,
    },
    {
      providerDeviceId: 'sim_term_7',
      label: 'Hub Lane Reader',
      vendor: 'ID TECH',
      model: 'VP7200',
      serialNumber: '7200SIM000007',
      firmwareVersion: '1.00.042',
      stationId: 'sta_demolayout14',
      evseNumber: null,
      online: false,
      pairedBefore: 'sta_demolayout11',
    },
    ...[1, 2, 3, 4, 5, 13, 15, 16, 21].map((n, i) => demoReader(8 + i, 'VP6825', n)),
    ...[34, 37, 41].map((n, i) => demoReader(17 + i, 'VP7200', n)),
    ...PATROON_DC.map((n, i) => demoReader(20 + i, 'VP6825', n)),
  ],
};

/**
 * The layout settings earlier plans seeded, by site, oldest first: a rerun
 * replaces stored settings only while they are still one of these (an
 * operator's edit stays). The spot and lane sizes the earlier plans also
 * stored are no settings any more (standard dimensions) and are left out:
 * comparing ignores them. Harbor Point's second entry is the plan before the
 * battery and the solar canopy, its last the solar carport over the middle
 * row; Willow Creek's the solar carport with its column line inside the head
 * of the pedestals' spots; Lakeside's second the plan before charger counts
 * and mountings (one row of 12 spots turned 90 degrees); Northgate's the
 * custom site it was before the Depot site type.
 */
export const LAYOUT_DEMO_PREVIOUS_SETTINGS: Readonly<Record<string, SiteLayoutSettings[]>> = {
  [HARBOR]: [
    {
      spotsPerRow: 10,
      rows: 2,
      facingDeg: 0,
      transformers: [
        { id: 'tx-1', name: 'Utility Transformer', ratedKva: 2500, x: 36, z: 2.8 },
        { id: 'tx-2', name: 'Solar Carport Tie-In', ratedKva: 750, x: 9.6, z: -6 },
      ],
    },
    {
      siteType: 'parking_lot',
      spotsPerRow: 6,
      rows: 2,
      facingDeg: 0,
      transformers: [
        { id: 'tx-1', name: 'Utility Transformer', ratedKva: 2500, x: -14, z: 2.5 },
        { id: 'tx-2', name: 'Solar Carport Tie-In', ratedKva: 750, x: -14, z: 16 },
      ],
    },
    // The 2 by 6 lot with the battery and the solar canopy, before Lot Edge.
    {
      siteType: 'parking_lot',
      spotsPerRow: 6,
      rows: 2,
      facingDeg: 0,
      transformers: [
        { id: 'tx-1', name: 'Utility Transformer', ratedKva: 2500, x: -14, z: 2.5 },
        { id: 'tx-2', name: 'Solar Carport Tie-In', ratedKva: 750, x: -14, z: 16 },
      ],
      energyAssets: [
        { id: 'bat-1', type: 'battery', name: 'Battery Storage', capacityKwh: 1000, x: 25, z: 4 },
        { id: 'pv-1', type: 'solar', name: 'Solar Carport', capacityKwp: 180, row: 1 },
      ],
    },
    // Lot Edge with the solar carport over the middle row, before it moved to the front edge row.
    HARBOR_SETTINGS_MIDDLE_CARPORT,
    // The equipment 14 m out on the grass, before the pad moved to the lot edge.
    HARBOR_SETTINGS_FAR_EQUIPMENT,
  ],
  // The transformer 5 m out, before it moved to the lot edge.
  [PATROON]: [PATROON_SETTINGS_FAR_TRANSFORMER],
  // The solar carport with its column line inside the head of the pedestals' spots.
  [WILLOW]: [
    willowSettings(-22),
    // The battery at the far end of the stations, before it moved onto the equipment pad.
    willowSettings(-23),
    // The battery beside a transformer far from the DC group, before both moved next to it.
    willowSettings(-23, { x: -25.5, z: -26 }),
  ],
  [LAKESIDE]: [
    {
      spotsPerRow: 6,
      rows: 3,
      facingDeg: 90,
      transformers: [{ id: 'tx-1', name: 'Lakeside Substation', ratedKva: 1500, x: 26.1, z: 4 }],
    },
    {
      siteType: 'office_retail',
      spotsPerRow: 12,
      rows: 1,
      facingDeg: 90,
      transformers: [],
    },
  ],
  [DEPOT]: [
    {
      siteType: 'custom',
      spotsPerRow: 8,
      rows: 1,
      facingDeg: 0,
      transformers: [{ id: 'tx-1', name: 'Depot Substation', ratedKva: 5000, x: -14, z: 8 }],
      energyAssets: [
        {
          id: 'bat-1',
          type: 'battery',
          name: 'Depot Battery Storage',
          capacityKwh: 2000,
          x: -14,
          z: 20,
        },
      ],
    },
    // The depot with one 5000 kVA substation, before an equipment pad per charger group.
    {
      ...DEPOT_SETTINGS_FAR_EQUIPMENT,
      transformers: [{ id: 'tx-1', name: 'Depot Substation', ratedKva: 5000, x: 8, z: -16 }],
    },
    // The truck transformer at 3000 kVA, before the 3750 kVA rating.
    {
      ...DEPOT_SETTINGS_FAR_EQUIPMENT,
      transformers: DEPOT_SETTINGS_FAR_EQUIPMENT.transformers.map((t) =>
        t.id === 'tx-2' ? { ...t, ratedKva: 3000 } : t,
      ),
    },
    // The equipment out on the grass, before each pad moved next to its group.
    DEPOT_SETTINGS_FAR_EQUIPMENT,
  ],
};
