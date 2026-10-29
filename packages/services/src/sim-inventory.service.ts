// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import {
  attachmentOutcome,
  attachSimToStation,
  attachSimToPaymentTerminal,
  openTerminalAttachment,
  chargingStations,
  closeAttachment,
  confirmAttachment,
  db,
  deleteSim as deleteSimRow,
  findOrCreateSimRecord,
  getSim,
  getSimByIccid,
  openSimAttachment,
  openStationAttachment,
  setSimStatus,
  simAuditLog,
  stationAuditLog,
  updateSimFields,
  users,
  writeAudit,
  type ConfirmAttachmentResult,
  type DeleteSimResult,
  type SetSimStatusResult,
  type Sim,
  type SimAttachment,
  type SimAuditActor,
  type SimDb,
  type SimDetachReason,
  type SimFields,
} from '@evtivity/database';
import { normalizeIccid, type ServiceLogger } from '@evtivity/lib';
import { withStationDataPlanPush } from './station-data-plan.service.js';

// The SIM inventory service: the only caller of the SIM writer
// (`@evtivity/database` `sim-inventory.ts`) outside reads and the fetch state
// of a Refresh (`station-sim.service.ts`). It applies the attach rules (who
// displaces whom, nothing while the switches are off, no inactive SIM, the
// ICCID's origin) and writes the SIM and station audit rows (fail-open, each
// in its own savepoint). Audit rows never hold an ICCID, an IMSI or a
// provider id. No function here calls a provider.

const BOOT_ACTOR: SimAuditActor = { actor: 'ocpp', actorLabel: 'BootNotification' };

/**
 * A confirmed SIM moves its station to the Cellular data plan, and its close
 * moves it back (resolveDataPlan). Runs a change and, after it commits, pushes
 * the new plan to the online stations whose effective plan changed. A call
 * inside the caller's transaction (executor is not db) pushes nothing: the
 * caller snapshots the stations first and pushes after its commit
 * (`stationsAffectedByIccidEntry`, `pushStationDataPlanChanges`).
 */
async function withPlanPush<T>(
  executor: SimDb,
  stationIds: () => Promise<(string | null | undefined)[]>,
  log: ServiceLogger | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (executor !== db) return run();
  return withStationDataPlanPush(await stationIds(), run, log != null ? { log } : {});
}

/** The station holding a SIM's open attachment, if any. */
async function simStation(simId: string, executor: SimDb): Promise<string | null> {
  return (await openSimAttachment(simId, executor))?.stationId ?? null;
}

/**
 * The stations an ICCID entry on a station can move to another data plan:
 * the station itself and the station the SIM of that ICCID is attached to
 * (a displaced attachment). For the station PATCH, which enters the ICCID in
 * its own transaction.
 */
export async function stationsAffectedByIccidEntry(
  stationId: string,
  iccid: string | null | undefined,
  executor: SimDb = db,
): Promise<string[]> {
  const normalized = normalizeIccid(iccid ?? null);
  const sim = normalized == null ? null : await getSimByIccid(normalized, executor);
  const other = sim == null ? null : await simStation(sim.id, executor);
  return other != null && other !== stationId ? [stationId, other] : [stationId];
}

/** Who acts: the audit fields and the user written as attached, confirmed or detached by. */
export interface SimActor {
  audit: SimAuditActor;
  /** An API key counts as its user; null for a process. */
  userId: string | null;
}

interface ActorInput {
  actor: SimActor;
  log?: ServiceLogger;
}

/** The audit view of an attachment: no ICCID, no provider id. */
function attachmentAudit(attachment: SimAttachment): Record<string, unknown> {
  return {
    attachmentId: attachment.id,
    simId: attachment.simId,
    stationId: attachment.stationId,
    ...(attachment.paymentTerminalId != null
      ? { paymentTerminalId: attachment.paymentTerminalId }
      : {}),
    source: attachment.source,
    confirmed: attachment.confirmedAt != null,
    detachReason: attachment.detachReason,
  };
}

/**
 * The audit view of a SIM: the operator fields and the states. Never the
 * ICCID, the IMSI or a provider id; an update says only whether the
 * IMSI changed (`imsiChanged`).
 */
function simAudit(sim: Sim): Record<string, unknown> {
  return {
    label: sim.label,
    notes: sim.notes,
    provider: sim.provider,
    status: sim.status,
  };
}

