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
} from '@evtivity/database';
import type { FastifyBaseLogger } from 'fastify';
import type { PubSubClient } from '@evtivity/lib';
import { getPubSub } from '../lib/pubsub.js';

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

// Cache last allocations per site to avoid sending unchanged profiles
const lastAllocations = new Map<string, string>();

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
      circuitId: chargingStations.circuitId,
    })
    .from(chargingStations)
    .where(eq(chargingStations.siteId, siteId));

  if (stationRows.length === 0) {
    return { totalDrawKw: 0, stations: [] };
  }

  const stationDbIds = stationRows.map((s) => s.id);

  // Get max power for each station from its connectors
  const connectorRows = await db
    .select({
      stationId: evses.stationId,
      maxPowerKw: connectors.maxPowerKw,
    })
    .from(connectors)
    .innerJoin(evses, eq(connectors.evseId, evses.id))
    .where(inArray(evses.stationId, stationDbIds));

  // Sum max power per station
  const stationMaxPower = new Map<string, number>();
  for (const row of connectorRows) {
    const current = stationMaxPower.get(row.stationId) ?? 0;
    stationMaxPower.set(
      row.stationId,
      current + (row.maxPowerKw != null ? Number(row.maxPowerKw) : 0),
    );
  }

  // Get active sessions per station
  const activeSessions = await db
    .select({
      stationId: chargingSessions.stationId,
    })
    .from(chargingSessions)
    .where(
      and(eq(chargingSessions.status, 'active'), inArray(chargingSessions.stationId, stationDbIds)),
    );

  const activeStationIds = new Set(activeSessions.map((s) => s.stationId));

  // Get latest power meter values per station (last 60 seconds)
  const powerValues = await db
    .select({
      stationId: meterValues.stationId,
      value: meterValues.value,
      unit: meterValues.unit,
    })
    .from(meterValues)
    .where(
      and(
        eq(meterValues.measurand, 'Power.Active.Import'),
        gte(meterValues.timestamp, since),
        inArray(meterValues.stationId, stationDbIds),
      ),
    )
    .orderBy(desc(meterValues.timestamp));

  // Take the most recent power reading per station
  const stationPower = new Map<string, number>();
  for (const row of powerValues) {
    if (stationPower.has(row.stationId)) continue;
    let kw = Number(row.value);
    // Convert W to kW if unit is W or not specified
    if (row.unit == null || row.unit === 'W') {
      kw = kw / 1000;
    }
    stationPower.set(row.stationId, kw);
  }

  // Get per-phase power meter values (last 60 seconds)
  const phasePowerValues = await db
    .select({
      stationId: meterValues.stationId,
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
        sql`${meterValues.phase} IS NOT NULL`,
      ),
    )
    .orderBy(desc(meterValues.timestamp));

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

  // Get EV charging needs (departure times) for priority-aware allocation
  const chargingNeedsRows = await db
    .select({
      stationId: evChargingNeeds.stationId,
      departureTime: evChargingNeeds.departureTime,
    })
    .from(evChargingNeeds)
    .where(inArray(evChargingNeeds.stationId, stationDbIds));

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

/**
 * Distribute available power equally among active stations within a circuit or group.
 * Returns an array of allocations. Iteratively redistributes surplus from capped stations.
 */
