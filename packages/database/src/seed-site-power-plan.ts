// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The electrical setup of a demo site sized as an engineer would size it
// (owner decision 2026-11-01: every site has enough power equipment for its
// connected load), as plain data so the seed and its tests read one plan. No
// database import.
//
// - Connected load from the stations' rated power at full nameplate (NFPA 70
//   (NEC) 2023, 625.41 and Article 220): a DC charger's input current
//   (`dcInputAmps`), an AC Level 2 port's current at 208 V. No demand factor:
//   NEC 625.42 lets EVSE under an energy management system be sized at the
//   managed setting, but a demo site's load management can be switched off,
//   so the plan sizes for every charger at once.
// - One utility transformer and one 480Y/277 V main switchboard per group of
//   nearby stations: each DC charger on its own switchboard breaker, AC Level 2
//   chargers each on their own 2-pole 208 V circuit (NEC 625.40) of a
//   208Y/120 V panelboard fed from the switchboard. Breakers at 125 percent
//   of the continuous load (NEC 625.41, 210.19, 210.20, 240.6(A) standard
//   ratings, `evseBreakerAmps`).
// - No panelboard or switchboard loaded past 80 percent of its rating (its
//   supply is a feeder, NEC 215.2(A)(1) and 215.3, `computeMaxContinuousKw`),
//   no panelboard past its 42 spaces (a 2-pole breaker takes two), no
//   transformer past its rating.
// - Each group's service transformer: the smallest IEEE C57.12.34
//   three-phase pad-mount rating (`PAD_MOUNT_TRANSFORMER_KVA`) of at least
//   the group's connected load. The load is apparent power (input V x A, x
//   sqrt(3) for three-phase), so it is compared with the kVA directly, with
//   no demand factor and no second divide by a power factor (SDG&E EV
//   Charging Station Standards 2023, EV-3.10, sheet EV3.11;
//   `serviceTransformerKva` in seed-demo-layout-plan.ts). It feeds the
//   group's switchboard (`panels.transformer_id`).
// - Each 208Y/120 V panelboard under the 480Y/277 V switchboard is fed
//   through its own dry-type step-down transformer: the smallest SDG&E Table
//   EV-11.10 rating whose kVA covers the panelboard's connected load and
//   whose largest 208 V overcurrent device covers its main
//   (`stepDownTransformerKva`): 75 kVA for a 225 A panelboard, 112.5 or 150
//   kVA for a 400 A one.

import { circuitConductorPhases, computeMaxContinuousKw } from '@evtivity/lib/load-allocation';
import {
  KEMPOWER_C502P200_FUSE_AMPS,
  KEMPOWER_C502P200_INPUT_AMPS,
  TERRA_184_BREAKER_AMPS,
  TERRA_184_INPUT_AMPS,
  dcInputAmps,
  evseBreakerAmps,
  serviceTransformerKva,
  stepDownTransformerKva,
} from './seed-demo-layout-plan.js';

/**
 * Main breaker ratings of a group's 480Y/277 V switchboard: the standard
 * ratings of NEC 2023 240.6(A) from 800 A to 4000 A. A group holds no more
 * than a 4000 A main carries continuously (80 percent, 2660 kVA); a larger
 * site splits into more groups. The 4000 A ceiling per group is a design
 * choice of the demo (no source), so every group stays one transformer and
 * one switchboard next to the stations it feeds.
 */
export const SWITCHBOARD_MAIN_AMPS = [800, 1000, 1200, 1600, 2000, 2500, 3000, 4000] as const;

/**
 * AC panelboard sizes of the plan: 225 A or 400 A, 42 spaces, 208Y/120 V
 * three-phase (owner decision 2026-11-01; the NEMA 3R 225 A 42-space
 * panelboard of the Schneider Electric NQ442L2C data sheet is the 225 A one,
 * https://cdn.shopify.com/s/files/1/0571/5899/2039/files/NQ442L2C_document.pdf).
 */
