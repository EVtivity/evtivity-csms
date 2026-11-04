// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, gte, sql, asc, desc, inArray } from 'drizzle-orm';
import {
  db,
  siteLoadManagement,
  panels,
  circuits,
  unmanagedLoads,
  chargingStations,
  chargingSessions,
  meterValues,
  connectors,
  evses,
  loadAllocationLog,
  evChargingNeeds,
  stationConfigurations,
  chargingProfiles,
  isOperatorStation,
  transformers,
  siteEnergyAssets,
  energyAssetReadings,
  sites,
} from '@evtivity/database';
import type {
  EnergyAssetSupply,
  EnergyAssetTelemetry,
  EnergyAssetType,
  LoadAllocationStrategy,
  ServiceLogger,
  SimulatedBatteryDispatch,
  TransformerKind,
} from '@evtivity/lib';
import type { OcppCommand, PubSubClient } from '@evtivity/lib';
import {
  circuitConductorPhases,
  conductorFactor,
  createLogger,
  effectiveCircuitVoltageV,
  energyAssetReadingFreshUntilMs,
  energyAssetSupply,
  publishOcppCommand,
  simulatedBatteryDispatch,
  simulatedBatteryReading,
  simulatedSolarReading,
} from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

const logger = createLogger('load-management');

export interface PhaseLoad {
  L1: number;
  L2: number;
  L3: number;
}

export interface StationPowerInfo {
  id: string;
  stationId: string;
  circuitId: string | null;
  currentDrawKw: number;
  phasePowerKw: PhaseLoad | null;
  maxPowerKw: number;
  loadPriority: number;
  isOnline: boolean;
  hasActiveSession: boolean;
  departureTime: Date | null;
  /** Lowest power in kW a charging session gets before it is stopped (0: none). */
  minPowerKw: number;
  /**
   * Charging rate unit of the station's limit: W unless it supports only A, or
   * supports A and sits on a circuit of two or three conductor phases (set by
   * `buildSiteHierarchy`).
   */
  rateUnit: ChargingRateUnit;
  /** Units the station reports it takes (empty: it reported none). */
  supportedRateUnits?: ChargingRateUnit[];
  /** Id of the station's load management profile (`loadManagementProfileId`). */
  profileId: number;
  /**
   * Highest charging profile stack level the station reports it takes (2.1
   * `SmartChargingCtrlr.ProfileStackLevel`, 1.6 `ChargeProfileMaxStackLevel`);
   * null when it reported none. Below the credit stack level it is sent no
   * credit profile (`LOAD_MANAGEMENT_CREDIT_STACK_LEVEL`).
   */
  maxStackLevel?: number | null;
  /** Latest power reading per EVSE database id in kW, for the EVSEs that sent one. */
  evseDrawKw?: Record<string, number>;
  /** True when `currentDrawKw` comes from a reading (false: no reading in the last minute). */
  drawMeasured?: boolean;
  /** Local generation the station reported (OCPP 2.1 K27), kW; set by `buildSiteHierarchy`. */
  localGenerationKw?: number;
}

export type ChargingRateUnit = 'A' | 'W';

// Configuration variables naming the units a station takes in a charging
// schedule: 2.1 SmartChargingCtrlr.RateUnit ("A,W"), 1.6
// ChargingScheduleAllowedChargingRateUnit ("Current,Power").
export const RATE_UNIT_VARIABLES = ['RateUnit', 'ChargingScheduleAllowedChargingRateUnit'] as const;

// 2.1 SmartChargingCtrlr.MaxExternalConstraintsId: profile ids up to it are
// the station's own (external constraints); the CSMS chooses ids above it
// (K01.FR.80) and the station rejects the others (K01.FR.81).
export const MAX_EXTERNAL_CONSTRAINTS_ID_VARIABLE = 'MaxExternalConstraintsId';

// The highest stack level a station takes: 2.1 SmartChargingCtrlr.ProfileStackLevel,
// 1.6 ChargeProfileMaxStackLevel (OCPP 1.6 section 9.4.1).
export const PROFILE_STACK_LEVEL_VARIABLES = [
  'ProfileStackLevel',
  'ChargeProfileMaxStackLevel',
] as const;

/** The units a station reports it takes in a charging schedule (empty: none reported). */
export function supportedRateUnits(reported: readonly string[]): ChargingRateUnit[] {
  const units = new Set<ChargingRateUnit>();
  for (const value of reported) {
    for (const part of value.split(',')) {
      const unit = part.trim();
      if (unit === 'W' || unit === 'Power') units.add('W');
      if (unit === 'A' || unit === 'Current') units.add('A');
    }
  }
  return (['A', 'W'] as const).filter((u) => units.has(u));
}

/**
 * The unit load management sends a station its limit in (K01.FR.26: a station
 * rejects a unit it does not support):
 * - A when it supports A only;
 * - A when it supports A and its circuit has two or three conductor phases: a
 *   limit in W bounds the total power, not the current of each phase (a
 *   single-phase vehicle on a three-phase circuit could put all of it on one
 *   phase), a limit in A bounds the phase current;
 * - else W, also when it reports nothing.
 */
export function chargingRateUnitFor(
  reported: readonly string[],
  conductorPhases = 1,
): ChargingRateUnit {
  const units = supportedRateUnits(reported);
  if (!units.includes('A')) return 'W';
  return !units.includes('W') || conductorPhases > 1 ? 'A' : 'W';
}

export interface AllocationResult {
  stationId: string;
  stationDbId: string;
  allocatedKw: number;
  currentDrawKw: number;
}

/** What the depot plan fixes for the current slot (departure-aware sites). */
export interface PlannedAllocationInput {
  kw?: ReadonlyMap<string, number>;
  sharing?: ReadonlySet<string>;
  minKw?: ReadonlyMap<string, number>;
}

/**
 * A battery or solar asset connected at a hierarchy node, with the supply it
 * gives this allocation (`energyAssetSupply`, @evtivity/lib/energy-supply).
 */
export interface EnergyAssetNodeSupply {
  id: string;
  name: string;
  type: EnergyAssetType;
  phases: number;
  telemetry: EnergyAssetTelemetry;
  /** `transformer`: supply-side (NEC 705.11); `panel`: load-side (705.12). */
  connection: 'transformer' | 'panel';
  state: EnergyAssetSupply['state'];
  /** Credit the asset gives, kW (0 unless its reading is fresh). */
  creditKw: number;
  /** Load it adds at its connection point, kW. */
  loadKw: number;
  /** False when no node takes the credit (a load-side asset on a root panel). */
  creditApplied: boolean;
  readingReceivedAt: Date | null;
  socPercent: number | null;
  /**
   * When the reading stops being fresh (`energyAssetReadingFreshUntilMs`);
   * null without a fresh reading. Limits that rest on it are sent valid until
   * then only (security case 334).
   */
  freshUntil: Date | null;
}

export interface HierarchyNode {
  /**
   * `transformer`: a service transformer (a root above the top-level panels
   * that name it) or a step-down transformer (between a panel and the
   * sub-panels that name it). The allocation treats it like a panel.
   */
  type: 'panel' | 'circuit' | 'transformer';
  /** Transformers only. */
  transformerKind?: TransformerKind;
  /**
   * Battery and solar supply this node carries on top of its capacity, kW
   * (owner decision D8): the credit of every asset connected load-side on a
   * strict descendant panel, and of a supply-side asset at this transformer.
   * Absent: 0.
   */
  supplyCreditKw?: number;
  /** The per-phase part of `supplyCreditKw` (three-phase assets only, / 3). */
  supplyPhaseCreditKw?: PhaseLoad | null;
  /**
   * Load of the assets connected at this node (a charging battery, or one
   * without a fresh reading that may charge from the grid, D9), kW: a fixed
   * load of this node and of every node above it.
   */
  supplyLoadKw?: number;
  /** The part of `supplyLoadKw` from single-phase assets (in full on every phase). */
  supplySinglePhaseLoadKw?: number;
  /**
   * `supplyLoadKw` and `supplySinglePhaseLoadKw` as they count once every
   * reading is stale (no reading: a battery that may charge from the grid at
   * its rating, D9). The station limits the cycle sends without an end date
   * are computed with these and no credit (`withoutAssetReadings`, security
   * case 334).
   */
  fallbackSupplyLoadKw?: number;
  fallbackSupplySinglePhaseLoadKw?: number;
  /** The assets connected at this node. */
  energyAssets?: EnergyAssetNodeSupply[];
  /**
   * Circuits: the local generation its stations reported (OCPP 2.1 K27), kW.
   * A station may draw it on top of its limit, so it is a fixed load of the
   * circuit and of every node above it (owner decision D11).
   */
  localGenerationKw?: number;
  id: string;
  name: string;
  maxContinuousKw: number;
  safetyMarginKw: number;
  unmanagedLoadKw: number;
  currentDrawKw: number;
  stations: StationPowerInfo[];
  children: HierarchyNode[];
  // Three-phase tracking (panels only, null for single-phase or circuits)
  phases: number;
  breakerRatingAmps: number;
  voltageV: number;
  oversubscriptionRatio: number;
  /**
   * Circuits: the phases of a three-phase panel the circuit uses. Panels: the
   * phases of a three-phase parent that feed this single-phase sub-panel.
   * Null: every phase.
   */
  phaseConnections: string | null;
  phaseLoad: PhaseLoad | null;
  perPhaseCapacityKw: number | null;
  /**
   * Circuits: the circuit's own stored voltage (null uses the panel voltage).
   * `voltageV` holds the voltage in use.
   */
  ownVoltageV?: number | null;
}

interface PanelRow {
  id: string;
  parentPanelId: string | null;
  name: string;
  breakerRatingAmps: number;
  voltageV: number;
  phases: number;
  maxContinuousKw: string;
  safetyMarginKw: string;
  oversubscriptionRatio: string;
  phaseConnections: string | null;
  transformerId: string | null;
}

interface TransformerRow {
  id: string;
  kind: TransformerKind;
  name: string;
  phases: number;
  secondaryVoltageV: number | null;
  safetyMarginKw: string;
  fedFromPanelId: string | null;
  maxContinuousKw: string | null;
}

interface EnergyAssetRow {
  id: string;
  type: EnergyAssetType;
  name: string;
  capacityKwh: number | null;
  peakKwp: number | null;
  inverterKw: string | null;
  maxDischargeKw: string | null;
  maxChargeKw: string | null;
  phases: number;
  connectionTransformerId: string | null;
  connectionPanelId: string | null;
  gridCharging: 'never' | 'possible';
  reservePercent: number;
  telemetry: EnergyAssetTelemetry;
  readingTtlSeconds: number;
}

interface EnergyAssetReadingRow {
  assetId: string;
  reportedAt: Date;
  receivedAt: Date;
  powerKw: string;
  availableKw: string | null;
  socPercent: string | null;
  source: string;
}

interface CircuitRow {
  id: string;
  panelId: string;
  name: string;
  breakerRatingAmps: number;
  maxContinuousKw: string;
  phaseConnections: string | null;
  voltageV: number | null;
}

interface UnmanagedLoadRow {
  panelId: string | null;
  circuitId: string | null;
  name: string;
  estimatedDrawKw: string;
}

/**
 * Maximum power of each station: the sum over its EVSEs of the highest
 * connector rating of the EVSE (the connectors of one EVSE cannot charge at
 * the same time). A station with an EVSE whose connectors have no rating gets
 * 0, which the allocation reads as unknown (capped at its equal share).
 */
export function stationMaxPowerKw(
  connectorRows: Array<{ stationId: string; evseDbId: string; maxPowerKw: string | null }>,
): Map<string, number> {
  const evseMax = new Map<string, Map<string, number | null>>();
  for (const row of connectorRows) {
    const perEvse = evseMax.get(row.stationId) ?? new Map<string, number | null>();
    const rating = row.maxPowerKw != null ? Number(row.maxPowerKw) : null;
    const known = rating != null && rating > 0 ? rating : null;
    const current = perEvse.get(row.evseDbId);
    if (current === undefined) {
      perEvse.set(row.evseDbId, known);
    } else if (known != null && (current == null || known > current)) {
      perEvse.set(row.evseDbId, known);
    }
    evseMax.set(row.stationId, perEvse);
  }
  const result = new Map<string, number>();
  for (const [stationId, perEvse] of evseMax) {
    const values = [...perEvse.values()];
    result.set(
      stationId,
      values.some((v) => v == null) ? 0 : values.reduce<number>((sum, v) => sum + (v ?? 0), 0),
    );
  }
  return result;
}

export async function getSitePowerStatus(siteId: string): Promise<{
  totalDrawKw: number;
  stations: StationPowerInfo[];
}> {
  const since = new Date(Date.now() - 60_000);

  // Get all stations at the site with their priority and online status.
  // Conformance test stations are never load managed.
  const stationRows = await db
    .select({
      id: chargingStations.id,
      stationId: chargingStations.stationId,
      isOnline: chargingStations.isOnline,
      loadPriority: chargingStations.loadPriority,
      loadMinPowerKw: chargingStations.loadMinPowerKw,
      circuitId: chargingStations.circuitId,
    })
    .from(chargingStations)
    .where(and(eq(chargingStations.siteId, siteId), isOperatorStation()));

  if (stationRows.length === 0) {
    return { totalDrawKw: 0, stations: [] };
  }

  const stationDbIds = stationRows.map((s) => s.id);

  // The remaining four queries all depend only on stationDbIds, not on
  // each other — fan them out in parallel so the per-cycle latency is
  // bounded by the slowest single query instead of the sum. Power
  // readings are read once and partitioned in JS into overall vs
  // per-phase below; previously this was two separate SELECTs against
  // the same measurand which doubled the meter_values index pressure.
  const [connectorRows, activeSessions, allPowerValues, chargingNeedsRows, rateUnitRows] =
    await Promise.all([
      db
        .select({
          stationId: evses.stationId,
          evseDbId: evses.id,
          maxPowerKw: connectors.maxPowerKw,
        })
        .from(connectors)
        .innerJoin(evses, eq(connectors.evseId, evses.id))
        .where(inArray(evses.stationId, stationDbIds)),
      db
        .select({
          stationId: chargingSessions.stationId,
        })
        .from(chargingSessions)
        .where(
          and(
            eq(chargingSessions.status, 'active'),
            inArray(chargingSessions.stationId, stationDbIds),
          ),
        ),
      db
        .select({
          stationId: meterValues.stationId,
          evseDbId: meterValues.evseId,
          value: meterValues.value,
          unit: meterValues.unit,
          phase: meterValues.phase,
        })
        .from(meterValues)
        .where(
          and(
            eq(meterValues.measurand, 'Power.Active.Import'),
            gte(meterValues.timestamp, since),
            inArray(meterValues.stationId, stationDbIds),
          ),
        )
        .orderBy(desc(meterValues.timestamp)),
      db
        .select({
          stationId: evChargingNeeds.stationId,
          departureTime: evChargingNeeds.departureTime,
        })
        .from(evChargingNeeds)
        .where(inArray(evChargingNeeds.stationId, stationDbIds)),
      db
        .select({
          stationId: stationConfigurations.stationId,
          variable: stationConfigurations.variable,
          value: stationConfigurations.value,
        })
        .from(stationConfigurations)
        .where(
          and(
            inArray(stationConfigurations.stationId, stationDbIds),
            inArray(stationConfigurations.variable, [
              ...RATE_UNIT_VARIABLES,
              MAX_EXTERNAL_CONSTRAINTS_ID_VARIABLE,
              ...PROFILE_STACK_LEVEL_VARIABLES,
            ]),
            eq(stationConfigurations.attributeType, 'Actual'),
          ),
        ),
    ]);
  const reportedUnits = new Map<string, string[]>();
  const maxExternalIds = new Map<string, string>();
  const maxStackLevels = new Map<string, number>();
  for (const row of rateUnitRows) {
    if (row.value == null) continue;
    if (row.variable === MAX_EXTERNAL_CONSTRAINTS_ID_VARIABLE) {
      maxExternalIds.set(row.stationId, row.value);
      continue;
    }
    if ((PROFILE_STACK_LEVEL_VARIABLES as readonly string[]).includes(row.variable)) {
      const level = Number(row.value);
      if (Number.isInteger(level) && level >= 0) maxStackLevels.set(row.stationId, level);
      continue;
    }
    const list = reportedUnits.get(row.stationId) ?? [];
    list.push(row.value);
    reportedUnits.set(row.stationId, list);
  }
  // Partition the single power query in JS: rows without a phase populate
  // the overall most-recent map, rows with a phase populate the per-phase
  // map. desc(timestamp) ordering above guarantees first-row-wins per
  // (station, [phase]) bucket.
  const powerValues = allPowerValues.filter((r) => r.phase == null);
  const phasePowerValues = allPowerValues.filter((r) => r.phase != null);

  const stationMaxPower = stationMaxPowerKw(connectorRows);

  const activeStationIds = new Set(activeSessions.map((s) => s.stationId));

  // Most recent power reading per EVSE, summed per station. A reading without
  // an EVSE is the station total and counts only when the station sent no
  // EVSE reading: a station with several EVSEs charging reports each one.
  const evsePower = new Map<string, Map<string, number>>();
  const stationLevelPower = new Map<string, number>();
  for (const row of powerValues) {
    let kw = Number(row.value);
    // Convert W to kW if unit is W or not specified
    if (row.unit == null || row.unit === 'W') {
      kw = kw / 1000;
    }
    if (row.evseDbId == null) {
      if (!stationLevelPower.has(row.stationId)) stationLevelPower.set(row.stationId, kw);
      continue;
    }
    const perEvse = evsePower.get(row.stationId) ?? new Map<string, number>();
    if (!perEvse.has(row.evseDbId)) perEvse.set(row.evseDbId, kw);
    evsePower.set(row.stationId, perEvse);
  }
  const stationPower = new Map<string, number>(stationLevelPower);
  for (const [stationId, perEvse] of evsePower) {
    stationPower.set(
      stationId,
      [...perEvse.values()].reduce((sum, kw) => sum + kw, 0),
    );
  }

  // Take the most recent per-phase reading per station
  const stationPhasePower = new Map<string, PhaseLoad>();
  const seenPhases = new Map<string, Set<string>>();
  for (const row of phasePowerValues) {
    const phase = row.phase;
    if (phase == null || !['L1', 'L2', 'L3'].includes(phase)) continue;
    const seen = seenPhases.get(row.stationId) ?? new Set<string>();
    if (seen.has(phase)) continue;
    seen.add(phase);
    seenPhases.set(row.stationId, seen);

    let kw = Number(row.value);
    if (row.unit == null || row.unit === 'W') {
      kw = kw / 1000;
    }

    const existing = stationPhasePower.get(row.stationId) ?? { L1: 0, L2: 0, L3: 0 };
    existing[phase as 'L1' | 'L2' | 'L3'] = kw;
    stationPhasePower.set(row.stationId, existing);
  }

  // Map earliest departure time per station
  const stationDeparture = new Map<string, Date>();
  for (const row of chargingNeedsRows) {
    if (row.departureTime == null) continue;
    const existing = stationDeparture.get(row.stationId);
    if (existing == null || row.departureTime < existing) {
      stationDeparture.set(row.stationId, row.departureTime);
    }
  }

  let totalDrawKw = 0;
  const stationInfos: StationPowerInfo[] = stationRows.map((station) => {
    const currentDrawKw = stationPower.get(station.id) ?? 0;
    totalDrawKw += currentDrawKw;
    return {
      id: station.id,
      stationId: station.stationId,
      circuitId: station.circuitId,
      currentDrawKw,
      phasePowerKw: stationPhasePower.get(station.id) ?? null,
      maxPowerKw: stationMaxPower.get(station.id) ?? 0,
      loadPriority: station.loadPriority,
      isOnline: station.isOnline,
      hasActiveSession: activeStationIds.has(station.id),
      departureTime: stationDeparture.get(station.id) ?? null,
      minPowerKw: station.loadMinPowerKw != null ? Number(station.loadMinPowerKw) : 0,
      rateUnit: chargingRateUnitFor(reportedUnits.get(station.id) ?? []),
      supportedRateUnits: supportedRateUnits(reportedUnits.get(station.id) ?? []),
      profileId: loadManagementProfileId(maxExternalIds.get(station.id)),
      maxStackLevel: maxStackLevels.get(station.id) ?? null,
      evseDrawKw: Object.fromEntries(evsePower.get(station.id) ?? []),
      drawMeasured: stationPower.has(station.id),
    };
  });

  return { totalDrawKw, stations: stationInfos };
}