export function computeEqualShareAllocation(
  stations: StationPowerInfo[],
  availableKw: number,
): AllocationResult[] {
  const active = stations.filter((s) => s.hasActiveSession && s.isOnline);
  if (active.length === 0) return [];

  const results: AllocationResult[] = [];
  let remaining = availableKw;
  let unallocated = [...active];

  while (unallocated.length > 0 && remaining > 0) {
    const share = remaining / unallocated.length;
    const nextRound: StationPowerInfo[] = [];
    let surplusThisRound = 0;

    for (const station of unallocated) {
      const cap = station.maxPowerKw > 0 ? station.maxPowerKw : share;
      if (share >= cap) {
        results.push({
          stationId: station.stationId,
          stationDbId: station.id,
          allocatedKw: cap,
          currentDrawKw: station.currentDrawKw,
        });
        surplusThisRound += share - cap;
      } else {
        nextRound.push(station);
      }
    }

    if (nextRound.length === unallocated.length) {
      for (const station of nextRound) {
        results.push({
          stationId: station.stationId,
          stationDbId: station.id,
          allocatedKw: share,
          currentDrawKw: station.currentDrawKw,
        });
      }
      break;
    }

    remaining = share * nextRound.length + surplusThisRound;
    unallocated = nextRound;
  }

  return results;
}

/**
 * Distribute available power by priority among active stations.
 * Higher priority groups get first claim. Equal-share within each group.
 */
export function computePriorityAllocation(
  stations: StationPowerInfo[],
  availableKw: number,
): AllocationResult[] {
  const active = stations
    .filter((s) => s.hasActiveSession && s.isOnline)
    .sort((a, b) => {
      if (b.loadPriority !== a.loadPriority) return b.loadPriority - a.loadPriority;
      if (a.departureTime != null && b.departureTime != null) {
        return a.departureTime.getTime() - b.departureTime.getTime();
      }
      if (a.departureTime != null) return -1;
      if (b.departureTime != null) return 1;
      return 0;
    });

  if (active.length === 0) return [];

  const results: AllocationResult[] = [];
  let remaining = availableKw;

  // Group by priority level
  const priorityGroups = new Map<number, StationPowerInfo[]>();
  for (const station of active) {
    const group = priorityGroups.get(station.loadPriority) ?? [];
    group.push(station);
    priorityGroups.set(station.loadPriority, group);
  }

  const sortedPriorities = [...priorityGroups.keys()].sort((a, b) => b - a);

  for (const priority of sortedPriorities) {
    const group = priorityGroups.get(priority);
    if (group == null || remaining <= 0) break;

    let groupRemaining = remaining;
    const groupUnallocated = [...group];

    while (groupUnallocated.length > 0 && groupRemaining > 0) {
      const share = groupRemaining / groupUnallocated.length;
      const nextRound: StationPowerInfo[] = [];
      let surplus = 0;

      for (const station of groupUnallocated) {
        const cap = station.maxPowerKw > 0 ? station.maxPowerKw : share;
        if (share >= cap) {
          results.push({
            stationId: station.stationId,
            stationDbId: station.id,
            allocatedKw: cap,
            currentDrawKw: station.currentDrawKw,
          });
          surplus += share - cap;
          groupRemaining -= cap;
        } else {
          nextRound.push(station);
        }
      }

      if (nextRound.length === groupUnallocated.length) {
        for (const station of nextRound) {
          results.push({
            stationId: station.stationId,
            stationDbId: station.id,
            allocatedKw: share,
            currentDrawKw: station.currentDrawKw,
          });
          groupRemaining -= share;
        }
        break;
      }

      groupRemaining = surplus;
      groupUnallocated.length = 0;
      groupUnallocated.push(...nextRound);
    }

    remaining = groupRemaining;
  }

  return results;
}

/**
 * Compute hierarchical allocation respecting panel and circuit constraints.
 *
 * Algorithm:
 * 1. For each leaf circuit: allocate among active stations using the strategy
 * 2. For each panel (bottom-up): if total child demand exceeds panel capacity,
 *    scale down all allocations proportionally
 * 3. Return final per-station allocations
 */