export const PANELBOARD_AMPS = [225, 400] as const;
export const PANELBOARD_SPACES = 42;

/** 480Y/277 V and 208Y/120 V three-phase services, stored phase to neutral. */
export const V480 = 277;
export const V208 = 120;

const SQRT3 = Math.sqrt(3);
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** The most a group carries: the continuous capacity of a 4000 A 480Y/277 V switchboard, in kW. */
export const GROUP_MAX_KW = computeMaxContinuousKw(4000, V480, 3);

/** The most transformers (groups) a site layout holds. */
export const MAX_GROUPS = 10;

/**
 * The datasheet input of the base seed's DC models that publish one, by
 * station model (`STATION_MODELS` in seed-station-defs.ts): input current at
 * 480 V and the breaker or fuse the datasheet gives. Every other DC model is
 * sized by `dcInputAmps` (0.96 efficiency and 0.96 power factor, no datasheet
 * value per model).
 */
export const DC_DATASHEET_INPUTS: Readonly<
  Record<string, { inputAmps: number; breakerAmps: number }>
> = {
  'Terra 184': { inputAmps: TERRA_184_INPUT_AMPS, breakerAmps: TERRA_184_BREAKER_AMPS },
  'C-Series Satellites': {
    inputAmps: KEMPOWER_C502P200_INPUT_AMPS,
    breakerAmps: KEMPOWER_C502P200_FUSE_AMPS,
  },
};

/**
 * A dual-port AC pedestal's one circuit: 32 A continuous shared by both ports
 * on one 2-pole 40 A branch circuit with power sharing (owner rule
 * 2026-11-01). ChargePoint CT4000 datasheet, General Specifications,
 * Electrical Input, dual port "Standard Power Share": input current 32 A,
 * "One 40 A branch circuit", "40 A dual pole" breaker; NFPA 70 (NEC) 2023,
 * 625.42(A): with load management the load is the one the system permits.
 */
export const DUAL_PORT_SHARED_AMPS = 32;

/** A station as the plan sizes it. */
export interface PowerStation {
  id: string;
  /** DC fast charger or AC Level 2. */
  kind: 'ac' | 'dc';
  /** DC: the station model, for its datasheet input (`DC_DATASHEET_INPUTS`). */
  model?: string | null | undefined;
  /** DC: the station's rated output, kW (shared by its outlets). */
  kw: number;
  /** AC: the ports (EVSEs) and each port's current at 208 V, A. */
  ports: number;
  portAmps: number;
  /** Where its spot is, in lot meters (groups gather nearby stations). */
  spot: { x: number; z: number };
}

export interface PlannedCircuit {
  stationId: string;
  breakerAmps: number;
  /** The circuit's stored capacity (80 percent of its breaker), kW. */
  maxContinuousKw: number;
  /** The connected load the charger draws: input V x A, apparent power in kVA. */
  loadKw: number;
  /** A 2-pole 208 V circuit's phase pair; null for a 3-phase DC breaker. */
  phaseConnections: string | null;
}

export interface PlannedPanelboard {
  amps: (typeof PANELBOARD_AMPS)[number];
  maxContinuousKw: number;
  circuits: PlannedCircuit[];
  /** Connected load, kVA. */
  loadKw: number;
  spaces: number;
  /** The step-down transformer that feeds it from the 480Y/277 V switchboard, kVA. */
  stepDownKva: number;
}

export interface PlannedGroup {
  transformerKva: number;
  switchboardAmps: number;
  switchboardMaxContinuousKw: number;
  dc: PlannedCircuit[];
  panelboards: PlannedPanelboard[];
  /** Connected load of the group, kVA. */
  loadKw: number;
  stationIds: string[];
}

const PHASE_PAIRS = ['L1L2', 'L2L3', 'L1L3'] as const;