export type Phase = 'L1' | 'L2' | 'L3';
export const ALL_PHASES: readonly Phase[] = ['L1', 'L2', 'L3'];

/**
 * The phases of a three-phase panel a circuit is connected to, from its
 * phaseConnections value (none: all three).
 */
function getCircuitPhases(phaseConnections: string | null): Phase[] {
  if (phaseConnections == null || phaseConnections === 'L1L2L3') return ['L1', 'L2', 'L3'];
  const map: Record<string, Array<'L1' | 'L2' | 'L3'>> = {
    L1: ['L1'],
    L2: ['L2'],
    L3: ['L3'],
    L1L2: ['L1', 'L2'],
    L1L3: ['L1', 'L3'],
    L2L3: ['L2', 'L3'],
    L1L2L3: ['L1', 'L2', 'L3'],
  };
  return map[phaseConnections] ?? ['L1', 'L2', 'L3'];
}

/**
 * The phases a circuit loads below a three-phase panel, and the share of its
 * power each of them carries. Phase loads are in kW as phase current x phase
 * to neutral voltage, the unit of `perPhaseCapacityKw`. The current on each
 * conductor is P / (V x 1, sqrt(3) or 3) for 1, 2 or 3 conductor phases
 * (`conductorFactor`), so each phase carries P / conductorFactor(n): all of it
 * on one phase, P / sqrt(3) (not P / 2) on each of two phases, P / 3 on each of
 * three.
 *
 * `panelPhases` is the circuit's own panel. A circuit of a single-phase
 * sub-panel below a three-phase panel is counted with all of its power on
 * every phase: the CSMS does not know which phase feeds the sub-panel.
 */
export function circuitPhaseShare(
  phaseConnections: string | null,
  panelPhases: number,
): { phases: readonly Phase[]; share: number } {
  if (panelPhases !== 3) return { phases: ALL_PHASES, share: 1 };
  const phases = getCircuitPhases(phaseConnections);
  return { phases, share: 1 / conductorFactor(phases.length) };
}

/**
 * Share of a panel's own (unmanaged) load on each phase: balanced on a
 * three-phase panel, all of it on every phase for a single-phase sub-panel.
 */
function panelOwnPhaseShare(panelPhases: number): number {
  return panelPhases === 3 ? 1 / 3 : 1;
}

/**
 * The phases of a three-phase `parent` a single-phase sub-panel loads, and the
 * share of its power each carries. Without phase connections (or below a
 * single-phase parent): all of it on every phase (conservative). With them:
 * the phase current x the parent's phase to neutral voltage, P x Vparent /
 * Vsub on each named phase, never less than the circuit rule
 * (1 / conductorFactor(n)), so a sub-panel voltage entered too high does not
 * hide load.
 */
export function subPanelPhaseShare(
  parent: HierarchyNode,
  child: HierarchyNode,
): { phases: readonly Phase[]; share: number } {
  if (parent.phases !== 3 || child.phases === 3 || child.phaseConnections == null) {
    return { phases: ALL_PHASES, share: 1 };
  }
  const phases = getCircuitPhases(child.phaseConnections);
  if (phases.length === 3) return { phases: ALL_PHASES, share: 1 };
  // A transformer of unknown secondary voltage has voltageV 0: full share.
  const byVoltage =
    child.voltageV > 0 && parent.voltageV > 0 ? parent.voltageV / child.voltageV : 1;
  return { phases, share: Math.min(1, Math.max(1 / conductorFactor(phases.length), byVoltage)) };
}

/**
 * Weight of a child's load in its single-phase panel's capacity check. A
 * circuit below the panel voltage (a 120 V branch of a 240 V split-phase
 * panel) draws its current from one leg, so P kW at 120 V loads that leg like
 * 2P kW at 240 V: weight Vpanel / Vcircuit. Every other child: 1. The
 * capacity (kW at the panel voltage) then bounds the current of each leg even
 * when every lower-voltage circuit sits on the same leg.
 */
export function legWeight(parent: HierarchyNode, child: HierarchyNode): number {
  if (parent.phases === 3 || child.type !== 'circuit') return 1;
  return child.voltageV > 0 && child.voltageV < parent.voltageV
    ? parent.voltageV / child.voltageV
    : 1;
}

/**
 * Whether `child` is a three-phase step-down transformer below a three-phase
 * `parent`: its secondary phase loads map onto the parent's phases through
 * `stepDownPrimaryPhases` (owner decision D16). A three-phase sub-panel
 * directly below a three-phase panel keeps the 1:1 mapping.
 */
export function mapsThroughStepDown(parent: HierarchyNode, child: HierarchyNode): boolean {
  return child.type === 'transformer' && parent.phases === 3 && child.phases === 3;
}

/**
 * Per-phase load on the primary of a three-phase delta-wye step-down
 * transformer from the load on its secondary phases (derived, D16). A
 * secondary line to neutral load on phase a sits across one delta winding, so
 * it draws on two primary lines: in the per-phase unit of the hierarchy
 * (phase current x phase to neutral voltage) that is P / sqrt(3) on each of
 * them, the two-phase rule of `circuitPhaseShare`. Secondary L1, L2, L3 load
 * primary L1L2, L2L3, L3L1. A balanced load P counts 2 / (3 sqrt 3) = 0.385 P
 * on each primary phase instead of P / 3 (up to 15 percent high, the safe side).
 */
export function stepDownPrimaryPhases(secondary: PhaseLoad): PhaseLoad {
  const k = 1 / Math.sqrt(3);
  return {
    L1: (secondary.L1 + secondary.L3) * k,
    L2: (secondary.L1 + secondary.L2) * k,
    L3: (secondary.L2 + secondary.L3) * k,
  };
}

// The secondary phases of a step-down transformer that load each primary
// phase (the inverse of `stepDownPrimaryPhases`).
const STEP_DOWN_SECONDARY_OF: Record<Phase, readonly Phase[]> = {
  L1: ['L1', 'L3'],
  L2: ['L1', 'L2'],
  L3: ['L2', 'L3'],
};

/**
 * Load of the node itself that no allocation can change, kW: its unmanaged
 * loads and the load of the batteries connected at it.
 */
function ownFixedKw(node: HierarchyNode): number {
  return node.unmanagedLoadKw + (node.supplyLoadKw ?? 0) + (node.localGenerationKw ?? 0);
}

/**
 * Most a node can carry for what it feeds, kW: its capacity after the safety
 * margin plus its supply credit, and never more than its own loads plus what
 * its children can carry (a credit never raises a node past the limits of the
 * nodes below it). A circuit: its capacity.
 */
function feedCapacityKw(node: HierarchyNode): number {
  if (node.type === 'circuit') return node.maxContinuousKw;
  const own = node.maxContinuousKw - node.safetyMarginKw + (node.supplyCreditKw ?? 0);
  const fed = node.children.reduce((sum, child) => sum + feedCapacityKw(child), ownFixedKw(node));
  return Math.min(own, fed);
}

/**
 * Capacity of a panel or transformer for its stations and fixed loads, kW:
 * its capacity after the safety margin plus its supply credit, the credited
 * part never above what its children can carry (`feedCapacityKw`). Without a
 * credit: the capacity after the margin, unchanged.
 */
export function nodeCapacityKw(node: HierarchyNode): number {
  const base = node.maxContinuousKw - node.safetyMarginKw;
  const credit = node.supplyCreditKw ?? 0;
  if (credit <= 0) return base;
  const fed = node.children.reduce((sum, child) => sum + feedCapacityKw(child), ownFixedKw(node));
  return Math.min(base + credit, Math.max(base, fed));
}

interface AssetReading {
  receivedAtMs: number;
  reportedAtMs: number;
  powerKw: number;
  availableKw: number | null;
  socPercent: number | null;
}

/** What a simulated reading needs: the site position and the demand above the grid. */
interface SimulationContext {
  latitudeDeg: number | null;
  longitudeDeg: number | null;
  /** The site's IANA time zone (the battery's time-of-use windows). */
  timeZone: string | null;
  /** The battery dispatch of the site type: a depot discharges overnight. */
  dispatch: SimulatedBatteryDispatch;
  deficitKw: number;
}

const numberOrNull = (value: string | null): number | null =>
  value != null ? Number(value) : null;

/**
 * The reading an asset's supply is judged on: the stored `api` reading of an
 * asset with `api` telemetry; a reading computed now for `simulated` telemetry
 * while the process allows it (`simulation` set; @evtivity/lib
 * energy-asset-simulation, nothing stored); none for `none` (informational)
 * and for `simulated` otherwise.
 */
function assetReading(
  asset: EnergyAssetRow,
  stored: EnergyAssetReadingRow | undefined,
  nowMs: number,
  simulation: SimulationContext | null,
): AssetReading | null {
  if (asset.telemetry === 'simulated') {
    if (simulation == null) return null;
    const at = new Date(nowMs);
    const simulated =
      asset.type === 'solar'
        ? simulatedSolarReading(
            asset.peakKwp,
            numberOrNull(asset.inverterKw),
            simulation.latitudeDeg,
            simulation.longitudeDeg,
            at,
          )
        : simulatedBatteryReading(
            {
              capacityKwh: asset.capacityKwh,
              maxDischargeKw: numberOrNull(asset.maxDischargeKw),
              maxChargeKw: numberOrNull(asset.maxChargeKw),
              inverterKw: numberOrNull(asset.inverterKw),
              reservePercent: asset.reservePercent,
              gridCharging: asset.gridCharging,
              dispatch: simulation.dispatch,
              deficitKw: simulation.deficitKw,
            },
            simulation.timeZone,
            at,
          );
    return simulated == null ? null : { receivedAtMs: nowMs, reportedAtMs: nowMs, ...simulated };
  }
  if (asset.telemetry !== 'api' || stored == null || stored.source !== 'api') return null;
  return {
    receivedAtMs: stored.receivedAt.getTime(),
    reportedAtMs: stored.reportedAt.getTime(),
    powerKw: Number(stored.powerKw),
    availableKw: numberOrNull(stored.availableKw),
    socPercent: numberOrNull(stored.socPercent),
  };
}