function simAuditTable() {
  return { table: simAuditLog, idColumn: 'sim_id' };
}

function stationAuditTable() {
  return { table: stationAuditLog, idColumn: 'station_id' };
}

/** Thrown inside the audit savepoint so a failed audit insert rolls back only the savepoint. */
class AuditInsertFailed extends Error {
  constructor(readonly detail: unknown) {
    super('audit insert failed');
    this.name = 'AuditInsertFailed';
  }
}

/**
 * Writes an audit row fail-open in its own savepoint. Most writes here run
 * inside the caller's transaction (the station PATCH), where a failed insert
 * would abort the whole transaction (25P02) even though writeAudit catches the
 * error. The savepoint rolls back the failed insert only, so the mutation goes
 * on and commits; the failure is logged.
 */
async function auditSafely(
  config: Parameters<typeof writeAudit>[0],
  args: Parameters<typeof writeAudit>[1],
  executor: SimDb,
  log?: ServiceLogger,
): Promise<void> {
  try {
    await executor.transaction(async (savepoint) => {
      const failures: unknown[] = [];
      // writeAudit reports a failed insert through the logger only.
      await writeAudit(config, args, savepoint, {
        warn: (detail: unknown) => failures.push(detail),
      });
      if (failures.length > 0) throw new AuditInsertFailed(failures[0]);
    });
  } catch (err: unknown) {
    log?.warn(
      { err: err instanceof AuditInsertFailed ? err.detail : err, action: args.action },
      'SIM audit row not written; the change is kept',
    );
  }
}

/** Writes the SIM `detached` row and, for a station target, the station row. */
async function auditDetached(
  closed: SimAttachment,
  open: SimAttachment,
  reason: SimDetachReason,
  actor: SimAuditActor,
  log?: ServiceLogger,
  executor: SimDb = db,
): Promise<void> {
  await auditSafely(
    simAuditTable(),
    {
      entityId: closed.simId,
      entityIdSnapshot: closed.simId,
      action: 'detached',
      ...actor,
      before: { attachment: attachmentAudit(open) },
      after: { attachment: attachmentAudit(closed) },
      notes: reason,
    },
    executor,
    log,
  );
  if (closed.stationId == null) return;
  await auditSafely(
    stationAuditTable(),
    {
      entityId: closed.stationId,
      entityIdSnapshot: closed.stationId,
      action: 'updated',
      ...actor,
      before: { simAttachment: attachmentAudit(open) },
      after: { simAttachment: null },
      notes: 'sim_detached',
    },
    executor,
    log,
  );
}

/** Writes the SIM `attached` row and, for a station target, the station row. */
async function auditAttached(
  attachment: SimAttachment,
  provider: string | null,
  actor: SimAuditActor,
  notes: string | null,
  log?: ServiceLogger,
  executor: SimDb = db,
): Promise<void> {
  await auditSafely(
    simAuditTable(),
    {
      entityId: attachment.simId,
      entityIdSnapshot: attachment.simId,
      action: 'attached',
      ...actor,
      before: null,
      after: { attachment: attachmentAudit(attachment) },
      notes,
    },
    executor,
    log,
  );
  if (attachment.stationId == null) return;
  await auditSafely(
    stationAuditTable(),
    {
      entityId: attachment.stationId,
      entityIdSnapshot: attachment.stationId,
      action: 'updated',
      ...actor,
      before: { simAttachment: null },
      after: { simAttachment: attachmentAudit(attachment) },
      notes: `sim_attached (${provider ?? 'none'})`,
    },
    executor,
    log,
  );
}

/**
 * Ends the all-site vouch of the ICCID entered on a station, so a later
 * Refresh attaches that ICCID unconfirmed.
 */
async function endEntryVouch(stationId: string, executor: SimDb): Promise<void> {
  await executor
    .update(chargingStations)
    .set({ iccidEnteredWithAllSites: false })
    .where(eq(chargingStations.id, stationId));
}

/**
 * Closes an attachment and audits it; null when it was closed meanwhile
 * (nothing audited). The close, the history floor raise and the end of the
 * station's entry vouch commit together, so a failure between them leaves the
 * attachment open instead of a closed one with a stale floor or vouch. A
 * `replaced` close keeps the vouch: the same entry put another SIM on the
 * station, and the vouch belongs to that entry.
 */
