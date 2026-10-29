// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  and,
  eq,
  inArray,
  isNull,
  ne,
  notExists,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { normalizeIccid } from '@evtivity/lib';
import { db } from '../config.js';
import {
  simAttachments,
  simFetchCoverage,
  sims,
  type SimAttachmentSource,
  type SimDetachReason,
  type SimStatus,
} from '../schema/sim.js';
import { paymentTerminals } from '../schema/payment-terminals.js';
import type { WriteAuditArgs } from './audit.js';
import { PG_UNIQUE_VIOLATION, pgConstraintName, pgErrorCode } from './pg-errors.js';

// The only writer of `sims` and `sim_attachments`: find or create a SIM by its
// normalized ICCID, attach it to a station, confirm and close attachments, the
// provider lookup and its miss cache (which deletes the fetched periods of a
// provider SIM the SIM no longer holds), the fetch state of the last Refresh,
// the operator fields and the delete. No audit rows and no attach rules here: the
// SIM inventory service decides (`attachmentOutcome`) and audits. Every
// function takes the caller's transaction as `executor`.

export type Sim = typeof sims.$inferSelect;
export type SimAttachment = typeof simAttachments.$inferSelect;
export type { SimAttachmentSource, SimDetachReason, SimStatus };

export type SimAuditActor = Pick<
  WriteAuditArgs,
  'actor' | 'actorUserId' | 'actorDriverId' | 'actorApiKeyId' | 'actorLabel'
>;

/** Why a lookup found no SIM at the provider. */
export type SimLookupMissReason = 'not_found';

/** The provider's other ids of a SIM (Hologram: link and SIM card). */
export interface SimProviderMeta {
  linkId?: string;
  simcardId?: string;
}

/** The allow-listed SIM status of the last Refresh. */
export interface StoredSimStatus {
  state: string;
  providerState: string;
  inSession: boolean | null;
  openSessionBeganAt: string | null;
  apn: string | null;
  profileName: string | null;
  lastSessionAt: string | null;
  usage: { bytes: number; periodEnd: string | null; limitBytes: number | null } | null;
}

/** The database, or a transaction a caller holds. */
export type SimDb = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'transaction'>;

// ---------------------------------------------------------------------------
// Attach decision
// ---------------------------------------------------------------------------

/** The fields of an open attachment the attach decision reads. */
export type OpenAttachmentView = Pick<
  SimAttachment,
  'id' | 'simId' | 'stationId' | 'source' | 'confirmedAt'
>;

export interface AttachmentOutcomeInput {
  /** The SIM to attach. */
  simId: string;
  /** The SIM's CSMS status is `active`. */
  simActive: boolean;
  source: SimAttachmentSource;
  /** The person attaching has access to every site. */
  withAllSites: boolean;
  /** The station's open attachment. */
  stationOpen: OpenAttachmentView | null;
  /** The SIM's open attachment (at this station or elsewhere). */
  simOpen: OpenAttachmentView | null;
}

/**
 * - `unchanged`: the station's open attachment already holds the SIM.
 * - `attach`: attach; close `replace` (the station's attachment of another
 *   SIM, `replaced`) and `displace` (the SIM's attachment elsewhere,
 *   `displaced`) first, when set.
 * - `attached_elsewhere`: the SIM stays where it is and no attachment is
 *   made; `replace` is the station's attachment of another SIM, which an
 *   entered ICCID still replaces (the station's ICCID changed).
 * - `station_has_sim`: the station holds another SIM (every source but an
 *   entered ICCID).
 * - `sim_inactive`: the SIM is inactive; nothing is attached, closed
 *   or displaced.
 */
export type AttachmentDecision =
  | { kind: 'unchanged' }
  | { kind: 'attach'; replace: number | null; displace: number | null }
  | { kind: 'attached_elsewhere'; replace: number | null }
  | { kind: 'station_has_sim' }
  | { kind: 'sim_inactive' };

