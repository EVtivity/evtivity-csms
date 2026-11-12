// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The site layout demo as plain data (no database import), so the seed, its
// tests and the docs screenshot fixtures read one plan. Four sites, one per
// site type and charger mounting, as on real sites: Harbor Point Charging Hub,
// a parking lot (an outdoor hub of DC fast chargers, 2 rows of 6 spots, a
// transformer and a battery at the lot edge, a solar carport over the front row,
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
import type {
  FreePlacement,
  LayoutBay,
  LayoutEnergyAsset,
  LayoutPowerEquipment,
  SiteLayoutSettings,
} from '@evtivity/lib/site-layout';
import {
  PAD_MOUNT_TRANSFORMER_KVA,
  STEP_DOWN_TRANSFORMER_KVA,
  circuitConductorPhases,
  computeMaxContinuousKw,
  computeTransformerCapacityKw,
} from '@evtivity/lib/load-allocation';
import type { LoadAllocationStrategy } from '@evtivity/lib/load-allocation';
import type { VehicleBodyType, VehicleColor } from '@evtivity/lib/vehicle-appearance';
import { layoutEquipmentRowId } from './lib/layout-equipment-id.js';

/**
 * A service transformer of a demo site as the plan writes it: its row (name,
 * rating) and its layout position. `id` is the plan's layout id; the row's id
 * is `layoutEquipmentRowId('tfm', siteId, id)`, the id the v0.1.50 migration
 * gave the transformers an earlier plan stored in the layout settings.
 */
export interface DemoTransformer {
  id: string;
  name: string;
  ratedKva: number;
  x: number;
  z: number;
  /** The top-level panel (switchboard) it feeds (`panels.transformer_id`). */
  feeds?: string;
  /** The ratings earlier plans seeded: a rerun moves a row still at one of these to `ratedKva`. */
  ratedKvaBefore?: readonly number[];
}

/**
 * How a demo battery or solar canopy is wired and read (the
 * `site_energy_assets` columns the layout settings do not hold).
 */
export interface DemoAssetElectrical {
  /** AC nameplate of the inverter, kW (caps every credit). */
  inverterKw: number;
  /** Battery: the most it discharges and charges, kW. */
  maxDischargeKw?: number;
  maxChargeKw?: number;
  /**
   * Where it connects: supply-side at the service transformer (NEC 705.11,
   * the plan's layout id) or load-side on a panel (NEC 705.12).
   */
  connection: { transformer: string } | { panel: string };
  /**
   * `simulated` (shown live where ENERGY_ASSETS_ALLOW_SIMULATED is true,
   * `none` elsewhere), or `api` with an old reading so it reads Stale.
   */
  telemetry: 'simulated' | 'api';
  /** `api`: the age of the one reading the seed writes, minutes (past its TTL). */
  staleReadingMinutes?: number;
  /** `api`: the power of that reading, kW. */
  staleReadingKw?: number;
  /** The ratings earlier plans seeded (kWh or kWp): a rerun moves a row still at one of these. */
  ratingBefore?: readonly number[];
}

/** A demo battery or solar canopy: its layout entry and, in the current plan, its wiring. */
export type DemoEnergyAsset = LayoutEnergyAsset & { electrical?: DemoAssetElectrical };

/**
 * A step-down transformer of a demo site (480 V to 208Y/120 V, dry-type),
 * fed from a switchboard breaker and feeding one panelboard.
 */
export interface DemoStepDown {
  id: string;
  name: string;
  ratedKva: number;
  /** The switchboard it is fed from. */
  fedFromPanelId: string;
  /** The panelboard it feeds. */
  panelId: string;
}

/**
 * A demo site's layout settings with its power equipment as the plan writes
 * it (names and ratings with the positions). The seed writes the rows through
 * the load management writers and stores the positions by their table ids
 * (`demoLayoutPositions`). An energy asset's `id` is its layout id too
 * (`layoutEquipmentRowId('ena', ...)`).
 */
export interface DemoLayoutSettings extends Omit<
  SiteLayoutSettings,
  'transformers' | 'energyAssets'
> {
  transformers: DemoTransformer[];
  energyAssets?: DemoEnergyAsset[];
}

/**
 * The power equipment rows a demo plan writes (service transformers, then the
 * step-down units, at the default power factor and loading limit; energy
 * assets), as the layout reads them (`readLayoutPowerEquipment`).
 */
export function demoPowerEquipment(
  siteId: string,
  s: DemoLayoutSettings,
  stepDowns: readonly DemoStepDown[] = [],
): LayoutPowerEquipment {
  return {
    transformers: [
      ...s.transformers.map((t) => ({
        id: layoutEquipmentRowId('tfm', siteId, t.id),
        kind: 'service' as const,
        name: t.name,
        ratedKva: t.ratedKva,
        maxContinuousKw: computeTransformerCapacityKw(t.ratedKva, 0.95, 100),
      })),
      ...stepDowns.map((t) => ({
        id: t.id,
        kind: 'step_down' as const,
        name: t.name,
        ratedKva: t.ratedKva,
        maxContinuousKw: computeTransformerCapacityKw(t.ratedKva, 0.95, 100),
      })),
    ],
    energyAssets: (s.energyAssets ?? []).map((a) => ({
      id: layoutEquipmentRowId('ena', siteId, a.id),
      type: a.type,
      name: a.name,
      capacityKwh: a.type === 'battery' ? a.capacityKwh : null,
      peakKwp: a.type === 'solar' ? a.capacityKwp : null,
    })),
  };
}

/**
 * The layout settings a demo plan stores: each transformer and energy asset
 * by the id of its row with its position (a battery `x`, `z`; a canopy `row`,
 * and `x`, `z`, `rotationDeg` when it stands freely), the form the v0.1.50
 * migration wrote over the settings an earlier plan stored.
 */