async function closeAudited(
  open: SimAttachment,
  reason: SimDetachReason,
  actor: SimActor,
  log?: ServiceLogger,
  executor: SimDb = db,
): Promise<SimAttachment | null> {
  const closed = await executor.transaction(async (tx) => {
    const row = await closeAttachment(open.id, reason, actor.userId, tx);
    if (row?.stationId != null && reason !== 'replaced') await endEntryVouch(row.stationId, tx);
    return row;
  });
  if (closed == null) return null;
  await auditDetached(closed, open, reason, actor.audit, log, executor);
  return closed;
}

/**
 * The SIM with this ICCID, created when new and then audited `created` once
 * (of parallel calls only the one whose insert won audits). `fields` (label,
 * notes, IMSI) go into the new row's insert only: an existing SIM is returned
 * unchanged (`created: false`), so the loser of a race changes nothing. The
 * row and its `created` audit row commit in one transaction. `notes` are the
 * audit notes. Throws for a value that is not an ICCID.
 */
export async function ensureSim(
  iccid: string,
  input: ActorInput & { notes?: string; fields?: SimFields },
  executor: SimDb = db,
): Promise<{ sim: Sim; created: boolean }> {
  return executor.transaction(async (tx) => {
    const record = await findOrCreateSimRecord(iccid, input.actor.userId, tx, input.fields ?? {});
    if (!record.created) return record;
    await auditSafely(
      simAuditTable(),
      {
        entityId: record.sim.id,
        entityIdSnapshot: record.sim.id,
        action: 'created',
        ...input.actor.audit,
        before: null,
        after: simAudit(record.sim),
        notes: input.notes ?? null,
      },
      tx,
      input.log,
    );
    return record;
  });
}

/** Attempts of a decision whose attach lost a race to another writer. */
const ATTACH_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Station: entered ICCID (station PATCH), reported ICCID (Refresh), boot
// ---------------------------------------------------------------------------

/**
 * - `attached`: the SIM is now attached to the station (confirmed for an all-site user).
 * - `attached_elsewhere`: the SIM stays attached elsewhere and no attachment is
 *   made; the station's attachment of another SIM was still closed (`replaced`).
 * - `unchanged`: the station's open attachment already holds the SIM.
 * - `none`: no ICCID (removed or not an ICCID); the station's attachment was closed (`detached`).
 * - `sim_inactive`: the SIM is inactive; nothing was attached, and the
 *   station's attachment of another SIM was closed (`replaced`).
 * - `attach_conflict`: other writers kept changing the attachments of the
 *   station or the SIM, so after a few attempts nothing was attached; the
 *   ICCID stays on the station and a Refresh attaches it later.
 * - `off`: the SIM switches are both off: nothing was read or written.
 */
export type EnterStationIccidResult =
  | 'attached'
  | 'attached_elsewhere'
  | 'unchanged'
  | 'none'
  | 'sim_inactive'
  | 'attach_conflict'
  | 'off';

/**
 * An ICCID a person entered on a station (station PATCH), inside the
 * station update's transaction (`executor`). Finds or creates the SIM and
 * attaches it `entered`, confirmed at once only when the person has access to
 * every site. Only such a person displaces, and only an unconfirmed `reported`
 * attachment elsewhere (`displaced`); a confirmed, entered, attached or
 * imported attachment is never displaced (`attached_elsewhere`). The
 * station's attachment of another SIM is closed (`replaced`) in both cases,
 * and for an inactive SIM (`sim_inactive`), since the station's ICCID
 * changed. `null` closes the station's attachment
 * (`detached`). With both switches off (`featureOn` false) nothing is read or
 * written: the ICCID stays on the station only. Never throws for a SIM
 * conflict: the station PATCH never fails for one.
 */
export async function enterStationIccid(
  stationId: string,
  iccid: string | null,
  input: ActorInput & { withAllSites: boolean; featureOn: boolean },
  executor: SimDb = db,
): Promise<EnterStationIccidResult> {
  if (!input.featureOn) return 'off';
  return withPlanPush(
    executor,
    () => stationsAffectedByIccidEntry(stationId, iccid, executor),
    input.log,
    () => enterStationIccidInTx(stationId, iccid, input, executor),
  );
}