/**
 * A DC charger's own switchboard breaker: its input at 480 V three-phase, the
 * datasheet values for a model that publishes them (`DC_DATASHEET_INPUTS`).
 */
export function plannedDcCircuit(station: PowerStation): PlannedCircuit {
  const datasheet = station.model != null ? DC_DATASHEET_INPUTS[station.model] : undefined;
  const inputAmps = datasheet?.inputAmps ?? dcInputAmps(station.kw);
  const breakerAmps = datasheet?.breakerAmps ?? evseBreakerAmps(inputAmps);
  return {
    stationId: station.id,
    breakerAmps,
    maxContinuousKw: round2(computeMaxContinuousKw(breakerAmps, V480, 3)),
    loadKw: round2((SQRT3 * 480 * inputAmps) / 1000),
    phaseConnections: null,
  };
}

/**
 * An AC charger's own 2-pole 208 V circuit: a single-port charger at its
 * port's current, a dual-port pedestal on one 40 A circuit with power
 * sharing, 32 A shared by its ports (`DUAL_PORT_SHARED_AMPS`).
 */
export function plannedAcCircuit(station: PowerStation, index: number): PlannedCircuit {
  const amps = station.ports >= 2 ? DUAL_PORT_SHARED_AMPS : station.portAmps;
  const breakerAmps = evseBreakerAmps(amps);
  const phaseConnections = PHASE_PAIRS[index % PHASE_PAIRS.length] ?? 'L1L2';
  return {
    stationId: station.id,
    breakerAmps,
    maxContinuousKw: round2(
      computeMaxContinuousKw(breakerAmps, V208, circuitConductorPhases(phaseConnections, 3)),
    ),
    loadKw: round2((208 * amps) / 1000),
    phaseConnections,
  };
}

/** The connected load of a station, kW. */
export function stationLoadKw(station: PowerStation): number {
  return station.kind === 'dc'
    ? plannedDcCircuit(station).loadKw
    : plannedAcCircuit(station, 0).loadKw;
}

/** The AC panelboards of a group: filled in order, a new one when the load or the spaces run out. */
function panelboardsOf(stations: readonly PowerStation[]): PlannedPanelboard[] {
  const max400 = computeMaxContinuousKw(400, V208, 3);
  const out: Array<{ circuits: PlannedCircuit[]; loadKw: number; spaces: number }> = [];
  let index = 0;
  for (const station of stations) {
    let circuit = plannedAcCircuit(station, index);
    let last = out[out.length - 1];
    if (
      last == null ||
      last.loadKw + circuit.loadKw > max400 + 1e-9 ||
      last.spaces + 2 > PANELBOARD_SPACES
    ) {
      index = 0;
      circuit = plannedAcCircuit(station, index);
      last = { circuits: [], loadKw: 0, spaces: 0 };
      out.push(last);
    }
    last.circuits.push(circuit);
    last.loadKw = round2(last.loadKw + circuit.loadKw);
    last.spaces += 2;
    index++;
  }
  return out.map((p) => {
    const amps =
      PANELBOARD_AMPS.find((a) => computeMaxContinuousKw(a, V208, 3) >= p.loadKw - 1e-9) ?? 400;
    return {
      amps,
      maxContinuousKw: round2(computeMaxContinuousKw(amps, V208, 3)),
      circuits: p.circuits,
      loadKw: p.loadKw,
      spaces: p.spaces,
      stepDownKva: stepDownTransformerKva(p.loadKw, amps),
    };
  });
}