export function demoLayoutPositions(siteId: string, s: DemoLayoutSettings): SiteLayoutSettings {
  return {
    ...s,
    transformers: s.transformers.map((t) => ({
      id: layoutEquipmentRowId('tfm', siteId, t.id),
      x: t.x,
      z: t.z,
    })),
    ...(s.energyAssets != null
      ? {
          energyAssets: s.energyAssets.map((a) => {
            const id = layoutEquipmentRowId('ena', siteId, a.id);
            if (a.type === 'battery') return { id, x: a.x, z: a.z };
            return {
              id,
              row: a.row,
              ...(a.x != null ? { x: a.x } : {}),
              ...(a.z != null ? { z: a.z } : {}),
              ...(a.rotationDeg != null ? { rotationDeg: a.rotationDeg } : {}),
            };
          }),
        }
      : {}),
  };
}

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
  /**
   * Connector powers an earlier plan seeded for this station: a rerun moves a
   * connector (and its simulator EVSE) still at one of them to `maxPowerKw`,
   * an operator's change stays.
   */
  maxPowerKwBefore?: readonly number[];
  /** The EVSEs of the station (default 2 for DC, 1 for AC). */
  evses?: number;
  /**
   * More connectors on every EVSE after the first (`connectorType`), as
   * connectors 2 and up: a dispenser with two cables per EVSE (one charges at
   * a time). At most `CHARGER_PORT_LIMITS` connectors per EVSE.
   */
  extraConnectorTypes?: readonly string[];
  /**
   * The key of the station's EVSE, connector and simulator row ids
   * (`evs_demolayout<key><e>`); default the last two characters of `id`.
   */
  rowKey?: string;
  /** The model name (default Terra 184 for DC, Pulsar Plus for AC). */
  model?: string;
  /** The OCPP protocol (default ocpp2.1). */
  ocppProtocol?: 'ocpp1.6' | 'ocpp2.1';
  /** The AC supply of every EVSE in the simulator (default one phase at 208 V, North America). */
  acSupply?: { phases: number; voltage: number };
  /**
   * The station's units (physical charger boxes, `station_units`), in their
   * order, each with its OCPP EVSE numbers: created through the unit writer
   * only while the station has none (`seedDemoStationUnitsOf`).
   */
  units?: ReadonlyArray<{ name: string; evseIds: readonly number[] }>;
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
  /** Default NY, 12207, US, America/New_York (the Albany demo sites). */
  state?: string | null;
  postalCode?: string;
  country?: string;
  timezone?: string;
  latitude: string;
  longitude: string;
  settings: DemoLayoutSettings;
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
  | 'maxPowerKwBefore'
  | 'message'
  | 'connectorType'
  | 'maxPowerKw'
  | 'evses'
  | 'extraConnectorTypes'
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

/** 400Y/230 V three-phase service (Germany), stored phase to neutral. */
const V230 = 230;

const LINDENHOF = 'sit_demogarage01';

/**
 * Parkhaus Lindenhof, a fictional parking garage in Freiburg (GitHub
 * discussion 59 setup): one OCPP 1.6 AC master with seven extenders behind
 * one Charge Point ID, 8 boxes "Box 1" to "Box 8" of 2 Type 2 EVSEs each
 * (22 kW for one point, 11 kW each for two), drawn as 8 dual-port AC
 * chargers in one run of 16 spots (`stationSpanCount`). One row of 18 spots:
 * the run and a free spot beside it for the accessible charging space.
 */
const LINDENHOF_SETTINGS: DemoLayoutSettings = {
  siteType: 'parking_lot',
  spotsPerRow: 18,
  rows: 2,
  facingDeg: 0,
  chargerPlacement: 'islands',
  // 225 kVA: 8 boxes at 400 V x 32 A three-phase = 22.2 kVA each, 177.4 kVA
  // connected (`serviceTransformerKva`, 79 percent). It feeds the main board.
  transformers: [
    {
      id: 'tx-1',
      name: 'Utility Transformer',
      ratedKva: 225,
      x: -2.5,
      z: 2.5,
      feeds: 'pnl_demogarage01',
    },
  ],
  energyAssets: [],
};

/** The 8 boxes of the Lindenhof master and extenders: Box n holds EVSEs 2n-1 and 2n. */
export const LINDENHOF_UNITS: ReadonlyArray<{ name: string; evseIds: readonly number[] }> =
  Array.from({ length: 8 }, (_, i) => ({
    name: `Box ${String(i + 1)}`,
    evseIds: [2 * i + 1, 2 * i + 2],
  }));

/** The box current, three-phase (each box on its own 32 A three-phase fuses, discussion 59). */
export const LINDENHOF_BOX_AMPS = 32;

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
// transformer: one dry-type unit per panelboard, fed from a switchboard
// breaker and linked to the panelboard (`panels.transformer_id`,
// `demoStepDowns`), drawn next to it on the layout. Every service transformer
// feeds its group's switchboard (`DemoTransformer.feeds`).
//
// Transformer sizing: the connected load is apparent power (a charger's input
// V x A, times sqrt(3) for three-phase, already kVA), compared directly with
// the nameplate kVA with no demand factor and no second divide by a power
// factor. SDG&E EV Charging Station Standards 2023 (Rev C, 07/21/2022),
// EV-3.10, sheet EV3.11: "There is no applicable demand factor to use on EVSE
// loads" and "For EVSE power factor is typically very close to 1 (>0.95). In
// this case kW and kVA are almost interchangeable",
// https://www.sdge.com/sites/default/files/EVSE2023v0120e%20%281%29.pdf.
// Load management turns the kVA into kW at the 0.95 default power factor.

/**
 * The largest 208 V overcurrent device each dry-type step-down rating takes,
 * A: SDG&E EV Charging Station Standards 2023, Table EV-11.10 (sheet
 * EV11.10): 75 kVA 250 A, 112.5 kVA 400 A, 150 kVA 500 A, 225 kVA 800 A,
 * 300 kVA 1000 A, 500 kVA 1600 A (the kVA list is `STEP_DOWN_TRANSFORMER_KVA`).
 */
export const STEP_DOWN_MAX_OCPD_AMPS: Readonly<
  Record<(typeof STEP_DOWN_TRANSFORMER_KVA)[number], number>
> = { 75: 250, 112.5: 400, 150: 500, 225: 800, 300: 1000, 500: 1600 };

/**
 * The step-down transformer of a 208Y/120 V panelboard: the smallest Table
 * EV-11.10 rating whose kVA is at least the panelboard's connected kVA and
 * whose largest 208 V overcurrent device is at least the panelboard's main
 * (a 225 A panelboard takes at least 75 kVA, a 400 A one 112.5 kVA). Throws
 * past 500 kVA.
 */
export function stepDownTransformerKva(loadKva: number, mainAmps: number): number {
  const found = STEP_DOWN_TRANSFORMER_KVA.find(
    (k) => k >= loadKva - 1e-9 && STEP_DOWN_MAX_OCPD_AMPS[k] >= mainAmps,
  );
  if (found == null) {
    throw new Error(
      `No step-down rating for ${String(loadKva)} kVA and a ${String(mainAmps)} A main`,
    );
  }
  return found;
}

/**
 * The service transformer of a group: the smallest IEEE C57.12.34 three-phase
 * pad-mount rating (`PAD_MOUNT_TRANSFORMER_KVA`) of at least the group's
 * connected kVA (SDG&E EV-3.10). Throws past the list.
 */