function enterStationIccidInTx(
  stationId: string,
  iccid: string | null,
  input: ActorInput & { withAllSites: boolean },
  executor: SimDb,
): Promise<EnterStationIccidResult> {
  return executor.transaction(async (tx) => {
    const result = await enterIccid(stationId, iccid, input, tx);
    // The all-site vouch stands only for the attachment the entry made. An
    // entry that attached nothing must not confirm the SIM at a later Refresh,
    // when the SIM may have been freed at another site's station meanwhile.
    if (
      result === 'attached_elsewhere' ||
      result === 'sim_inactive' ||
      result === 'attach_conflict'
    ) {
      await endEntryVouch(stationId, tx);
    }
    return result;
  });
}

async function enterIccid(
  stationId: string,
  iccid: string | null,
  input: ActorInput & { withAllSites: boolean },
  tx: SimDb,
): Promise<EnterStationIccidResult> {
  const normalized = normalizeIccid(iccid);
  if (normalized == null) {
    const open = await openStationAttachment(stationId, tx);
    if (open != null) await closeAudited(open, 'detached', input.actor, input.log, tx);
    return 'none';
  }
  const { sim } = await ensureSim(normalized, input, tx);
  for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt++) {
    const stationOpen = await openStationAttachment(stationId, tx);
    const simOpen = await openSimAttachment(sim.id, tx);
    const decision = attachmentOutcome({
      simId: sim.id,
      simActive: sim.status === 'active',
      source: 'entered',
      withAllSites: input.withAllSites,
      stationOpen,
      simOpen,
    });
    if (decision.kind === 'sim_inactive') {
      // The station's ICCID changed all the same: its attachment of
      // another SIM closes, and nothing is attached.
      if (stationOpen != null && stationOpen.simId !== sim.id) {
        await closeAudited(stationOpen, 'replaced', input.actor, input.log, tx);
      }
      return 'sim_inactive';
    }
    if (decision.kind === 'unchanged') return 'unchanged';
    // An entered ICCID never answers station_has_sim; a race is decided again.
    if (decision.kind === 'station_has_sim') continue;
    if (stationOpen != null && decision.replace === stationOpen.id) {
      await closeAudited(stationOpen, 'replaced', input.actor, input.log, tx);
    }
    if (decision.kind === 'attached_elsewhere') return 'attached_elsewhere';
    if (simOpen != null && decision.displace === simOpen.id) {
      // Re-checked in the UPDATE: one confirmed meanwhile stays (then attached_elsewhere).
      await closeAudited(simOpen, 'displaced', input.actor, input.log, tx);
    }
    const result = await attachSimToStation(
      {
        simId: sim.id,
        stationId,
        source: 'entered',
        by: input.actor.userId,
        withAllSites: input.withAllSites,
        confirm: input.withAllSites,
      },
      tx,
    );
    if (result.kind === 'attached') {
      if (!result.created) return 'unchanged';
      await auditAttached(result.attachment, sim.provider, input.actor.audit, null, input.log, tx);
      return 'attached';
    }
    if (result.kind === 'sim_attached_elsewhere') return 'attached_elsewhere';
    if (result.kind === 'sim_inactive') return 'sim_inactive';
    // station_has_sim or sim_not_found: another writer won; decide again.
  }
  return 'attach_conflict';
}

export type ReportedStationSimResult =
  | { kind: 'attached'; sim: Sim; attachment: SimAttachment }
  | { kind: 'no_iccid' }
  | { kind: 'attached_elsewhere' }
  | { kind: 'attach_conflict' }
  | { kind: 'sim_inactive' };

interface StationIccid {
  iccid: string | null;
  source: string;
  enteredBy: string | null;
  enteredWithAllSites: boolean;
}

/** The person is active and has access to every site now (database, no cache). */
async function stillAllSiteUser(userId: string, executor: SimDb): Promise<boolean> {
  const [user] = await executor
    .select({ hasAllSiteAccess: users.hasAllSiteAccess, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId));
  return user?.isActive === true && user.hasAllSiteAccess;
}

async function stationIccid(stationId: string, executor: SimDb): Promise<StationIccid | null> {
  const [row] = await executor
    .select({
      iccid: chargingStations.iccid,
      source: chargingStations.iccidSource,
      enteredBy: chargingStations.iccidEnteredBy,
      enteredWithAllSites: chargingStations.iccidEnteredWithAllSites,
    })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationId));
  return row ?? null;
}