/** A group's equipment for its stations: switchboard, DC breakers, AC panelboards, transformer. */
export function plannedGroup(stations: readonly PowerStation[]): PlannedGroup {
  const dc = stations.filter((s) => s.kind === 'dc').map(plannedDcCircuit);
  const panelboards = panelboardsOf(stations.filter((s) => s.kind === 'ac'));
  const loadKw = round2(
    dc.reduce((n, c) => n + c.loadKw, 0) + panelboards.reduce((n, p) => n + p.loadKw, 0),
  );
  const switchboardAmps = SWITCHBOARD_MAIN_AMPS.find(
    (a) => computeMaxContinuousKw(a, V480, 3) >= loadKw - 1e-9,
  );
  // A group never holds more than the largest main carries (`planSitePower` splits).
  if (switchboardAmps == null) throw new Error(`Group load ${String(loadKw)} kW past 4000 A`);
  const transformerKva = serviceTransformerKva(loadKw);
  return {
    transformerKva,
    switchboardAmps,
    switchboardMaxContinuousKw: round2(computeMaxContinuousKw(switchboardAmps, V480, 3)),
    dc,
    panelboards,
    loadKw,
    stationIds: stations.map((s) => s.id),
  };
}

/**
 * The groups of a site: the stations in rows (by spot z, then x), cut into as
 * few contiguous groups as the 4000 A ceiling allows, each about the same
 * load, so each group's stations stand together and its transformer stands
 * next to them. Throws when a site needs more than MAX_GROUPS.
 */
export function planSitePower(stations: readonly PowerStation[]): PlannedGroup[] {
  if (stations.length === 0) return [];
  const sorted = [...stations].sort(
    (a, b) => a.spot.z - b.spot.z || a.spot.x - b.spot.x || a.id.localeCompare(b.id),
  );
  const loads = sorted.map(stationLoadKw);
  const total = loads.reduce((n, l) => n + l, 0);
  // A little below the ceiling: the panelboards round up and the cut lands between stations.
  const ceiling = GROUP_MAX_KW * 0.95;
  for (let count = Math.max(1, Math.ceil(total / ceiling)); count <= MAX_GROUPS; count++) {
    const target = total / count;
    const groups: PowerStation[][] = [];
    let open: PowerStation[] = [];
    let current = 0;
    sorted.forEach((s, i) => {
      const load = loads[i] ?? 0;
      if (open.length > 0 && groups.length + 1 < count && current + load / 2 > target) {
        groups.push(open);
        open = [];
        current = 0;
      }
      open.push(s);
      current += load;
    });
    groups.push(open);
    const planned = groups.filter((g) => g.length > 0).map((g) => tryGroup(g));
    if (planned.every((g): g is PlannedGroup => g != null)) return planned;
  }
  throw new Error(
    `Site load ${String(round2(total))} kW needs more than ${String(MAX_GROUPS)} groups`,
  );
}

function tryGroup(stations: readonly PowerStation[]): PlannedGroup | null {
  try {
    const g = plannedGroup(stations);
    return g.loadKw <= GROUP_MAX_KW ? g : null;
  } catch {
    // fail-open: a group past the largest main is refused; the caller tries more groups.
    return null;
  }
}

/**
 * Where each group's transformer stands: on the grass `clearanceM` past the
 * lot's right edge (where a site without stored settings has its default
 * transformer and its DC group, `defaultTransformer`), level with the middle
 * of its group's spots, at least `pitchM` from the one before so the pads and
 * switchboard rows stay apart.
 */
export function groupTransformerPoints(
  groups: ReadonlyArray<{ stationIds: readonly string[] }>,
  spots: ReadonlyMap<string, { x: number; z: number }>,
  lot: { width: number; depth: number },
  clearanceM: number,
  pitchM = 6,
): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  for (const g of groups) {
    const zs = g.stationIds.flatMap((id) => {
      const p = spots.get(id);
      return p != null ? [p.z] : [];
    });
    let z = zs.length > 0 ? zs.reduce((a, b) => a + b, 0) / zs.length : lot.depth / 2;
    const prev = out[out.length - 1];
    if (prev != null) z = Math.max(z, prev.z + pitchM);
    out.push({ x: round2(lot.width + clearanceM), z: Math.round(z * 10) / 10 });
  }
  return out;
}
