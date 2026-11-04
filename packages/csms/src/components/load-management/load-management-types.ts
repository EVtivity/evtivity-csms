// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TransformerKind } from '@evtivity/lib/load-allocation';
import { ApiError } from '@/lib/api';
import { formatNumber } from '@/lib/formatting';

// Shapes and helpers the Load Management tab shares for transformers,
// batteries and solar (features/load-management.md, "Transformers and energy
// assets"). Every query key starts with ['sites', siteId, 'load-management'],
// so the tab's invalidation after a write refreshes all of them.

export type SupplyState = 'fresh' | 'stale' | 'none';

/** A battery or solar asset connected at a hierarchy node (`GET .../load-management`). */
export interface NodeEnergyAsset {
  id: string;
  name: string;
  type: 'battery' | 'solar';
  connection: 'transformer' | 'panel';
  supply: {
    state: SupplyState;
    creditKw: number;
    loadKw: number;
    creditApplied?: boolean;
    readingReceivedAt: string | null;
    socPercent: number | null;
  };
}

/** `GET /v1/sites/:siteId/transformers` item. */
export interface TransformerItem {
  id: string;
  siteId: string;
  kind: TransformerKind;
  name: string;
  ratedKva: number | null;
  phases: number;
  secondaryVoltageV: number | null;
  powerFactor: number;
  loadingLimitPercent: number;
  safetyMarginKw: number;
  fedFromPanelId: string | null;
  maxContinuousKw: number | null;
  panelIds: string[];
  sortOrder: number;
}

/** `GET /v1/sites/:siteId/energy-assets` item. */
export interface EnergyAssetItem {
  id: string;
  siteId: string;
  type: 'battery' | 'solar';
  name: string;
  capacityKwh: number | null;
  peakKwp: number | null;
  inverterKw: number | null;
  maxDischargeKw: number | null;
  maxChargeKw: number | null;
  phases: number;
  connectionTransformerId: string | null;
  connectionPanelId: string | null;
  gridCharging: 'never' | 'possible';
  reservePercent: number;
  telemetry: 'none' | 'api' | 'simulated';
  readingTtlSeconds: number;
  reading: {
    reportedAt: string;
    receivedAt: string;
    powerKw: number;
    availableKw: number | null;
    socPercent: number | null;
    source: string;
  } | null;
  supply: {
    state: SupplyState;
    counted: boolean;
    creditKw: number;
    loadKw: number;
  };
}

/** The fields of a hierarchy node the tree and the forms read. */
export interface TreeNode {
  type?: 'panel' | 'circuit' | 'transformer';
  id: string;
  name: string;
  childPanels: TreeNode[];
}

export function transformersQueryKey(siteId: string): unknown[] {
  return ['sites', siteId, 'load-management', 'transformers'];
}

export function energyAssetsQueryKey(siteId: string): unknown[] {
  return ['sites', siteId, 'load-management', 'energy-assets'];
}

/** The list the API answered, or [] for anything else (a test mock, an error body). */
export function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function isTransformerNode(node: { type?: string }): boolean {
  return node.type === 'transformer';
}

/**
 * Every panel of the tree, top down, without the transformer nodes (a
 * transformer sits between a panel and its sub-panels, or above the
 * top-level panels).
 */
export function flattenPanelNodes<T extends TreeNode>(nodes: T[]): T[] {
  const result: T[] = [];
  for (const node of nodes) {
    if (!isTransformerNode(node)) result.push(node);
    result.push(...flattenPanelNodes(node.childPanels as T[]));
  }
  return result;
}

/**
 * The parent panel of every panel: a sub-panel below a step-down transformer
 * belongs to the panel that feeds the transformer. Top-level panels map to null.
 */
export function parentPanelIds(nodes: TreeNode[]): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  const visit = (list: TreeNode[], parent: string | null): void => {
    for (const node of list) {
      if (isTransformerNode(node)) {
        visit(node.childPanels, parent);
      } else {
        parents.set(node.id, parent);
        visit(node.childPanels, node.id);
      }
    }
  };
  visit(nodes, null);
  return parents;
}

/** The `field` of a 400 VALIDATION_ERROR, or null. */
export function refusedField(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { code?: unknown; field?: unknown } | null;
  if (body == null || typeof body !== 'object') return null;
  return body.code === 'VALIDATION_ERROR' && typeof body.field === 'string' ? body.field : null;
}

/** Translation key of a supply state badge. */
export function supplyStateKey(
  state: SupplyState,
): 'loadManagement.supplyLive' | 'loadManagement.supplyStale' | 'loadManagement.supplyNoData' {
  if (state === 'fresh') return 'loadManagement.supplyLive';
  if (state === 'stale') return 'loadManagement.supplyStale';
  return 'loadManagement.supplyNoData';
}

export function supplyStateVariant(state: SupplyState): 'success' | 'warning' | 'outline' {
  if (state === 'fresh') return 'success';
  if (state === 'stale') return 'warning';
  return 'outline';
}

/** A kVA rating: whole ratings without decimals (500 kVA), others with one (112.5 kVA). */
export function formatKva(kva: number): string {
  return `${formatNumber(kva, Number.isInteger(kva) ? 0 : 1)} kVA`;
}
