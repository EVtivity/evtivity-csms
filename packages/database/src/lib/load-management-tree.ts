// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The one writer of a site's load management tree: the `panels` and
// `circuits` tables. The panel and circuit routes and the seeds call it; every
// write records the site `load_management_changed` audit row in the caller's
// name (fail-open, writeAudit). A panel delete also unassigns the site's
// stations from the panel's circuits, and a circuit delete from the circuit,
// before the row goes (the database cascades the circuits and unmanaged
// loads). A panel whose voltage or phases change recomputes the capacity of
// its circuits, and a panel that is no longer three-phase clears the phase
// connections of its sub-panels.
//
// Seeds insert rows with fixed ids only while the id is free (`ifMissing`: no
// row written and no audit when it exists), and move a row of an earlier plan
// only while it still holds what that plan seeded (`onlyIf`: no audit when no
// row changed).

import { and, eq, isNotNull, type SQL } from 'drizzle-orm';
import {
  circuitConductorPhases,
  computeMaxContinuousKw,
  effectiveCircuitVoltageV,
  isCircuitVoltageAllowed,
} from '@evtivity/lib';
import { db } from '../config.js';
import { panels, circuits } from '../schema/load-management.js';
import { chargingStations } from '../schema/assets.js';
import { siteAuditLog } from '../schema/audit.js';
import { writeAudit, type AuditActor } from './audit.js';

export type PanelRow = typeof panels.$inferSelect;
export type PanelValues = typeof panels.$inferInsert;
export type CircuitRow = typeof circuits.$inferSelect;
export type CircuitValues = typeof circuits.$inferInsert;
export type PanelChanges = Partial<Omit<PanelValues, 'id' | 'siteId' | 'createdAt'>>;
export type CircuitChanges = Partial<Omit<CircuitValues, 'id' | 'createdAt'>>;

type Row = Record<string, unknown>;

