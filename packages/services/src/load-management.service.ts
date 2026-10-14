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
} from '@evtivity/database';
import type { LoadAllocationStrategy, ServiceLogger } from '@evtivity/lib';
import type { OcppCommand, PubSubClient } from '@evtivity/lib';
import {
  circuitConductorPhases,
  conductorFactor,
  createLogger,
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
  /** Charging rate unit of the station's limit: W unless it supports only A. */
  rateUnit: ChargingRateUnit;
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

/**
 * The unit load management sends a station its limit in: W when the station
 * reports W (Power) support or reports nothing, A when it supports A only
 * (K01.FR.26: a station rejects a unit it does not support).
 */
export function chargingRateUnitFor(reported: readonly string[]): ChargingRateUnit {
  const units = new Set<string>();
  for (const value of reported) {
    for (const part of value.split(',')) {
      const unit = part.trim();
      if (unit === 'W' || unit === 'Power') units.add('W');
      if (unit === 'A' || unit === 'Current') units.add('A');
    }
  }
  return units.has('A') && !units.has('W') ? 'A' : 'W';
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
  phaseConnections: string | null;
  phaseLoad: PhaseLoad | null;
  perPhaseCapacityKw: number | null;
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
}

interface CircuitRow {
  id: string;
  panelId: string;
  name: string;
  breakerRatingAmps: number;
  maxContinuousKw: string;
  phaseConnections: string | null;
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

  // Get all stations at the site with their priority and online status
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
    .where(eq(chargingStations.siteId, siteId));

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
      profileId: loadManagementProfileId(maxExternalIds.get(station.id)),
    };
  });

  return { totalDrawKw, stations: stationInfos };
}

/**
 * Get the phases a circuit is connected to based on its phaseConnections value.
 * Returns an array of phase keys (L1, L2, L3).
 */