/**
 * Who displaces whom. Only an ICCID entered on a station by a person
 * with access to every site displaces, and only an unconfirmed `reported`
 * attachment elsewhere. A confirmed attachment and an `entered`, `attached`
 * or `imported` one are never displaced; a station-reported ICCID never
 * displaces anything.
 */
export function attachmentOutcome(input: AttachmentOutcomeInput): AttachmentDecision {
  const { stationOpen, simOpen } = input;
  if (!input.simActive) return { kind: 'sim_inactive' };
  if (stationOpen?.simId === input.simId) return { kind: 'unchanged' };
  const entered = input.source === 'entered';
  if (stationOpen != null && !entered) return { kind: 'station_has_sim' };
  const replace = stationOpen?.id ?? null;
  if (simOpen == null) return { kind: 'attach', replace, displace: null };
  if (entered && input.withAllSites && isDisplaceable(simOpen)) {
    return { kind: 'attach', replace, displace: simOpen.id };
  }
  return { kind: 'attached_elsewhere', replace };
}

function isDisplaceable(attachment: Pick<SimAttachment, 'source' | 'confirmedAt'>): boolean {
  return attachment.confirmedAt == null && attachment.source === 'reported';
}

// ---------------------------------------------------------------------------
// SIMs
// ---------------------------------------------------------------------------

/**
 * The SIM with this ICCID, created when new (`created_by` the person, null for
 * a station report), and whether this call inserted the row (`created`), so
 * the caller audits a creation once: of parallel calls for one ICCID only the
 * one whose insert won sees `created: true`. Throws for a value that is not an
 * ICCID; callers validate it first. Safe to run twice and in parallel: one row
 * per normalized ICCID. An existing row is read FOR KEY SHARE, so inside the
 * caller's transaction a delete waits until the caller commits and then sees
 * its attachment. `fields` (label, notes, IMSI) are written only into a new
 * row, in the same insert: an existing SIM is returned unchanged, so the loser
 * of a race changes nothing.
 */
export async function findOrCreateSimRecord(
  iccid: string,
  createdBy: string | null,
  executor: SimDb = db,
  fields: SimFields = {},
): Promise<{ sim: Sim; created: boolean }> {
  const normalized = normalizeIccid(iccid);
  if (normalized == null) throw new Error('findOrCreateSimRecord: not an ICCID');
  // Assumes READ COMMITTED: the select after a conflicting insert sees the row that won.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [created] = await executor
      .insert(sims)
      .values({
        iccid: normalized,
        createdBy,
        ...(fields.label !== undefined ? { label: fields.label } : {}),
        ...(fields.notes !== undefined ? { notes: fields.notes } : {}),
        ...(fields.imsi !== undefined ? { imsi: fields.imsi } : {}),
      })
      .onConflictDoNothing({ target: sims.iccid })
      .returning();
    if (created != null) return { sim: created, created: true };
    const [existing] = await executor
      .select()
      .from(sims)
      .where(eq(sims.iccid, normalized))
      .for('key share');
    if (existing != null) return { sim: existing, created: false };
    // Deleted between the insert and the read: the ICCID is free again.
  }
  throw new Error('findOrCreateSimRecord: SIM deleted while it was created');
}

export async function getSim(simId: string, executor: SimDb = db): Promise<Sim | null> {
  const [row] = await executor.select().from(sims).where(eq(sims.id, simId));
  return row ?? null;
}

/** The SIM with this ICCID (any form a station or person gave), or null. */
export async function getSimByIccid(iccid: string, executor: SimDb = db): Promise<Sim | null> {
  const normalized = normalizeIccid(iccid);
  if (normalized == null) return null;
  const [row] = await executor.select().from(sims).where(eq(sims.iccid, normalized));
  return row ?? null;
}

/** The operator fields of a SIM. */
export interface SimFields {
  label?: string | null;
  notes?: string | null;
  imsi?: string | null;
}