export function serviceTransformerKva(loadKva: number): number {
  const found = PAD_MOUNT_TRANSFORMER_KVA.find((k) => k >= loadKva - 1e-9);
  if (found == null) throw new Error(`No pad-mount rating for ${String(loadKva)} kVA`);
  return found;
}

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
 * (`TERRA_184_INPUT_AMPS`, `KEMPOWER_C502P200_INPUT_AMPS`,
 * `HVC_450PD_INPUT_AMPS`, `HVC_C_150_INPUT_AMPS`, `HVC360_INPUT_AMPS`).
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
/**
 * ABB HVC 450PD depot charging cabinet (the pantograph poles): 510 kVA input,
 * so 510,000 / (sqrt(3) x 480 V) = 613.4 A at 480 V three-phase (derived).
 * New Flyer Charger Catalog 2023, pp. 2 and 9,
 * https://www.newflyer.com/site-content/uploads/2023/01/Charger-Catalog-2023.pdf
 * (research 2026-11-03). Its breaker: 125 percent is 767 A, so 800 A.
 */
export const HVC_450PD_INPUT_KVA = 510;
export const HVC_450PD_INPUT_AMPS = (HVC_450PD_INPUT_KVA * 1000) / (Math.sqrt(3) * 480);
/**
 * ABB HVC-C 150 plug-in charging cabinet: 170 kVA input, so 204.5 A at 480 V
 * three-phase (derived; same catalog, p. 9). Its breaker: 125 percent is
 * 255.6 A, so 300 A (the 250 A of the 150 kW estimate is too small).
 */
export const HVC_C_150_INPUT_KVA = 170;
export const HVC_C_150_INPUT_AMPS = (HVC_C_150_INPUT_KVA * 1000) / (Math.sqrt(3) * 480);
/**
 * ABB HVC360 multi-outlet charging cabinet, North American version (the
 * cabinet of the depot's dual-outlet plug-in bus charger, CS-3046): "AC input
 * power HVC360: (NA): 391 kVA", "AC input current HVC360: (NA): 470 A" at the
 * 480 Vac nominal input, output "Configurable as 200 kW, 300 kW, or 360 kW"
 * shared between 1 to 4 outlets, power factor >= 0.98. ABB HVC360 Data Sheet
 * V2-3,
 * https://library.e.abb.com/public/ec2bc0ec97114f62806cda649cc72b44/HVC360_Datasheet_Public_V2-3_Global_EN.pdf
 * (read 2026-11-12). Its breaker: 125 percent of 470 A is 587.5 A, so 600 A
 * (NEC 2023 625.41, 240.6(A)).
 */
export const HVC360_INPUT_KVA = 391;
export const HVC360_INPUT_AMPS = 470;
/**
 * The most one outlet of the dual-outlet charge box draws from an HVC360
 * cabinet: "90 to 180 kW per vehicle" with the HVC360 (ABB "Depot charge box
 * dual outlet for HVC360 multi-outlet cabinet", 9AKK108468A6766). The two
 * outlets share the cabinet's 360 kW.
 */
export const HVC360_OUTLET_MAX_KW = 180;
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

/**
 * The step-down transformers of a demo site: one for each 208Y/120 V
 * panelboard under a 480Y/277 V switchboard, sized by
 * `stepDownTransformerKva` from the panelboard's connected kVA (each Level 2
 * circuit 208 V x 32 A = 6.66 kVA, a dual-port pedestal's one shared
 * circuit counted once) and its main. Ids are fixed per panelboard
 * (`layoutEquipmentRowId('tfm', site, 'sd-<panel id>')`), so a rerun finds them.
 */
export function demoStepDowns(site: Pick<LayoutDemoSite, 'id' | 'panels'>): DemoStepDown[] {
  const byId = new Map(site.panels.map((p) => [p.id, p]));
  return site.panels.flatMap((p) => {
    const parent = p.parentPanelId != null ? byId.get(p.parentPanelId) : undefined;
    if (parent == null || p.voltageV !== V208 || parent.voltageV !== V480) return [];
    const loadKva = round2((p.circuits.length * 208 * LEVEL_2_AMPS) / 1000);
    return [
      {
        id: layoutEquipmentRowId('tfm', site.id, `sd-${p.id}`),
        name: `Step-Down Transformer ${p.name.replace(/^Panelboard /, '')}`,
        ratedKva: stepDownTransformerKva(loadKva, p.breakerRatingAmps),
        fedFromPanelId: parent.id,
        panelId: p.id,
      },
    ];
  });
}

const acCircuits = (
  stations: readonly number[],
  reused: Record<number, LayoutDemoCircuit['renamedFrom']> = {},
) => stations.map((n, i) => acCircuit(n, i, reused[n]));

/**
 * Northgate Fleet Depot's layout with its equipment out on the grass, as an
 * earlier plan seeded it (2500 kVA bus and 3750 kVA truck transformers; the
 * current ratings are in `DEPOT_SETTINGS`).
 */
