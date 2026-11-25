// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The one writer of a site's load management tree: the `panels`,
// `circuits` and `transformers` tables and the panel transformer link
// (`panels.transformer_id`). The routes and the seeds call it; every
// write records the site `load_management_changed` audit row in the caller's
// name (fail-open, writeAudit). A panel delete also unassigns the site's
// stations from the panel's circuits, and a circuit delete from the circuit,
// before the row goes (the database cascades the circuits and unmanaged
// loads). A panel whose voltage or phases change recomputes the capacity of
// its circuits, and a panel that is no longer three-phase clears the phase
// connections of its sub-panels.
//
// Transformers: the writer computes `max_continuous_kw` (rated kVA x power
// factor x loading limit, `computeTransformerCapacityKw`) on every write, and
// refuses (LoadTreeValidationError, 400 VALIDATION_ERROR with `field`) a link
// that breaks the tree rules: a panel names only a rated transformer of its
// site; a top-level panel only a `service` transformer; a sub-panel only a
// `step_down` transformer fed from its parent panel. A transformer delete
// unlinks its panels first; a panel delete takes the step-down units it feeds
// with it (foreign key cascade, listed in the audit row).
//
// Station Unit budgets (`station_unit_load_budgets`): a budget goes on a unit
// of a station of the site whose EVSEs are all AC or all DC, of that kind; an
// AC budget without phases takes the conductor phases of the station circuit.
//
// Seeds insert rows with fixed ids only while the id is free (`ifMissing`: no
// row written and no audit when it exists), and move a row of an earlier plan
// only while it still holds what that plan seeded (`onlyIf`: no audit when no
// row changed).

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { circuitConductorPhases, evseChargingKind } from '@evtivity/lib';
import { UNIT_BUDGET_MIN_AC_A } from '@evtivity/lib/load-allocation';
import { db } from '../config.js';
import { panels, circuits, stationUnitLoadBudgets } from '../schema/load-management.js';
import { chargingStations, connectors, evses, stationUnits } from '../schema/assets.js';
import {
  type LoadTreeWriteContext,
  LoadTreeValidationError,
  writeTreeAudit,
} from './load-management-tree.js';

export type UnitLoadBudgetRow = typeof stationUnitLoadBudgets.$inferSelect;

/** A unit budget as the caller sends it: AC in A per phase, DC in kW. */
export type UnitLoadBudgetInput =
  | { kind: 'ac'; maxCurrentA: number; phases?: 1 | 3 | null }
  | { kind: 'dc'; maxPowerKw: number };

/** A unit budget as the audit row and the routes show it. */
export interface UnitLoadBudgetView {
  unitId: string;
  stationId: string;
  kind: 'ac' | 'dc';
  maxCurrentA: number | null;
  phases: number | null;
  maxPowerKw: number | null;
}

export type UnitBudgetRefusal =
  | 'station_not_found'
  | 'unit_not_found'
  | 'mixed_unit'
  | 'kind_mismatch';

export type UnitBudgetWriteResult =
  | { ok: true; budget: UnitLoadBudgetView; changed: boolean }
  | { ok: false; reason: UnitBudgetRefusal };

export type UnitBudgetClearResult =
  | { ok: true; removed: boolean }
  | { ok: false; reason: 'station_not_found' | 'unit_not_found' };

type TreeTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function unitLoadBudgetView(row: UnitLoadBudgetRow): UnitLoadBudgetView {
  return {
    unitId: row.unitId,
    stationId: row.stationId,
    kind: row.kind === 'dc' ? 'dc' : 'ac',
    maxCurrentA: row.maxCurrentA == null ? null : Number(row.maxCurrentA),
    phases: row.phases,
    maxPowerKw: row.maxPowerKw == null ? null : Number(row.maxPowerKw),
  };
}

/**
 * The charging kind of a unit from the in-service connectors of its in-service
 * EVSEs: `ac` or `dc` when every EVSE with a typed connector is that kind,
 * `mixed` when they differ (or one EVSE holds both), null when none is typed.
 */