/** The fields given (undefined keeps a field) whose value differs from `before`. */
export function changedSimFields(
  before: { label: string | null; notes: string | null; imsi: string | null },
  fields: SimFields,
): SimFields {
  const changed: SimFields = {};
  if (fields.label !== undefined && fields.label !== before.label) changed.label = fields.label;
  if (fields.notes !== undefined && fields.notes !== before.notes) changed.notes = fields.notes;
  if (fields.imsi !== undefined && fields.imsi !== before.imsi) changed.imsi = fields.imsi;
  return changed;
}

/**
 * Sets the operator fields given (undefined keeps a field). Null when the SIM
 * does not exist. Writes nothing when no field changes (`after` is `before`).
 */
export async function updateSimFields(
  simId: string,
  fields: SimFields,
  executor: SimDb = db,
): Promise<{ before: Sim; after: Sim } | null> {
  return executor.transaction(async (tx) => {
    const [before] = await tx.select().from(sims).where(eq(sims.id, simId)).for('update');
    if (before == null) return null;
    const changed = changedSimFields(before, fields);
    if (Object.keys(changed).length === 0) return { before, after: before };
    const [after] = await tx
      .update(sims)
      .set({ ...changed, updatedAt: new Date() })
      .where(eq(sims.id, simId))
      .returning();
    if (after == null) return null;
    return { before, after };
  });
}

export type SetSimStatusResult =
  | {
      kind: 'changed';
      before: Sim;
      after: Sim;
      /** The attachment a deactivation closed (`deactivated`), else null. */
      closedAttachment: SimAttachment | null;
    }
  | { kind: 'unchanged'; sim: Sim }
  | { kind: 'not_found' };

/**
 * Sets the CSMS status of a SIM, in one transaction under the SIM row
 * lock. Deactivating sets `deactivated_at` and `deactivated_by` and closes the
 * open attachment (`deactivated`); reactivating clears both and opens
 * nothing. The same status again writes nothing (`unchanged`). The provider
 * status (`last_status`) is never touched and the row is never deleted. An
 * attach holds the SIM row FOR SHARE, so it either commits first (and its
 * attachment is closed here) or waits and then sees `inactive`.
 */
export async function setSimStatus(
  simId: string,
  status: SimStatus,
  by: string | null,
  executor: SimDb = db,
): Promise<SetSimStatusResult> {
  return executor.transaction(async (tx) => {
    const [before] = await tx.select().from(sims).where(eq(sims.id, simId)).for('update');
    if (before == null) return { kind: 'not_found' };
    if (before.status === status) return { kind: 'unchanged', sim: before };
    const now = new Date();
    const inactive = status === 'inactive';
    const [after] = await tx
      .update(sims)
      .set({
        status,
        deactivatedAt: inactive ? now : null,
        deactivatedBy: inactive ? by : null,
        updatedAt: now,
      })
      .where(eq(sims.id, simId))
      .returning();
    if (after == null) return { kind: 'not_found' };
    let closedAttachment: SimAttachment | null = null;
    if (inactive) {
      const open = await openSimAttachment(simId, tx);
      if (open != null) closedAttachment = await closeAttachment(open.id, 'deactivated', by, tx);
    }
    return { kind: 'changed', before, after, closedAttachment };
  });
}

export type DeleteSimResult = { kind: 'deleted'; sim: Sim } | { kind: 'attached' | 'not_found' };

/**
 * Deletes a SIM without an open attachment, with its attachment history,
 * sessions, alerts and coverage (cascade). The SIM row is locked first, so an
 * attachment committed meanwhile is seen and refuses the delete.
 */