/**
 * The station's SIM for a station tab Refresh: its open attachment, else the
 * SIM of the ICCID the station holds (created when new). The ICCID's origin on
 * the station decides the attachment: one the station reported is
 * attached unconfirmed with source `reported` and no attaching user; one a
 * person entered (the station PATCH while the attach was not possible, or
 * before a Detach) is attached `entered` with that person, confirmed only when
 * they had access to every site at the entry and still have it, active, now
 * (a detach clears the entry's all-site flag). So the Confirm SIM dialog never
 * shows an entered ICCID as reported by the station. A Refresh never displaces: a
 * SIM open elsewhere answers `attached_elsewhere`. An inactive SIM is never
 * attached (`sim_inactive`). No provider call. `actor` is the person who
 * pressed Refresh, for the audit rows.
 */
export async function attachReportedStationSim(
  stationId: string,
  actor: SimAuditActor,
  log?: ServiceLogger,
  executor: SimDb = db,
): Promise<ReportedStationSimResult> {
  return withPlanPush(
    executor,
    () => Promise.resolve([stationId]),
    log,
    () => attachReported(stationId, actor, log, executor),
  );
}

async function attachReported(
  stationId: string,
  actor: SimAuditActor,
  log: ServiceLogger | undefined,
  executor: SimDb,
): Promise<ReportedStationSimResult> {
  const existing = await openStationAttachment(stationId, executor);
  if (existing != null) {
    const sim = await getSim(existing.simId, executor);
    if (sim != null) return { kind: 'attached', sim, attachment: existing };
  }
  const held = await stationIccid(stationId, executor);
  const iccid = normalizeIccid(held?.iccid ?? null);
  if (held == null || iccid == null) return { kind: 'no_iccid' };
  const entered = held.source === 'entered';
  const source = entered ? 'entered' : 'reported';
  const by = entered ? held.enteredBy : null;
  // The saved all-site flag is a snapshot: the entering person must still be
  // active with access to every site now, else the attachment stays unconfirmed.
  // A confirmation names a person, so an entry whose user was deleted stays unconfirmed too.
  const withAllSites =
    entered && held.enteredWithAllSites && by != null && (await stillAllSiteUser(by, executor));
  // A SIM made here was asked for by the person who entered the ICCID, if any.
  const simActor: SimActor = { audit: actor, userId: by };
  return executor.transaction(async (tx): Promise<ReportedStationSimResult> => {
    const { sim } = await ensureSim(
      iccid,
      { actor: simActor, ...(log != null ? { log } : {}) },
      tx,
    );
    for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt++) {
      const stationOpen = await openStationAttachment(stationId, tx);
      const simOpen = await openSimAttachment(sim.id, tx);
      const decision = attachmentOutcome({
        simId: sim.id,
        simActive: sim.status === 'active',
        source,
        withAllSites,
        stationOpen,
        simOpen,
      });
      if (decision.kind === 'sim_inactive') return { kind: 'sim_inactive' };
      if (decision.kind === 'attached_elsewhere') return { kind: 'attached_elsewhere' };
      // A Refresh never displaces, also not for an entered ICCID.
      if (decision.kind === 'attach' && decision.displace != null) {
        return { kind: 'attached_elsewhere' };
      }
      if (stationOpen != null) {
        // Unchanged, or another attachment opened at the station meanwhile: use it.
        const held = stationOpen.simId === sim.id ? sim : await getSim(stationOpen.simId, tx);
        if (held != null) return { kind: 'attached', sim: held, attachment: stationOpen };
        continue;
      }
      const result = await attachSimToStation(
        { simId: sim.id, stationId, source, by, withAllSites, confirm: withAllSites },
        tx,
      );
      if (result.kind === 'attached') {
        if (result.created) {
          await auditAttached(result.attachment, sim.provider, actor, null, log, tx);
        }
        return { kind: 'attached', sim, attachment: result.attachment };
      }
      if (result.kind === 'sim_attached_elsewhere') return { kind: 'attached_elsewhere' };
      if (result.kind === 'sim_inactive') return { kind: 'sim_inactive' };
    }
    return { kind: 'attach_conflict' };
  });
}

