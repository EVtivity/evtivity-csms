// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, sql, asc, inArray } from 'drizzle-orm';
import { db, panels, circuits, unmanagedLoads, transformers } from '@evtivity/database';
import {
  circuitConductorPhases,
  computeMaxContinuousKw,
  effectiveCircuitVoltageV,
} from '@evtivity/lib';
import type {
  StationPowerInfo,
  SiteHierarchyOptions,
  HierarchyNode,
  PanelRow,
  CircuitRow,
  UnmanagedLoadRow,
  TransformerRow,
} from './load-management-model.js';
import {
  type EnergyAssetsKnowledge,
  applyLocalGeneration,
  applyEnergyAssets,
} from './load-management-energy-assets.js';
import { chargingRateUnitFor } from './load-management-rate-units.js';
import {
  ownFixedKw,
  circuitPhaseShare,
  mapsThroughStepDown,
  stepDownPrimaryPhases,
  subPanelPhaseShare,
} from './load-management-phases.js';

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
    const conductorPhases = circuitConductorPhases(
      circuit.phaseConnections,
      parentPanel?.phases ?? 1,
    );
    const circuitVoltageV = effectiveCircuitVoltageV(
      circuit.voltageV,
      parentPanel?.voltageV ?? 240,
      parentPanel?.phases ?? 1,
    );
    for (const station of circuitStations) {
      // A single-phase charger on a three-phase circuit draws on one phase
      // only: its limits and allowance are for that one phase.
      const singleOnThree = station.supplyPhases === 1 && conductorPhases === 3;
      const stationPhases = singleOnThree ? 1 : conductorPhases;
      if (station.supportedRateUnits != null && station.supportedRateUnits.length > 0) {
        station.rateUnit = chargingRateUnitFor(station.supportedRateUnits);
      }
      station.circuitVoltageV = circuitVoltageV;
      station.circuitPhases = stationPhases;
      station.circuitCapacityKw = Number(circuit.maxContinuousKw);
      station.singlePhaseOnThreePhase = singleOnThree;
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
      voltageV: circuitVoltageV,
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
    // The lower of the breaker per phase and a third of the stored continuous
    // limit: a row whose limit is set below its breaker never gets more per phase.
    const perPhaseCapacityKw = isThreePhase
      ? Math.min(
          computeMaxContinuousKw(panel.breakerRatingAmps, panel.voltageV, 1),
          Number(panel.maxContinuousKw) / 3,
        )
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