export async function deleteSim(simId: string, executor: SimDb = db): Promise<DeleteSimResult> {
  return executor.transaction(async (tx) => {
    const [sim] = await tx.select().from(sims).where(eq(sims.id, simId)).for('update');
    if (sim == null) return { kind: 'not_found' };
    if ((await openSimAttachment(simId, tx)) != null) return { kind: 'attached' };
    await tx.delete(sims).where(eq(sims.id, simId));
    return { kind: 'deleted', sim };
  });
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export async function openStationAttachment(
  stationId: string,
  executor: SimDb = db,
): Promise<SimAttachment | null> {
  const [row] = await executor
    .select()
    .from(simAttachments)
    .where(and(eq(simAttachments.stationId, stationId), isNull(simAttachments.detachedAt)));
  return row ?? null;
}

export async function openSimAttachment(
  simId: string,
  executor: SimDb = db,
): Promise<SimAttachment | null> {
  const [row] = await executor
    .select()
    .from(simAttachments)
    .where(and(eq(simAttachments.simId, simId), isNull(simAttachments.detachedAt)));
  return row ?? null;
}

export type AttachSimResult =
  | {
      kind: 'attached';
      attachment: SimAttachment;
      /** False when the SIM was already open at this station (nothing written). */
      created: boolean;
    }
  | { kind: 'sim_attached_elsewhere' }
  | { kind: 'station_has_sim' }
  | { kind: 'sim_inactive' }
  | { kind: 'sim_not_found' };

/**
 * Opens an attachment of the SIM to the station. Never closes an attachment:
 * a SIM with an open attachment elsewhere answers `sim_attached_elsewhere`, a
 * station with another SIM `station_has_sim` (the two partial unique indexes
 * decide, so two parallel attaches never both win), and a SIM already open at
 * this station returns that attachment (`created: false`). `confirm` confirms
 * it at once (`confirmed_by` is `by`).
 *
 * The SIM row is read FOR SHARE first. A status change or a delete holds or
 * takes a stronger lock, so either it waits for this attach to commit (and a
 * delete then refuses, a deactivation closes the attachment), or this attach
 * waits and then sees the SIM `inactive` (`sim_inactive`) or gone
 * (`sim_not_found`). The foreign key's own KEY SHARE lock does not conflict
 * with a status UPDATE, so it alone would not do.
 */
export async function attachSimToStation(
  input: {
    simId: string;
    stationId: string;
    source: SimAttachmentSource;
    by: string | null;
    withAllSites: boolean;
    confirm: boolean;
  },
  executor: SimDb = db,
): Promise<AttachSimResult> {
  return executor.transaction(async (tx) => {
    const [sim] = await tx
      .select({ status: sims.status })
      .from(sims)
      .where(eq(sims.id, input.simId))
      .for('share');
    if (sim == null) return { kind: 'sim_not_found' };
    if (sim.status !== 'active') return { kind: 'sim_inactive' };
    const now = new Date();
    // ON CONFLICT DO NOTHING instead of catching the unique violation, so the
    // caller's transaction stays usable after a refused attach.
    for (let attempt = 0; attempt < 3; attempt++) {
      const [attachment] = await tx
        .insert(simAttachments)
        .values({
          simId: input.simId,
          stationId: input.stationId,
          source: input.source,
          attachedAt: now,
          attachedBy: input.by,
          attachedWithAllSites: input.withAllSites,
          confirmedAt: input.confirm ? now : null,
          confirmedBy: input.confirm ? input.by : null,
        })
        .onConflictDoNothing()
        .returning();
      if (attachment != null) return { kind: 'attached', attachment, created: true };
      const simOpen = await openSimAttachment(input.simId, tx);
      if (simOpen != null) {
        return simOpen.stationId === input.stationId
          ? { kind: 'attached', attachment: simOpen, created: false }
          : { kind: 'sim_attached_elsewhere' };
      }
      if ((await openStationAttachment(input.stationId, tx)) != null) {
        return { kind: 'station_has_sim' };
      }
      // The conflicting attachment was closed between the insert and the reads: try again.
    }
    throw new Error('attachSimToStation: conflicting attachment not found');
  });
}

/**
 * Closes an open attachment once: a closed one stays as it was and the
 * result is null. `displaced` closes only an unconfirmed `reported`
 * attachment, re-checked in the UPDATE. Every close, for any reason,
 * raises the SIM's history floor to the close time.
 */
export async function closeAttachment(
  attachmentId: number,
  reason: SimDetachReason,
  by: string | null,
  executor: SimDb = db,
): Promise<SimAttachment | null> {
  const now = new Date();
  // One transaction (a savepoint inside the caller's): a close whose floor
  // raise fails stays open, never closed with the old floor.
  return executor.transaction(async (tx) => {
    const [row] = await tx
      .update(simAttachments)
      .set({ detachedAt: now, detachedBy: by, detachReason: reason })
      .where(
        and(
          eq(simAttachments.id, attachmentId),
          isNull(simAttachments.detachedAt),
          reason === 'displaced'
            ? and(isNull(simAttachments.confirmedAt), eq(simAttachments.source, 'reported'))
            : undefined,
        ),
      )
      .returning();
    if (row == null) return null;
    await raiseHistoryFloor(eq(sims.id, row.simId), now, tx);
    return row;
  });
}

/**
 * Raises the history floor of the matching SIMs to `at`, never lowering it
 * (GREATEST ignores a null floor).
 */
async function raiseHistoryFloor(where: SQL, at: Date, executor: SimDb): Promise<void> {
  await executor
    .update(sims)
    .set({
      historyFloorAt: sql`GREATEST(${sims.historyFloorAt}, ${at.toISOString()}::timestamptz)`,
    })
    .where(where);
}

/**
 * Before stations are deleted: their attachment rows cascade away with
 * them, so no close raises the floor of the SIMs they hold. Every path that
 * deletes station rows calls this first with those station ids
 * (guard test `station-delete-sim-floor-guard.test.ts`). Raising early is
 * safe: a floor only hides more of a SIM's history on a station.
 */
export async function raiseStationSimHistoryFloor(
  stationIds: readonly string[],
  executor: SimDb = db,
): Promise<void> {
  if (stationIds.length === 0) return;
  const held = executor
    .select({ simId: simAttachments.simId })
    .from(simAttachments)
    .where(
      and(inArray(simAttachments.stationId, [...stationIds]), isNull(simAttachments.detachedAt)),
    );
  await raiseHistoryFloor(inArray(sims.id, held), new Date(), executor);
}

/**
 * Before payment terminals are deleted: their attachment rows cascade away,
 * so the floor of the SIMs they hold is raised first (the station rule above,
 * security case 44, for the terminal target).
 */
export async function raiseTerminalSimHistoryFloor(
  terminalIds: readonly string[],
  executor: SimDb = db,
): Promise<void> {
  if (terminalIds.length === 0) return;
  const held = executor
    .select({ simId: simAttachments.simId })
    .from(simAttachments)
    .where(
      and(
        inArray(simAttachments.paymentTerminalId, [...terminalIds]),
        isNull(simAttachments.detachedAt),
      ),
    );
  await raiseHistoryFloor(inArray(sims.id, held), new Date(), executor);
}

export async function openTerminalAttachment(
  paymentTerminalId: string,
  executor: SimDb = db,
): Promise<SimAttachment | null> {
  const [row] = await executor
    .select()
    .from(simAttachments)
    .where(
      and(
        eq(simAttachments.paymentTerminalId, paymentTerminalId),
        isNull(simAttachments.detachedAt),
      ),
    );
  return row ?? null;
}

export type AttachSimToTerminalResult =
  | { kind: 'attached'; attachment: SimAttachment; created: boolean }
  | { kind: 'sim_attached_elsewhere' }
  | { kind: 'terminal_has_sim' }
  | { kind: 'sim_inactive' }
  | { kind: 'sim_not_found' };

/**
 * Opens an attachment of the SIM to a payment terminal: the station rules
 * (attachSimToStation) for the terminal target. One open attachment per SIM
 * and per terminal (the partial unique indexes decide); never closes one.
 * `confirm` confirms it at once, only for a person with access to every site
 * (plan E10; the service decides).
 */
export async function attachSimToPaymentTerminal(
  input: {
    simId: string;
    paymentTerminalId: string;
    source: SimAttachmentSource;
    by: string | null;
    withAllSites: boolean;
    confirm: boolean;
  },
  executor: SimDb = db,
): Promise<AttachSimToTerminalResult> {
  return executor.transaction(async (tx) => {
    const [sim] = await tx
      .select({ status: sims.status })
      .from(sims)
      .where(eq(sims.id, input.simId))
      .for('share');
    if (sim == null) return { kind: 'sim_not_found' };
    if (sim.status !== 'active') return { kind: 'sim_inactive' };
    // The terminal row is read FOR SHARE: a site change (which closes the
    // attachment) waits for this attach, so the stored site holds for the
    // whole window (security case 276).
    const [terminal] = await tx
      .select({ siteId: paymentTerminals.siteId })
      .from(paymentTerminals)
      .where(eq(paymentTerminals.id, input.paymentTerminalId))
      .for('share');
    if (terminal == null) return { kind: 'sim_not_found' };
    const now = new Date();
    for (let attempt = 0; attempt < 3; attempt++) {
      const [attachment] = await tx
        .insert(simAttachments)
        .values({
          simId: input.simId,
          paymentTerminalId: input.paymentTerminalId,
          siteId: terminal.siteId,
          source: input.source,
          attachedAt: now,
          attachedBy: input.by,
          attachedWithAllSites: input.withAllSites,
          confirmedAt: input.confirm ? now : null,
          confirmedBy: input.confirm ? input.by : null,
        })
        .onConflictDoNothing()
        .returning();
      if (attachment != null) return { kind: 'attached', attachment, created: true };
      const simOpen = await openSimAttachment(input.simId, tx);
      if (simOpen != null) {
        return simOpen.paymentTerminalId === input.paymentTerminalId
          ? { kind: 'attached', attachment: simOpen, created: false }
          : { kind: 'sim_attached_elsewhere' };
      }
      if ((await openTerminalAttachment(input.paymentTerminalId, tx)) != null) {
        return { kind: 'terminal_has_sim' };
      }
    }
    throw new Error('attachSimToPaymentTerminal: conflicting attachment not found');
  });
}

export type ConfirmAttachmentResult =
  | 'confirmed'
  | 'already_confirmed'
  | 'not_attached'
  | 'attachment_changed'
  | 'sim_inactive';

/** The result of a confirm; `confirmed` carries the row the UPDATE confirmed. */
export type ConfirmAttachmentOutcome =
  | { result: 'confirmed'; attachment: SimAttachment }
  | { result: Exclude<ConfirmAttachmentResult, 'confirmed'> };

/**
 * Confirms the station's open attachment the person saw (`attachmentId`). An
 * attachment closed or replaced since is never confirmed (`attachment_changed`);
 * a confirmed one stays as it is (`confirmed_by` kept). The SIM of that
 * attachment is read FOR SHARE first, so a confirm never runs alongside a
 * deactivation: an inactive SIM answers `sim_inactive`. A confirm returns
 * the row it confirmed, so the caller audits exactly that row.
 */
export async function confirmAttachment(
  stationId: string,
  attachmentId: number,
  by: string,
  executor: SimDb = db,
): Promise<ConfirmAttachmentOutcome> {
  return executor.transaction(async (tx): Promise<ConfirmAttachmentOutcome> => {
    const [sim] = await tx
      .select({ status: sims.status })
      .from(sims)
      .innerJoin(simAttachments, eq(simAttachments.simId, sims.id))
      .where(and(eq(simAttachments.id, attachmentId), eq(simAttachments.stationId, stationId)))
      .for('share', { of: sims });
    if (sim != null && sim.status !== 'active') return { result: 'sim_inactive' };
    const [row] = await tx
      .update(simAttachments)
      .set({ confirmedAt: new Date(), confirmedBy: by })
      .where(
        and(
          eq(simAttachments.id, attachmentId),
          eq(simAttachments.stationId, stationId),
          isNull(simAttachments.detachedAt),
          isNull(simAttachments.confirmedAt),
        ),
      )
      .returning();
    if (row != null) return { result: 'confirmed', attachment: row };
    const current = await openStationAttachment(stationId, tx);
    if (current == null) return { result: 'not_attached' };
    if (current.id !== attachmentId) return { result: 'attachment_changed' };
    return { result: current.confirmedAt != null ? 'already_confirmed' : 'attachment_changed' };
  });
}

// ---------------------------------------------------------------------------
// Provider lookup and fetch state
// ---------------------------------------------------------------------------

/** Fetch state that belongs to one provider SIM. */
const NO_FETCH_STATE = {
  lastStatus: null,
  statusFetchedAt: null,
  openSessionBeganAt: null,
  lastRecordId: null,
  sessionsSyncedAt: null,
  alertsSyncedAt: null,
} as const;

/**
 * - `recorded`: the lookup is stored.
 * - `ref_held_elsewhere`: the hit names a provider SIM another SIM row holds
 *   (`uq_sims_provider_ref`); nothing is written, and the caller records a miss
 *   or reports the conflict.
 * - `not_found`: the SIM does not exist.
 */
export type RecordSimLookupResult = 'recorded' | 'ref_held_elsewhere' | 'not_found';

const otherSims = alias(sims, 'other_sims');

/**
 * The SIM's fetched periods belong to its provider SIM: when that changes they
 * are deleted in the caller's transaction, under the coverage lock of the SIM
 * (the advisory lock the coverage writes of a Refresh take), so days fetched
 * for the old provider SIM never show as covered for the new one.
 */
async function lockCoverage(simId: string, tx: { execute: (query: SQL) => Promise<unknown> }) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sim_coverage:${simId}`}))`);
}