/**
 * BootNotification with another ICCID than the stored one (the caller compares
 * them normalized, so a trailing F or an empty ICCID never gets here): the
 * station holds another SIM, so its open attachment is closed `iccid_changed`.
 * Creates no SIM and calls no provider: the next Refresh attaches the
 * reported SIM. True when an attachment was closed; a repeat closes nothing.
 */
export async function closeStationAttachmentOnIccidChange(
  stationId: string,
  reportedIccid: string,
  log?: ServiceLogger,
  executor: SimDb = db,
): Promise<boolean> {
  return withPlanPush(
    executor,
    () => Promise.resolve([stationId]),
    log,
    () => closeOnIccidChange(stationId, reportedIccid, log, executor),
  );
}

async function closeOnIccidChange(
  stationId: string,
  reportedIccid: string,
  log: ServiceLogger | undefined,
  executor: SimDb,
): Promise<boolean> {
  const open = await openStationAttachment(stationId, executor);
  if (open == null) return false;
  // A SIM attached before the station first reported it (an import, an Attach
  // on the SIM page) is the SIM the station now reports: the attachment stays.
  const attached = await getSim(open.simId, executor);
  const reported = normalizeIccid(reportedIccid);
  if (attached != null && reported != null && normalizeIccid(attached.iccid) === reported) {
    return false;
  }
  const closed = await closeAudited(
    open,
    'iccid_changed',
    { audit: BOOT_ACTOR, userId: null },
    log,
    executor,
  );
  return closed != null;
}

/**
 * Confirm SIM on the station tab: confirms the station's open attachment the
 * person saw (`attachmentId`). Audited only when it confirmed something. The
 * caller checks `stations:write` and access to every site. No provider call.
 */
export async function confirmStationAttachment(
  stationId: string,
  attachmentId: number,
  input: ActorInput,
  executor: SimDb = db,
): Promise<ConfirmAttachmentResult> {
  return withPlanPush(
    executor,
    () => Promise.resolve([stationId]),
    input.log,
    () => confirmStation(stationId, attachmentId, input, executor),
  );
}

async function confirmStation(
  stationId: string,
  attachmentId: number,
  input: ActorInput,
  executor: SimDb,
): Promise<ConfirmAttachmentResult> {
  const by = input.actor.userId;
  if (by == null) throw new Error('confirmStationAttachment: a person confirms');
  const outcome = await confirmAttachment(stationId, attachmentId, by, executor);
  if (outcome.result !== 'confirmed') return outcome.result;
  // The row the UPDATE confirmed: a read after the commit could miss it.
  const confirmed = outcome.attachment;
  await auditSafely(
    simAuditTable(),
    {
      entityId: confirmed.simId,
      entityIdSnapshot: confirmed.simId,
      action: 'attachment_confirmed',
      ...input.actor.audit,
      before: { attachment: { ...attachmentAudit(confirmed), confirmed: false } },
      after: { attachment: attachmentAudit(confirmed) },
    },
    executor,
    input.log,
  );
  await auditSafely(
    stationAuditTable(),
    {
      entityId: stationId,
      entityIdSnapshot: stationId,
      action: 'updated',
      ...input.actor.audit,
      before: { simAttachment: { ...attachmentAudit(confirmed), confirmed: false } },
      after: { simAttachment: attachmentAudit(confirmed) },
      notes: 'sim_attachment_confirmed',
    },
    executor,
    input.log,
  );
  return outcome.result;
}

/** Detach on the station tab: closes the station's open attachment (`detached`). Null without one. */
export async function detachStationSim(
  stationId: string,
  input: ActorInput,
  executor: SimDb = db,
): Promise<SimAttachment | null> {
  return withPlanPush(
    executor,
    () => Promise.resolve([stationId]),
    input.log,
    async () => {
      const open = await openStationAttachment(stationId, executor);
      if (open == null) return null;
      return closeAudited(open, 'detached', input.actor, input.log, executor);
    },
  );
}

// ---------------------------------------------------------------------------
// Payment terminal: the terminal's own SIM (VP6825 LTE)
// ---------------------------------------------------------------------------

export type TerminalSimResult =
  | { kind: 'attached'; attachment: SimAttachment }
  | { kind: 'unchanged'; attachment: SimAttachment }
  | { kind: 'sim_attached_elsewhere' }
  | { kind: 'terminal_has_sim' }
  | { kind: 'sim_inactive' }
  | { kind: 'sim_not_found' };

