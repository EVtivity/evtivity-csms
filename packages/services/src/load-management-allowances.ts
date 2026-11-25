// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { LoadAllocationStrategy } from '@evtivity/lib';
import { acMinimumKw } from '@evtivity/lib/evse-allocation';
import {
  type StationPowerInfo,
  type AllocationResult,
  type HierarchyNode,
  EPSILON_KW,
} from './load-management-model.js';
import type { StationRate } from './load-management-profiles.js';
import { toResult, computeHierarchicalAllocation } from './load-management-allocation.js';
import { unitBoxKw } from './load-management-unit-boxes.js';

/**
 * The start allowance of each managed station without an active session (owner
 * decision 2026-11-24): its minimum power, else 6 A on every phase of its
 * circuit, at most its maximum. An online one is sent it as its limit and
 * counted as a fixed load (`online`, reason `idle_allowance`), so a session that
 * starts between cycles starts inside the budget. An offline one keeps the
 * limit it was last sent, else the allowance, as a reservation (`offline`). A
 * station already reserved keeps its reservation.
 */
export function idleAllowances(
  managed: readonly StationPowerInfo[],
  reservedKw: ReadonlyMap<string, number>,
  rates: ReadonlyMap<string, StationRate>,
): AllocationResult[] {
  const online: AllocationResult[] = [];
  for (const station of managed) {
    // Offline stations are reserved at what they may draw (`limitReservations`).
    if (station.hasActiveSession || reservedKw.has(station.id) || !station.isOnline) continue;
    online.push(
      toResult(station, startAllowanceKw(station, rates.get(station.id)), 'idle_allowance'),
    );
  }
  return online;
}

/**
 * The start allowances of the online idle stations that fit the tree after
 * the active sessions (`fitIdleAllowances`). A raise among them waits like
 * any raise (and is held while energy assets are unknown).
 */
export function startAllowances(
  roots: readonly HierarchyNode[],
  strategy: LoadAllocationStrategy,
  managed: readonly StationPowerInfo[],
  reservedKw: Map<string, number>,
  rates: ReadonlyMap<string, StationRate>,
): AllocationResult[] {
  const idle = idleAllowances(managed, reservedKw, rates);
  return fitIdleAllowances(roots, strategy, managed, reservedKw, idle, rates);
}

/** A station's start allowance: its minimum, else 6 A on every phase of its circuit, at most its maximum. */
function startAllowanceKw(
  station: StationPowerInfo,
  rate: StationRate | undefined,
  sessions = 1,
): number {
  const voltageV = rate?.voltageV ?? station.circuitVoltageV;
  const phases = rate?.phases ?? station.circuitPhases ?? 1;
  const sixAmpsKw =
    voltageV != null && voltageV > 0 ? acMinimumKw(voltageV, phases) * Math.max(1, sessions) : 0;
  let kw = station.minPowerKw > 0 ? station.minPowerKw : sixAmpsKw;
  if (station.maxPowerKw > 0) kw = Math.min(kw, station.maxPowerKw);
  const unitCap = smallestUnitBudgetKw(station, rate);
  if (unitCap != null) kw = Math.min(kw, unitCap);
  return Math.max(0, kw);
}

/**
 * The smallest unit box of a station in kW at 80 percent of its rating (owner
 * decision 2026-11-24: an idle allowance fits every unit, since a session can
 * start on any of them). A W limit bounds the total only, so an AC box counts
 * its single-phase worst case (rating x circuit voltage); null without a box.
 */
export function smallestUnitBudgetKw(
  station: StationPowerInfo,
  rate: StationRate | undefined,
): number | null {
  let smallest: number | null = null;
  for (const budget of station.unitBudgets ?? []) {
    const kw = unitBoxKw(budget, station, rate);
    if (kw != null && (smallest == null || kw < smallest)) smallest = kw;
  }
  return smallest;
}

function withStations(
  node: HierarchyNode,
  map: (station: StationPowerInfo) => StationPowerInfo,
): HierarchyNode {
  return {
    ...node,
    stations: node.stations.map(map),
    children: node.children.map((child) => withStations(child, map)),
  };
}

/**
 * The start allowances of the online idle stations that fit the tree (review
 * H1): every active session first keeps what a start allowance holds (its
 * station minimum, else 6 A on its circuit phases per session), then the
 * allowances go through the same circuit, panel, phase and transformer cuts
 * as the sessions, whole or not at all, the lowest priority idle stations
 * left at 0 first. So the allowances never take the power of an active
 * session and never add up above a node.
 */
export function fitIdleAllowances(
  roots: readonly HierarchyNode[],
  strategy: LoadAllocationStrategy,
  managed: readonly StationPowerInfo[],
  reservedKw: ReadonlyMap<string, number>,
  allowances: readonly AllocationResult[],
  rates: ReadonlyMap<string, StationRate>,
): AllocationResult[] {
  const wanted = new Map(
    allowances.filter((a) => a.allocatedKw > EPSILON_KW).map((a) => [a.stationDbId, a.allocatedKw]),
  );
  if (wanted.size === 0) return allowances.map((a) => ({ ...a, allocatedKw: 0 }));
  const fixed = new Map(reservedKw);
  for (const station of managed) {
    if (!station.isOnline || !station.hasActiveSession || fixed.has(station.id)) continue;
    const sessions = (station.sessions ?? []).length;
    fixed.set(station.id, startAllowanceKw(station, rates.get(station.id), sessions));
  }
  const asStarting = (station: StationPowerInfo): StationPowerInfo => {
    const kw = wanted.get(station.id);
    if (kw == null) return station;
    return {
      ...station,
      hasActiveSession: true,
      sessions: [],
      minPowerKw: kw,
      maxPowerKw: kw,
    };
  };
  const fitted = new Map(
    computeHierarchicalAllocation(
      roots.map((root) => withStations(root, asStarting)),
      strategy === 'priority_based' ? 'priority_based' : 'equal_share',
      fixed,
    ).map((a) => [a.stationDbId, a.allocatedKw]),
  );
  return allowances.map((a) => ({
    ...a,
    allocatedKw: Math.min(a.allocatedKw, fitted.get(a.stationDbId) ?? 0),
  }));
}