/** A coordinate stored as text, or null when it is missing or out of range. */
function coordinate(value: string | null | undefined, limit: number): number | null {
  if (value == null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : null;
}

/**
 * Demand of the active sessions above the capacity of the roots, kW: what a
 * simulated battery discharges to cover. A station counts with its maximum
 * power, or its draw when the maximum is unknown.
 */
function demandAboveGridKw(roots: readonly HierarchyNode[]): number {
  let demand = 0;
  const walk = (nodes: readonly HierarchyNode[]): void => {
    for (const node of nodes) {
      for (const station of node.stations) {
        if (!station.isOnline || !station.hasActiveSession) continue;
        demand += station.maxPowerKw > 0 ? station.maxPowerKw : station.currentDrawKw;
      }
      walk(node.children);
    }
  };
  walk(roots);
  const grid = roots.reduce((sum, r) => sum + Math.max(0, r.maxContinuousKw - r.safetyMarginKw), 0);
  return Math.max(0, demand - grid);
}

function addPhaseCredit(node: HierarchyNode, perPhaseKw: number): void {
  if (node.phases !== 3) return;
  const current = node.supplyPhaseCreditKw ?? { L1: 0, L2: 0, L3: 0 };
  node.supplyPhaseCreditKw = {
    L1: current.L1 + perPhaseKw,
    L2: current.L2 + perPhaseKw,
    L3: current.L3 + perPhaseKw,
  };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** An ISO time as ms since the epoch, NaN when absent or not a date. */
const timeMs = (value: unknown): number => (typeof value === 'string' ? Date.parse(value) : NaN);

/**
 * Local generation of one stored station_reported row at `nowMs`, kW (OCPP
 * 2.1 K27): the active period of every LocalGeneration entry (a profile of a
 * GetChargingProfiles report, or a NotifyChargingLimit with isLocalGeneration
 * stored by the OCPP projection), its largest one. 0 when the row holds no
 * LocalGeneration entry or none is active; null when one is there but its
 * power cannot be read (no schedule, a unit that cannot be converted).
 *
 * A schedule starts at its `startSchedule`, else at the notification time
 * (`notifiedAt`, a schedule "from that moment onwards"), else when the row
 * was stored; it ends after `duration` and outside `validFrom`/`validTo`. A
 * W limit with `limit_L2`/`limit_L3` is per phase (summed), an A limit is the
 * phase current on the station's circuit (`rate`).
 */
export function localGenerationKw(
  profileData: unknown,
  reportedAtMs: number | null,
  nowMs: number,
  rate: { voltageV: number; phases: number },
): number | null {
  const entries = Array.isArray(profileData) ? profileData : [profileData];
  let best = 0;
  let unknown = false;
  for (const raw of entries) {
    const entry = asRecord(raw);
    if (entry?.['chargingProfilePurpose'] !== 'LocalGeneration') continue;
    const validFrom = timeMs(entry['validFrom']);
    const validTo = timeMs(entry['validTo']);
    if (
      (Number.isFinite(validFrom) && validFrom > nowMs) ||
      (Number.isFinite(validTo) && validTo <= nowMs)
    ) {
      continue;
    }
    const schedules = entry['chargingSchedule'];
    const schedule = asRecord(Array.isArray(schedules) ? schedules[0] : schedules);
    const periods = schedule?.['chargingSchedulePeriod'];
    if (schedule == null || !Array.isArray(periods) || periods.length === 0) {
      unknown = true;
      continue;
    }
    const scheduleStart = timeMs(schedule['startSchedule']);
    const notifiedAt = timeMs(entry['notifiedAt']);
    const startMs = Number.isFinite(scheduleStart)
      ? scheduleStart
      : Number.isFinite(notifiedAt)
        ? notifiedAt
        : (reportedAtMs ?? nowMs);
    if (startMs > nowMs) continue;
    const duration = finiteNumber(schedule['duration']);
    const elapsedS = (nowMs - startMs) / 1000;
    if (duration != null && elapsedS >= duration) continue;
    let active: Record<string, unknown> | null = null;
    for (const p of periods) {
      const period = asRecord(p);
      const startPeriod = finiteNumber(period?.['startPeriod']);
      if (period != null && startPeriod != null && startPeriod <= elapsedS) active = period;
    }
    if (active == null) continue;
    const limit = finiteNumber(active['limit']);
    const l2 = finiteNumber(active['limit_L2']);
    const l3 = finiteNumber(active['limit_L3']);
    const unit = schedule['chargingRateUnit'];
    let kw: number | null = null;
    if (limit != null && unit === 'W') {
      kw = (limit + (l2 ?? 0) + (l3 ?? 0)) / 1000;
    } else if (limit != null && unit === 'A' && rate.voltageV > 0) {
      const amps = Math.max(limit, l2 ?? 0, l3 ?? 0);
      const phases = finiteNumber(active['numberPhases']) ?? rate.phases;
      kw = (amps * rate.voltageV * conductorFactor(Math.min(3, Math.max(1, phases)))) / 1000;
    }
    if (kw == null) {
      unknown = true;
      continue;
    }
    best = Math.max(best, kw);
  }
  return unknown ? null : best;
}

/**
 * Reserves the local generation each station reported (K27) on its circuit:
 * per EVSE the largest stored value, summed over the EVSEs, never above the
 * station's maximum power (else the circuit capacity), and an unreadable one
 * counts at that bound (fail closed).
 */
async function applyLocalGeneration(
  circuitNodes: readonly HierarchyNode[],
  nowMs: number,
): Promise<void> {
  const byStation = new Map<string, { station: StationPowerInfo; circuit: HierarchyNode }>();
  for (const circuit of circuitNodes) {
    for (const station of circuit.stations) byStation.set(station.id, { station, circuit });
  }
  if (byStation.size === 0) return;
  const rows = await db
    .select({
      stationId: chargingProfiles.stationId,
      evseId: chargingProfiles.evseId,
      profileData: chargingProfiles.profileData,
      reportedAt: chargingProfiles.reportedAt,
    })
    .from(chargingProfiles)
    .where(
      and(
        inArray(chargingProfiles.stationId, [...byStation.keys()]),
        eq(chargingProfiles.source, 'station_reported'),
        sql`${chargingProfiles.profileData} @> '[{"chargingProfilePurpose": "LocalGeneration"}]'::jsonb`,
      ),
    );
  // station -> EVSE key -> largest kW (null: unreadable)
  const perEvse = new Map<string, Map<number, number | null>>();
  for (const row of rows) {
    const target = byStation.get(row.stationId);
    if (target == null) continue;
    const kw = localGenerationKw(row.profileData, row.reportedAt?.getTime() ?? null, nowMs, {
      voltageV: target.circuit.voltageV,
      phases: circuitConductorPhases(target.circuit.phaseConnections, target.circuit.phases),
    });
    const evses = perEvse.get(row.stationId) ?? new Map<number, number | null>();
    const key = row.evseId ?? 0;
    const prior = evses.get(key);
    evses.set(key, prior === null || kw === null ? null : Math.max(prior ?? 0, kw));
    perEvse.set(row.stationId, evses);
  }
  for (const [stationId, evses] of perEvse) {
    const target = byStation.get(stationId);
    if (target == null) continue;
    const bound =
      target.station.maxPowerKw > 0 ? target.station.maxPowerKw : target.circuit.maxContinuousKw;
    let total = 0;
    for (const kw of evses.values()) total += kw ?? bound;
    const reserved = Math.min(total, bound);
    if (reserved <= 0) continue;
    target.station.localGenerationKw = reserved;
    target.circuit.localGenerationKw = (target.circuit.localGenerationKw ?? 0) + reserved;
  }
}

/** The site's battery and solar rows (throws on a failed read). */
async function readEnergyAssetRows(siteId: string): Promise<EnergyAssetRow[]> {
  return db
    .select({
      id: siteEnergyAssets.id,
      type: siteEnergyAssets.type,
      name: siteEnergyAssets.name,
      capacityKwh: siteEnergyAssets.capacityKwh,
      peakKwp: siteEnergyAssets.peakKwp,
      inverterKw: siteEnergyAssets.inverterKw,
      maxDischargeKw: siteEnergyAssets.maxDischargeKw,
      maxChargeKw: siteEnergyAssets.maxChargeKw,
      phases: siteEnergyAssets.phases,
      connectionTransformerId: siteEnergyAssets.connectionTransformerId,
      connectionPanelId: siteEnergyAssets.connectionPanelId,
      gridCharging: siteEnergyAssets.gridCharging,
      reservePercent: siteEnergyAssets.reservePercent,
      telemetry: siteEnergyAssets.telemetry,
      readingTtlSeconds: siteEnergyAssets.readingTtlSeconds,
    })
    .from(siteEnergyAssets)
    .where(eq(siteEnergyAssets.siteId, siteId));
}

/**
 * How the energy assets of a tree were known: `read` this cycle, `remembered`
 * from the last successful read of this process (the read failed), or
 * `unknown` (the read failed and this process never read them).
 */
export type EnergyAssetsKnowledge = 'read' | 'remembered' | 'unknown';

/**
 * The battery and solar rows of each site from the last successful read in
 * this process, kept so a failed read never drops a battery's grid charging
 * load (D9). Process memory only (one entry per site, replaced on every read).
 */
const rememberedEnergyAssets = new Map<string, { rows: EnergyAssetRow[]; readAtMs: number }>();

// A site this process has not read for this long is one the cycle no longer
// sees (deleted, load management turned off, its jobs run elsewhere): its
// remembered rows are dropped after the next successful read of any site.
export const REMEMBERED_ENERGY_ASSETS_MAX_AGE_MS = 15 * 60_000;

/** Forgets the remembered energy asset rows (tests). */
export function clearRememberedEnergyAssets(): void {
  rememberedEnergyAssets.clear();
}

/** Forgets the remembered energy asset rows of a site (the site was deleted). */
export function forgetRememberedEnergyAssets(siteId: string): void {
  rememberedEnergyAssets.delete(siteId);
}

/** The sites whose energy asset rows this process remembers (tests). */
export function rememberedEnergyAssetSiteIds(): string[] {
  return [...rememberedEnergyAssets.keys()];
}

/**
 * Drops the remembered rows of every site not read since
 * `REMEMBERED_ENERGY_ASSETS_MAX_AGE_MS` before `nowMs`. Called after a
 * successful read only, so a database outage never drops the fallback.
 */
export function pruneRememberedEnergyAssets(nowMs: number = Date.now()): void {
  for (const [siteId, entry] of rememberedEnergyAssets) {
    if (nowMs - entry.readAtMs > REMEMBERED_ENERGY_ASSETS_MAX_AGE_MS) {
      rememberedEnergyAssets.delete(siteId);
    }
  }
}

/**
 * Reads the site's batteries and solar with their latest readings and puts
 * their supply on the tree (see `buildSiteHierarchy`). Every read fails closed
 * (P9), on both sides of the supply:
 *
 * - No credit without the rows: a failed assets read gives no battery or solar
 *   credit, so no limit rests on supply that cannot be confirmed.
 * - No dropped load: a battery that may charge from the grid is a load (D9),
 *   and dropping it would let the limits exceed what the site carries. A
 *   failed read uses the rows of the last successful read of this process
 *   with no readings, so every such battery counts at its rated charge power
 *   (`maxChargeKw`, else `inverterKw`) at its connection point and above it:
 *   at least any load it can draw, whatever it did at that read. The rows are
 *   configuration and change rarely; a battery added since that read is
 *   unknown (answer `remembered`).
 * - Nothing known (`unknown`): the process never read the rows, so no bound
 *   on a battery load exists in the data at hand (the allocation log keeps
 *   site totals only, not loads per connection point). The tree then carries
 *   no asset and the caller sends no raise this cycle: each limit is the
 *   grid-only result capped at the limit the station holds (cuts only,
 *   `computeSiteAllocation`). The held limits came from a cycle that knew the
 *   assets, so the cycle never sends more than that cycle, and the cuts still
 *   bring the site under its grid limits. Throwing instead would send no cut
 *   either.
 */
async function applyEnergyAssets(
  siteId: string,
  nowMs: number,
  panelNodesById: ReadonlyMap<string, HierarchyNode>,
  transformerNodesById: ReadonlyMap<string, HierarchyNode>,
  parentOf: ReadonlyMap<HierarchyNode, HierarchyNode>,
  roots: readonly HierarchyNode[],
  options: SiteHierarchyOptions,
): Promise<EnergyAssetsKnowledge> {
  let assetRows: EnergyAssetRow[];
  let knowledge: EnergyAssetsKnowledge = 'read';
  try {
    assetRows = await readEnergyAssetRows(siteId);
    const readAtMs = Date.now();
    rememberedEnergyAssets.set(siteId, { rows: assetRows, readAtMs });
    pruneRememberedEnergyAssets(readAtMs);
  } catch (err: unknown) {
    const remembered = rememberedEnergyAssets.get(siteId)?.rows;
    if (remembered == null) {
      (options.log ?? logger).warn(
        { err, siteId },
        'Energy assets not read and not known, no limit is raised this cycle',
      );
      return 'unknown';
    }
    (options.log ?? logger).warn(
      { err, siteId },
      'Energy assets not read, the allocation uses the grid limits and the last known battery loads this cycle',
    );
    assetRows = remembered;
    knowledge = 'remembered';
  }
  const connected = assetRows.filter(
    (a) => a.connectionPanelId != null || a.connectionTransformerId != null,
  );
  if (connected.length === 0) return knowledge;

  let readings = new Map<string, EnergyAssetReadingRow>();
  // Remembered rows take no reading (no credit, rated battery loads).
  if (knowledge === 'read') {
    try {
      const rows: EnergyAssetReadingRow[] = await db
        .select({
          assetId: energyAssetReadings.assetId,
          reportedAt: energyAssetReadings.reportedAt,
          receivedAt: energyAssetReadings.receivedAt,
          powerKw: energyAssetReadings.powerKw,
          availableKw: energyAssetReadings.availableKw,
          socPercent: energyAssetReadings.socPercent,
          source: energyAssetReadings.source,
        })
        .from(energyAssetReadings)
        .where(
          inArray(
            energyAssetReadings.assetId,
            connected.map((a) => a.id),
          ),
        );
      readings = new Map(rows.map((r) => [r.assetId, r]));
    } catch (err: unknown) {
      (options.log ?? logger).warn(
        { err, siteId },
        'Energy asset readings not read, batteries and solar give no supply this cycle',
      );
    }
  }

  // Simulated readings (development and demos, ENERGY_ASSETS_ALLOW_SIMULATED):
  // the site position for the sun, the demand above the grid for a battery. A
  // failed position read gives no simulated reading (no credit, D9 loads).
  let simulation: SimulationContext | null = null;
  if (
    knowledge === 'read' &&
    options.allowSimulatedEnergyAssets === true &&
    connected.some((a) => a.telemetry === 'simulated')
  ) {
    let latitudeDeg: number | null = null;
    let longitudeDeg: number | null = null;
    let timeZone: string | null = null;
    let siteType: string | null = null;
    try {
      const [site] = await db
        .select({
          latitude: sites.latitude,
          longitude: sites.longitude,
          timezone: sites.timezone,
          layoutSettings: sites.layoutSettings,
        })
        .from(sites)
        .where(eq(sites.id, siteId));
      latitudeDeg = coordinate(site?.latitude, 90);
      longitudeDeg = coordinate(site?.longitude, 180);
      timeZone = site?.timezone ?? null;
      siteType = site?.layoutSettings?.siteType ?? null;
    } catch (err: unknown) {
      (options.log ?? logger).warn(
        { err, siteId },
        'Site position not read, simulated batteries and solar give no supply this cycle',
      );
    }
    simulation = {
      latitudeDeg,
      longitudeDeg,
      timeZone,
      dispatch: simulatedBatteryDispatch(siteType),
      deficitKw: demandAboveGridKw(roots),
    };
  }

  for (const asset of connected) {
    const atTransformer = asset.connectionTransformerId != null;
    const node = atTransformer
      ? transformerNodesById.get(asset.connectionTransformerId ?? '')
      : panelNodesById.get(asset.connectionPanelId ?? '');
    // A transformer outside the tree (unrated or unlinked): counts nowhere.
    if (node == null) continue;
    const reading = assetReading(asset, readings.get(asset.id), nowMs, simulation);
    const supplyInput = {
      type: asset.type,
      inverterKw: asset.inverterKw != null ? Number(asset.inverterKw) : null,
      peakKwp: asset.peakKwp,
      maxDischargeKw: asset.maxDischargeKw != null ? Number(asset.maxDischargeKw) : null,
      maxChargeKw: asset.maxChargeKw != null ? Number(asset.maxChargeKw) : null,
      gridCharging: asset.gridCharging,
      reservePercent: asset.reservePercent,
      ttlSeconds: asset.readingTtlSeconds,
    };
    const supply = energyAssetSupply({ ...supplyInput, reading }, nowMs);
    // The supply once the reading is stale: what the limits sent without an
    // end date must hold to (security case 334).
    const fallback =
      supply.state === 'fresh'
        ? energyAssetSupply({ ...supplyInput, reading: null }, nowMs)
        : supply;

    // Load at the connection point (it counts above it through the tree). An
    // unknown load (an unrated battery that may charge from the grid and has
    // no fresh reading, stored before the writer refused it) counts as the
    // connection point's whole continuous capacity: its grid charging passes
    // that point's protection, so it cannot draw more, and less would be a
    // guess that could exceed the limits while it charges (D9).
    const loadKw = supply.loadKw ?? Math.max(0, node.maxContinuousKw);
    if (supply.loadKw == null) {
      (options.log ?? logger).warn(
        { siteId, energyAssetId: asset.id, connectionId: node.id },
        'Battery without a charge or inverter rating, it counts as a load of its whole connection point',
      );
    }
    if (loadKw > 0) {
      node.supplyLoadKw = (node.supplyLoadKw ?? 0) + loadKw;
      if (asset.phases !== 3) {
        node.supplySinglePhaseLoadKw = (node.supplySinglePhaseLoadKw ?? 0) + loadKw;
      }
    }
    const fallbackLoadKw = fallback.loadKw ?? Math.max(0, node.maxContinuousKw);
    if (fallbackLoadKw > 0) {
      node.fallbackSupplyLoadKw = (node.fallbackSupplyLoadKw ?? 0) + fallbackLoadKw;
      if (asset.phases !== 3) {
        node.fallbackSupplySinglePhaseLoadKw =
          (node.fallbackSupplySinglePhaseLoadKw ?? 0) + fallbackLoadKw;
      }
    }

    // Credit: a supply-side asset on its transformer only, a load-side one on
    // every strict ancestor of its panel (D8), bottom-up. A single-phase asset
    // gives no per-phase credit. A three-phase asset at a single-phase point
    // (made single-phase after the asset connected: the writer refuses it on
    // a write) gives no credit at all: its power flows on that point's phases
    // only, which the CSMS cannot tell. A three-phase asset gives per-phase
    // credit only while every node from its connection point up to the
    // credited one is three-phase: a single-phase node on the path carries
    // the power on its own phases only, so crediting all three phases above
    // it would raise phases the asset does not feed.
    const credited: HierarchyNode[] = [];
    if (atTransformer) {
      credited.push(node);
    } else {
      for (let up = parentOf.get(node); up != null; up = parentOf.get(up)) credited.push(up);
    }
    const phaseMismatch = asset.phases === 3 && node.phases !== 3;
    if (phaseMismatch) {
      (options.log ?? logger).warn(
        { siteId, energyAssetId: asset.id, connectionId: node.id },
        'Three-phase energy asset at a single-phase connection point, it gives no credit',
      );
    }
    const creditApplied = supply.creditKw > 0 && credited.length > 0 && !phaseMismatch;
    if (creditApplied) {
      let threePhasePath = asset.phases === 3;
      for (const target of credited) {
        threePhasePath = threePhasePath && target.phases === 3;
        target.supplyCreditKw = (target.supplyCreditKw ?? 0) + supply.creditKw;
        if (threePhasePath) addPhaseCredit(target, supply.creditKw / 3);
      }
    }

    const entry: EnergyAssetNodeSupply = {
      id: asset.id,
      name: asset.name,
      type: asset.type,
      phases: asset.phases,
      telemetry: asset.telemetry,
      connection: atTransformer ? 'transformer' : 'panel',
      state: supply.state,
      creditKw: supply.creditKw,
      loadKw,
      creditApplied,
      readingReceivedAt: reading != null ? new Date(reading.receivedAtMs) : null,
      socPercent: reading?.socPercent ?? null,
      freshUntil:
        supply.state === 'fresh' && reading != null
          ? new Date(energyAssetReadingFreshUntilMs(reading, asset.readingTtlSeconds))
          : null,
    };
    node.energyAssets = [...(node.energyAssets ?? []), entry];
  }
  return knowledge;
}

export interface SiteHierarchyOptions {
  /** The time the supply readings are judged at (freshness). Default: now. */
  nowMs?: number;
  log?: ServiceLogger;
  /**
   * Whether this process computes readings for `simulated` telemetry
   * (ENERGY_ASSETS_ALLOW_SIMULATED, owner decision D13). Default: false, so a
   * simulated asset has no reading.
   */
  allowSimulatedEnergyAssets?: boolean;
}

/**
 * Build the hierarchy tree of a site: service transformers (rated, linked by a
 * top-level panel) as roots above the top-level panels that name them, the
 * other top-level panels as roots, sub-panels below their parent panel or
 * below the step-down transformer between them (rated, fed from that parent),
 * circuits below their panel, stations below their circuit. An unrated or
 * unlinked transformer is not in the tree.
 *
 * Batteries and solar give their supply (`energyAssetSupply`) where they
 * connect: their load counts at the connection node (and so above it), their
 * credit on the strict ancestors of a load-side panel and on a supply-side
 * transformer only (owner decision D8). A failed read of the readings counts
 * every asset as without data (no credit, a battery that may charge from the
 * grid as a load, D9): a security control never turns off on a read error.
 * A failed read of the assets themselves: see `applyEnergyAssets`.
 */
export async function buildSiteHierarchy(
  siteId: string,
  stationInfos: StationPowerInfo[],
  options: SiteHierarchyOptions = {},
): Promise<HierarchyNode[]> {
  return (await buildSiteHierarchyWithAssets(siteId, stationInfos, options)).roots;
}

/**
 * `buildSiteHierarchy` plus how its energy assets were known
 * (`EnergyAssetsKnowledge`): an `unknown` tree may only cut limits.
 */
export async function buildSiteHierarchyWithAssets(
  siteId: string,
  stationInfos: StationPowerInfo[],
  options: SiteHierarchyOptions = {},
): Promise<{ roots: HierarchyNode[]; energyAssets: EnergyAssetsKnowledge }> {
  const nowMs = options.nowMs ?? Date.now();
  // Query all panels for site
  const panelRows: PanelRow[] = await db
    .select({
      id: panels.id,
      parentPanelId: panels.parentPanelId,
      name: panels.name,
      breakerRatingAmps: panels.breakerRatingAmps,
      voltageV: panels.voltageV,
      phases: panels.phases,
      maxContinuousKw: panels.maxContinuousKw,
      safetyMarginKw: panels.safetyMarginKw,
      oversubscriptionRatio: panels.oversubscriptionRatio,
      phaseConnections: panels.phaseConnections,
      transformerId: panels.transformerId,
    })
    .from(panels)
    .where(eq(panels.siteId, siteId))
    // A stable sibling order (the Load Management tab order), so the tree and the
    // charging plan built on it do not change shape after an update.
    .orderBy(asc(panels.sortOrder), asc(panels.createdAt), asc(panels.id));

  if (panelRows.length === 0) {
    return { roots: [], energyAssets: 'read' };
  }

  const panelIds = panelRows.map((p) => p.id);

  // Query all circuits for these panels
  const circuitRows: CircuitRow[] = await db
    .select({
      id: circuits.id,
      panelId: circuits.panelId,
      name: circuits.name,
      breakerRatingAmps: circuits.breakerRatingAmps,
      maxContinuousKw: circuits.maxContinuousKw,
      phaseConnections: circuits.phaseConnections,
      voltageV: circuits.voltageV,
    })
    .from(circuits)
    .where(inArray(circuits.panelId, panelIds))
    .orderBy(asc(circuits.sortOrder), asc(circuits.createdAt), asc(circuits.id));

  const circuitIds = circuitRows.map((c) => c.id);

  // Query all unmanaged loads
  const loadRows: UnmanagedLoadRow[] = await db
    .select({
      panelId: unmanagedLoads.panelId,
      circuitId: unmanagedLoads.circuitId,
      name: unmanagedLoads.name,
      estimatedDrawKw: unmanagedLoads.estimatedDrawKw,
    })
    .from(unmanagedLoads)
    .where(
      sql`${unmanagedLoads.panelId} IN (${sql.join(
        panelIds.map((id) => sql`${id}`),
        sql`,`,
      )}) OR ${unmanagedLoads.circuitId} IN (${sql.join(circuitIds.length > 0 ? circuitIds.map((id) => sql`${id}`) : [sql`'__none__'`], sql`,`)})`,
    );

  // Index stations by circuitId
  const stationsByCircuit = new Map<string, StationPowerInfo[]>();
  for (const station of stationInfos) {
    if (station.circuitId == null) continue;
    const list = stationsByCircuit.get(station.circuitId) ?? [];
    list.push(station);
    stationsByCircuit.set(station.circuitId, list);
  }

  // Index unmanaged loads by panelId and circuitId
  const loadsByPanel = new Map<string, UnmanagedLoadRow[]>();
  const loadsByCircuit = new Map<string, UnmanagedLoadRow[]>();
  for (const load of loadRows) {
    if (load.panelId != null) {
      const list = loadsByPanel.get(load.panelId) ?? [];
      list.push(load);
      loadsByPanel.set(load.panelId, list);
    }
    if (load.circuitId != null) {
      const list = loadsByCircuit.get(load.circuitId) ?? [];
      list.push(load);
      loadsByCircuit.set(load.circuitId, list);
    }
  }

  // Index panels by id for circuit lookups
  const panelRowById = new Map<string, PanelRow>();
  for (const panel of panelRows) {
    panelRowById.set(panel.id, panel);
  }

  // Build circuit nodes
  const circuitNodesByPanel = new Map<string, HierarchyNode[]>();
  for (const circuit of circuitRows) {
    const circuitStations = stationsByCircuit.get(circuit.id) ?? [];
    const circuitLoads = loadsByCircuit.get(circuit.id) ?? [];
    const unmanagedKw = circuitLoads.reduce((sum, l) => sum + Number(l.estimatedDrawKw), 0);
    const currentDrawKw =
      circuitStations.reduce((sum, s) => sum + s.currentDrawKw, 0) + unmanagedKw;
    const parentPanel = panelRowById.get(circuit.panelId);
    // A station that takes A gets its limit in A on a circuit of two or three
    // conductor phases (chargingRateUnitFor). Set on the shared station object
    // so the load management view shows the unit sent.
    const conductorPhases = circuitConductorPhases(
      circuit.phaseConnections,
      parentPanel?.phases ?? 1,
    );
    for (const station of circuitStations) {
      if (station.supportedRateUnits != null && station.supportedRateUnits.length > 0) {
        station.rateUnit = chargingRateUnitFor(station.supportedRateUnits, conductorPhases);
      }
    }

    const node: HierarchyNode = {
      type: 'circuit',
      id: circuit.id,
      name: circuit.name,
      maxContinuousKw: Number(circuit.maxContinuousKw),
      safetyMarginKw: 0,
      unmanagedLoadKw: unmanagedKw,
      currentDrawKw,
      stations: circuitStations,
      children: [],
      phases: parentPanel?.phases ?? 1,
      breakerRatingAmps: circuit.breakerRatingAmps,
      // A circuit can run below its single-phase panel's voltage (a 120 V
      // branch of a 240 V split-phase panel): limits in A use it.
      voltageV: effectiveCircuitVoltageV(
        circuit.voltageV,
        parentPanel?.voltageV ?? 240,
        parentPanel?.phases ?? 1,
      ),
      oversubscriptionRatio: 1.0,
      phaseConnections: circuit.phaseConnections,
      phaseLoad: null,
      perPhaseCapacityKw: null,
      ownVoltageV: circuit.voltageV,
    };

    const list = circuitNodesByPanel.get(circuit.panelId) ?? [];
    list.push(node);
    circuitNodesByPanel.set(circuit.panelId, list);
  }

  await applyLocalGeneration([...circuitNodesByPanel.values()].flat(), nowMs);

  // Build panel nodes (with sub-panel support)
  const panelNodesById = new Map<string, HierarchyNode>();
  for (const panel of panelRows) {
    const panelLoads = loadsByPanel.get(panel.id) ?? [];
    const unmanagedKw = panelLoads.reduce((sum, l) => sum + Number(l.estimatedDrawKw), 0);
    const circuitChildren = circuitNodesByPanel.get(panel.id) ?? [];
    const isThreePhase = panel.phases === 3;
    const perPhaseCapacityKw = isThreePhase
      ? (panel.breakerRatingAmps * panel.voltageV * 0.8) / 1000
      : null;

    const node: HierarchyNode = {
      type: 'panel',
      id: panel.id,
      name: panel.name,
      maxContinuousKw: Number(panel.maxContinuousKw),
      safetyMarginKw: Number(panel.safetyMarginKw),
      unmanagedLoadKw: unmanagedKw,
      currentDrawKw: 0, // computed below
      stations: [],
      children: circuitChildren,
      phases: panel.phases,
      breakerRatingAmps: panel.breakerRatingAmps,
      voltageV: panel.voltageV,
      oversubscriptionRatio: Number(panel.oversubscriptionRatio),
      phaseConnections: panel.phaseConnections,
      phaseLoad: isThreePhase ? { L1: 0, L2: 0, L3: 0 } : null,
      perPhaseCapacityKw,
    };

    panelNodesById.set(panel.id, node);
  }

  const transformerRows: TransformerRow[] = await db
    .select({
      id: transformers.id,
      kind: transformers.kind,
      name: transformers.name,
      phases: transformers.phases,
      secondaryVoltageV: transformers.secondaryVoltageV,
      safetyMarginKw: transformers.safetyMarginKw,
      fedFromPanelId: transformers.fedFromPanelId,
      maxContinuousKw: transformers.maxContinuousKw,
    })
    .from(transformers)
    .where(eq(transformers.siteId, siteId))
    .orderBy(asc(transformers.sortOrder), asc(transformers.createdAt), asc(transformers.id));
  const transformerRowById = new Map(transformerRows.map((t) => [t.id, t]));

  // Transformer nodes, built the first time a panel links one.
  const transformerNodesById = new Map<string, HierarchyNode>();
  const transformerNode = (row: TransformerRow, voltageV: number): HierarchyNode => {
    const existing = transformerNodesById.get(row.id);
    if (existing != null) return existing;
    const maxContinuousKw = Number(row.maxContinuousKw);
    const node: HierarchyNode = {
      type: 'transformer',
      transformerKind: row.kind,
      id: row.id,
      name: row.name,
      maxContinuousKw,
      safetyMarginKw: Number(row.safetyMarginKw),
      unmanagedLoadKw: 0,
      currentDrawKw: 0,
      stations: [],
      children: [],
      phases: row.phases,
      breakerRatingAmps: 0,
      voltageV: row.secondaryVoltageV ?? voltageV,
      oversubscriptionRatio: 1,
      phaseConnections: null,
      phaseLoad: row.phases === 3 ? { L1: 0, L2: 0, L3: 0 } : null,
      perPhaseCapacityKw: row.phases === 3 ? maxContinuousKw / 3 : null,
    };
    transformerNodesById.set(row.id, node);
    return node;
  };
  // The transformer a panel links, when it is a valid link: rated, of the
  // right kind, and a step-down unit fed from the panel's parent.
  const linkedTransformer = (panel: PanelRow): TransformerRow | null => {
    if (panel.transformerId == null) return null;
    const row = transformerRowById.get(panel.transformerId);
    if (row == null || row.maxContinuousKw == null) return null;
    if (panel.parentPanelId == null) return row.kind === 'service' ? row : null;
    return row.kind === 'step_down' && row.fedFromPanelId === panel.parentPanelId ? row : null;
  };

  // Wire sub-panels and compute root list
  const roots: HierarchyNode[] = [];
  const parentOf = new Map<HierarchyNode, HierarchyNode>();
  const attach = (parent: HierarchyNode, child: HierarchyNode): void => {
    parent.children.push(child);
    parentOf.set(child, parent);
  };
  for (const panel of panelRows) {
    const node = panelNodesById.get(panel.id);
    if (node == null) continue;
    const parent = panel.parentPanelId != null ? panelNodesById.get(panel.parentPanelId) : null;
    const transformer = linkedTransformer(panel);
    if (parent != null) {
      if (transformer != null) {
        const known = transformerNodesById.has(transformer.id);
        const tx = transformerNode(transformer, panel.voltageV);
        if (!known) attach(parent, tx);
        attach(tx, node);
      } else {
        attach(parent, node);
      }
    } else if (panel.parentPanelId == null && transformer != null) {
      const known = transformerNodesById.has(transformer.id);
      const tx = transformerNode(transformer, panel.voltageV);
      if (!known) roots.push(tx);
      attach(tx, node);
    } else {
      roots.push(node);
    }
  }

  const energyAssets = await applyEnergyAssets(
    siteId,
    nowMs,
    panelNodesById,
    transformerNodesById,
    parentOf,
    roots,
    options,
  );

  // Compute currentDrawKw for panels bottom-up, including per-phase tracking
  function computePanelDraw(node: HierarchyNode): number {
    let draw = ownFixedKw(node);
    for (const child of node.children) {
      if (child.type === 'circuit') {
        draw += child.currentDrawKw;
        // Accumulate per-phase load on three-phase panels
        if (node.phaseLoad != null) {
          const { phases, share } = circuitPhaseShare(child.phaseConnections, node.phases);
          for (const phase of phases) {
            node.phaseLoad[phase] += child.currentDrawKw * share;
          }
        }
      } else {
        const childDraw = computePanelDraw(child);
        draw += childDraw;
        // Propagate child panel phase load to parent. A single-phase
        // sub-panel tracks no phases: its draw counts on every phase.
        if (node.phaseLoad != null) {
          if (child.phaseLoad != null && mapsThroughStepDown(node, child)) {
            const primary = stepDownPrimaryPhases(child.phaseLoad);
            node.phaseLoad.L1 += primary.L1;
            node.phaseLoad.L2 += primary.L2;
            node.phaseLoad.L3 += primary.L3;
          } else if (child.phaseLoad != null) {
            node.phaseLoad.L1 += child.phaseLoad.L1;
            node.phaseLoad.L2 += child.phaseLoad.L2;
            node.phaseLoad.L3 += child.phaseLoad.L3;
          } else {
            const { phases, share } = subPanelPhaseShare(node, child);
            for (const phase of phases) node.phaseLoad[phase] += childDraw * share;
          }
        }
      }
    }
    node.currentDrawKw = draw;
    return draw;
  }

  for (const root of roots) {
    computePanelDraw(root);
  }

  return { roots, energyAssets };
}

// Floating point slack for kW comparisons.
const EPSILON_KW = 1e-9;

/**
 * Order in which stations keep power: higher `loadPriority` first, then the
 * earlier departure, then the input order. The last one stops first when the
 * minimums do not fit.
 */
function byPriority(stations: readonly StationPowerInfo[]): StationPowerInfo[] {
  return stations
    .map((station, index) => ({ station, index }))
    .sort((a, b) => {
      if (b.station.loadPriority !== a.station.loadPriority) {
        return b.station.loadPriority - a.station.loadPriority;
      }
      const ad = a.station.departureTime;
      const bd = b.station.departureTime;
      if (ad != null && bd != null && ad.getTime() !== bd.getTime()) {
        return ad.getTime() - bd.getTime();
      }
      if (ad != null && bd == null) return -1;
      if (bd != null && ad == null) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.station);
}

// A station's minimum, never above its known maximum.
function stationMinKw(station: StationPowerInfo): number {
  const min = Math.max(0, station.minPowerKw);
  return station.maxPowerKw > 0 ? Math.min(min, station.maxPowerKw) : min;
}

/**
 * Water-filling: the level L with sum(clamp(L, lo, hi)) = budget, each item
 * getting clamp(L, lo, hi). Assumes sum(lo) <= budget.
 */
function waterFill(items: ReadonlyArray<{ lo: number; hi: number }>, budget: number): number[] {
  const totalHi = items.reduce((sum, i) => sum + i.hi, 0);
  if (totalHi <= budget) return items.map((i) => i.hi);
  const used = (level: number): number =>
    items.reduce((sum, i) => sum + Math.min(i.hi, Math.max(i.lo, level)), 0);
  // f(level) is piecewise linear between the item bounds: find the segment
  // that reaches the budget and solve on it, exactly.
  const points = [...new Set(items.flatMap((i) => [i.lo, i.hi]))].sort((a, b) => a - b);
  let level = points[0] ?? 0;
  for (let k = 0; k < points.length - 1; k++) {
    const start = points[k] ?? 0;
    const end = points[k + 1] ?? start;
    if (used(end) >= budget) {
      const slope = items.filter((i) => i.lo <= start && i.hi >= end).length;
      level = slope > 0 ? start + (budget - used(start)) / slope : start;
      break;
    }
  }
  return items.map((i) => Math.min(i.hi, Math.max(i.lo, level)));
}

/**
 * Stations whose minimums fit in `availableKw`, in priority order. The rest
 * stop (limit 0), lowest priority first.
 */
function admitByMinimum(
  stations: readonly StationPowerInfo[],
  availableKw: number,
): { admitted: StationPowerInfo[]; stopped: StationPowerInfo[] } {
  const admitted: StationPowerInfo[] = [];
  const stopped: StationPowerInfo[] = [];
  let minTotal = 0;
  for (const station of byPriority(stations)) {
    const min = stationMinKw(station);
    if (minTotal + min <= availableKw + EPSILON_KW) {
      admitted.push(station);
      minTotal += min;
    } else {
      stopped.push(station);
    }
  }
  return { admitted, stopped };
}

function toResult(station: StationPowerInfo, allocatedKw: number): AllocationResult {
  return {
    stationId: station.stationId,
    stationDbId: station.id,
    allocatedKw,
    currentDrawKw: station.currentDrawKw,
  };
}

/**
 * Distribute available power equally among active online stations within a
 * circuit. Each station gets at least its minimum and at most its maximum
 * (a station of unknown maximum is capped at its equal share); the surplus of
 * capped stations goes to the others. When the minimums do not fit, the
 * lowest priority stations stop (allocation 0).
 */
export function computeEqualShareAllocation(
  stations: StationPowerInfo[],
  availableKw: number,
): AllocationResult[] {
  const active = stations.filter((s) => s.hasActiveSession && s.isOnline);
  if (active.length === 0) return [];
  const available = Math.max(0, availableKw);
  const { admitted, stopped } = admitByMinimum(active, available);
  const unknownCap = admitted.length > 0 ? available / admitted.length : 0;
  const levels = waterFill(
    admitted.map((s) => {
      const lo = stationMinKw(s);
      return { lo, hi: Math.max(lo, s.maxPowerKw > 0 ? s.maxPowerKw : unknownCap) };
    }),
    available,
  );
  return [
    ...admitted.map((s, i) => toResult(s, levels[i] ?? 0)),
    ...stopped.map((s) => toResult(s, 0)),
  ];
}

/**
 * Distribute available power by priority among active online stations. Every
 * admitted station first gets its minimum; higher priority groups then take
 * the rest first, equal share within a group (secondary order: earlier
 * departure). When the minimums do not fit, the lowest priority stations stop.
 */
export function computePriorityAllocation(
  stations: StationPowerInfo[],
  availableKw: number,
): AllocationResult[] {
  const active = stations.filter((s) => s.hasActiveSession && s.isOnline);
  if (active.length === 0) return [];
  const available = Math.max(0, availableKw);
  const { admitted, stopped } = admitByMinimum(active, available);

  const allocated = new Map(admitted.map((s) => [s.id, stationMinKw(s)]));
  let remaining = available - [...allocated.values()].reduce((sum, v) => sum + v, 0);

  const priorityGroups = new Map<number, StationPowerInfo[]>();
  for (const station of admitted) {
    const group = priorityGroups.get(station.loadPriority) ?? [];
    group.push(station);
    priorityGroups.set(station.loadPriority, group);
  }
  for (const priority of [...priorityGroups.keys()].sort((a, b) => b - a)) {
    const group = priorityGroups.get(priority) ?? [];
    const groupMin = group.reduce((sum, s) => sum + (allocated.get(s.id) ?? 0), 0);
    const budget = Math.max(0, remaining) + groupMin;
    const unknownCap = budget / group.length;
    const levels = waterFill(
      group.map((s) => {
        const lo = stationMinKw(s);
        return { lo, hi: Math.max(lo, s.maxPowerKw > 0 ? s.maxPowerKw : unknownCap) };
      }),
      budget,
    );
    group.forEach((s, i) => allocated.set(s.id, levels[i] ?? 0));
    remaining = budget - levels.reduce((sum, v) => sum + v, 0);
  }

  return [
    ...admitted.map((s) => toResult(s, allocated.get(s.id) ?? 0)),
    ...stopped.map((s) => toResult(s, 0)),
  ];
}

/**
 * Bring the allocations of `entries` down to `targetKw` in total. Above their
 * minimums they shrink proportionally; when the minimums alone exceed the
 * target, the lowest priority stations stop first (allocation 0). With no
 * minimums this is a proportional scale.
 */
export function reduceAllocations(
  entries: ReadonlyArray<{ station: StationPowerInfo; alloc: AllocationResult }>,
  targetKw: number,
): void {
  const target = Math.max(0, targetKw);
  const live = entries.filter((e) => e.alloc.allocatedKw > 0);
  let total = live.reduce((sum, e) => sum + e.alloc.allocatedKw, 0);
  if (total <= target + EPSILON_KW) return;

  const minOf = (e: { station: StationPowerInfo; alloc: AllocationResult }): number =>
    Math.min(stationMinKw(e.station), e.alloc.allocatedKw);
  const keep = new Set(live);
  let minTotal = live.reduce((sum, e) => sum + minOf(e), 0);
  const order = byPriority(live.map((e) => e.station));
  for (let i = order.length - 1; i >= 0 && minTotal > target + EPSILON_KW; i--) {
    const entry = live.find((e) => e.station === order[i]);
    if (entry == null) continue;
    minTotal -= minOf(entry);
    total -= entry.alloc.allocatedKw;
    entry.alloc.allocatedKw = 0;
    keep.delete(entry);
  }
  if (total <= target + EPSILON_KW) return;

  const kept = [...keep];
  const mins = kept.map(minOf);
  const extra = total - mins.reduce((sum, v) => sum + v, 0);
  const factor = extra > 0 ? Math.max(0, target - (total - extra)) / extra : 0;
  kept.forEach((e, i) => {
    const min = mins[i] ?? 0;
    e.alloc.allocatedKw = min + (e.alloc.allocatedKw - min) * factor;
  });
}

/**
 * Load that the allocation cannot change, in kW: the unmanaged loads of the
 * node and of every node below it, plus the reservation of each offline
 * station that still has an active session (it keeps charging at the limit it
 * last received, so its power is not free for the others).
 */
export function fixedLoadKw(node: HierarchyNode, reservedKw: ReadonlyMap<string, number>): number {
  let fixed = ownFixedKw(node);
  for (const station of node.stations) {
    fixed += reservedKw.get(station.id) ?? 0;
  }
  for (const child of node.children) {
    fixed += fixedLoadKw(child, reservedKw);
  }
  return fixed;
}

// Fixed load per phase below a three-phase panel. A circuit's fixed load is
// shared over the phases it uses like its station load (circuitPhaseShare).
// A three-phase battery's load is spread like the panel's own load, a
// single-phase one counts in full on every phase; a step-down transformer's
// secondary phases map onto the panel's phases (`stepDownPrimaryPhases`).
export function fixedPhaseLoad(
  node: HierarchyNode,
  reservedKw: ReadonlyMap<string, number>,
  into: PhaseLoad,
): void {
  const single = node.supplySinglePhaseLoadKw ?? 0;
  const spread = node.unmanagedLoadKw + (node.supplyLoadKw ?? 0) - single;
  if (spread > 0 || single > 0) {
    for (const phase of ALL_PHASES) {
      into[phase] += spread * panelOwnPhaseShare(node.phases) + single;
    }
  }
  for (const child of node.children) {
    if (mapsThroughStepDown(node, child)) {
      const secondary: PhaseLoad = { L1: 0, L2: 0, L3: 0 };
      fixedPhaseLoad(child, reservedKw, secondary);
      const primary = stepDownPrimaryPhases(secondary);
      for (const phase of ALL_PHASES) into[phase] += primary[phase];
    } else if (child.type === 'circuit') {
      const { phases, share } = circuitPhaseShare(child.phaseConnections, node.phases);
      const fixed = fixedLoadKw(child, reservedKw);
      for (const phase of phases) into[phase] += fixed * share;
    } else if (node.phases === 3 && child.phases !== 3 && child.phaseConnections != null) {
      // A single-phase sub-panel that names its feeding phases loads only those.
      const { phases, share } = subPanelPhaseShare(node, child);
      const fixed = fixedLoadKw(child, reservedKw);
      for (const phase of phases) into[phase] += fixed * share;
    } else {
      fixedPhaseLoad(child, reservedKw, into);
    }
  }
}

/**
 * Fixed load of a panel for its capacity check, in kW at the panel voltage:
 * like `fixedLoadKw`, with each circuit weighted by `legWeight`.
 */
export function weightedFixedKw(
  node: HierarchyNode,
  reservedKw: ReadonlyMap<string, number>,
): number {
  let fixed = ownFixedKw(node);
  for (const station of node.stations) {
    fixed += reservedKw.get(station.id) ?? 0;
  }
  for (const child of node.children) {
    fixed +=
      child.type === 'circuit'
        ? fixedLoadKw(child, reservedKw) * legWeight(node, child)
        : weightedFixedKw(child, reservedKw);
  }
  return fixed;
}

/**
 * Compute hierarchical allocation respecting panel and circuit constraints.
 *
 * Algorithm:
 * 1. For each leaf circuit: allocate among active online stations using the
 *    strategy, within the circuit capacity minus its fixed load (unmanaged
 *    loads and the reservations of offline stations).
 * 2. For each panel (bottom-up): the stations get at most the panel capacity
 *    minus the safety margin and every fixed load below the panel (its own
 *    unmanaged loads, those of its circuits and sub-panels, and the
 *    reservations). Above that, scale all station allocations down
 *    proportionally. On a three-phase panel, then scale the circuits of each
 *    overloaded phase.
 * 3. Return final per-station allocations, never negative.
 *
 * `reservedKw` maps a station database id to the power kept for it while it
 * is offline with an active session.
 *
 * `planned` (departure-aware sites): `kw` maps a station to the power the depot
 * plan gives its planned sessions in the current slot, capped at the station
 * maximum. Such a station gets that power first; the other stations of the
 * circuit share what is left, and a planned station in `sharing` (it also has
 * an unplanned session) takes part in that share on top of its planned power.
 * `minKw` raises the planned station's minimum (the 6 A floor of its AC
 * sessions), so the panel and phase limits, which cut everything alike, never
 * cut a planned session below it: they stop the station instead.
 */
export function computeHierarchicalAllocation(
  roots: HierarchyNode[],
  strategy: LoadAllocationStrategy,
  reservedKw: ReadonlyMap<string, number> = new Map(),
  planned: PlannedAllocationInput = {},
): AllocationResult[] {
  const plannedKw = planned.kw ?? new Map<string, number>();
  const sharingPlanned = planned.sharing ?? new Set<string>();
  const plannedMinKw = planned.minKw ?? new Map<string, number>();
  // Mutable map: stationDbId -> allocatedKw
  const allocationMap = new Map<string, AllocationResult>();
  // Planned stations as the reductions see them: their minimum raised.
  const effective = new Map<string, StationPowerInfo>();
  const effectiveStation = (station: StationPowerInfo): StationPowerInfo =>
    effective.get(station.id) ?? station;

  // Pass 1: Allocate within each circuit
  function allocateCircuit(circuit: HierarchyNode): void {
    const capacity = Math.max(0, circuit.maxContinuousKw - fixedLoadKw(circuit, reservedKw));
    // A station with a reservation (offline, or a limit it has not accepted)
    // is a fixed load and gets no allocation.
    const allocatable = circuit.stations.filter((s) => !reservedKw.has(s.id));
    const plannedStations = allocatable.filter(
      (s) => plannedKw.has(s.id) && s.isOnline && s.hasActiveSession,
    );
    const plannedIds = new Set(plannedStations.map((s) => s.id));
    const plannedEntries = plannedStations.map((station) => {
      const raised = {
        ...station,
        minPowerKw: Math.max(station.minPowerKw, plannedMinKw.get(station.id) ?? 0),
      };
      effective.set(station.id, raised);
      const kw = Math.max(0, plannedKw.get(station.id) ?? 0);
      return {
        station: raised,
        alloc: toResult(station, station.maxPowerKw > 0 ? Math.min(kw, station.maxPowerKw) : kw),
      };
    });
    // A plan read before a capacity change can ask for more than the circuit holds.
    reduceAllocations(plannedEntries, capacity);
    const plannedTotal = plannedEntries.reduce((sum, e) => sum + e.alloc.allocatedKw, 0);
    const available = Math.max(0, capacity - plannedTotal);
    const plannedPartKw = new Map(plannedEntries.map((e) => [e.station.id, e.alloc.allocatedKw]));

    const sharers: StationPowerInfo[] = [];
    for (const station of allocatable) {
      if (!plannedIds.has(station.id)) {
        sharers.push(station);
        continue;
      }
      if (!sharingPlanned.has(station.id)) continue;
      const plannedPart = plannedPartKw.get(station.id) ?? 0;
      if (station.maxPowerKw <= 0) {
        sharers.push({ ...station, minPowerKw: 0 });
      } else if (station.maxPowerKw - plannedPart > EPSILON_KW) {
        sharers.push({ ...station, maxPowerKw: station.maxPowerKw - plannedPart, minPowerKw: 0 });
      }
    }
    const circuitAllocations =
      strategy === 'priority_based'
        ? computePriorityAllocation(sharers, available)
        : computeEqualShareAllocation(sharers, available);

    for (const entry of plannedEntries) {
      allocationMap.set(entry.station.id, entry.alloc);
    }
    for (const alloc of circuitAllocations) {
      const plannedAlloc = allocationMap.get(alloc.stationDbId);
      if (plannedAlloc != null && plannedIds.has(alloc.stationDbId)) {
        plannedAlloc.allocatedKw += alloc.allocatedKw;
      } else {
        allocationMap.set(alloc.stationDbId, alloc);
      }
    }
  }

  // Station allocations below a panel, in kW at the panel voltage: each
  // circuit weighted by `legWeight` (1 unless it runs below the voltage of
  // its single-phase panel).
  function stationAllocatedKw(node: HierarchyNode): number {
    let total = 0;
    for (const station of node.stations) {
      total += allocationMap.get(station.id)?.allocatedKw ?? 0;
    }
    for (const child of node.children) {
      total += stationAllocatedKw(child) * legWeight(node, child);
    }
    return total;
  }

  // Pass 2: Enforce panel constraints bottom-up
  function enforcePanel(panel: HierarchyNode): void {
    for (const child of panel.children) {
      if (child.type === 'circuit') {
        allocateCircuit(child);
      } else {
        enforcePanel(child);
      }
    }

    // A panel or a transformer: its capacity plus any supply credit
    // (`nodeCapacityKw`), less every fixed load below it.
    const panelAvailable = Math.max(0, nodeCapacityKw(panel) - weightedFixedKw(panel, reservedKw));
    // Without lower-voltage circuits the weighted demand is the plain total
    // and one cut fits. With them, a cut changes the mix, so measure again.
    for (let attempt = 0; attempt < 10; attempt++) {
      const stationDemand = stationAllocatedKw(panel);
      if (stationDemand <= panelAvailable + EPSILON_KW || stationDemand <= 0) break;
      const entries = entriesUnder(panel, null);
      const total = entries.reduce((sum, e) => sum + e.alloc.allocatedKw, 0);
      reduceAllocations(entries, (total * panelAvailable) / stationDemand);
    }

    // For three-phase panels, check per-phase constraints on the scaled
    // allocations. Each phase is measured again after the previous phase's
    // scaling, so a circuit on two overloaded phases is not cut twice.
    if (panel.phases === 3 && panel.perPhaseCapacityKw != null) {
      const fixedPhases: PhaseLoad = { L1: 0, L2: 0, L3: 0 };
      fixedPhaseLoad(panel, reservedKw, fixedPhases);
      for (const phase of ['L1', 'L2', 'L3'] as const) {
        const perPhaseLimit = Math.max(
          0,
          panel.perPhaseCapacityKw -
            panel.safetyMarginKw / 3 -
            fixedPhases[phase] +
            (panel.supplyPhaseCreditKw?.[phase] ?? 0),
        );
        // Reduce only the circuits on this overloaded phase. A circuit on two
        // or three phases loads this one with part of its power, so measure
        // again until the phase fits (stopping a station changes the mix).
        for (let attempt = 0; attempt < 10; attempt++) {
          const phaseAllocated: PhaseLoad = { L1: 0, L2: 0, L3: 0 };
          computePhaseAllocations(panel, phaseAllocated, allocationMap);
          if (phaseAllocated[phase] <= perPhaseLimit + 1e-9 || phaseAllocated[phase] <= 0) break;
          const entries = entriesUnder(panel, phase);
          const total = entries.reduce((sum, e) => sum + e.alloc.allocatedKw, 0);
          reduceAllocations(entries, (total * perPhaseLimit) / phaseAllocated[phase]);
        }
      }
    }
  }

  // The allocated stations under a node, only those on circuits using
  // `phase` when one is given.
  function entriesUnder(
    node: HierarchyNode,
    phase: 'L1' | 'L2' | 'L3' | null,
  ): Array<{ station: StationPowerInfo; alloc: AllocationResult }> {
    const result: Array<{ station: StationPowerInfo; alloc: AllocationResult }> = [];
    for (const child of node.children) {
      if (phase != null && mapsThroughStepDown(node, child)) {
        // A primary phase carries two secondary phases of a step-down unit.
        const seen = new Set<string>();
        for (const secondary of STEP_DOWN_SECONDARY_OF[phase]) {
          for (const entry of entriesUnder(child, secondary)) {
            if (seen.has(entry.alloc.stationDbId)) continue;
            seen.add(entry.alloc.stationDbId);
            result.push(entry);
          }
        }
      } else if (child.type === 'circuit') {
        if (
          phase != null &&
          !circuitPhaseShare(child.phaseConnections, node.phases).phases.includes(phase)
        ) {
          continue;
        }
        for (const station of child.stations) {
          const alloc = allocationMap.get(station.id);
          if (alloc != null) result.push({ station: effectiveStation(station), alloc });
        }
      } else {
        // A single-phase sub-panel that names its feeding phases loads only those.
        if (
          phase != null &&
          node.phases === 3 &&
          child.phases !== 3 &&
          !subPanelPhaseShare(node, child).phases.includes(phase)
        ) {
          continue;
        }
        result.push(...entriesUnder(child, phase));
      }
    }
    return result;
  }

  // Compute per-phase allocated power from circuits under a panel
  function computePhaseAllocations(
    node: HierarchyNode,
    phaseAllocated: PhaseLoad,
    allocMap: Map<string, AllocationResult>,
  ): void {
    for (const child of node.children) {
      if (mapsThroughStepDown(node, child)) {
        const secondary: PhaseLoad = { L1: 0, L2: 0, L3: 0 };
        computePhaseAllocations(child, secondary, allocMap);
        const primary = stepDownPrimaryPhases(secondary);
        for (const phase of ALL_PHASES) phaseAllocated[phase] += primary[phase];
      } else if (child.type === 'circuit') {
        const { phases, share } = circuitPhaseShare(child.phaseConnections, node.phases);
        let circuitTotal = 0;
        for (const station of child.stations) {
          const alloc = allocMap.get(station.id);
          if (alloc != null) {
            circuitTotal += alloc.allocatedKw;
          }
        }
        for (const phase of phases) {
          phaseAllocated[phase] += circuitTotal * share;
        }
      } else if (node.phases === 3 && child.phases !== 3 && child.phaseConnections != null) {
        // A single-phase sub-panel that names its feeding phases loads only those.
        const { phases, share } = subPanelPhaseShare(node, child);
        let subTotal = 0;
        for (const entry of entriesUnder(child, null)) subTotal += entry.alloc.allocatedKw;
        for (const phase of phases) phaseAllocated[phase] += subTotal * share;
      } else {
        computePhaseAllocations(child, phaseAllocated, allocMap);
      }
    }
  }

  // Process all root panels
  for (const root of roots) {
    enforcePanel(root);
  }

  return [...allocationMap.values()].map((a) => ({
    ...a,
    allocatedKw: Math.max(0, a.allocatedKw),
  }));
}

/**
 * Site capacity for the allocation log: `siteLimitKw` is the capacity of the
 * roots (service transformers where they exist, else top-level panels) after
 * their safety margin plus their supply credit (`nodeCapacityKw`),
 * `availableKw` what is left of it for the managed stations after every fixed
 * load, and `supplyCreditKw` the battery and solar credit the tree used (each
 * asset once, where some node took it).
 */
export function summarizeSiteCapacity(
  roots: HierarchyNode[],
  reservedKw: ReadonlyMap<string, number>,
): { siteLimitKw: number; availableKw: number; supplyCreditKw: number } {
  let siteLimitKw = 0;
  let availableKw = 0;
  for (const root of roots) {
    const capacity = Math.max(0, nodeCapacityKw(root));
    siteLimitKw += capacity;
    availableKw += Math.max(0, capacity - fixedLoadKw(root, reservedKw));
  }
  let supplyCreditKw = 0;
  const walk = (nodes: readonly HierarchyNode[]): void => {
    for (const node of nodes) {
      for (const asset of node.energyAssets ?? []) {
        if (asset.creditApplied) supplyCreditKw += asset.creditKw;
      }
      walk(node.children);
    }
  };
  walk(roots);
  return { siteLimitKw, availableKw, supplyCreditKw };
}

// The profile load management owns on each managed station. OCPP 2.1 K01.FR.22
// forbids a CSMS to send ChargingStationExternalConstraints (a station clears
// none of those either, K10), and OCPP 1.6 has no such purpose: the limit of
// the whole station is a ChargingStationMaxProfile on EVSE 0 (1.6
// ChargePointMaxProfile on connector 0). A fixed, high id so the profile
// replaces only itself (a profile with the same id is replaced, K01.FR.05) and
// stays above a station's MaxExternalConstraintsId (K01.FR.80). Stack level 1,
// above the stack level 0 default of the smart charging templates: within one
// purpose the highest stack level wins, and the breaker limit must win.
export const LOAD_MANAGEMENT_PROFILE_ID = 1_000_000_000;

/**
 * The load management profile id of a station: LOAD_MANAGEMENT_PROFILE_ID, or
 * one above the station's MaxExternalConstraintsId when that is not lower
 * (K01.FR.80), within the 32-bit id range.
 */
export function loadManagementProfileId(
  maxExternalConstraintsId: string | null | undefined,
): number {
  const max = Number(maxExternalConstraintsId);
  if (
    maxExternalConstraintsId == null ||
    !Number.isInteger(max) ||
    max < LOAD_MANAGEMENT_PROFILE_ID
  ) {
    return LOAD_MANAGEMENT_PROFILE_ID;
  }
  // One below the int32 maximum, so the credit profile id (one above) fits.
  return Math.min(max + 1, 2_147_483_646);
}
export const LOAD_MANAGEMENT_STACK_LEVEL = 1;

// The credit profile (security case 334): a limit that rests on a battery or
// solar reading (its credit, or a battery load the reading lowered) goes to
// the station as a second ChargingStationMaxProfile one stack level above the
// limit without readings, valid until the reading goes stale (validTo). Within
// one purpose the valid profile with the highest stack level overrules
// (2.1 and 2.0.1 K01.FR.17, 1.6 section 3.13.2) and a profile is valid only
// while the current time is before validTo (K01.FR.37, 1.6 ChargingProfile
// validTo), so a station that gets no new limit (the worker stopped) falls back
// to the stack level 1 limit by itself. Its own id (one above the station's
// load management id): two ChargingStationMaxProfiles on EVSE 0 at different
// stack levels with different ids (K01.FR.06), both above the station's
// MaxExternalConstraintsId (K01.FR.80) and below the TxProfile ids of the depot
// plan (`chargingNeedsProfileId`, from 2^30).
export const LOAD_MANAGEMENT_CREDIT_STACK_LEVEL = 2;

/** The credit profile id of a station whose load management profile id is `profileId`. */
export function loadManagementCreditProfileId(profileId: number): number {
  return profileId + 1;
}

// A credit profile is sent again, with the end of the newer reading, once the
// one the station holds ends within this time: about two 10 second cycles, so
// readings that keep arriving keep the credit without a gap, and the station
// keeps no credit longer than the reading it rests on.
export const LOAD_MANAGEMENT_CREDIT_RESEND_MS = 25_000;

/** True when the station may take a credit profile (it reports a stack level of 2 or more, or none). */
export function takesCreditProfile(station: Pick<StationPowerInfo, 'maxStackLevel'>): boolean {
  return (
    station.maxStackLevel == null || station.maxStackLevel >= LOAD_MANAGEMENT_CREDIT_STACK_LEVEL
  );
}

/**
 * True for a profile that is a load management profile: a
 * ChargingStationMaxProfile (1.6 ChargePointMaxProfile) at the load management
 * stack level with an id from LOAD_MANAGEMENT_PROFILE_ID up. Other senders
 * cannot use such a profile on a managed station (the API refuses it), so a
 * reply to one is the reply to load management. Reads the 2.1 and 1.6 forms.
 */
export function isLoadManagementProfile(profile: unknown): boolean {
  if (profile == null || typeof profile !== 'object') return false;
  const p = profile as Record<string, unknown>;
  const id = p['id'] ?? p['chargingProfileId'];
  const purpose = p['chargingProfilePurpose'];
  return (
    typeof id === 'number' &&
    id >= LOAD_MANAGEMENT_PROFILE_ID &&
    p['stackLevel'] === LOAD_MANAGEMENT_STACK_LEVEL &&
    (purpose === 'ChargingStationMaxProfile' || purpose === 'ChargePointMaxProfile')
  );
}

/** The rate unit of a load management profile's schedule (2.1 array or 1.6 object). */
export function profileRateUnit(profile: unknown): ChargingRateUnit | null {
  if (profile == null || typeof profile !== 'object') return null;
  const raw = (profile as Record<string, unknown>)['chargingSchedule'];
  const schedule = (Array.isArray(raw) ? (raw[0] as unknown) : raw) as
    | Record<string, unknown>
    | null
    | undefined;
  const unit = schedule?.['chargingRateUnit'];
  return unit === 'A' || unit === 'W' ? unit : null;
}

/**
 * The limit in kW of an accepted load management profile: its first period's
 * limit, from A with the station's circuit (`rate`). Null when it cannot be
 * read.
 */
export function profileLimitKw(profile: unknown, rate: StationRate | undefined): number | null {
  if (profile == null || typeof profile !== 'object') return null;
  const raw = (profile as Record<string, unknown>)['chargingSchedule'];
  const schedule = (Array.isArray(raw) ? (raw[0] as unknown) : raw) as
    | Record<string, unknown>
    | null
    | undefined;
  const periods = schedule?.['chargingSchedulePeriod'];
  const first = Array.isArray(periods) ? (periods[0] as Record<string, unknown> | undefined) : null;
  const limit = first?.['limit'];
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) return null;
  const unit = profileRateUnit(profile);
  if (unit === 'W') return limit / 1000;
  if (unit === 'A' && rate != null) {
    return (limit * rate.voltageV * conductorFactor(rate.phases)) / 1000;
  }
  return null;
}

// Unchanged allocations are sent again after this interval, so a lost
// publish, a rejected profile or a station that lost its profiles converges.
export const LOAD_MANAGEMENT_REFRESH_MS = 5 * 60_000;

/** How a station's limit is expressed: in W, or in A per phase on its circuit. */
export interface StationRate {
  rateUnit: ChargingRateUnit;
  /** Phase to neutral voltage of the circuit's panel (single-phase: its voltage). */
  voltageV: number;
  /** Conductor phases of the circuit (1 to 3). */
  phases: number;
  /** Id of the station's load management profile. */
  profileId?: number;
}

/**
 * The limit for `allocatedWatts` in the station's unit: W as is, A as the
 * phase current on its circuit (W / (V x 1, sqrt(3) or 3)), rounded down to
 * 0.1 A so the station never exceeds the allocation.
 */
export function limitInUnit(allocatedWatts: number, rate: StationRate | undefined): number {
  if (rate == null || rate.rateUnit === 'W') return allocatedWatts;
  const amps = allocatedWatts / (rate.voltageV * conductorFactor(rate.phases));
  return Math.floor(amps * 10) / 10;
}

/**
 * The SetChargingProfile of a station limit. Without `validTo`: the load
 * management profile (stack level 1, no end). With it: the credit profile
 * (stack level 2, its own id, valid until `validTo`, security case 334).
 */
export function buildLoadManagementProfile(
  allocatedWatts: number,
  now: Date,
  rate?: StationRate,
  validTo?: Date,
): Record<string, unknown> {
  // Absolute needs a startSchedule (K01.FR.40). A minute in the past so a
  // station clock that runs a little behind applies the limit at once.
  const startSchedule = new Date(Math.floor(now.getTime() / 1000) * 1000 - 60_000);
  const profileId = rate?.profileId ?? LOAD_MANAGEMENT_PROFILE_ID;
  return {
    evseId: 0,
    chargingProfile: {
      id: validTo != null ? loadManagementCreditProfileId(profileId) : profileId,
      stackLevel:
        validTo != null ? LOAD_MANAGEMENT_CREDIT_STACK_LEVEL : LOAD_MANAGEMENT_STACK_LEVEL,
      chargingProfilePurpose: 'ChargingStationMaxProfile',
      chargingProfileKind: 'Absolute',
      ...(validTo != null ? { validTo: validTo.toISOString() } : {}),
      chargingSchedule: [
        {
          id: 1,
          startSchedule: startSchedule.toISOString(),
          chargingRateUnit: rate?.rateUnit ?? 'W',
          chargingSchedulePeriod: [
            {
              startPeriod: 0,
              limit: limitInUnit(allocatedWatts, rate),
            },
          ],
        },
      ],
    },
  };
}

async function dispatchSetChargingProfile(
  pubsub: PubSubClient,
  stationId: string,
  allocatedWatts: number,
  now: Date,
  rate: StationRate | undefined,
  log: ServiceLogger,
  validTo?: Date,
): Promise<boolean> {
  // Never queued for an offline station: the limit would be stale on
  // reconnect, and the next cycle sends the current one (the station is
  // reserved while offline). Clears stay queued.
  const command: OcppCommand = {
    stationId,
    action: 'SetChargingProfile',
    payload: buildLoadManagementProfile(allocatedWatts, now, rate, validTo),
    noQueue: true,
  };

  try {
    await publishOcppCommand(pubsub, command);
    return true;
  } catch (err: unknown) {
    log.error({ err, stationId }, 'Failed to dispatch SetChargingProfile');
    return false;
  }
}

/**
 * Remove the load management limit from stations it no longer manages (load
 * management turned off, the station left its circuit or the site). Returns
 * false when a publish failed.
 */
export async function clearLoadManagementProfiles(
  stationIds: readonly string[],
  log: ServiceLogger,
): Promise<boolean> {
  const pubsub = getPubSub();
  const unique = [...new Set(stationIds)];
  // Each station's profile id follows its MaxExternalConstraintsId.
  const maxExternalIds = new Map<string, string>();
  if (unique.length > 0) {
    try {
      const rows = await db
        .select({ stationId: chargingStations.stationId, value: stationConfigurations.value })
        .from(stationConfigurations)
        .innerJoin(chargingStations, eq(stationConfigurations.stationId, chargingStations.id))
        .where(
          and(
            inArray(chargingStations.stationId, unique),
            eq(stationConfigurations.variable, MAX_EXTERNAL_CONSTRAINTS_ID_VARIABLE),
            eq(stationConfigurations.attributeType, 'Actual'),
          ),
        );
      for (const row of rows) {
        if (row.value != null) maxExternalIds.set(row.stationId, row.value);
      }
    } catch (err: unknown) {
      // fail-open: clear by the default id; a station with a higher
      // MaxExternalConstraintsId answers Unknown and keeps its limit until
      // the next clear.
      log.warn({ err }, 'Reading MaxExternalConstraintsId failed, clearing by the default id');
    }
  }
  // Both limits go: the load management profile and the credit profile
  // (security case 334; a station that holds no credit profile answers
  // Unknown for it).
  const results = await Promise.all(
    unique.flatMap((stationId) => {
      const profileId = loadManagementProfileId(maxExternalIds.get(stationId));
      return [profileId, loadManagementCreditProfileId(profileId)].map(
        async (chargingProfileId) => {
          try {
            await publishOcppCommand(pubsub, {
              stationId,
              action: 'ClearChargingProfile',
              payload: { chargingProfileId },
            });
            return true;
          } catch (err: unknown) {
            log.error(
              { err, stationId, chargingProfileId },
              'Failed to dispatch ClearChargingProfile',
            );
            return false;
          }
        },
      );
    }),
  );
  return results.every(Boolean);
}

async function broadcastLoadUpdate(pubsub: PubSubClient, siteId: string): Promise<void> {
  try {
    const event = JSON.stringify({
      eventType: 'load.updated',
      siteId,
      stationId: null,
      sessionId: null,
    });
    await pubsub.publish('csms_events', event);
  } catch (err) {
    logger.warn(
      { err, siteId },
      'Load update event publish failed, the dashboard refreshes on its next poll',
    );
  }
}

/**
 * Write the allocation log row. `capacity` gives the site capacity and what was
 * left of it for the stations; without it both default to the allocated total.
 */
export async function logAllocations(
  siteId: string,
  allocations: AllocationResult[],
  config: { strategy: LoadAllocationStrategy },
  totalDrawKw: number,
  capacity?: { siteLimitKw: number; availableKw: number; supplyCreditKw?: number },
): Promise<void> {
  const totalAllocatedKw = allocations.reduce((sum, a) => sum + a.allocatedKw, 0);
  await db.insert(loadAllocationLog).values({
    siteId,
    siteLimitKw: String(capacity?.siteLimitKw ?? totalAllocatedKw),
    totalDrawKw: String(totalDrawKw),
    availableKw: String(capacity?.availableKw ?? totalAllocatedKw),
    supplyCreditKw: String(capacity?.supplyCreditKw ?? 0),
    strategy: config.strategy,
    allocations: allocations.map((a) => ({
      stationId: a.stationId,
      allocatedKw: a.allocatedKw,
      currentDrawKw: a.currentDrawKw,
    })),
  });
}

/**
 * Split a cycle's allocations into the limits that go down and those that go
 * up, against the limit each station holds (`previousKw`, the kW last sent).
 * A station with no known limit holds none (unlimited), so its limit is a cut.
 * An unchanged limit goes with the cuts. Sending every cut before any raise
 * keeps the total within the capacity while the limits change.
 */
export function orderLimitChanges(
  allocations: readonly AllocationResult[],
  previousKw: ReadonlyMap<string, number>,
): { cuts: AllocationResult[]; raises: AllocationResult[] } {
  const cuts: AllocationResult[] = [];
  const raises: AllocationResult[] = [];
  for (const allocation of allocations) {
    const before = previousKw.get(allocation.stationDbId);
    if (before != null && allocation.allocatedKw > before + EPSILON_KW) raises.push(allocation);
    else cuts.push(allocation);
  }
  return { cuts, raises };
}

/**
 * The credit profile of one station for a send (security case 334): its limit
 * (`allocatedKw`) goes as the credit profile until `validTo`, and `baseKw` as
 * the load management profile, the limit once the credit profile ends.
 */
export interface CreditLimit {
  /** The limit without readings (stack level 1). */
  baseKw: number;
  /** The stack level 1 limit the station holds; absent: its last limit. */
  previousBaseKw?: number;
  /** End of the credit profile. */
  validTo: Date;
}

/** One SetChargingProfile of a send: a station limit, or its credit profile (`validTo`). */
export interface LimitCommand {
  allocation: AllocationResult;
  kw: number;
  /** The limit this profile replaces at the station; absent: none known. */
  previousKw?: number;
  validTo?: Date;
}

/**
 * The profiles of a send. A station without a credit limit gets its limit as
 * the load management profile. One with a credit limit gets the credit
 * profile (its limit, compared with the limit it holds now) and the load
 * management profile at `baseKw` (compared with the stack level 1 limit it
 * holds, which applies only after the credit profile ends). `creditOnly`
 * sends the credit profiles only (a refresh of their end).
 */
export function limitCommands(
  allocations: readonly AllocationResult[],
  previousKw: ReadonlyMap<string, number>,
  credit: ReadonlyMap<string, CreditLimit> = new Map(),
  creditOnly = false,
): LimitCommand[] {
  const commands: LimitCommand[] = [];
  for (const allocation of allocations) {
    const before = previousKw.get(allocation.stationDbId);
    const limit = credit.get(allocation.stationDbId);
    const held = before != null ? { previousKw: before } : {};
    if (limit == null) {
      if (!creditOnly) commands.push({ allocation, kw: allocation.allocatedKw, ...held });
      continue;
    }
    commands.push({ allocation, kw: allocation.allocatedKw, validTo: limit.validTo, ...held });
    if (creditOnly) continue;
    const baseBefore = limit.previousBaseKw ?? before;
    commands.push({
      allocation,
      kw: limit.baseKw,
      ...(baseBefore != null ? { previousKw: baseBefore } : {}),
    });
  }
  return commands;
}

/** `orderLimitChanges` for profiles: a profile that raises the limit it replaces goes last. */
export function orderLimitCommands(commands: readonly LimitCommand[]): {
  cuts: LimitCommand[];
  raises: LimitCommand[];
} {
  const cuts: LimitCommand[] = [];
  const raises: LimitCommand[] = [];
  for (const command of commands) {
    if (command.previousKw != null && command.kw > command.previousKw + EPSILON_KW) {
      raises.push(command);
    } else {
      cuts.push(command);
    }
  }
  return { cuts, raises };
}

/**
 * Send each allocation to its station as a SetChargingProfile, then tell the
 * dashboards. Limit cuts go out first and raises only after every cut was
 * published (`orderLimitCommands`; none after a failed cut), so the stations
 * together never hold more than the capacity mid-cycle. A station in
 * `options.credit` gets its credit profile and its limit without readings
 * (`limitCommands`, security case 334). Returns false when a publish failed,
 * so the caller sends again on the next cycle.
 */
export async function dispatchAllocations(
  siteId: string,
  allocations: AllocationResult[],
  log: ServiceLogger,
  now: Date = new Date(),
  rates: ReadonlyMap<string, StationRate> = new Map(),
  previousKw: ReadonlyMap<string, number> = new Map(),
  options: { credit?: ReadonlyMap<string, CreditLimit>; creditOnly?: boolean } = {},
): Promise<boolean> {
  const pubsub = getPubSub();

  // Within each group the publishes run in parallel: each is an independent
  // pub/sub publish, so serializing them adds (N * publish latency) of
  // needless delay at the end of every 10s control cycle.
  const send = (group: readonly LimitCommand[]): Promise<boolean[]> =>
    Promise.all(
      group.map((command) =>
        dispatchSetChargingProfile(
          pubsub,
          command.allocation.stationId,
          Math.round(command.kw * 1000),
          now,
          rates.get(command.allocation.stationDbId),
          log,
          command.validTo,
        ),
      ),
    );
  const { cuts, raises } = orderLimitCommands(
    limitCommands(allocations, previousKw, options.credit, options.creditOnly === true),
  );
  const cutsSent = (await send(cuts)).every(Boolean);
  // A cut that was not published leaves its station above its new limit:
  // no raise goes out on top of it. The caller sends everything again on the
  // next cycle.
  if (!cutsSent && raises.length > 0) {
    log.warn(
      { siteId, raiseCount: raises.length },
      'Load management limit raises held back after a failed cut',
    );
  }
  const raisesSent = cutsSent ? (await send(raises)).every(Boolean) : raises.length === 0;

  await broadcastLoadUpdate(pubsub, siteId);
  return cutsSent && raisesSent;
}

/** One allocation as stored in `site_load_management.applied_allocations`. */
export interface AppliedAllocation {
  stationId: string;
  stationDbId: string;
  allocatedKw: number;
  /**
   * True for the power kept for a station that gets no allocation: offline
   * with an active session, or with a limit it has not accepted.
   */
  reserved?: boolean;
  /**
   * The station answered its load management profile with a rejection or an
   * error and has accepted none since (`recordLoadManagementProfileReply`,
   * @evtivity/database). It is a fixed load until it accepts one.
   */
  limitPending?: boolean;
  /** Units the station rejected for its load management profile. */
  rejectedUnits?: ChargingRateUnit[];
  /**
   * The limit without readings sent at stack level 1 when it differs from
   * `allocatedKw`, which then went as the credit profile (security case 334).
   */
  baseKw?: number;
  /**
   * End of the credit profile last sent (ISO 8601) while it may still hold at
   * the station: a send before then sends the credit profile too, so a lower
   * limit replaces it.
   */
  creditUntil?: string;
}

export function parseAppliedAllocations(value: unknown): AppliedAllocation[] | null {
  if (!Array.isArray(value)) return null;
  const result: AppliedAllocation[] = [];
  for (const entry of value) {
    if (entry == null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (
      typeof row['stationId'] !== 'string' ||
      typeof row['stationDbId'] !== 'string' ||
      typeof row['allocatedKw'] !== 'number'
    ) {
      continue;
    }
    const rawUnits = row['rejectedUnits'];
    const rejectedUnits = Array.isArray(rawUnits)
      ? (['A', 'W'] as const).filter((u) => (rawUnits as unknown[]).includes(u))
      : [];
    result.push({
      stationId: row['stationId'],
      stationDbId: row['stationDbId'],
      allocatedKw: row['allocatedKw'],
      ...(row['reserved'] === true ? { reserved: true } : {}),
      ...(row['limitPending'] === true ? { limitPending: true } : {}),
      ...(rejectedUnits.length > 0 ? { rejectedUnits } : {}),
      ...(typeof row['baseKw'] === 'number' && Number.isFinite(row['baseKw'])
        ? { baseKw: row['baseKw'] }
        : {}),
      ...(typeof row['creditUntil'] === 'string' && Number.isFinite(Date.parse(row['creditUntil']))
        ? { creditUntil: row['creditUntil'] }
        : {}),
    });
  }
  return result;
}

function allocationKey(entries: readonly AppliedAllocation[]): string {
  return JSON.stringify(
    [...entries]
      .map((a) => ({
        s: a.stationDbId,
        kw: Math.round(a.allocatedKw * 100),
        r: a.reserved === true,
        p: a.limitPending === true,
        u: [...(a.rejectedUnits ?? [])].sort().join(','),
        b: a.baseKw != null ? Math.round(a.baseKw * 100) : null,
      }))
      .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0)),
  );
}

/**
 * The unit a station is sent its limit in: its preferred unit (`rateUnit`)
 * unless it rejected it, else the other unit when the station may take it (it
 * reports it, or reports no unit). A station that rejected every unit it may
 * take is sent the preferred one again; it stays a fixed load meanwhile.
 */
export function sendRateUnit(
  station: Pick<StationPowerInfo, 'rateUnit' | 'supportedRateUnits'>,
  rejected: readonly ChargingRateUnit[],
): ChargingRateUnit {
  const other: ChargingRateUnit = station.rateUnit === 'W' ? 'A' : 'W';
  const supported = station.supportedRateUnits ?? [];
  const candidates: ChargingRateUnit[] = [station.rateUnit];
  if (supported.length === 0 || supported.includes(other)) candidates.push(other);
  return candidates.find((u) => !rejected.includes(u)) ?? station.rateUnit;
}

/**
 * Unit and circuit of each managed station, for a limit in A: the circuit's
 * panel voltage and the conductor phases of the circuit. `rejected` holds the
 * units each station rejected (`sendRateUnit`).
 */
export function stationRates(
  nodes: readonly HierarchyNode[],
  rejected: ReadonlyMap<string, readonly ChargingRateUnit[]> = new Map(),
): Map<string, StationRate> {
  const rates = new Map<string, StationRate>();
  const walk = (list: readonly HierarchyNode[]): void => {
    for (const node of list) {
      if (node.type === 'circuit') {
        const phases = circuitConductorPhases(node.phaseConnections, node.phases);
        for (const station of node.stations) {
          rates.set(station.id, {
            rateUnit: sendRateUnit(station, rejected.get(station.id) ?? []),
            voltageV: node.voltageV,
            phases,
            profileId: station.profileId,
          });
        }
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return rates;
}

function managedStations(nodes: readonly HierarchyNode[], into: StationPowerInfo[]): void {
  for (const node of nodes) {
    into.push(...node.stations);
    managedStations(node.children, into);
  }
}

/**
 * Power kept for each managed station that is offline with an active session:
 * the higher of the limit it was last sent and the last one it accepted
 * (`acceptedKw`), else its maximum power. It keeps charging while offline at
 * the limit it holds, which is the accepted one when the last send never
 * reached it, so its circuit cannot give that power to the others.
 */
export function offlineReservations(
  stations: readonly StationPowerInfo[],
  previous: readonly AppliedAllocation[] | null,
  acceptedKw: ReadonlyMap<string, number> = new Map(),
): Map<string, number> {
  const lastKw = new Map((previous ?? []).map((a) => [a.stationDbId, a.allocatedKw]));
  const reserved = new Map<string, number>();
  for (const station of stations) {
    if (station.isOnline || !station.hasActiveSession) continue;
    const known = [lastKw.get(station.id), acceptedKw.get(station.id)].filter(
      (kw): kw is number => kw != null,
    );
    const kw =
      known.length > 0 ? Math.max(...known) : station.maxPowerKw > 0 ? station.maxPowerKw : 0;
    reserved.set(station.id, kw);
  }
  return reserved;
}

/**
 * Power kept for each managed station whose load management limit is not
 * confirmed (`limitPending`: it rejected the last one or answered with an
 * error). It may charge with no limit, so it is a fixed load of its maximum
 * power or its measured draw, whichever is higher, until it accepts a limit.
 * Idle or offline too: a session can start at any time.
 */
export function unconfirmedReservations(
  stations: readonly StationPowerInfo[],
  previous: readonly AppliedAllocation[] | null,
): Map<string, number> {
  const pending = new Set(
    (previous ?? []).filter((a) => a.limitPending === true).map((a) => a.stationDbId),
  );
  const reserved = new Map<string, number>();
  for (const station of stations) {
    if (!pending.has(station.id)) continue;
    reserved.set(station.id, Math.max(station.maxPowerKw, station.currentDrawKw, 0));
  }
  return reserved;
}

/**
 * The last load management limit each station accepted, in kW: the stored
 * copy of its accepted profile (`charging_profiles`, source csms_set, the
 * station's load management profile id), converted from A with its circuit.
 */
export async function lastAcceptedLimitsKw(
  stations: readonly StationPowerInfo[],
  rates: ReadonlyMap<string, StationRate>,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (stations.length === 0) return result;
  const byId = new Map(stations.map((s) => [s.id, s]));
  const rows = await db
    .select({ stationId: chargingProfiles.stationId, profileData: chargingProfiles.profileData })
    .from(chargingProfiles)
    .where(
      and(
        inArray(chargingProfiles.stationId, [...byId.keys()]),
        eq(chargingProfiles.source, 'csms_set'),
      ),
    );
  for (const row of rows) {
    const station = byId.get(row.stationId);
    const data = row.profileData as Record<string, unknown> | null;
    if (station == null || data == null || !isLoadManagementProfile(data)) continue;
    if ((data['id'] ?? data['chargingProfileId']) !== station.profileId) continue;
    const kw = profileLimitKw(data, rates.get(row.stationId));
    if (kw != null) result.set(row.stationId, Math.max(result.get(row.stationId) ?? 0, kw));
  }
  return result;
}

/**
 * A copy of the tree as it counts once every battery and solar reading is
 * stale: no credit, and every asset load as without a reading (a battery that
 * may charge from the grid at its rating, D9). The limits a station holds
 * without an end date are computed on it (security case 334).
 */
export function withoutAssetReadings(roots: readonly HierarchyNode[]): HierarchyNode[] {
  const copy = structuredClone(roots) as HierarchyNode[];
  const walk = (nodes: HierarchyNode[]): void => {
    for (const node of nodes) {
      delete node.supplyCreditKw;
      delete node.supplyPhaseCreditKw;
      if (node.fallbackSupplyLoadKw != null) node.supplyLoadKw = node.fallbackSupplyLoadKw;
      else delete node.supplyLoadKw;
      if (node.fallbackSupplySinglePhaseLoadKw != null) {
        node.supplySinglePhaseLoadKw = node.fallbackSupplySinglePhaseLoadKw;
      } else {
        delete node.supplySinglePhaseLoadKw;
      }
      walk(node.children);
    }
  };
  walk(copy);
  return copy;
}

/** The earliest end of a fresh battery or solar reading on the tree, ms; null without one. */
export function assetReadingsFreshUntilMs(roots: readonly HierarchyNode[]): number | null {
  let earliest: number | null = null;
  const walk = (nodes: readonly HierarchyNode[]): void => {
    for (const node of nodes) {
      for (const asset of node.energyAssets ?? []) {
        const until = asset.freshUntil?.getTime();
        if (until != null && (earliest == null || until < earliest)) earliest = until;
      }
      walk(node.children);
    }
  };
  walk(roots);
  return earliest;
}

/**
 * Splits the limits that rest on battery and solar readings (security case
 * 334): each station's limit computed on the tree without readings
 * (`withoutAssetReadings`; a departure-aware site shares it equally, as when
 * its plan fails) becomes its limit without an end date, capped at its
 * allocation. A station whose allocation is higher keeps it as a credit
 * limit until `validToMs`, the earliest end of a fresh reading; one that
 * takes no credit profile (`takesCreditProfile`) gets the lower limit only.
 */
export function splitCreditLimits(
  hierarchy: HierarchyNode[],
  strategy: LoadAllocationStrategy,
  reservedKw: ReadonlyMap<string, number>,
  allocations: AllocationResult[],
  managed: readonly StationPowerInfo[],
): { allocations: AllocationResult[]; baseKw: Map<string, number>; validToMs: number | null } {
  const baseKw = new Map<string, number>();
  const freshUntil = assetReadingsFreshUntilMs(hierarchy);
  if (freshUntil == null || allocations.length === 0) {
    return { allocations, baseKw, validToMs: null };
  }
  const without = computeHierarchicalAllocation(
    withoutAssetReadings(hierarchy),
    strategy === 'departure_aware' ? 'equal_share' : strategy,
    reservedKw,
  );
  const withoutById = new Map(without.map((a) => [a.stationDbId, a.allocatedKw]));
  const stations = new Map(managed.map((s) => [s.id, s]));
  const split = allocations.map((a) => {
    const base = Math.min(a.allocatedKw, withoutById.get(a.stationDbId) ?? 0);
    if (base >= a.allocatedKw - EPSILON_KW) return a;
    const station = stations.get(a.stationDbId);
    if (station != null && !takesCreditProfile(station)) return { ...a, allocatedKw: base };
    baseKw.set(a.stationDbId, base);
    return a;
  });
  return { allocations: split, baseKw, validToMs: baseKw.size > 0 ? freshUntil : null };
}

/**
 * Current allocation of a site: its power status, its hierarchy, the power
 * kept for offline stations and for stations with an unconfirmed limit, and
 * the allocations of the others.
 *
 * A `departure_aware` site with fleet charging on follows its depot plan
 * (`departureAwareAllocation`); with it off, or when planning fails, it shares
 * power equally. `replan` (the cycle only) lets the planner bind sessions and
 * write a new plan; without it the stored plan is only read.
 */
export async function computeSiteAllocation(
  siteId: string,
  strategy: LoadAllocationStrategy,
  previous: readonly AppliedAllocation[] | null,
  options: {
    replan?: boolean;
    log?: ServiceLogger;
    nowMs?: number;
    /** ENERGY_ASSETS_ALLOW_SIMULATED of the calling process. */
    allowSimulatedEnergyAssets?: boolean;
  } = {},
): Promise<{
  status: { totalDrawKw: number; stations: StationPowerInfo[] };
  hierarchy: HierarchyNode[];
  managed: StationPowerInfo[];
  reservedKw: Map<string, number>;
  allocations: AllocationResult[];
  /**
   * The limit without readings of each station whose allocation rests on a
   * fresh battery or solar reading (`splitCreditLimits`, security case 334).
   */
  baseKw: Map<string, number>;
  /** End of the credit limits, ms; null without one. */
  creditValidToMs: number | null;
}> {
  const status = await getSitePowerStatus(siteId);
  const { roots: hierarchy, energyAssets } = await buildSiteHierarchyWithAssets(
    siteId,
    status.stations,
    {
      ...(options.nowMs != null ? { nowMs: options.nowMs } : {}),
      ...(options.log != null ? { log: options.log } : {}),
      allowSimulatedEnergyAssets: options.allowSimulatedEnergyAssets === true,
    },
  );
  const managed: StationPowerInfo[] = [];
  managedStations(hierarchy, managed);
  const offline = managed.filter((s) => !s.isOnline && s.hasActiveSession);
  const acceptedKw =
    offline.length > 0
      ? await lastAcceptedLimitsKw(offline, stationRates(hierarchy))
      : new Map<string, number>();
  const reservedKw = offlineReservations(managed, previous, acceptedKw);
  for (const [stationDbId, kw] of unconfirmedReservations(managed, previous)) {
    reservedKw.set(stationDbId, Math.max(reservedKw.get(stationDbId) ?? 0, kw));
  }
  let allocations: AllocationResult[] = [];
  if (hierarchy.length > 0) {
    allocations =
      strategy === 'departure_aware'
        ? await departureAwareOrEqualShare(
            siteId,
            status.stations,
            hierarchy,
            reservedKw,
            previous,
            {
              replan: options.replan === true,
              log: options.log ?? logger,
              ...(options.nowMs != null ? { nowMs: options.nowMs } : {}),
            },
          )
        : computeHierarchicalAllocation(hierarchy, strategy, reservedKw);
  }
  if (energyAssets === 'unknown') allocations = withoutRaises(allocations, previous);
  const split = splitCreditLimits(hierarchy, strategy, reservedKw, allocations, managed);
  return {
    status,
    hierarchy,
    managed,
    reservedKw,
    allocations: split.allocations,
    baseKw: split.baseKw,
    creditValidToMs: split.validToMs,
  };
}

/**
 * Caps each allocation at the limit its station holds (the kW last sent), so
 * a cycle that could not account for a battery's grid charging load sends
 * cuts only (`applyEnergyAssets`, `unknown`). A station without a held limit
 * is unlimited, so its grid-only allocation is a cut too.
 */
export function withoutRaises(
  allocations: readonly AllocationResult[],
  previous: readonly AppliedAllocation[] | null,
): AllocationResult[] {
  const heldKw = new Map((previous ?? []).map((a) => [a.stationDbId, a.allocatedKw]));
  return allocations.map((a) => {
    const held = heldKw.get(a.stationDbId);
    return held != null && a.allocatedKw > held ? { ...a, allocatedKw: held } : a;
  });
}

async function departureAwareOrEqualShare(
  siteId: string,
  stations: StationPowerInfo[],
  hierarchy: HierarchyNode[],
  reservedKw: Map<string, number>,
  previous: readonly AppliedAllocation[] | null,
  options: { replan: boolean; log: ServiceLogger; nowMs?: number },
): Promise<AllocationResult[]> {
  try {
    // Loaded on use: the planner module imports this one.
    const { departureAwareAllocation } = await import('./charging-plan.service.js');
    const planned = await departureAwareAllocation({
      siteId,
      hierarchy,
      stations,
      reservedKw,
      previous,
      replan: options.replan,
      log: options.log,
      ...(options.nowMs != null ? { nowMs: options.nowMs } : {}),
    });
    if (planned != null) return planned;
  } catch (err: unknown) {
    options.log.error({ err, siteId }, 'Depot charging plan failed, sharing power equally');
  }
  return computeHierarchicalAllocation(hierarchy, 'equal_share', reservedKw);
}

/**
 * The depot plan's TxProfiles of a departure-aware site, sent after its
 * station limits. Fail-open: the station limit holds each station meanwhile,
 * and the next cycle sends what was not sent.
 */
async function dispatchPlanProfilesAfterLimits(
  siteId: string,
  hierarchy: HierarchyNode[],
  stations: StationPowerInfo[],
  reservedKw: Map<string, number>,
  previous: readonly AppliedAllocation[] | null,
  log: ServiceLogger,
): Promise<void> {
  try {
    // Loaded on use: the planner module imports this one.
    const { dispatchDepotPlanProfiles } = await import('./charging-plan.service.js');
    await dispatchDepotPlanProfiles({ siteId, hierarchy, stations, reservedKw, previous, log });
  } catch (err: unknown) {
    log.warn({ err, siteId }, 'Depot plan profiles not sent, the station limits hold');
  }
}

/**
 * A site that no longer follows a depot plan (another strategy) clears the
 * plan TxProfiles its stations may still hold. Fail-open: the next cycle tries
 * again, and a TxProfile ends with its transaction anyway.
 */
async function clearPlanProfilesOffPlan(
  siteId: string,
  stations: StationPowerInfo[],
  log: ServiceLogger,
): Promise<void> {
  try {
    const { clearDepotPlanProfiles } = await import('./charging-plan.service.js');
    await clearDepotPlanProfiles({ siteId, stations, log });
  } catch (err: unknown) {
    log.warn({ err, siteId }, 'Depot plan profiles not cleared, the next cycle tries again');
  }
}

/**
 * Load management turned off at a site: clears the plan TxProfiles its
 * stations may still hold. Fail-open: a TxProfile ends with its transaction.
 */
export async function clearPlanProfilesOnDisable(
  siteId: string,
  log: ServiceLogger,
): Promise<void> {
  try {
    const { clearSitePlanProfiles } = await import('./charging-plan.service.js');
    await clearSitePlanProfiles(siteId, log);
  } catch (err: unknown) {
    log.warn(
      { err, siteId },
      'Depot plan profiles not cleared after load management was turned off',
    );
  }
}

/** The station reply state of a previous entry, carried into the next one. */
function replyState(
  entry: AppliedAllocation | undefined,
): Pick<AppliedAllocation, 'limitPending' | 'rejectedUnits'> {
  return {
    ...(entry?.limitPending === true ? { limitPending: true } : {}),
    ...(entry?.rejectedUnits != null && entry.rejectedUnits.length > 0
      ? { rejectedUnits: entry.rejectedUnits }
      : {}),
  };
}

/** `entry` with the credit end `until`, or without one. */
function withCreditUntil(entry: AppliedAllocation, until: string | undefined): AppliedAllocation {
  const copy: AppliedAllocation = { ...entry };
  delete copy.creditUntil;
  return until != null ? { ...copy, creditUntil: until } : copy;
}

/**
 * Sends the credit profiles again whose end comes within
 * `LOAD_MANAGEMENT_CREDIT_RESEND_MS` when a newer reading carries the credit
 * further (security case 334), on a cycle that sends nothing else. Only the
 * credit profiles go; the stored entries keep the end each station holds. A
 * reading that stopped arriving gives no later end, so the credit profile
 * ends at the station when its reading goes stale, also with no worker.
 */
async function refreshCreditProfiles(
  siteId: string,
  allocations: readonly AllocationResult[],
  applied: readonly AppliedAllocation[],
  previousById: ReadonlyMap<string, AppliedAllocation>,
  creditLimits: ReadonlyMap<string, CreditLimit>,
  creditValidToMs: number | null,
  hierarchy: HierarchyNode[],
  now: Date,
  log: ServiceLogger,
): Promise<void> {
  if (creditValidToMs == null) return;
  const nowMs = now.getTime();
  const due = new Set<string>();
  for (const entry of applied) {
    if (entry.baseKw == null || entry.reserved === true) continue;
    const held = previousById.get(entry.stationDbId)?.creditUntil;
    const heldMs = held != null ? Date.parse(held) : null;
    if (
      heldMs == null ||
      (heldMs - nowMs < LOAD_MANAGEMENT_CREDIT_RESEND_MS && creditValidToMs > heldMs)
    ) {
      due.add(entry.stationDbId);
    }
  }
  if (due.size === 0) return;
  const stored = applied.map((entry) =>
    due.has(entry.stationDbId)
      ? entry
      : withCreditUntil(entry, previousById.get(entry.stationDbId)?.creditUntil),
  );
  const claimed = await db
    .update(siteLoadManagement)
    .set({ appliedAllocations: stored })
    .where(and(eq(siteLoadManagement.siteId, siteId), eq(siteLoadManagement.isEnabled, true)))
    .returning({ id: siteLoadManagement.id });
  if (claimed.length === 0) return;
  const rejected = new Map<string, readonly ChargingRateUnit[]>();
  for (const a of applied) {
    if (a.rejectedUnits != null) rejected.set(a.stationDbId, a.rejectedUnits);
  }
  const previousKw = new Map([...previousById.values()].map((a) => [a.stationDbId, a.allocatedKw]));
  const sent = await dispatchAllocations(
    siteId,
    allocations.filter((a) => due.has(a.stationDbId)),
    log,
    now,
    stationRates(hierarchy, rejected),
    previousKw,
    { credit: creditLimits, creditOnly: true },
  );
  if (!sent) {
    // A failed publish: the next cycle sends everything again.
    await db
      .update(siteLoadManagement)
      .set({ appliedAt: null })
      .where(and(eq(siteLoadManagement.siteId, siteId), eq(siteLoadManagement.isEnabled, true)));
  }
}

export async function runLoadManagementCycle(
  log: ServiceLogger,
  targetSiteId?: string,
  options: {
    /** ENERGY_ASSETS_ALLOW_SIMULATED of the worker (owner decision D13). */
    allowSimulatedEnergyAssets?: boolean;
  } = {},
): Promise<void> {
  const conditions = [eq(siteLoadManagement.isEnabled, true)];
  if (targetSiteId != null) {
    conditions.push(eq(siteLoadManagement.siteId, targetSiteId));
  }
  const enabledSites = await db
    .select({
      siteId: siteLoadManagement.siteId,
      strategy: siteLoadManagement.strategy,
      appliedAllocations: siteLoadManagement.appliedAllocations,
      appliedAt: siteLoadManagement.appliedAt,
    })
    .from(siteLoadManagement)
    .where(and(...conditions));

  for (const site of enabledSites) {
    try {
      const previous = parseAppliedAllocations(site.appliedAllocations);
      const { status, hierarchy, managed, reservedKw, allocations, baseKw, creditValidToMs } =
        await computeSiteAllocation(site.siteId, site.strategy, previous, {
          replan: true,
          log,
          allowSimulatedEnergyAssets: options.allowSimulatedEnergyAssets === true,
        });

      const now = new Date();
      const nowMs = now.getTime();
      const previousById = new Map((previous ?? []).map((a) => [a.stationDbId, a]));
      const stationById = new Map(managed.map((s) => [s.id, s]));
      // A credit profile sent earlier that may still hold at the station.
      const heldCreditUntil = (stationDbId: string): string | undefined => {
        const until = previousById.get(stationDbId)?.creditUntil;
        return until != null && Date.parse(until) > nowMs ? until : undefined;
      };
      const creditValidTo = creditValidToMs != null ? new Date(creditValidToMs) : null;
      // The reply state (unconfirmed limit, rejected units) is carried for
      // every station that keeps an entry.
      const applied: AppliedAllocation[] = [
        ...allocations.map((a) => {
          const base = baseKw.get(a.stationDbId);
          const creditUntil =
            base != null && creditValidTo != null
              ? creditValidTo.toISOString()
              : heldCreditUntil(a.stationDbId);
          return {
            stationId: a.stationId,
            stationDbId: a.stationDbId,
            allocatedKw: a.allocatedKw,
            ...replyState(previousById.get(a.stationDbId)),
            ...(base != null ? { baseKw: base } : {}),
            ...(creditUntil != null ? { creditUntil } : {}),
          };
        }),
        ...[...reservedKw].map(([stationDbId, allocatedKw]) => {
          const creditUntil = heldCreditUntil(stationDbId);
          return {
            stationId: stationById.get(stationDbId)?.stationId ?? stationDbId,
            stationDbId,
            allocatedKw,
            reserved: true,
            ...replyState(previousById.get(stationDbId)),
            ...(creditUntil != null ? { creditUntil } : {}),
          };
        }),
      ];
      const appliedById = new Map(applied.map((a) => [a.stationDbId, a]));

      // The credit profile of each station that gets one this send: its
      // credit limit until the readings end, or (a credit profile it may
      // still hold, no credit now) its limit until that profile ends, so a
      // lower limit replaces it at once (security case 334).
      const creditLimits = new Map<string, CreditLimit>();
      for (const a of allocations) {
        const entry = appliedById.get(a.stationDbId);
        if (entry?.creditUntil == null) continue;
        const previousBaseKw = previousById.get(a.stationDbId)?.baseKw;
        creditLimits.set(a.stationDbId, {
          baseKw: entry.baseKw ?? a.allocatedKw,
          ...(previousBaseKw != null ? { previousBaseKw } : {}),
          validTo: new Date(entry.creditUntil),
        });
      }

      // Stations that had a limit and are no longer managed (unassigned from
      // their circuit, moved to another site): remove the limit.
      const managedIds = new Set(managed.map((s) => s.id));
      const released = (previous ?? []).filter((a) => !managedIds.has(a.stationDbId));

      const changed = previous == null || allocationKey(applied) !== allocationKey(previous);
      const due =
        site.appliedAt == null ||
        now.getTime() - site.appliedAt.getTime() >= LOAD_MANAGEMENT_REFRESH_MS;
      const planProfiles = (): Promise<void> =>
        site.strategy === 'departure_aware'
          ? dispatchPlanProfilesAfterLimits(
              site.siteId,
              hierarchy,
              status.stations,
              reservedKw,
              previous,
              log,
            )
          : clearPlanProfilesOffPlan(site.siteId, status.stations, log);
      if (!changed && !due && released.length === 0) {
        await refreshCreditProfiles(
          site.siteId,
          allocations,
          applied,
          previousById,
          creditLimits,
          creditValidToMs,
          hierarchy,
          now,
          log,
        );
        await planProfiles();
        continue;
      }

      // Record the allocations before sending them (eager state), only while
      // load management is still on: turned off in between, the site's
      // profiles were cleared and this cycle sends nothing.
      const claimed = await db
        .update(siteLoadManagement)
        .set({ appliedAllocations: applied, appliedAt: now })
        .where(
          and(eq(siteLoadManagement.siteId, site.siteId), eq(siteLoadManagement.isEnabled, true)),
        )
        .returning({ id: siteLoadManagement.id });
      if (claimed.length === 0) continue;

      if (changed) {
        await logAllocations(
          site.siteId,
          allocations,
          { strategy: site.strategy },
          status.totalDrawKw,
          summarizeSiteCapacity(hierarchy, reservedKw),
        );
      }
      // An online station with an unconfirmed limit is sent its reservation
      // as the limit, in a unit it has not rejected: once it accepts, the
      // next cycle allocates it like the others.
      const rejected = new Map<string, readonly ChargingRateUnit[]>();
      for (const a of applied) {
        if (a.rejectedUnits != null) rejected.set(a.stationDbId, a.rejectedUnits);
      }
      const retries: AllocationResult[] = applied
        .filter((a) => a.limitPending === true && stationById.get(a.stationDbId)?.isOnline === true)
        .map((a) => ({
          stationId: a.stationId,
          stationDbId: a.stationDbId,
          allocatedKw: a.allocatedKw,
          currentDrawKw: stationById.get(a.stationDbId)?.currentDrawKw ?? 0,
        }));
      const toSend = [...allocations, ...retries];
      // The kW each station was last sent (its current limit), so cuts go out
      // before raises.
      const previousKw = new Map((previous ?? []).map((a) => [a.stationDbId, a.allocatedKw]));
      const sent = await dispatchAllocations(
        site.siteId,
        toSend,
        log,
        now,
        stationRates(hierarchy, rejected),
        previousKw,
        { credit: creditLimits },
      );
      const cleared =
        released.length === 0
          ? true
          : await clearLoadManagementProfiles(
              released.map((a) => a.stationId),
              log,
            );
      if (!sent || !cleared) {
        // A failed publish: send everything again on the next cycle. The
        // released stations stay listed so their clear is retried too. Only
        // while load management is on: turned off, its clear already ran.
        await db
          .update(siteLoadManagement)
          .set({
            appliedAllocations: cleared ? applied : [...applied, ...released],
            appliedAt: null,
          })
          .where(
            and(eq(siteLoadManagement.siteId, site.siteId), eq(siteLoadManagement.isEnabled, true)),
          );
      }

      // Turned off while this cycle sent: the clear of the PUT can reach a
      // station before this cycle's limit, which would then stay. Clear the
      // stations just sent again.
      if (toSend.length > 0) {
        const [state] = await db
          .select({ isEnabled: siteLoadManagement.isEnabled })
          .from(siteLoadManagement)
          .where(eq(siteLoadManagement.siteId, site.siteId));
        if (state?.isEnabled !== true) {
          await clearLoadManagementProfiles(
            toSend.map((a) => a.stationId),
            log,
          );
          log.info(
            { siteId: site.siteId, stationCount: toSend.length },
            'Load management turned off during the cycle, limits cleared again',
          );
          continue;
        }
      }

      // The station limits went out first: the plan profiles stay under them.
      await planProfiles();

      log.info(
        {
          siteId: site.siteId,
          strategy: site.strategy,
          totalDrawKw: status.totalDrawKw,
          stationCount: allocations.length,
          reservedCount: reservedKw.size,
          retryCount: retries.length,
          releasedCount: released.length,
          changed,
        },
        changed ? 'Load management cycle applied' : 'Load management allocations refreshed',
      );
    } catch (err: unknown) {
      log.error({ err, siteId: site.siteId }, 'Load management cycle failed');
    }
  }
}