export function computeHierarchicalAllocation(
  roots: HierarchyNode[],
  strategy: 'equal_share' | 'priority_based',
): AllocationResult[] {
  // Mutable map: stationDbId -> allocatedKw
  const allocationMap = new Map<string, AllocationResult>();

  // Pass 1: Allocate within each circuit
  function allocateCircuit(circuit: HierarchyNode): number {
    const available = Math.max(0, circuit.maxContinuousKw - circuit.unmanagedLoadKw);
    const circuitAllocations =
      strategy === 'priority_based'
        ? computePriorityAllocation(circuit.stations, available)
        : computeEqualShareAllocation(circuit.stations, available);

    let totalAllocated = 0;
    for (const alloc of circuitAllocations) {
      allocationMap.set(alloc.stationDbId, alloc);
      totalAllocated += alloc.allocatedKw;
    }
    return totalAllocated;
  }

  // Pass 2: Enforce panel constraints bottom-up
  function enforcePanel(panel: HierarchyNode): number {
    const panelAvailable = panel.maxContinuousKw - panel.safetyMarginKw - panel.unmanagedLoadKw;
    let childDemand = 0;

    // Process children: circuits get allocations, sub-panels recurse
    for (const child of panel.children) {
      if (child.type === 'circuit') {
        childDemand += allocateCircuit(child);
      } else {
        childDemand += enforcePanel(child);
      }
    }

    // Total capacity scale factor
    let scaleFactor = 1.0;

    // If child demand exceeds panel capacity, scale down
    if (childDemand > panelAvailable && childDemand > 0) {
      scaleFactor = panelAvailable / childDemand;
    }

    // For three-phase panels, check per-phase constraints
    if (panel.phases === 3 && panel.perPhaseCapacityKw != null && panel.phaseLoad != null) {
      const perPhaseLimit =
        panel.perPhaseCapacityKw - panel.safetyMarginKw / 3 - panel.unmanagedLoadKw / 3;
      // Compute per-phase load from allocated circuits (not just current draw)
      const phaseAllocated: PhaseLoad = { L1: 0, L2: 0, L3: 0 };
      computePhaseAllocations(panel, phaseAllocated, allocationMap);

      for (const phase of ['L1', 'L2', 'L3'] as const) {
        if (phaseAllocated[phase] > perPhaseLimit && phaseAllocated[phase] > 0) {
          const phaseScale = perPhaseLimit / phaseAllocated[phase];
          // Scale down only circuits on this overloaded phase
          scaleCircuitsOnPhase(panel, phase, phaseScale, allocationMap);
        }
      }
    }

    if (scaleFactor < 1.0) {
      scaleAllocations(panel, scaleFactor);
      return panelAvailable;
    }

    return childDemand;
  }

  // Scale all allocations under a panel node by a factor
  function scaleAllocations(node: HierarchyNode, factor: number): void {
    for (const child of node.children) {
      if (child.type === 'circuit') {
        for (const station of child.stations) {
          const alloc = allocationMap.get(station.id);
          if (alloc != null) {
            alloc.allocatedKw = alloc.allocatedKw * factor;
          }
        }
      } else {
        scaleAllocations(child, factor);
      }
    }
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

  // Scale down allocations for circuits connected to a specific overloaded phase
  function scaleCircuitsOnPhase(
    node: HierarchyNode,
    phase: 'L1' | 'L2' | 'L3',
    factor: number,
    allocMap: Map<string, AllocationResult>,
  ): void {
    for (const child of node.children) {
      if (child.type === 'circuit') {
        const circuitPhases = getCircuitPhases(child.phaseConnections, node.phases);
        if (circuitPhases.includes(phase)) {
          for (const station of child.stations) {
            const alloc = allocMap.get(station.id);
            if (alloc != null) {
              alloc.allocatedKw = alloc.allocatedKw * factor;
            }
          }
        }
      } else {
        scaleCircuitsOnPhase(child, phase, factor, allocMap);
      }
    }
  }

  // Process all root panels
  for (const root of roots) {
    enforcePanel(root);
  }

  return [...allocationMap.values()];
}

async function dispatchSetChargingProfile(
  pubsub: PubSubClient,
  stationId: string,
  allocatedWatts: number,
  log: FastifyBaseLogger,
): Promise<void> {
  const payload = {
    commandId: crypto.randomUUID(),
    stationId,
    action: 'SetChargingProfile',
    payload: {
      evseId: 0,
      chargingProfile: {
        id: 1,
        stackLevel: 0,
        chargingProfilePurpose: 'ChargingStationExternalConstraints',
        chargingProfileKind: 'Absolute',
        chargingSchedule: [
          {
            id: 1,
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [
              {
                startPeriod: 0,
                limit: allocatedWatts,
              },
            ],
          },
        ],
      },
    },
  };

  try {
    await pubsub.publish('ocpp_commands', JSON.stringify(payload));
  } catch (err: unknown) {
    log.error({ err, stationId }, 'Failed to dispatch SetChargingProfile');
  }
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
  } catch {
    // Non-critical, SSE update is best-effort
  }
}