export async function unitChargingKind(
  tx: TreeTx | typeof db,
  unitId: string,
): Promise<'ac' | 'dc' | 'mixed' | null> {
  const rows = await tx
    .select({
      evseId: evses.id,
      connectorType: connectors.connectorType,
      maxPowerKw: connectors.maxPowerKw,
    })
    .from(evses)
    .innerJoin(connectors, eq(connectors.evseId, evses.id))
    .where(and(eq(evses.unitId, unitId), isNull(evses.retiredAt), isNull(connectors.retiredAt)));
  const byEvse = new Map<
    string,
    Array<{ connectorType: string | null; maxPowerKw: string | null }>
  >();
  for (const row of rows) {
    const list = byEvse.get(row.evseId) ?? [];
    list.push({ connectorType: row.connectorType, maxPowerKw: row.maxPowerKw });
    byEvse.set(row.evseId, list);
  }
  let kind: 'ac' | 'dc' | 'mixed' | null = null;
  for (const list of byEvse.values()) {
    const evseKind = evseChargingKind(list);
    if (evseKind == null) continue;
    if (evseKind === 'mixed' || (kind != null && kind !== evseKind)) return 'mixed';
    kind = evseKind;
  }
  return kind;
}

async function lockSiteStation(
  tx: TreeTx,
  siteId: string,
  stationId: string,
): Promise<{ circuitId: string | null } | null> {
  const [station] = await tx
    .select({ circuitId: chargingStations.circuitId })
    .from(chargingStations)
    .where(and(eq(chargingStations.id, stationId), eq(chargingStations.siteId, siteId)))
    .for('update');
  return station ?? null;
}

async function stationUnitName(
  tx: TreeTx,
  stationId: string,
  unitId: string,
): Promise<string | null> {
  const [unit] = await tx
    .select({ name: stationUnits.name })
    .from(stationUnits)
    .where(and(eq(stationUnits.id, unitId), eq(stationUnits.stationId, stationId)));
  return unit?.name ?? null;
}

/** The phases an AC unit budget takes by default: 3 on a three-phase circuit, else 1; null without a circuit. */
export async function circuitPhaseDefault(
  tx: TreeTx | typeof db,
  circuitId: string | null,
): Promise<1 | 3 | null> {
  if (circuitId == null) return null;
  const [row] = await tx
    .select({ phaseConnections: circuits.phaseConnections, panelPhases: panels.phases })
    .from(circuits)
    .innerJoin(panels, eq(panels.id, circuits.panelId))
    .where(eq(circuits.id, circuitId));
  if (row == null) return null;
  return circuitConductorPhases(row.phaseConnections, row.panelPhases) >= 3 ? 3 : 1;
}

function sameBudget(a: UnitLoadBudgetView | null, b: UnitLoadBudgetView): boolean {
  return (
    a != null &&
    a.kind === b.kind &&
    a.maxCurrentA === b.maxCurrentA &&
    a.phases === b.phases &&
    a.maxPowerKw === b.maxPowerKw
  );
}

/**
 * Sets the budget of a unit of a station of the site, under the station row
 * lock the unit writer takes. Refuses a station of another site, a unit of
 * another station, a unit whose EVSEs mix AC and DC and a budget of the other
 * kind; an AC budget without phases takes the circuit's (else refused with
 * LoadTreeValidationError on `phases`). Writing the same budget again changes
 * and audits nothing.
 */