/**
 * The ICCID of a payment terminal's own SIM, entered by a person (`entered`)
 * or reported by the terminal provider (`reported`): the SIM is found or
 * created and attached to the terminal, confirmed at once only for an ICCID
 * an all-site person entered (plan E10, the station rule). Never closes an
 * attachment: a SIM held elsewhere and a terminal holding another SIM are
 * refused.
 */
export async function enterTerminalIccid(
  paymentTerminalId: string,
  iccid: string,
  input: ActorInput & { source: 'entered' | 'reported'; withAllSites: boolean },
  executor: SimDb = db,
): Promise<TerminalSimResult> {
  const { sim } = await ensureSim(
    iccid,
    {
      actor: input.actor,
      ...(input.log != null ? { log: input.log } : {}),
      notes: 'payment_terminal',
    },
    executor,
  );
  const confirm = input.source === 'entered' && input.withAllSites;
  const result = await attachSimToPaymentTerminal(
    {
      simId: sim.id,
      paymentTerminalId,
      source: input.source,
      by: input.actor.userId,
      withAllSites: input.withAllSites,
      confirm,
    },
    executor,
  );
  if (result.kind !== 'attached') return { kind: result.kind };
  if (!result.created) return { kind: 'unchanged', attachment: result.attachment };
  await auditAttached(
    result.attachment,
    sim.provider,
    input.actor.audit,
    'payment_terminal',
    input.log,
    executor,
  );
  return { kind: 'attached', attachment: result.attachment };
}

/** Audits the SIM side of a terminal SIM attachment the terminal writer closed on a site change. */
export async function auditTerminalSimClosed(
  open: SimAttachment,
  closed: SimAttachment,
  input: ActorInput,
): Promise<void> {
  await auditDetached(closed, open, 'detached', input.actor.audit, input.log);
}

/** Closes a payment terminal's open SIM attachment (`detached`). Null without one. */
export async function detachTerminalSim(
  paymentTerminalId: string,
  input: ActorInput,
  executor: SimDb = db,
): Promise<SimAttachment | null> {
  const open = await openTerminalAttachment(paymentTerminalId, executor);
  if (open == null) return null;
  return closeAudited(open, 'detached', input.actor, input.log, executor);
}

// ---------------------------------------------------------------------------
// SIM page and import
// ---------------------------------------------------------------------------

export type AttachSimServiceResult =
  | { kind: 'attached'; attachment: SimAttachment }
  | { kind: 'unchanged'; attachment: SimAttachment }
  | { kind: 'sim_attached_elsewhere' }
  | { kind: 'station_has_sim' }
  | { kind: 'sim_inactive' }
  | { kind: 'sim_not_found' };

/**
 * Attach on the SIM page (`attached`) or by the CSV import (`imported`):
 * confirmed at once, since only a person with access to every site may do it
 * (the caller checks). Refuses a SIM attached elsewhere, a station with
 * another SIM and an inactive SIM; never closes an attachment.
 */
export async function attachSim(
  simId: string,
  stationId: string,
  input: ActorInput & { source?: 'attached' | 'imported'; notes?: string },
  executor: SimDb = db,
): Promise<AttachSimServiceResult> {
  return withPlanPush(
    executor,
    () => Promise.resolve([stationId]),
    input.log,
    () => attachSimAudited(simId, stationId, input, executor),
  );
}

async function attachSimAudited(
  simId: string,
  stationId: string,
  input: ActorInput & { source?: 'attached' | 'imported'; notes?: string },
  executor: SimDb,
): Promise<AttachSimServiceResult> {
  const result = await attachSimToStation(
    {
      simId,
      stationId,
      source: input.source ?? 'attached',
      by: input.actor.userId,
      withAllSites: true,
      confirm: true,
    },
    executor,
  );
  if (result.kind !== 'attached') return { kind: result.kind };
  if (!result.created) return { kind: 'unchanged', attachment: result.attachment };
  const sim = await getSim(simId, executor);
  await auditAttached(
    result.attachment,
    sim?.provider ?? null,
    input.actor.audit,
    input.notes ?? null,
    input.log,
    executor,
  );
  return { kind: 'attached', attachment: result.attachment };
}

