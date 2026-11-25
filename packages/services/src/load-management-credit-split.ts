// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { CREDIT_CLOCK_MARGIN_MS } from './load-limit-entries.js';
import type { LoadAllocationStrategy } from '@evtivity/lib';
import {
  type HierarchyNode,
  type AllocationResult,
  type StationPowerInfo,
  EPSILON_KW,
} from './load-management-model.js';
import { computeHierarchicalAllocation } from './load-management-allocation.js';
import { LOAD_MANAGEMENT_CYCLE_MS } from './load-management-send.js';
import { takesCreditProfile } from './load-management-profiles.js';

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
 * limit until `validToMs`, one clock margin before the earliest end of a fresh
 * reading; one that takes no credit profile (`takesCreditProfile`) gets the
 * lower limit only.
 */
export function splitCreditLimits(
  hierarchy: HierarchyNode[],
  strategy: LoadAllocationStrategy,
  reservedKw: ReadonlyMap<string, number>,
  allocations: AllocationResult[],
  managed: readonly StationPowerInfo[],
  nowMs: number,
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
  // A station whose clock runs behind keeps a credit profile up to the clock
  // margin past its end, so the profile ends one margin before the readings do,
  // and a credit that would last less than one cycle is not sent at all.
  const creditEndMs = freshUntil - CREDIT_CLOCK_MARGIN_MS;
  if (creditEndMs - nowMs <= LOAD_MANAGEMENT_CYCLE_MS) {
    return {
      allocations: allocations.map((a) => ({
        ...a,
        allocatedKw: Math.min(a.allocatedKw, withoutById.get(a.stationDbId) ?? 0),
      })),
      baseKw,
      validToMs: null,
    };
  }
  const stations = new Map(managed.map((s) => [s.id, s]));
  const split = allocations.map((a) => {
    const base = Math.min(a.allocatedKw, withoutById.get(a.stationDbId) ?? 0);
    if (base >= a.allocatedKw - EPSILON_KW) return a;
    const station = stations.get(a.stationDbId);
    if (station != null && !takesCreditProfile(station)) return { ...a, allocatedKw: base };
    baseKw.set(a.stationDbId, base);
    return a;
  });
  return { allocations: split, baseKw, validToMs: baseKw.size > 0 ? creditEndMs : null };
}