const DEPOT_SETTINGS_FAR_EQUIPMENT: DemoLayoutSettings = {
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
//
// The 5000 kVA of the depot's earlier single substation as two standard
// pad-mount units, one per charger group and switchboard: a single 5000 kVA
// unit at 480Y/277 V would carry 5,000,000 / (sqrt(3) x 480) = 6014 A, past
// a 4000 A switchboard, and the SMU three-phase pad-mount specification (Dec
// 2021, 1.1 and 2.1, citing IEEE C57.12.34) lists 45 to 3750 kVA for
// secondaries of 700 V or less. Ratings `serviceTransformerKva` of each
// group's connected kVA (SDG&E EV-3.10):
//   - Bus: 3 ABB HVC 450PD pantograph cabinets of 510 kVA input and one HVC-C
//     150 plug-in cabinet of 170 kVA (New Flyer Charger Catalog 2023, pp. 2
//     and 9, https://www.newflyer.com/site-content/uploads/2023/01/Charger-Catalog-2023.pdf),
//     and the dual-outlet charger's HVC360 cabinet of 391 kVA (ABB HVC360
//     Data Sheet V2-3, NA): 3 x 510 + 170 + 391 = 2091 kVA, so 2500 kVA (84
//     percent of nameplate; 2000 kVA before, when CS-3046 was an HVC-C 150).
//     The circuits carry the same inputs (`HVC_450PD_INPUT_AMPS`,
//     `HVC_C_150_INPUT_AMPS`, `HVC360_INPUT_AMPS`); the bus switchboard
//     carries 3 x 613.4 + 204.5 + 470 = 2514.7 A of its 4000 A, under the
//     3200 A of 80 percent.
//   - Truck: 2 x 1000 kW megawatt cabinets and a 240 kW one, no datasheet
//     input, so output over 0.96 efficiency and 0.96 power factor (derived):
//     2 x 1085.1 + 260.4 = 2431 kVA. 2500 kVA would run at 97 percent; 3000
//     kVA (81 percent) keeps headroom.
//
// Battery: 2000 kWh at 0.5C, 1000 kW discharge and charge, the 2-hour class
// of the Tesla Megapack 2 XL datasheet (Rev 1.5.1, 2023-02-10, Power and
// Energy table: 2-hour 1927 kW / 3854 kWh), its inverter at the datasheet's
// 1.25 kVA per kW (2400 kVA for 1927 kW): 1250 kW, taken as the AC nameplate
// at unity power factor (derived). Its simulated readings use the depot
// dispatch and the one generic efficiency and state of charge window of
// @evtivity/lib energy-asset-simulation (no per-asset value). Supply-side at the bus
// transformer (NEC 2023 705.11): the 1250 kW inverter is 1504 A at 480 V, and
// 125 percent of it (1879 A) is past the 800 A a 4000 A bus takes load-side
// under the 120 percent rule of 705.12(B)(3)(2) (derived).
/** Maple Street before its two-port curb post: four posts on each curb. */
const MAPLE_SETTINGS_BEFORE_PAIR: DemoLayoutSettings = {
  siteType: 'curbside',
  spotsPerRow: 10,
  rows: 2,
  facingDeg: 0,
  chargersLeft: 4,
  chargersRight: 4,
  transformers: [],
};
/** Maple Street: five charging spots on the left curb, the last two for its two-port post. */
const MAPLE_SETTINGS: DemoLayoutSettings = { ...MAPLE_SETTINGS_BEFORE_PAIR, chargersLeft: 5 };

const DEPOT_SETTINGS: DemoLayoutSettings = {
  ...DEPOT_SETTINGS_FAR_EQUIPMENT,
  transformers: [
    {
      id: 'tx-1',
      name: 'Bus Charging Transformer',
      ratedKva: 2500,
      x: 0,
      z: -6.1,
      feeds: 'pnl_demolayout08',
      // 2000 kVA while CS-3046 was an HVC-C 150 (the 2500 kVA of the plan
      // before that is the rating again).
      ratedKvaBefore: [2000],
    },
    {
      id: 'tx-2',
      name: 'Truck Charging Transformer',
      ratedKva: 3000,
      x: 68,
      z: -10.1,
      feeds: 'pnl_demolayout09',
      ratedKvaBefore: [3750],
    },
  ],
  energyAssets: [
    {
      id: 'bat-1',
      type: 'battery',
      name: 'Depot Battery Storage',
      capacityKwh: 2000,
      x: 5.5,
      z: -6.1,
      electrical: {
        inverterKw: 1250,
        maxDischargeKw: 1000,
        maxChargeKw: 1000,
        connection: { transformer: 'tx-1' },
        telemetry: 'simulated',
      },
    },
  ],
};

const HARBOR = 'sit_demolayout01';

/** Harbor Point's layout before the solar carport moved to the front edge row (over the middle row). */
const HARBOR_SETTINGS_MIDDLE_CARPORT: DemoLayoutSettings = {
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

/** Willow Creek's layout with its solar carport at `canopyZ`, as earlier plans seeded it (1000 kVA, 10 kWp). */
const willowSettings = (
  canopyZ: number,
  battery: { x: number; z: number } = { x: 30, z: -24 },
  transformer: { x: number; z: number } = { x: -30, z: -26 },
): DemoLayoutSettings => ({
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
 * Willow Creek's power equipment as the current plan rates and wires it:
 *   - Transformer 750 kVA, `serviceTransformerKva` of the connected load: 3
 *     ABB Terra 184 at sqrt(3) x 480 V x 230 A = 191.2 kVA each and 5 Level 2
 *     pedestals at 208 V x 32 A = 6.66 kVA each, 573.6 + 33.3 = 607 kVA (81
 *     percent of 750; 1000 kVA before). It feeds the main switchboard.
 *   - Battery 500 kWh at 0.5C, 250 kW, inverter 1.25 kVA per kW (Tesla
 *     Megapack 2 XL datasheet Rev 1.5.1, 2-hour) = 313 kW (derived). Supply-side
 *     at the transformer (NEC 2023 705.11): the 313 kW inverter is 376 A at
 *     480 V and 125 percent of it (471 A) is past the 240 A a 1200 A bus takes
 *     load-side under the 120 percent rule of 705.12(B)(3)(2) (derived).
 *   - Solar canopy over 3 stalls at 2.93 kWp a stall (the mean of the Six
 *     Flags Magic Mountain 2.87, MSU 2.70 and Disneyland Paris 3.22 kWp a
 *     space carports, derived): 8.8, so 9 kWp (10 before), with a 7.5 kW
 *     inverter at the 1.2 DC to AC ratio of the PVWatts API v8 default and LBNL
 *     Tracking the Sun 2024 (1.23 to 1.25), derived 9 / 1.2. Load-side on the
 *     main switchboard (7.5 kW is 9 A at 480 V). Telemetry `api` with an old
 *     reading, so the demo shows a stale feed: no credit, no load.
 */
function willowCurrent(base: DemoLayoutSettings): DemoLayoutSettings {
  return {
    ...base,
    transformers: base.transformers.map((t) => ({
      ...t,
      ratedKva: 750,
      feeds: 'pnl_demolayout07',
      ratedKvaBefore: [1000],
    })),
    energyAssets: (base.energyAssets ?? []).map((a) =>
      a.type === 'battery'
        ? {
            ...a,
            electrical: {
              inverterKw: 313,
              maxDischargeKw: 250,
              maxChargeKw: 250,
              connection: { transformer: 'tx-1' },
              telemetry: 'simulated' as const,
            },
          }
        : {
            ...a,
            capacityKwp: 9,
            electrical: {
              inverterKw: 7.5,
              connection: { panel: 'pnl_demolayout07' },
              telemetry: 'api' as const,
              staleReadingMinutes: 15,
              staleReadingKw: 6,
              ratingBefore: [10],
            },
          },
    ),
  };
}
/**
 * The transformer stands beside the DC group it feeds (the three DC
 * dispensers at the west end), and the battery on the same equipment pad
 * behind it, not alone at the far end of the stations, where it stood in the
 * way of the panelboard feeders (owner rule 2026-11-01: every equipment item
 * next to the group it feeds).
 */
const WILLOW_TRANSFORMER = { x: -26.5, z: -21 };
const WILLOW_SETTINGS = willowCurrent(
  willowSettings(-23, { x: -26.5, z: -25.5 }, WILLOW_TRANSFORMER),
);

/** Harbor Point's layout with its equipment 14 m out on the grass, before the pad moved to the lot edge. */
const HARBOR_SETTINGS_FAR_EQUIPMENT: DemoLayoutSettings = {
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
const HARBOR_SETTINGS_TIE_IN: DemoLayoutSettings = {
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
/**
 * Harbor Point's power equipment as the current plan rates and wires it:
 *   - Utility transformer 2500 kVA, `serviceTransformerKva` of 11 ABB Terra
 *     184 at sqrt(3) x 480 V x 230 A = 191.2 kVA each, 2103 kVA (84 percent).
 *     It feeds the main switchboard. The earlier 750 kVA "Solar Carport
 *     Tie-In" is gone: about 40 times the canopy's inverter, and a 480 V
 *     three-phase inverter connects without one (research note, no source).
 *   - Battery 1000 kWh at 0.5C, 500 kW (the 2-hour class of the Sungrow
 *     ST255CS-2H, 125 kW / 257 kWh, and of the Tesla Megapack 2 XL), inverter
 *     1.25 kVA per kW (Megapack 2 XL datasheet Rev 1.5.1) = 625 kW (derived).
 *     Supply-side at the transformer (NEC 2023 705.11): the 625 kW inverter
 *     is 752 A at 480 V, and 125 percent of it (940 A) is past the 800 A a
 *     4000 A bus with a 4000 A main takes load-side under the 120 percent
 *     rule of 705.12(B)(3)(2) (derived).
 *   - Solar canopy over the 12 stalls of the front row at 2.93 kWp a stall (the
 *     mean of the Six Flags Magic Mountain 2.87, MSU 2.70 (13,490 kWp,
 *     Inovateus, over 5,000 spaces, MSU Today, March 2018) and Disneyland Paris
 *     3.22 kWp a space carports, derived): 35.2, so 35 kWp (18 over the 6
 *     stalls before the DC pairs, 180 before that), with a 29 kW inverter at a
 *     1.2 DC to AC ratio (PVWatts API v8 default; LBNL Tracking the Sun 2024,
 *     1.23 to 1.25), derived 35 / 1.2. Load-side on the main switchboard: 29
 *     kW is 35 A at 480 V, 44 A at 125 percent, within the 800 A (derived).
 *   - Twelve spots a row (six before): every ABB Terra 184 dual outlet stands
 *     on the line between two spots and serves both (`sharesSpotPair`, owner
 *     decision 2026-11-09), six on the front edge row and five on the back.
 */
const HARBOR_SETTINGS_SIX_SPOTS: DemoLayoutSettings = {
  ...HARBOR_SETTINGS_MIDDLE_CARPORT,
  transformers: [
    {
      id: 'tx-1',
      name: 'Utility Transformer',
      ratedKva: 2500,
      x: -2.5,
      z: 2.5,
      feeds: 'pnl_demolayout01',
    },
  ],
  energyAssets: [
    {
      id: 'bat-1',
      type: 'battery',
      name: 'Battery Storage',
      capacityKwh: 1000,
      x: -7.5,
      z: -3.5,
      electrical: {
        inverterKw: 625,
        maxDischargeKw: 500,
        maxChargeKw: 500,
        connection: { transformer: 'tx-1' },
        telemetry: 'simulated',
      },
    },
    {
      id: 'pv-1',
      type: 'solar',
      name: 'Solar Carport',
      capacityKwp: 18,
      row: 0,
      electrical: {
        inverterKw: 15,
        connection: { panel: 'pnl_demolayout01' },
        telemetry: 'simulated',
        ratingBefore: [180],
      },
    },
  ],
};
const HARBOR_SETTINGS: DemoLayoutSettings = {
  ...HARBOR_SETTINGS_SIX_SPOTS,
  spotsPerRow: 12,
  energyAssets: (HARBOR_SETTINGS_SIX_SPOTS.energyAssets ?? []).map((a) =>
    a.id === 'pv-1' && a.electrical != null
      ? {
          ...a,
          capacityKwp: 35,
          electrical: { ...a.electrical, inverterKw: 29, ratingBefore: [180, 18] },
        }
      : a,
  ),
};
const LAKESIDE = 'sit_demolayout02';

/** The ports (EVSEs) of Lakeside Retail Park's two-port wall box, CS-3019. */
export const LAKESIDE_WALL_PAIR_PORTS = 2;
const RIVERSIDE = 'sit_demolayout03';
const MAPLE = 'sit_demolayout04';
const WILLOW = 'sit_demolayout05';
const DEPOT = 'sit_demolayout06';
const PATROON = 'sit_demolayout07';

/**
 * Patroon Creek Charging Plaza: a parking lot of 4 rows of 8 spots with the
 * chargers on islands (rows 1 and 2 back to back on one island), its
 * transformer on the grass left of the first row. Four dual-outlet DC fast
 * chargers take the eight spots of the first row next to the transformer,
 * two each, and eight dual-port
 * Level 2 pedestals the far rows (`freeSlotsFor`), each standing on the line
 * between two spots and serving both (`sharesSpotPair`, ChargePoint CPF50 Site Design
 * Guide: "two stations back to back centered on four spaces").
 */
const PATROON_SETTINGS: DemoLayoutSettings = {
  siteType: 'parking_lot',
  spotsPerRow: 8,
  rows: 4,
  facingDeg: 0,
  chargerPlacement: 'islands',
  // 1000 kVA, `serviceTransformerKva` of 4 ABB Terra 184 at 191.2 kVA and 8
  // dual-port Level 2 pedestals at 208 V x 32 A = 6.66 kVA: 764.8 + 53.3 =
  // 818 kVA (82 percent). It feeds the main switchboard.
  transformers: [
    {
      id: 'tx-1',
      name: 'Utility Transformer',
      ratedKva: 1000,
      x: -2.5,
      z: 2.5,
      feeds: 'pnl_demolayout15',
    },
  ],
  energyAssets: [],
};
/** Patroon Creek's layout before its transformer moved to the lot edge (5 m out). */
const PATROON_SETTINGS_FAR_TRANSFORMER: DemoLayoutSettings = {
  ...PATROON_SETTINGS,
  transformers: [{ id: 'tx-1', name: 'Utility Transformer', ratedKva: 1000, x: -5, z: 2.5 }],
};
const PATROON_DC: readonly number[] = [50, 51, 52, 53];
/**
 * The Patroon Creek DC dispensers drawn at the most cables one dispenser holds
 * (`CHARGER_PORT_LIMITS.dc`): two EVSEs with a CCS1 and a CHAdeMO cable each,
 * four in all, the four-cable arrangement of the Alpitronic HYC400UL (Product
 * Data Sheet V1-2: up to 4 outputs, CCS1, J3400 or CHAdeMO). The other two
 * keep one CCS1 cable per EVSE (ABB Terra 184 dual outlet).
 */
export const PATROON_DC_FOUR_CABLES: readonly number[] = [50, 51];
const PATROON_AC: readonly number[] = [54, 55, 56, 57, 58, 59, 60, 61];
/** The ports (EVSEs) of each Patroon Creek Level 2 pedestal. */
export const PATROON_AC_PORTS = 2;
/**
 * The DC dispensers on the line between two spots each, serving both
 * (`sharesSpotPair`, owner decision 2026-11-09): the whole first row, next to
 * the transformer, so the island of rows 1 and 2 holds only the AC group and
 * its panelboards stand at its row end nearest the pad.
 */
const PATROON_DC_SPOTS: readonly LayoutBay[] = [0, 2, 4, 6].map((col) => ({ col, row: 0 }));
/**
 * The dual-port pedestals from the far end (`freeSlotsFor`): the last row,
 * three pairs of the third and one at the far end of the second, whose
 * neighbor spot is the access aisle of the accessible charging space.
 */
const PATROON_AC_SPOTS: readonly LayoutBay[] = freeSlotsFor(
  PATROON_AC.map(() => ({ charging: 'ac' as const, depot: null, ports: PATROON_AC_PORTS })),
  PATROON_DC_SPOTS.map((b) => ({ ...bayToPosition(b), charging: 'dc' as const, pair: true })),
  PATROON_SETTINGS,
).map(positionToBay);
/** Where the plan before the DC pairs stood the DC dispensers: one spot each, nearest the transformer. */
const PATROON_DC_SPOTS_SINGLE: readonly LayoutBay[] = groupedSpotOrder(
  PATROON_SETTINGS,
  'dc',
).slice(0, PATROON_DC.length);
/** Where the plan before the DC pairs stood the dual-port pedestals: after the single-spot DC group. */
const PATROON_AC_SPOTS_BEFORE_DC_PAIRS: readonly LayoutBay[] = freeSlotsFor(
  PATROON_AC.map(() => ({ charging: 'ac' as const, depot: null, ports: PATROON_AC_PORTS })),
  PATROON_DC_SPOTS_SINGLE.map((b) => ({ ...bayToPosition(b), charging: 'dc' as const })),
  PATROON_SETTINGS,
).map(positionToBay);

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
    /** Usable battery size in kWh. */
    batteryCapacityKwh: number;
    /** The most power the vehicle accepts, in kW. */
    maxChargePowerKw: number;
  };
  /** The vehicle's weekly departure from the depot (local time of the site). */
  departure: LayoutDemoDeparture;
}

/** A weekly departure of a depot vehicle: days, time, energy for the route and priority. */
export interface LayoutDemoDeparture {
  /** ISO days, 1 (Monday) to 7 (Sunday). */
  daysOfWeek: number[];
  /** HH:MM, local time of the depot. */
  departureTime: string;
  targetEnergyKwh: number;
  /** The targets earlier plans seeded: a rerun moves a schedule still at one of these to `targetEnergyKwh`. */
  targetEnergyKwhBefore?: readonly number[];
  /** 1 lowest to 10 highest. */
  priority: number;
}

/**
 * Battery size and accepted power of each depot body type, typical of the
 * demo models. Bus: 550 kWh, a New Flyer Xcelsior CHARGE NG 40 ft option
 * (440, 550 or 660 kWh; specs page, https://www.newflyer.com/bus/xcelsior-charge-ng/specs/),
 * charging up to 450 kW through its roof pantograph (SAE J3105-A, New Flyer
 * brochure 2023, p. 2). 525 kWh before, no product option.
 */
export const DEPOT_BODY_TYPE_BATTERY: Readonly<
  Partial<Record<VehicleBodyType, { batteryCapacityKwh: number; maxChargePowerKw: number }>>
> = {
  bus: { batteryCapacityKwh: 550, maxChargePowerKw: 450 },
  semi_truck: { batteryCapacityKwh: 565, maxChargePowerKw: 750 },
  box_truck: { batteryCapacityKwh: 291, maxChargePowerKw: 180 },
};

/** Battery sizes earlier demo plans seeded, by body type: a rerun moves a vehicle still at one of these. */
export const DEPOT_BODY_TYPE_BATTERY_BEFORE: Readonly<Partial<Record<VehicleBodyType, number[]>>> =
  {
    bus: [525],
  };

const WEEKDAYS = [1, 2, 3, 4, 5];
/**
 * A bus's energy for its day, kWh: 180, inside what evaluated US transit
 * fleets use a day: Foothill Transit 1.90 kWh/mi over 3022 mi a month, about
 * 99 mi and 189 kWh a day (NREL/TP-5400-80022, June 2021, Table ES-2, p. viii,
 * daily figures derived); King County Metro 2.36 kWh/mi, 76 mi, 179 kWh (FTA
 * Report 0118, Feb 2018, Table ES-1); Duluth 85 kWh (NREL/TP-5400-83038, Sep
 * 2022, Table ES-1, p. v). 330 kWh before (about 174 mi at 1.9 kWh/mi, past
 * every evaluated fleet, derived).
 */
const EARLY_BUS: LayoutDemoDeparture = {
  daysOfWeek: WEEKDAYS,
  departureTime: '05:30',
  targetEnergyKwh: 180,
  targetEnergyKwhBefore: [330],
  priority: 6,
};
const LATE_BUS: LayoutDemoDeparture = { ...EARLY_BUS, departureTime: '06:15' };
const SEMI: LayoutDemoDeparture = {
  daysOfWeek: WEEKDAYS,
  departureTime: '04:00',
  targetEnergyKwh: 420,
  priority: 5,
};
const BOX_TRUCK: LayoutDemoDeparture = {
  daysOfWeek: WEEKDAYS,
  departureTime: '07:00',
  targetEnergyKwh: 200,
  priority: 4,
};

/** The fleet of the depot: its drivers charge only at the depot's stations (fleet_stations). */
export interface LayoutDemoFleet {
  id: string;
  name: string;
  description: string;
  siteId: string;
  /** The load management strategy of the depot: the planner charges each vehicle for its departure. */
  loadStrategy: LoadAllocationStrategy;
  drivers: LayoutDemoFleetDriver[];
}

const depotDriver = (
  n: number,
  firstName: string,
  lastName: string,
  vehicle: Omit<
    LayoutDemoFleetDriver['vehicle'],
    'id' | 'licensePlate' | 'batteryCapacityKwh' | 'maxChargePowerKw'
  > &
    Partial<Pick<LayoutDemoFleetDriver['vehicle'], 'maxChargePowerKw'>>,
  departure: LayoutDemoDeparture,
): LayoutDemoFleetDriver => {
  const nn = String(n).padStart(2, '0');
  // Ids keep 12 characters after the prefix, the format the detail routes accept.
  const nnn = String(n).padStart(3, '0');
  const battery = DEPOT_BODY_TYPE_BATTERY[vehicle.bodyType];
  if (battery == null) throw new Error(`No depot battery data for ${vehicle.bodyType}`);
  return {
    id: `drv_demodepot${nnn}`,
    firstName,
    lastName,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@northgate-fleet.example`,
    idToken: `RFID-DEPOT-${nn}`,
    vehicle: {
      id: `veh_demodepot${nnn}`,
      licensePlate: `NGF-${String(100 + n)}`,
      ...battery,
      ...vehicle,
    },
    departure,
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
        dc(2, 2, 0, 'cir_demolayout01', { cellular: true }),
        dc(3, 4, 0, 'cir_demolayout01'),
        dc(4, 6, 0, 'cir_demolayout01', { maintenance: true }),
        dc(5, 8, 0, 'cir_demolayout01'),
        dc(6, 10, 0, 'cir_demolayout01'),
        dc(13, 2, 2, 'cir_demolayout02', {
          movedFrom: { siteId: LAKESIDE, circuitId: 'cir_demolayout03' },
        }),
        dc(14, 4, 2, 'cir_demolayout02', {
          movedFrom: { siteId: LAKESIDE, circuitId: 'cir_demolayout03' },
        }),
        dc(15, 6, 2, 'cir_demolayout02', {
          movedFrom: { siteId: LAKESIDE, circuitId: 'cir_demolayout03' },
        }),
        dc(16, 8, 2, 'cir_demolayout02', {
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
        // A two-port wall box on the line between spots 8 and 9, one car per
        // port (owner decision 2026-11-10), so the demo shows a two-port wall
        // pair: one station with two EVSEs on its one 2-pole 40 A circuit with
        // power sharing, 32 A continuous shared by both ports (ChargePoint
        // CT4000 data sheet, dual port "Standard Power Share": "One 40 A
        // branch circuit"; the family's dual-port wall mounts CT4023 and
        // CT4027), so panel LP-2 keeps its loading. The box after it moves
        // from spot 9 to spot 10, keeping the run continuous.
        ac(19, 8, 0, 'cir_demolayout04', { evses: LAKESIDE_WALL_PAIR_PORTS }),
        ac(20, 10, 0, 'cir_demolayout04', { before: { col: 9, row: 0 } }),
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
      settings: MAPLE_SETTINGS,
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
        // A two-port curb post on the line between spots 3 and 4, a car per port
        // (owner decision 2026-11-12, `TWO_PORT_CURB_POST`), on one 2-pole 40 A
        // circuit with power sharing like the dual-port pedestals (CT4000).
        ac(29, 3, 0, 'cir_demolayout06', { evses: 2 }),
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
      // Six bus bays (the dual-outlet dispenser holds the last two) and three truck lanes. One equipment pad per
      // charger group, as large depots build them: the bus transformer and the
      // battery on the grass behind the bus bays, the truck transformer beside
      // the truck lanes. Each transformer feeds its group's switchboard.
      settings: DEPOT_SETTINGS,
      // DC only. Each charger group's transformer feeds its own 480Y/277 V
      // switchboard (bus and truck), each power cabinet on its own
      // breaker, sized from the cabinet input of its datasheet (HVC 450PD
      // 613 A on 800 A, HVC-C 150 204.5 A on 300 A, 250 A before; the
      // dual-outlet charger's HVC360 470 A on 600 A, 300 A before),
      // 1 MW megawatt cabinets on 2000 A, the 240 kW box truck cabinet on 400 A.
      panels: [
        panelOf(
          'pnl_demolayout08',
          null,
          'Bus Charging Switchboard',
          4000,
          V480,
          [
            dcCircuit(42, HVC_450PD_INPUT_AMPS, [
              { name: 'Bus Pantograph Circuit', panelId: 'pnl_demolayout08', amps: 2000 },
            ]),
            dcCircuit(43, HVC_450PD_INPUT_AMPS),
            dcCircuit(44, HVC_450PD_INPUT_AMPS),
            // The plug-in cabinets were seeded on 250 A from the 150 kW estimate.
            dcCircuit(45, HVC_C_150_INPUT_AMPS, [
              { name: 'Bus Plug-In Circuit', panelId: 'pnl_demolayout08', amps: 800 },
              { name: 'Charger CS-3045', panelId: 'pnl_demolayout08', amps: 250 },
            ]),
            // The dual-outlet charger's HVC360 cabinet (360 kW shared by its two
            // outlets): seeded on 250 A, then on the 300 A of an HVC-C 150.
            dcCircuit(46, HVC360_INPUT_AMPS, [
              { name: 'Charger CS-3046', panelId: 'pnl_demolayout08', amps: 250 },
              { name: 'Charger CS-3046', panelId: 'pnl_demolayout08', amps: 300 },
            ]),
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
      // The bus bays (row 0): three depot pantograph poles, one bay each, a
      // one-outlet plug-in dispenser in bay 3 and a dual-outlet plug-in
      // dispenser between bays 4 and 5, a bus per outlet (owner decision
      // 2026-11-12, `DUAL_OUTLET_BUS_CHARGER`). The truck lanes (row 1): two
      // megawatt dispensers and a box truck dispenser, one lane each. A depot
      // seeded before keeps CS-3045's second EVSE (the seed only adds rows);
      // its next bay is CS-3046's, so it serves its own bay.
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
          evses: 1,
        }),
        // Up to 180 kW per outlet, the two sharing the cabinet's 360 kW.
        dc(46, 4, 0, 'cir_demolayout10', {
          connectorType: 'CCS1',
          maxPowerKw: HVC360_OUTLET_MAX_KW,
          maxPowerKwBefore: [150],
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
          const single = PATROON_DC_SPOTS_SINGLE[i] ?? spot;
          return dc(n, spot.col, spot.row, evseCircuitId(n), {
            ...(PATROON_DC_FOUR_CABLES.includes(n) ? { extraConnectorTypes: ['CHAdeMO'] } : {}),
            before: { col: single.col, row: single.row },
          });
        }),
        ...PATROON_AC.map((n, i) => {
          const spot = PATROON_AC_SPOTS[i] ?? { col: 0, row: 0 };
          const earlier = PATROON_AC_SPOTS_BEFORE_DC_PAIRS[i] ?? spot;
          return ac(n, spot.col, spot.row, evseCircuitId(n), {
            evses: PATROON_AC_PORTS,
            before: { col: earlier.col, row: earlier.row },
          });
        }),
      ],
    },
    {
      id: LINDENHOF,
      name: 'Parkhaus Lindenhof',
      address: 'Lindenhofstraße 12',
      city: 'Freiburg im Breisgau',
      state: null,
      postalCode: '79098',
      country: 'DE',
      timezone: 'Europe/Berlin',
      latitude: '47.995900',
      longitude: '7.852200',
      settings: LINDENHOF_SETTINGS,
      // 400Y/230 V service. Load management stays per station (owner decision
      // O1 A), and a station hangs on one circuit, so the station is on one
      // feeder circuit sized for its 8 boxes: 8 x 32 A = 256 A continuous, at
      // 125 percent 320 A, the next standard breaker 350 A (NFPA 70 2023,
      // 625.41, 240.6(A); `evseBreakerAmps`). Each box's own 32 A three-phase
      // fuses sit in the master and extender wiring the station meters and
      // shares; they are not load management circuits (a circuit holds
      // stations, and a unit holds no circuit before per-unit circuits,
      // Phase G). Main board 400 A: 256 A continuous is 64 percent, under the
      // 80 percent limit (NEC 215.2(A)(1), 215.3).
      panels: [
        panelOf('pnl_demogarage01', null, 'Main Distribution Board', 400, V230, [
          {
            id: 'cir_demogarage01',
            name: 'EM4-MASTER-01 Boxes 1 to 8',
            breakerRatingAmps: evseBreakerAmps(8 * LINDENHOF_BOX_AMPS),
            maxContinuousKw: round2(
              computeMaxContinuousKw(evseBreakerAmps(8 * LINDENHOF_BOX_AMPS), V230, 3),
            ),
            phaseConnections: null,
          },
        ]),
      ],
      stations: [
        {
          id: 'sta_demounits001',
          stationId: 'EM4-MASTER-01',
          kind: 'ac',
          col: 0,
          row: 0,
          circuitId: 'cir_demogarage01',
          rowKey: 'u1',
          model: 'AC Master Extenders',
          ocppProtocol: 'ocpp1.6',
          evses: 16,
          connectorType: 'Type2',
          maxPowerKw: 22,
          acSupply: { phases: 3, voltage: 230 },
          units: LINDENHOF_UNITS,
        },
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
    id: 'flt_demodepot001',
    name: 'Northgate Transit and Freight',
    description: 'Transit buses, semi trucks and box trucks charging at Northgate Fleet Depot',
    siteId: DEPOT,
    loadStrategy: 'departure_aware',
    drivers: [
      depotDriver(
        1,
        'Daniel',
        'Reyes',
        {
          make: 'New Flyer',
          model: 'Xcelsior CHARGE NG',
          year: '2025',
          bodyType: 'bus',
          color: 'white',
        },
        EARLY_BUS,
      ),
      depotDriver(
        2,
        'Grace',
        'Okafor',
        {
          make: 'New Flyer',
          model: 'Xcelsior CHARGE NG',
          year: '2025',
          bodyType: 'bus',
          color: 'blue',
        },
        EARLY_BUS,
      ),
      depotDriver(
        3,
        'Hector',
        'Alvarez',
        {
          make: 'Gillig',
          model: 'Low Floor Battery Electric',
          year: '2024',
          bodyType: 'bus',
          color: 'green',
        },
        EARLY_BUS,
      ),
      depotDriver(
        4,
        'Priya',
        'Nair',
        {
          make: 'Gillig',
          model: 'Low Floor Battery Electric',
          year: '2024',
          bodyType: 'bus',
          color: 'yellow_orange',
        },
        LATE_BUS,
      ),
      depotDriver(
        5,
        'Samuel',
        'Brooks',
        {
          make: 'New Flyer',
          model: 'Xcelsior CHARGE NG',
          year: '2023',
          bodyType: 'bus',
          color: 'red',
          // An older bus that accepts 125 kW and runs the longest route, 189 kWh
          // (the highest daily energy of the evaluated fleets, Foothill Transit,
          // NREL/TP-5400-80022; 470 kWh before, past every fleet): the tight
          // schedule of the demo, about 2 hours at its own maximum with the
          // buffer, At Risk once it is not plugged in by about 04:15.
          maxChargePowerKw: 125,
        },
        { ...LATE_BUS, targetEnergyKwh: 189, targetEnergyKwhBefore: [470] },
      ),
      depotDriver(
        6,
        'Lena',
        'Fischer',
        {
          make: 'Nova Bus',
          model: 'LFSe+',
          year: '2024',
          bodyType: 'bus',
          color: 'silver',
        },
        LATE_BUS,
      ),
      depotDriver(
        7,
        'Marcus',
        'Hill',
        {
          make: 'Freightliner',
          model: 'eCascadia',
          year: '2025',
          bodyType: 'semi_truck',
          color: 'white',
        },
        SEMI,
      ),
      depotDriver(
        8,
        'Elena',
        'Petrova',
        {
          make: 'Volvo',
          model: 'VNR Electric',
          year: '2025',
          bodyType: 'semi_truck',
          color: 'blue',
        },
        SEMI,
      ),
      depotDriver(
        9,
        'Tom',
        'Becker',
        {
          make: 'Freightliner',
          model: 'eCascadia',
          year: '2024',
          bodyType: 'semi_truck',
          color: 'red',
        },
        SEMI,
      ),
      depotDriver(
        10,
        'Aisha',
        'Bello',
        {
          make: 'Tesla',
          model: 'Semi',
          year: '2025',
          bodyType: 'semi_truck',
          color: 'black',
        },
        SEMI,
      ),
      depotDriver(
        11,
        'Kevin',
        'Tran',
        {
          make: 'Freightliner',
          model: 'eM2',
          year: '2024',
          bodyType: 'box_truck',
          color: 'white',
        },
        BOX_TRUCK,
      ),
      depotDriver(
        12,
        'Rosa',
        'Medina',
        {
          make: 'Freightliner',
          model: 'eM2',
          year: '2025',
          bodyType: 'box_truck',
          color: 'yellow_orange',
        },
        BOX_TRUCK,
      ),
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
export const LAYOUT_DEMO_PREVIOUS_SETTINGS: Readonly<Record<string, DemoLayoutSettings[]>> = {
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
    // The pad at the lot edge with the 750 kVA solar carport tie-in transformer.
    HARBOR_SETTINGS_TIE_IN,
    // Six spots a row, each DC dispenser in one spot, before the DC pairs.
    HARBOR_SETTINGS_SIX_SPOTS,
  ],
  // The transformer 5 m out, before it moved to the lot edge.
  [PATROON]: [PATROON_SETTINGS_FAR_TRANSFORMER],
  [MAPLE]: [MAPLE_SETTINGS_BEFORE_PAIR],
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