/**
 * Detach on the SIM page: closes the SIM's open attachment when it is
 * `attachmentId` (`detached`). Null when that attachment is not open. The
 * caller checks access to the attachment's station first.
 */
export async function detachSimAttachment(
  simId: string,
  attachmentId: number,
  input: ActorInput,
  executor: SimDb = db,
): Promise<SimAttachment | null> {
  return withPlanPush(
    executor,
    async () => [await simStation(simId, executor)],
    input.log,
    async () => {
      const open = await openSimAttachment(simId, executor);
      if (open?.id !== attachmentId) return null;
      return closeAudited(open, 'detached', input.actor, input.log, executor);
    },
  );
}

function operatorFieldsDiffer(before: Sim, after: Sim): boolean {
  return before.label !== after.label || before.notes !== after.notes || before.imsi !== after.imsi;
}

/** Edit on the SIM page: label, notes, IMSI. Audited when a field changed; null for an unknown SIM. */
export async function updateSim(
  simId: string,
  fields: SimFields,
  input: ActorInput & { notes?: string },
  executor: SimDb = db,
): Promise<{ before: Sim; after: Sim } | null> {
  const result = await updateSimFields(simId, fields, executor);
  if (result == null || !operatorFieldsDiffer(result.before, result.after)) return result;
  await auditSafely(
    simAuditTable(),
    {
      entityId: simId,
      entityIdSnapshot: simId,
      action: 'updated',
      ...input.actor.audit,
      before: simAudit(result.before),
      after: { ...simAudit(result.after), imsiChanged: result.before.imsi !== result.after.imsi },
      notes: input.notes ?? null,
    },
    executor,
    input.log,
  );
  return result;
}

/** Delete on the SIM page: refused while attached; the `deleted` row keeps the SIM's audit view. */
export async function deleteSim(
  simId: string,
  input: ActorInput,
  executor: SimDb = db,
): Promise<DeleteSimResult> {
  const result = await deleteSimRow(simId, executor);
  if (result.kind !== 'deleted') return result;
  await auditSafely(
    simAuditTable(),
    {
      entityId: simId,
      entityIdSnapshot: simId,
      action: 'deleted',
      ...input.actor.audit,
      before: simAudit(result.sim),
      after: null,
    },
    executor,
    input.log,
  );
  return result;
}

async function setStatusAudited(
  simId: string,
  status: 'active' | 'inactive',
  input: ActorInput,
  executor: SimDb,
): Promise<SetSimStatusResult> {
  // The attachment a deactivation closes and the end of its station's entry
  // vouch commit together.
  const result = await executor.transaction(async (tx) => {
    const changed = await setSimStatus(simId, status, input.actor.userId, tx);
    const stationId = changed.kind === 'changed' ? changed.closedAttachment?.stationId : null;
    if (stationId != null) await endEntryVouch(stationId, tx);
    return changed;
  });
  if (result.kind !== 'changed') return result;
  await auditSafely(
    simAuditTable(),
    {
      entityId: simId,
      entityIdSnapshot: simId,
      action: status === 'inactive' ? 'deactivated' : 'reactivated',
      ...input.actor.audit,
      before: simAudit(result.before),
      after: simAudit(result.after),
    },
    executor,
    input.log,
  );
  const closed = result.closedAttachment;
  if (closed != null) {
    const open: SimAttachment = {
      ...closed,
      detachedAt: null,
      detachedBy: null,
      detachReason: null,
    };
    await auditDetached(closed, open, 'deactivated', input.actor.audit, input.log, executor);
  }
  return result;
}

/**
 * Deactivate: the SIM becomes `inactive` and its open attachment is
 * closed (`deactivated`). Never deletes the SIM, never touches the provider
 * status and calls no provider. The same status again writes nothing.
 */
export async function deactivateSim(
  simId: string,
  input: ActorInput,
  executor: SimDb = db,
): Promise<SetSimStatusResult> {
  return withPlanPush(
    executor,
    async () => [await simStation(simId, executor)],
    input.log,
    () => setStatusAudited(simId, 'inactive', input, executor),
  );
}

/** Reactivate: the SIM becomes `active` again; no attachment is opened. */
export async function reactivateSim(
  simId: string,
  input: ActorInput,
  executor: SimDb = db,
): Promise<SetSimStatusResult> {
  return setStatusAudited(simId, 'active', input, executor);
}