export async function setUnitLoadBudget(
  input: { siteId: string; stationId: string; unitId: string; budget: UnitLoadBudgetInput },
  ctx: LoadTreeWriteContext,
): Promise<UnitBudgetWriteResult> {
  const { siteId, stationId, unitId, budget } = input;
  const outcome = await db.transaction(async (tx) => {
    const station = await lockSiteStation(tx, siteId, stationId);
    if (station == null) return { ok: false as const, reason: 'station_not_found' as const };
    const unitName = await stationUnitName(tx, stationId, unitId);
    if (unitName == null) return { ok: false as const, reason: 'unit_not_found' as const };
    const kind = await unitChargingKind(tx, unitId);
    if (kind === 'mixed') return { ok: false as const, reason: 'mixed_unit' as const };
    if (kind != null && kind !== budget.kind) {
      return { ok: false as const, reason: 'kind_mismatch' as const };
    }
    let phases: 1 | 3 | null = null;
    if (budget.kind === 'ac') {
      if (!(budget.maxCurrentA >= UNIT_BUDGET_MIN_AC_A)) {
        throw new LoadTreeValidationError(
          `An AC unit budget is at least ${String(UNIT_BUDGET_MIN_AC_A)} A: 80 percent of it must reach the 6 A an AC session needs`,
          'maxCurrentA',
        );
      }
      phases = budget.phases ?? (await circuitPhaseDefault(tx, station.circuitId));
      if (phases == null) {
        throw new LoadTreeValidationError(
          'The station is on no circuit: give the phases of the unit budget',
          'phases',
        );
      }
    }
    const values = {
      kind: budget.kind,
      maxCurrentA: budget.kind === 'ac' ? budget.maxCurrentA.toFixed(1) : null,
      phases,
      maxPowerKw: budget.kind === 'dc' ? budget.maxPowerKw.toFixed(2) : null,
    };
    const [previousRow] = await tx
      .select()
      .from(stationUnitLoadBudgets)
      .where(eq(stationUnitLoadBudgets.unitId, unitId));
    const previous = previousRow == null ? null : unitLoadBudgetView(previousRow);
    const [written] = await tx
      .insert(stationUnitLoadBudgets)
      .values({ unitId, stationId, ...values })
      .onConflictDoUpdate({
        target: stationUnitLoadBudgets.unitId,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    if (written == null) throw new Error('Unit load budget not written');
    const after = unitLoadBudgetView(written);
    return { ok: true as const, budget: after, previous, unitName };
  });
  if (!outcome.ok) return outcome;
  const changed = !sameBudget(outcome.previous, outcome.budget);
  if (changed) {
    await writeTreeAudit(siteId, ctx, {
      before: { unitBudget: outcome.previous },
      after: { unitBudget: outcome.budget },
      notes: `unit load budget set: ${outcome.unitName}`,
    });
  }
  return { ok: true, budget: outcome.budget, changed };
}

/** Removes the budget of a unit of a station of the site; audited only when one existed. */
export async function clearUnitLoadBudget(
  input: { siteId: string; stationId: string; unitId: string },
  ctx: LoadTreeWriteContext,
): Promise<UnitBudgetClearResult> {
  const { siteId, stationId, unitId } = input;
  const outcome = await db.transaction(async (tx) => {
    const station = await lockSiteStation(tx, siteId, stationId);
    if (station == null) return { ok: false as const, reason: 'station_not_found' as const };
    const unitName = await stationUnitName(tx, stationId, unitId);
    if (unitName == null) return { ok: false as const, reason: 'unit_not_found' as const };
    const [removed] = await tx
      .delete(stationUnitLoadBudgets)
      .where(
        and(
          eq(stationUnitLoadBudgets.unitId, unitId),
          eq(stationUnitLoadBudgets.stationId, stationId),
        ),
      )
      .returning();
    return {
      ok: true as const,
      removed: removed == null ? null : unitLoadBudgetView(removed),
      unitName,
    };
  });
  if (!outcome.ok) return outcome;
  if (outcome.removed != null) {
    await writeTreeAudit(siteId, ctx, {
      before: { unitBudget: outcome.removed },
      after: { unitBudget: null },
      notes: `unit load budget removed: ${outcome.unitName}`,
    });
  }
  return { ok: true, removed: outcome.removed != null };
}

/** The budgets of the units of the given stations. */
export async function readUnitLoadBudgets(
  stationIds: readonly string[],
): Promise<UnitLoadBudgetView[]> {
  if (stationIds.length === 0) return [];
  const rows = await db
    .select()
    .from(stationUnitLoadBudgets)
    .where(inArray(stationUnitLoadBudgets.stationId, [...stationIds]));
  return rows.map(unitLoadBudgetView);
}