export async function applyAllocations(
  siteId: string,
  allocations: AllocationResult[],
  config: { strategy: string },
  totalDrawKw: number,
  log: FastifyBaseLogger,
): Promise<void> {
  const pubsub = getPubSub();

  // Compute totals for the log
  const totalAllocatedKw = allocations.reduce((sum, a) => sum + a.allocatedKw, 0);

  // Log the allocation cycle
  await db.insert(loadAllocationLog).values({
    siteId,
    siteLimitKw: String(totalAllocatedKw),
    totalDrawKw: String(totalDrawKw),
    availableKw: String(totalAllocatedKw),
    strategy: config.strategy,
    allocations: allocations.map((a) => ({
      stationId: a.stationId,
      allocatedKw: a.allocatedKw,
      currentDrawKw: a.currentDrawKw,
    })),
  });

  // Dispatch SetChargingProfile to each station
  for (const allocation of allocations) {
    const allocatedWatts = Math.round(allocation.allocatedKw * 1000);
    await dispatchSetChargingProfile(pubsub, allocation.stationId, allocatedWatts, log);
  }

  await broadcastLoadUpdate(pubsub, siteId);
}

export async function runLoadManagementCycle(
  log: FastifyBaseLogger,
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
    })
    .from(siteLoadManagement)
    .where(and(...conditions));

  for (const site of enabledSites) {
    try {
      const status = await getSitePowerStatus(site.siteId);
      const hierarchy = await buildSiteHierarchy(site.siteId, status.stations);

      let allocations: AllocationResult[];
      if (hierarchy.length === 0) {
        // No panels configured, skip allocation
        allocations = [];
      } else {
        allocations = computeHierarchicalAllocation(hierarchy, site.strategy);
      }

      // Check if allocations changed from last cycle
      const allocationKey = JSON.stringify(
        allocations.map((a) => ({ s: a.stationId, kw: Math.round(a.allocatedKw * 100) })),
      );
      const lastKey = lastAllocations.get(site.siteId);

      if (allocationKey !== lastKey) {
        lastAllocations.set(site.siteId, allocationKey);
        await applyAllocations(
          site.siteId,
          allocations,
          { strategy: site.strategy },
          status.totalDrawKw,
          log,
        );
        log.info(
          {
            siteId: site.siteId,
            strategy: site.strategy,
            totalDrawKw: status.totalDrawKw,
            stationCount: allocations.length,
          },
          'Load management cycle applied',
        );
      }
    } catch (err: unknown) {
      log.error({ err, siteId: site.siteId }, 'Load management cycle failed');
    }
  }
}

const LOOP_INTERVAL_MS = 10_000;

export function startLoadManagementLoop(log: FastifyBaseLogger): () => void {
  log.info('Load management control loop started (interval: 10s)');

  const timer = setInterval(() => {
    void runLoadManagementCycle(log).catch((err: unknown) => {
      log.error({ err }, 'Load management cycle failed');
    });
  }, LOOP_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    log.info('Load management control loop stopped');
  };
}