/**
 * Stores a lookup. A hit sets the provider SIM and clears a cached miss; a hit
 * on another provider SIM than before also clears the fetch state and deletes
 * the fetched periods. A miss is cached (the next Refresh within the hour skips
 * the lookup) and clears the provider SIM, its fetch state and its fetched
 * periods. A hit on a provider SIM another SIM holds
 * writes nothing (`ref_held_elsewhere`) and never fails the caller's
 * transaction: the UPDATE skips it (NOT EXISTS), and a parallel lookup that
 * commits the same ref first is caught as a unique violation in a savepoint.
 */
export async function recordSimLookup(
  simId: string,
  result: { provider: string; providerRef: string; meta: SimProviderMeta } | { miss: 'not_found' },
  executor: SimDb = db,
): Promise<RecordSimLookupResult> {
  const now = new Date();
  if ('miss' in result) {
    return executor.transaction(async (tx) => {
      await lockCoverage(simId, tx);
      const [row] = await tx
        .update(sims)
        .set({
          provider: null,
          providerRef: null,
          providerMeta: null,
          ...NO_FETCH_STATE,
          lookupMissedAt: now,
          lookupMissReason: result.miss,
          updatedAt: now,
        })
        .where(eq(sims.id, simId))
        .returning({ id: sims.id });
      if (row == null) return 'not_found';
      await tx.delete(simFetchCoverage).where(eq(simFetchCoverage.simId, simId));
      return 'recorded';
    });
  }
  const same = sql`${sims.provider} IS NOT DISTINCT FROM ${result.provider} AND ${sims.providerRef} IS NOT DISTINCT FROM ${result.providerRef}`;
  const keep = (column: AnyColumn) => sql`CASE WHEN ${same} THEN ${column} ELSE NULL END`;
  const heldElsewhere = executor
    .select({ one: sql`1` })
    .from(otherSims)
    .where(
      and(
        eq(otherSims.provider, result.provider),
        eq(otherSims.providerRef, result.providerRef),
        ne(otherSims.id, simId),
      ),
    );
  let updated: { id: string } | undefined;
  try {
    updated = await executor.transaction(async (tx) => {
      await lockCoverage(simId, tx);
      const [before] = await tx
        .select({ provider: sims.provider, providerRef: sims.providerRef })
        .from(sims)
        .where(eq(sims.id, simId))
        .for('update');
      const [row] = await tx
        .update(sims)
        .set({
          lastStatus: keep(sims.lastStatus),
          statusFetchedAt: keep(sims.statusFetchedAt),
          openSessionBeganAt: keep(sims.openSessionBeganAt),
          lastRecordId: keep(sims.lastRecordId),
          sessionsSyncedAt: keep(sims.sessionsSyncedAt),
          alertsSyncedAt: keep(sims.alertsSyncedAt),
          provider: result.provider,
          providerRef: result.providerRef,
          providerMeta: result.meta,
          lookupMissedAt: null,
          lookupMissReason: null,
          updatedAt: now,
        })
        .where(and(eq(sims.id, simId), notExists(heldElsewhere)))
        .returning({ id: sims.id });
      const changed =
        before != null &&
        (before.provider !== result.provider || before.providerRef !== result.providerRef);
      if (row != null && changed) {
        await tx.delete(simFetchCoverage).where(eq(simFetchCoverage.simId, simId));
      }
      return row;
    });
  } catch (err) {
    if (
      pgErrorCode(err) === PG_UNIQUE_VIOLATION &&
      pgConstraintName(err) === 'uq_sims_provider_ref'
    ) {
      return 'ref_held_elsewhere';
    }
    throw err;
  }
  if (updated != null) return 'recorded';
  return (await getSim(simId, executor)) == null ? 'not_found' : 'ref_held_elsewhere';
}

