// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, gte, sql, desc, inArray } from 'drizzle-orm';
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
} from '@evtivity/database';
import type { LoadAllocationStrategy, ServiceLogger } from '@evtivity/lib';
import type { OcppCommand, PubSubClient } from '@evtivity/lib';
import {
  circuitConductorPhases,
  conductorFactor,
  createLogger,
  effectiveCircuitVoltageV,
  publishOcppCommand,
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

export interface HierarchyNode {
  type: 'panel' | 'circuit';
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
            ]),
            eq(stationConfigurations.attributeType, 'Actual'),
          ),
        ),
    ]);
  const reportedUnits = new Map<string, string[]>();
  const maxExternalIds = new Map<string, string>();
  for (const row of rateUnitRows) {
    if (row.value == null) continue;
    if (row.variable === MAX_EXTERNAL_CONSTRAINTS_ID_VARIABLE) {
      maxExternalIds.set(row.stationId, row.value);
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
    };
  });

  return { totalDrawKw, stations: stationInfos };
}

type Phase = 'L1' | 'L2' | 'L3';
const ALL_PHASES: readonly Phase[] = ['L1', 'L2', 'L3'];

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
function circuitPhaseShare(
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
function subPanelPhaseShare(
  parent: HierarchyNode,
  child: HierarchyNode,
): { phases: readonly Phase[]; share: number } {
  if (parent.phases !== 3 || child.phases === 3 || child.phaseConnections == null) {
    return { phases: ALL_PHASES, share: 1 };
  }
  const phases = getCircuitPhases(child.phaseConnections);
  if (phases.length === 3) return { phases: ALL_PHASES, share: 1 };
  const byVoltage = child.voltageV > 0 ? parent.voltageV / child.voltageV : 1;
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
function legWeight(parent: HierarchyNode, child: HierarchyNode): number {
  if (parent.phases === 3 || child.type !== 'circuit') return 1;
  return child.voltageV > 0 && child.voltageV < parent.voltageV
    ? parent.voltageV / child.voltageV
    : 1;
}

/**
 * Build the panel/circuit hierarchy tree for a site.
 * Returns an array of root panel nodes (parentPanelId = null).
 */
export async function buildSiteHierarchy(
  siteId: string,
  stationInfos: StationPowerInfo[],
): Promise<HierarchyNode[]> {
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
    })
    .from(panels)
    .where(eq(panels.siteId, siteId));

  if (panelRows.length === 0) {
    return [];
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
    .where(inArray(circuits.panelId, panelIds));

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

  // Wire sub-panels and compute root list
  const roots: HierarchyNode[] = [];
  for (const panel of panelRows) {
    const node = panelNodesById.get(panel.id);
    if (node == null) continue;
    if (panel.parentPanelId != null) {
      const parent = panelNodesById.get(panel.parentPanelId);
      if (parent != null) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  // Compute currentDrawKw for panels bottom-up, including per-phase tracking
  function computePanelDraw(node: HierarchyNode): number {
    let draw = node.unmanagedLoadKw;
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
          if (child.phaseLoad != null) {
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

  return roots;
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
  let fixed = node.unmanagedLoadKw;
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
function fixedPhaseLoad(
  node: HierarchyNode,
  reservedKw: ReadonlyMap<string, number>,
  into: PhaseLoad,
): void {
  const own = node.unmanagedLoadKw;
  if (own > 0) {
    for (const phase of ALL_PHASES) into[phase] += own * panelOwnPhaseShare(node.phases);
  }
  for (const child of node.children) {
    if (child.type === 'circuit') {
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
function weightedFixedKw(node: HierarchyNode, reservedKw: ReadonlyMap<string, number>): number {
  let fixed = node.unmanagedLoadKw;
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
 */
export function computeHierarchicalAllocation(
  roots: HierarchyNode[],
  strategy: LoadAllocationStrategy,
  reservedKw: ReadonlyMap<string, number> = new Map(),
): AllocationResult[] {
  // Mutable map: stationDbId -> allocatedKw
  const allocationMap = new Map<string, AllocationResult>();

  // Pass 1: Allocate within each circuit
  function allocateCircuit(circuit: HierarchyNode): void {
    const available = Math.max(0, circuit.maxContinuousKw - fixedLoadKw(circuit, reservedKw));
    // A station with a reservation (offline, or a limit it has not accepted)
    // is a fixed load and gets no allocation.
    const allocatable = circuit.stations.filter((s) => !reservedKw.has(s.id));
    const circuitAllocations =
      strategy === 'priority_based'
        ? computePriorityAllocation(allocatable, available)
        : computeEqualShareAllocation(allocatable, available);

    for (const alloc of circuitAllocations) {
      allocationMap.set(alloc.stationDbId, alloc);
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

    const panelAvailable = Math.max(
      0,
      panel.maxContinuousKw - panel.safetyMarginKw - weightedFixedKw(panel, reservedKw),
    );
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
          panel.perPhaseCapacityKw - panel.safetyMarginKw / 3 - fixedPhases[phase],
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
      if (child.type === 'circuit') {
        if (
          phase != null &&
          !circuitPhaseShare(child.phaseConnections, node.phases).phases.includes(phase)
        ) {
          continue;
        }
        for (const station of child.stations) {
          const alloc = allocationMap.get(station.id);
          if (alloc != null) result.push({ station, alloc });
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
      if (child.type === 'circuit') {
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
 * root panels after their safety margin, `availableKw` what is left of it for
 * the managed stations after every fixed load.
 */
export function summarizeSiteCapacity(
  roots: HierarchyNode[],
  reservedKw: ReadonlyMap<string, number>,
): { siteLimitKw: number; availableKw: number } {
  let siteLimitKw = 0;
  let availableKw = 0;
  for (const root of roots) {
    const capacity = Math.max(0, root.maxContinuousKw - root.safetyMarginKw);
    siteLimitKw += capacity;
    availableKw += Math.max(0, capacity - fixedLoadKw(root, reservedKw));
  }
  return { siteLimitKw, availableKw };
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
  return Math.min(max + 1, 2_147_483_647);
}
export const LOAD_MANAGEMENT_STACK_LEVEL = 1;

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

export function buildLoadManagementProfile(
  allocatedWatts: number,
  now: Date,
  rate?: StationRate,
): Record<string, unknown> {
  // Absolute needs a startSchedule (K01.FR.40). A minute in the past so a
  // station clock that runs a little behind applies the limit at once.
  const startSchedule = new Date(Math.floor(now.getTime() / 1000) * 1000 - 60_000);
  return {
    evseId: 0,
    chargingProfile: {
      id: rate?.profileId ?? LOAD_MANAGEMENT_PROFILE_ID,
      stackLevel: LOAD_MANAGEMENT_STACK_LEVEL,
      chargingProfilePurpose: 'ChargingStationMaxProfile',
      chargingProfileKind: 'Absolute',
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
): Promise<boolean> {
  // Never queued for an offline station: the limit would be stale on
  // reconnect, and the next cycle sends the current one (the station is
  // reserved while offline). Clears stay queued.
  const command: OcppCommand = {
    stationId,
    action: 'SetChargingProfile',
    payload: buildLoadManagementProfile(allocatedWatts, now, rate),
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
  const results = await Promise.all(
    unique.map(async (stationId) => {
      try {
        await publishOcppCommand(pubsub, {
          stationId,
          action: 'ClearChargingProfile',
          payload: { chargingProfileId: loadManagementProfileId(maxExternalIds.get(stationId)) },
        });
        return true;
      } catch (err: unknown) {
        log.error({ err, stationId }, 'Failed to dispatch ClearChargingProfile');
        return false;
      }
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
  capacity?: { siteLimitKw: number; availableKw: number },
): Promise<void> {
  const totalAllocatedKw = allocations.reduce((sum, a) => sum + a.allocatedKw, 0);
  await db.insert(loadAllocationLog).values({
    siteId,
    siteLimitKw: String(capacity?.siteLimitKw ?? totalAllocatedKw),
    totalDrawKw: String(totalDrawKw),
    availableKw: String(capacity?.availableKw ?? totalAllocatedKw),
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
 * Send each allocation to its station as a SetChargingProfile, then tell the
 * dashboards. Limit cuts go out first and raises only after every cut was
 * published (`orderLimitChanges`; none after a failed cut), so the stations
 * together never hold more than the capacity mid-cycle. Returns false when a publish failed, so the
 * caller sends again on the next cycle.
 */
export async function dispatchAllocations(
  siteId: string,
  allocations: AllocationResult[],
  log: ServiceLogger,
  now: Date = new Date(),
  rates: ReadonlyMap<string, StationRate> = new Map(),
  previousKw: ReadonlyMap<string, number> = new Map(),
): Promise<boolean> {
  const pubsub = getPubSub();

  // Within each group the publishes run in parallel: each is an independent
  // pub/sub publish, so serializing them adds (N * publish latency) of
  // needless delay at the end of every 10s control cycle.
  const send = (group: readonly AllocationResult[]): Promise<boolean[]> =>
    Promise.all(
      group.map((allocation) =>
        dispatchSetChargingProfile(
          pubsub,
          allocation.stationId,
          Math.round(allocation.allocatedKw * 1000),
          now,
          rates.get(allocation.stationDbId),
          log,
        ),
      ),
    );
  const { cuts, raises } = orderLimitChanges(allocations, previousKw);
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
 * Current allocation of a site: its power status, its hierarchy, the power
 * kept for offline stations and for stations with an unconfirmed limit, and
 * the allocations of the others.
 */
export async function computeSiteAllocation(
  siteId: string,
  strategy: LoadAllocationStrategy,
  previous: readonly AppliedAllocation[] | null,
): Promise<{
  status: { totalDrawKw: number; stations: StationPowerInfo[] };
  hierarchy: HierarchyNode[];
  managed: StationPowerInfo[];
  reservedKw: Map<string, number>;
  allocations: AllocationResult[];
}> {
  const status = await getSitePowerStatus(siteId);
  const hierarchy = await buildSiteHierarchy(siteId, status.stations);
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
  const allocations =
    hierarchy.length === 0 ? [] : computeHierarchicalAllocation(hierarchy, strategy, reservedKw);
  return { status, hierarchy, managed, reservedKw, allocations };
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

export async function runLoadManagementCycle(
  log: ServiceLogger,
  targetSiteId?: string,
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
      const { status, hierarchy, managed, reservedKw, allocations } = await computeSiteAllocation(
        site.siteId,
        site.strategy,
        previous,
      );

      const previousById = new Map((previous ?? []).map((a) => [a.stationDbId, a]));
      const stationById = new Map(managed.map((s) => [s.id, s]));
      // The reply state (unconfirmed limit, rejected units) is carried for
      // every station that keeps an entry.
      const applied: AppliedAllocation[] = [
        ...allocations.map((a) => ({
          stationId: a.stationId,
          stationDbId: a.stationDbId,
          allocatedKw: a.allocatedKw,
          ...replyState(previousById.get(a.stationDbId)),
        })),
        ...[...reservedKw].map(([stationDbId, allocatedKw]) => ({
          stationId: stationById.get(stationDbId)?.stationId ?? stationDbId,
          stationDbId,
          allocatedKw,
          reserved: true,
          ...replyState(previousById.get(stationDbId)),
        })),
      ];

      // Stations that had a limit and are no longer managed (unassigned from
      // their circuit, moved to another site): remove the limit.
      const managedIds = new Set(managed.map((s) => s.id));
      const released = (previous ?? []).filter((a) => !managedIds.has(a.stationDbId));

      const now = new Date();
      const changed = previous == null || allocationKey(applied) !== allocationKey(previous);
      const due =
        site.appliedAt == null ||
        now.getTime() - site.appliedAt.getTime() >= LOAD_MANAGEMENT_REFRESH_MS;
      if (!changed && !due && released.length === 0) continue;

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
