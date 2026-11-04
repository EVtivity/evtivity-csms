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
// Seeds insert rows with fixed ids only while the id is free (`ifMissing`: no
// row written and no audit when it exists), and move a row of an earlier plan
// only while it still holds what that plan seeded (`onlyIf`: no audit when no
// row changed).

import { and, eq, isNotNull, type SQL } from 'drizzle-orm';
import {
  circuitConductorPhases,
  computeMaxContinuousKw,
  computeTransformerCapacityKw,
  effectiveCircuitVoltageV,
  isCircuitVoltageAllowed,
  ValidationError,
} from '@evtivity/lib';
import { db } from '../config.js';
import { panels, circuits, transformers } from '../schema/load-management.js';
import { chargingStations } from '../schema/assets.js';
import { siteAuditLog } from '../schema/audit.js';
import { writeAudit, type AuditActor } from './audit.js';

export type PanelRow = typeof panels.$inferSelect;
export type PanelValues = typeof panels.$inferInsert;
export type CircuitRow = typeof circuits.$inferSelect;
export type CircuitValues = typeof circuits.$inferInsert;
export type PanelChanges = Partial<Omit<PanelValues, 'id' | 'siteId' | 'createdAt'>>;
export type CircuitChanges = Partial<Omit<CircuitValues, 'id' | 'createdAt'>>;
export type TransformerRow = typeof transformers.$inferSelect;
/** A new transformer: the writer computes `maxContinuousKw`. */
export type TransformerValues = Omit<typeof transformers.$inferInsert, 'maxContinuousKw'>;
export type TransformerChanges = Partial<Omit<TransformerValues, 'id' | 'siteId' | 'createdAt'>>;

/**
 * A write that breaks a rule of the load management tree. A ValidationError
 * (400 VALIDATION_ERROR); `field` names the input the caller should fix.
 */
export class LoadTreeValidationError extends ValidationError {
  public readonly field: string;

  constructor(message: string, field: string) {
    super(message, { field });
    this.name = 'LoadTreeValidationError';
    this.field = field;
  }
}

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

/**
 * The keys of `after` whose value differs from `before`, `updatedAt` left out.
 * Shared with the energy asset writer.
 */