/** The SIM while it still holds this provider SIM: a Refresh of another one writes nothing. */
function simWithRef(simId: string, providerRef: string) {
  return and(eq(sims.id, simId), eq(sims.providerRef, providerRef));
}

/** The begin of the open session as a time; null when missing or not a valid time. */
export function openSessionBeganAtOf(value: string | null): Date | null {
  if (value == null || value === '') return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time;
}

/** Stores the status of a Refresh of the provider SIM `providerRef` and the begin of its open session. */
export async function recordSimStatus(
  simId: string,
  providerRef: string,
  status: StoredSimStatus,
  fetchedAt: Date,
  executor: SimDb = db,
): Promise<void> {
  await executor
    .update(sims)
    .set({
      lastStatus: status,
      statusFetchedAt: fetchedAt,
      openSessionBeganAt: openSessionBeganAtOf(status.openSessionBeganAt),
      updatedAt: new Date(),
    })
    .where(simWithRef(simId, providerRef));
}

/** Moves the session cursor of a days Refresh (never back) and its fetch time. */
export async function recordSimSessionsSynced(
  simId: string,
  providerRef: string,
  newestRecordId: string | null,
  syncedAt: Date,
  executor: SimDb = db,
): Promise<void> {
  await executor.transaction(async (tx) => {
    const [current] = await tx
      .select({ lastRecordId: sims.lastRecordId })
      .from(sims)
      .where(simWithRef(simId, providerRef))
      .for('update');
    if (current == null) return;
    const keep =
      newestRecordId == null ||
      (current.lastRecordId != null && compareRecordIds(current.lastRecordId, newestRecordId) >= 0);
    await tx
      .update(sims)
      .set({
        ...(keep ? {} : { lastRecordId: newestRecordId }),
        sessionsSyncedAt: syncedAt,
        updatedAt: new Date(),
      })
      .where(simWithRef(simId, providerRef));
  });
}

/** Records the fetch time of the alerts of a days Refresh. */
export async function recordSimAlertsSynced(
  simId: string,
  providerRef: string,
  syncedAt: Date,
  executor: SimDb = db,
): Promise<void> {
  await executor
    .update(sims)
    .set({ alertsSyncedAt: syncedAt, updatedAt: new Date() })
    .where(simWithRef(simId, providerRef));
}

/** Compares provider record ids: numerically when both are integers, else as text. */
export function compareRecordIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