/** Who makes the change, the audit notes when not the default, and the warn logger. */
export interface LoadTreeWriteContext {
  actor: AuditActor;
  actorUserId?: string | null;
  actorDriverId?: string | null;
  actorApiKeyId?: string | null;
  actorLabel?: string | null;
  /** Replaces the default audit notes (`panel created: <name>` and so on). */
  notes?: string;
  logger?: { warn: (obj: unknown, msg?: string) => void };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a != null && b != null && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/** The keys of `after` whose value differs from `before`, `updatedAt` left out. */
function changedFields(before: Row, after: Row): { before: Row; after: Row } {
  const b: Row = {};
  const a: Row = {};
  for (const key of Object.keys(after)) {
    if (key === 'updatedAt') continue;
    if (!sameValue(before[key], after[key])) {
      b[key] = before[key] ?? null;
      a[key] = after[key] ?? null;
    }
  }
  return { before: b, after: a };
}

async function writeTreeAudit(
  siteId: string,
  ctx: LoadTreeWriteContext,
  change: { before: unknown; after: unknown; notes: string },
): Promise<void> {
  await writeAudit(
    { table: siteAuditLog, idColumn: 'site_id' },
    {
      entityId: siteId,
      entityIdSnapshot: siteId,
      action: 'load_management_changed',
      actor: ctx.actor,
      actorUserId: ctx.actorUserId ?? null,
      actorDriverId: ctx.actorDriverId ?? null,
      actorApiKeyId: ctx.actorApiKeyId ?? null,
      actorLabel: ctx.actorLabel ?? null,
      before: change.before,
      after: change.after,
      notes: ctx.notes ?? change.notes,
    },
    db,
    ctx.logger,
  );
}

/**
 * Inserts a panel of `values.siteId`. Returns the new row, or null when none
 * was written (`ifMissing` and the id exists): then nothing is audited.
 */
export async function createPanel(
  values: PanelValues,
  ctx: LoadTreeWriteContext,
  options: { ifMissing?: boolean } = {},
): Promise<PanelRow | null> {
  const insert = db.insert(panels).values(values);
  const rows =
    options.ifMissing === true
      ? await insert.onConflictDoNothing({ target: panels.id }).returning()
      : await insert.returning();
  const created = rows[0];
  if (created == null) return null;
  await writeTreeAudit(created.siteId, ctx, {
    before: null,
    after: { panel: created },
    notes: `panel created: ${created.name}`,
  });
  return created;
}

/**
 * Updates a panel of the site. `existing` is the row the caller read (read
 * here when absent); `onlyIf` narrows the update to a row still in a given
 * state. `recomputeCircuits` recomputes the capacity of the panel's circuits
 * (voltage or phases changed); a circuit voltage the panel no longer allows is
 * cleared, so the circuit runs at the panel voltage. `clearSubPanelPhases`
 * clears the phase connections of the sub-panels when the panel is no longer
 * three-phase. Returns the updated row, or null when no row changed (nothing
 * else written, nothing audited).
 */
export async function updatePanel(
  input: {
    siteId: string;
    panelId: string;
    existing?: PanelRow;
    set: PanelChanges;
    onlyIf?: SQL | undefined;
    recomputeCircuits?: boolean;
    clearSubPanelPhases?: boolean;
  },
  ctx: LoadTreeWriteContext,
): Promise<PanelRow | null> {
  const { siteId, panelId } = input;
  let existing = input.existing;
  if (existing == null) {
    [existing] = await db
      .select()
      .from(panels)
      .where(and(eq(panels.id, panelId), eq(panels.siteId, siteId)));
    if (existing == null) return null;
  }

  const rows = await db
    .update(panels)
    .set({ ...input.set, updatedAt: input.set.updatedAt ?? new Date() })
    .where(
      input.onlyIf == null ? eq(panels.id, panelId) : and(eq(panels.id, panelId), input.onlyIf),
    )
    .returning();
  const updated = rows[0];
  if (updated == null) return null;

  if (input.recomputeCircuits === true) {
    const panelCircuits = await db.select().from(circuits).where(eq(circuits.panelId, panelId));
    for (const circuit of panelCircuits) {
      const keepVoltage =
        circuit.voltageV != null &&
        isCircuitVoltageAllowed(circuit.voltageV, updated.voltageV, updated.phases);
      const circuitMaxKw = computeMaxContinuousKw(
        circuit.breakerRatingAmps,
        effectiveCircuitVoltageV(
          keepVoltage ? circuit.voltageV : null,
          updated.voltageV,
          updated.phases,
        ),
        circuitConductorPhases(circuit.phaseConnections, updated.phases),
      );
      await db
        .update(circuits)
        .set({
          maxContinuousKw: String(circuitMaxKw),
          ...(circuit.voltageV != null && !keepVoltage ? { voltageV: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(circuits.id, circuit.id));
    }
  }

  if (input.clearSubPanelPhases === true && updated.phases !== 3) {
    await db
      .update(panels)
      .set({ phaseConnections: null, updatedAt: new Date() })
      .where(
        and(
          eq(panels.parentPanelId, panelId),
          eq(panels.siteId, siteId),
          isNotNull(panels.phaseConnections),
        ),
      );
  }

  const change = changedFields(existing, updated);
  await writeTreeAudit(siteId, ctx, {
    before: { panelId, ...change.before },
    after: { panelId, ...change.after },
    notes: `panel updated: ${updated.name}`,
  });
  return updated;
}

/**
 * Deletes a panel of the site: unassigns the site's stations from the panel's
 * circuits, then deletes the panel (the database cascades its circuits and
 * unmanaged loads). `panel` is the row the caller read.
 */
export async function deletePanel(
  input: { siteId: string; panel: PanelRow },
  ctx: LoadTreeWriteContext,
): Promise<void> {
  const { siteId, panel } = input;
  const panelCircuits = await db
    .select({ id: circuits.id })
    .from(circuits)
    .where(eq(circuits.panelId, panel.id));

  for (const circuit of panelCircuits) {
    await db
      .update(chargingStations)
      .set({ circuitId: null, updatedAt: new Date() })
      .where(and(eq(chargingStations.circuitId, circuit.id), eq(chargingStations.siteId, siteId)));
  }

  await db.delete(panels).where(eq(panels.id, panel.id));

  await writeTreeAudit(siteId, ctx, {
    before: { panel, circuitIds: panelCircuits.map((c) => c.id) },
    after: null,
    notes: `panel deleted: ${panel.name}`,
  });
}

/**
 * Inserts a circuit on a panel of the site. Returns the new row, or null when
 * none was written (`ifMissing` and the id exists): then nothing is audited.
 */
export async function createCircuit(
  siteId: string,
  values: CircuitValues,
  ctx: LoadTreeWriteContext,
  options: { ifMissing?: boolean } = {},
): Promise<CircuitRow | null> {
  const insert = db.insert(circuits).values(values);
  const rows =
    options.ifMissing === true
      ? await insert.onConflictDoNothing({ target: circuits.id }).returning()
      : await insert.returning();
  const created = rows[0];
  if (created == null) return null;
  await writeTreeAudit(siteId, ctx, {
    before: null,
    after: { circuit: created },
    notes: `circuit created: ${created.name}`,
  });
  return created;
}

/**
 * Updates a circuit on a panel of the site. `existing` is the row the caller
 * read (read here when absent); `onlyIf` narrows the update to a row still in
 * a given state. Returns the updated row, or null when no row changed
 * (nothing audited).
 */
export async function updateCircuit(
  input: {
    siteId: string;
    circuitId: string;
    existing?: CircuitRow;
    set: CircuitChanges;
    onlyIf?: SQL | undefined;
  },
  ctx: LoadTreeWriteContext,
): Promise<CircuitRow | null> {
  const { siteId, circuitId } = input;
  let existing = input.existing;
  if (existing == null) {
    [existing] = await db.select().from(circuits).where(eq(circuits.id, circuitId));
    if (existing == null) return null;
  }

  const rows = await db
    .update(circuits)
    .set({ ...input.set, updatedAt: input.set.updatedAt ?? new Date() })
    .where(
      input.onlyIf == null
        ? eq(circuits.id, circuitId)
        : and(eq(circuits.id, circuitId), input.onlyIf),
    )
    .returning();
  const updated = rows[0];
  if (updated == null) return null;

  const change = changedFields(existing, updated);
  await writeTreeAudit(siteId, ctx, {
    before: { circuitId, ...change.before },
    after: { circuitId, ...change.after },
    notes: `circuit updated: ${updated.name}`,
  });
  return updated;
}

/**
 * Deletes a circuit of the site: unassigns the site's stations from it, then
 * deletes it (the database cascades its unmanaged loads). `circuit` is the row
 * the caller read; it is stored as the audit `before`.
 */
export async function deleteCircuit(
  input: { siteId: string; circuit: { id: string; name: string } & Row },
  ctx: LoadTreeWriteContext,
): Promise<void> {
  const { siteId, circuit } = input;
  await db
    .update(chargingStations)
    .set({ circuitId: null, updatedAt: new Date() })
    .where(and(eq(chargingStations.circuitId, circuit.id), eq(chargingStations.siteId, siteId)));

  await db.delete(circuits).where(eq(circuits.id, circuit.id));

  await writeTreeAudit(siteId, ctx, {
    before: { circuit },
    after: null,
    notes: `circuit deleted: ${circuit.name}`,
  });
}