export function changedFields(before: Row, after: Row): { before: Row; after: Row } {
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

/** The site `load_management_changed` audit row; shared with the energy asset writer. */
export async function writeTreeAudit(
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
  if (values.transformerId != null) {
    await assertPanelTransformerLink(
      values.siteId,
      values.transformerId,
      values.parentPanelId ?? null,
    );
  }
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

  if ('transformerId' in input.set || 'parentPanelId' in input.set) {
    const transformerId =
      'transformerId' in input.set ? (input.set.transformerId ?? null) : existing.transformerId;
    const parentPanelId =
      'parentPanelId' in input.set ? (input.set.parentPanelId ?? null) : existing.parentPanelId;
    if (transformerId != null) {
      await assertPanelTransformerLink(siteId, transformerId, parentPanelId);
    }
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
  const stepDowns = await db
    .select({ id: transformers.id })
    .from(transformers)
    .where(eq(transformers.fedFromPanelId, panel.id));

  for (const circuit of panelCircuits) {
    await db
      .update(chargingStations)
      .set({ circuitId: null, updatedAt: new Date() })
      .where(and(eq(chargingStations.circuitId, circuit.id), eq(chargingStations.siteId, siteId)));
  }

  await db.delete(panels).where(eq(panels.id, panel.id));

  await writeTreeAudit(siteId, ctx, {
    before: {
      panel,
      circuitIds: panelCircuits.map((c) => c.id),
      stepDownTransformerIds: stepDowns.map((t) => t.id),
    },
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

type TransformerShape = Pick<TransformerRow, 'kind' | 'ratedKva' | 'fedFromPanelId'>;

/**
 * Why `transformer` cannot feed a panel whose parent is `parentPanelId`, or
 * null when it can.
 */
function panelLinkProblem(
  transformer: TransformerShape,
  parentPanelId: string | null,
): string | null {
  if (transformer.ratedKva == null) return 'An unrated transformer cannot feed a panel';
  if (transformer.kind === 'service') {
    return parentPanelId == null
      ? null
      : 'A service transformer feeds only a top-level panel; a sub-panel takes a step-down transformer';
  }
  return transformer.fedFromPanelId != null && transformer.fedFromPanelId === parentPanelId
    ? null
    : 'A step-down transformer feeds only a sub-panel of the panel it is fed from';
}

/** Refuses a panel link to a transformer that is not of the site or breaks a tree rule. */
async function assertPanelTransformerLink(
  siteId: string,
  transformerId: string,
  parentPanelId: string | null,
): Promise<void> {
  const [transformer] = await db
    .select()
    .from(transformers)
    .where(and(eq(transformers.id, transformerId), eq(transformers.siteId, siteId)));
  if (transformer == null) {
    throw new LoadTreeValidationError('Transformer not found on this site', 'transformerId');
  }
  const problem = panelLinkProblem(transformer, parentPanelId);
  if (problem != null) throw new LoadTreeValidationError(problem, 'transformerId');
}

/**
 * Refuses a transformer shape the CHECK `transformers_kind_feed_check` would
 * refuse, and a feeding panel that is not of the site.
 */
async function assertTransformerFeed(
  siteId: string,
  kind: TransformerRow['kind'],
  fedFromPanelId: string | null,
  checkPanel: boolean,
): Promise<void> {
  if (kind === 'service') {
    if (fedFromPanelId != null) {
      throw new LoadTreeValidationError(
        'A service transformer is fed by the utility, not from a panel',
        'fedFromPanelId',
      );
    }
    return;
  }
  if (fedFromPanelId == null) {
    throw new LoadTreeValidationError(
      'A step-down transformer needs the panel that feeds it',
      'fedFromPanelId',
    );
  }
  if (!checkPanel) return;
  const [panel] = await db
    .select({ id: panels.id, parentPanelId: panels.parentPanelId })
    .from(panels)
    .where(and(eq(panels.id, fedFromPanelId), eq(panels.siteId, siteId)));
  if (panel == null) {
    throw new LoadTreeValidationError('Feeding panel not found on this site', 'fedFromPanelId');
  }
}

function transformerCapacity(values: {
  ratedKva?: string | null | undefined;
  powerFactor?: string | undefined;
  loadingLimitPercent?: number | undefined;
}): string | null {
  const kw = computeTransformerCapacityKw(
    values.ratedKva == null ? null : Number(values.ratedKva),
    values.powerFactor == null ? 0.95 : Number(values.powerFactor),
    values.loadingLimitPercent ?? 100,
  );
  return kw == null ? null : String(kw);
}

/**
 * Inserts a transformer of `values.siteId` with its computed capacity.
 * Returns the new row, or null when none was written (`ifMissing` and the id
 * exists): then nothing is audited.
 */
export async function createTransformer(
  values: TransformerValues,
  ctx: LoadTreeWriteContext,
  options: { ifMissing?: boolean } = {},
): Promise<TransformerRow | null> {
  await assertTransformerFeed(values.siteId, values.kind, values.fedFromPanelId ?? null, true);
  const insert = db
    .insert(transformers)
    .values({ ...values, maxContinuousKw: transformerCapacity(values) });
  const rows =
    options.ifMissing === true
      ? await insert.onConflictDoNothing({ target: transformers.id }).returning()
      : await insert.returning();
  const created = rows[0];
  if (created == null) return null;
  await writeTreeAudit(created.siteId, ctx, {
    before: null,
    after: { transformer: created },
    notes: `transformer created: ${created.name}`,
  });
  return created;
}

/**
 * Updates a transformer of the site and recomputes its capacity. `existing`
 * is the row the caller read (read here when absent); `onlyIf` narrows the
 * update to a row still in a given state. A change of kind, feeding panel or
 * rating is refused while a panel it feeds would break a tree rule. Returns
 * the updated row, or null when no row changed (nothing audited).
 */
export async function updateTransformer(
  input: {
    siteId: string;
    transformerId: string;
    existing?: TransformerRow;
    set: TransformerChanges;
    onlyIf?: SQL | undefined;
  },
  ctx: LoadTreeWriteContext,
): Promise<TransformerRow | null> {
  const { siteId, transformerId } = input;
  let existing = input.existing;
  if (existing == null) {
    [existing] = await db
      .select()
      .from(transformers)
      .where(and(eq(transformers.id, transformerId), eq(transformers.siteId, siteId)));
    if (existing == null) return null;
  }

  const merged = { ...existing, ...input.set };
  const kindChanged = merged.kind !== existing.kind;
  const feedChanged = (merged.fedFromPanelId ?? null) !== existing.fedFromPanelId;
  const ratingCleared = merged.ratedKva == null && existing.ratedKva != null;
  if (kindChanged || feedChanged) {
    await assertTransformerFeed(siteId, merged.kind, merged.fedFromPanelId ?? null, feedChanged);
  }
  if (kindChanged || feedChanged || ratingCleared) {
    const linked = await db
      .select({ id: panels.id, parentPanelId: panels.parentPanelId })
      .from(panels)
      .where(and(eq(panels.transformerId, transformerId), eq(panels.siteId, siteId)));
    for (const panel of linked) {
      const problem = panelLinkProblem(
        {
          kind: merged.kind,
          ratedKva: merged.ratedKva ?? null,
          fedFromPanelId: merged.fedFromPanelId ?? null,
        },
        panel.parentPanelId,
      );
      if (problem != null) {
        throw new LoadTreeValidationError(
          `${problem} (it feeds panel ${panel.id})`,
          ratingCleared ? 'ratedKva' : kindChanged ? 'kind' : 'fedFromPanelId',
        );
      }
    }
  }

  const rows = await db
    .update(transformers)
    .set({
      ...input.set,
      maxContinuousKw: transformerCapacity(merged),
      updatedAt: input.set.updatedAt ?? new Date(),
    })
    .where(
      input.onlyIf == null
        ? eq(transformers.id, transformerId)
        : and(eq(transformers.id, transformerId), input.onlyIf),
    )
    .returning();
  const updated = rows[0];
  if (updated == null) return null;

  const change = changedFields(existing, updated);
  await writeTreeAudit(siteId, ctx, {
    before: { transformerId, ...change.before },
    after: { transformerId, ...change.after },
    notes: `transformer updated: ${updated.name}`,
  });
  return updated;
}

/**
 * Deletes a transformer of the site: unlinks the panels it feeds, then deletes
 * it (an energy asset connected to it loses its connection point, foreign key
 * set null). `transformer` is the row the caller read.
 */
export async function deleteTransformer(
  input: { siteId: string; transformer: TransformerRow },
  ctx: LoadTreeWriteContext,
): Promise<void> {
  const { siteId, transformer } = input;
  const unlinked = await db
    .update(panels)
    .set({ transformerId: null, updatedAt: new Date() })
    .where(and(eq(panels.transformerId, transformer.id), eq(panels.siteId, siteId)))
    .returning({ id: panels.id });

  await db.delete(transformers).where(eq(transformers.id, transformer.id));

  await writeTreeAudit(siteId, ctx, {
    before: { transformer, panelIds: unlinked.map((p) => p.id) },
    after: null,
    notes: `transformer deleted: ${transformer.name}`,
  });
}