function getCircuitPhases(
  phaseConnections: string | null,
  panelPhases: number,
): Array<'L1' | 'L2' | 'L3'> {
  if (panelPhases === 1) return ['L1'];
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
      voltageV: parentPanel?.voltageV ?? 240,
      oversubscriptionRatio: 1.0,
      phaseConnections: circuit.phaseConnections,
      phaseLoad: null,
      perPhaseCapacityKw: null,
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
      phaseConnections: null,
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
          const circuitPhases = getCircuitPhases(child.phaseConnections, node.phases);
          const circuitDraw = child.currentDrawKw;
          // Distribute circuit draw evenly across its connected phases
          const phaseCount = circuitPhases.length;
          if (phaseCount > 0) {
            const perPhase = circuitDraw / phaseCount;
            for (const phase of circuitPhases) {
              node.phaseLoad[phase] += perPhase;
            }
          }
        }
      } else {
        draw += computePanelDraw(child);
        // Propagate child panel phase load to parent
        if (node.phaseLoad != null && child.phaseLoad != null) {
          node.phaseLoad.L1 += child.phaseLoad.L1;
          node.phaseLoad.L2 += child.phaseLoad.L2;
          node.phaseLoad.L3 += child.phaseLoad.L3;
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
// spread evenly over the phases it uses, like its station load.
function fixedPhaseLoad(
  node: HierarchyNode,
  reservedKw: ReadonlyMap<string, number>,
  into: PhaseLoad,
): void {
  const own = node.unmanagedLoadKw;
  if (own > 0) {
    for (const phase of ['L1', 'L2', 'L3'] as const) into[phase] += own / 3;
  }
  for (const child of node.children) {
    if (child.type === 'circuit') {
      const circuitPhases = getCircuitPhases(child.phaseConnections, node.phases);
      const fixed = fixedLoadKw(child, reservedKw);
      for (const phase of circuitPhases) into[phase] += fixed / circuitPhases.length;
    } else {
      fixedPhaseLoad(child, reservedKw, into);
    }
  }
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
    const circuitAllocations =
      strategy === 'priority_based'
        ? computePriorityAllocation(circuit.stations, available)
        : computeEqualShareAllocation(circuit.stations, available);

    for (const alloc of circuitAllocations) {
      allocationMap.set(alloc.stationDbId, alloc);
    }
  }

  function stationAllocatedKw(node: HierarchyNode): number {
    let total = 0;
    for (const station of node.stations) {
      total += allocationMap.get(station.id)?.allocatedKw ?? 0;
    }
    for (const child of node.children) {
      total += stationAllocatedKw(child);
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
      panel.maxContinuousKw - panel.safetyMarginKw - fixedLoadKw(panel, reservedKw),
    );
    const stationDemand = stationAllocatedKw(panel);
    if (stationDemand > panelAvailable && stationDemand > 0) {
      reduceAllocations(entriesUnder(panel, null), panelAvailable);
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
          !getCircuitPhases(child.phaseConnections, node.phases).includes(phase)
        ) {
          continue;
        }
        for (const station of child.stations) {
          const alloc = allocationMap.get(station.id);
          if (alloc != null) result.push({ station, alloc });
        }
      } else {
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
        const circuitPhases = getCircuitPhases(child.phaseConnections, node.phases);
        let circuitTotal = 0;
        for (const station of child.stations) {
          const alloc = allocMap.get(station.id);
          if (alloc != null) {
            circuitTotal += alloc.allocatedKw;
          }
        }
        const phaseCount = circuitPhases.length;
        if (phaseCount > 0) {
          const perPhase = circuitTotal / phaseCount;
          for (const phase of circuitPhases) {
            phaseAllocated[phase] += perPhase;
          }
        }
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
  const command: OcppCommand = {
    stationId,
    action: 'SetChargingProfile',
    payload: buildLoadManagementProfile(allocatedWatts, now, rate),
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
 * Send each allocation to its station as a SetChargingProfile, then tell the
 * dashboards. Returns false when a publish failed, so the caller sends again
 * on the next cycle.
 */
export async function dispatchAllocations(
  siteId: string,
  allocations: AllocationResult[],
  log: ServiceLogger,
  now: Date = new Date(),
  rates: ReadonlyMap<string, StationRate> = new Map(),
): Promise<boolean> {
  const pubsub = getPubSub();

  // Dispatch SetChargingProfile to each station in parallel — each call is
  // an independent pub/sub publish, so serializing them adds (N * publish
  // latency) of needless delay at the end of every 10s control cycle.
  const results = await Promise.all(
    allocations.map((allocation) =>
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

  await broadcastLoadUpdate(pubsub, siteId);
  return results.every(Boolean);
}

/** One allocation as stored in `site_load_management.applied_allocations`. */
export interface AppliedAllocation {
  stationId: string;
  stationDbId: string;
  allocatedKw: number;
  /** True for the power kept for an offline station; nothing is sent for it. */
  reserved?: boolean;
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
    result.push({
      stationId: row['stationId'],
      stationDbId: row['stationDbId'],
      allocatedKw: row['allocatedKw'],
      ...(row['reserved'] === true ? { reserved: true } : {}),
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
      }))
      .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0)),
  );
}

/**
 * Unit and circuit of each managed station, for a limit in A: the circuit's
 * panel voltage and the conductor phases of the circuit.
 */
export function stationRates(nodes: readonly HierarchyNode[]): Map<string, StationRate> {
  const rates = new Map<string, StationRate>();
  const walk = (list: readonly HierarchyNode[]): void => {
    for (const node of list) {
      if (node.type === 'circuit') {
        const phases = circuitConductorPhases(node.phaseConnections, node.phases);
        for (const station of node.stations) {
          rates.set(station.id, {
            rateUnit: station.rateUnit,
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
 * the limit it last received, else its maximum power. It keeps charging while
 * offline, so its circuit cannot give that power to the others.
 */
export function offlineReservations(
  stations: readonly StationPowerInfo[],
  previous: readonly AppliedAllocation[] | null,
): Map<string, number> {
  const lastKw = new Map((previous ?? []).map((a) => [a.stationDbId, a.allocatedKw]));
  const reserved = new Map<string, number>();
  for (const station of stations) {
    if (station.isOnline || !station.hasActiveSession) continue;
    const kw = lastKw.get(station.id) ?? (station.maxPowerKw > 0 ? station.maxPowerKw : 0);
    reserved.set(station.id, kw);
  }
  return reserved;
}

/**
 * Current allocation of a site: its power status, its hierarchy, the power
 * kept for offline stations, and the allocations of the online ones.
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
  const reservedKw = offlineReservations(managed, previous);
  const allocations =
    hierarchy.length === 0 ? [] : computeHierarchicalAllocation(hierarchy, strategy, reservedKw);
  return { status, hierarchy, managed, reservedKw, allocations };
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

      const stationIdByDbId = new Map(managed.map((s) => [s.id, s.stationId]));
      const applied: AppliedAllocation[] = [
        ...allocations.map((a) => ({
          stationId: a.stationId,
          stationDbId: a.stationDbId,
          allocatedKw: a.allocatedKw,
        })),
        ...[...reservedKw].map(([stationDbId, allocatedKw]) => ({
          stationId: stationIdByDbId.get(stationDbId) ?? stationDbId,
          stationDbId,
          allocatedKw,
          reserved: true,
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
      const sent = await dispatchAllocations(
        site.siteId,
        allocations,
        log,
        now,
        stationRates(hierarchy),
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
        // released stations stay listed so their clear is retried too.
        await db
          .update(siteLoadManagement)
          .set({
            appliedAllocations: cleared ? applied : [...applied, ...released],
            appliedAt: null,
          })
          .where(eq(siteLoadManagement.siteId, site.siteId));
      }

      log.info(
        {
          siteId: site.siteId,
          strategy: site.strategy,
          totalDrawKw: status.totalDrawKw,
          stationCount: allocations.length,
          reservedCount: reservedKw.size,
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
