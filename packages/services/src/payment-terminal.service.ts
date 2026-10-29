// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The payment terminal registry service (features/payment-terminals.md):
// every change of `payment_terminals` goes through here and is audited in
// `payment_terminal_audit_log` (P3). The writer is
// `@evtivity/database/lib/payment-terminals.ts`; site rules are the routes'.

import {
  createTerminal,
  db,
  deleteTerminal,
  getTerminal,
  pairTerminal,
  paymentTerminalAuditLog,
  recordTerminalDeviceStatus,
  setTerminalStatus,
  unpairTerminal,
  updateTerminal,
  writeAudit,
  type ClosedTerminalSim,
  type CreateTerminalInput,
  type CreateTerminalResult,
  type DeleteTerminalResult,
  type PairTerminalResult,
  type PaymentTerminal,
  type SetTerminalStatusResult,
  type SimAuditActor,
  type TerminalFieldChanges,
  type TerminalPairing,
  type UnpairTerminalResult,
  type UpdateTerminalResult,
} from '@evtivity/database';
import type { ServiceLogger } from '@evtivity/lib';
import {
  auditTerminalSimClosed,
  detachTerminalSim,
  enterTerminalIccid,
  type TerminalSimResult,
} from './sim-inventory.service.js';

/** Who acts: the audit fields and the user written as creator and SIM attacher. */
export interface TerminalActor {
  audit: SimAuditActor;
  /** An API key counts as its user; null for a process. */
  userId: string | null;
}

interface Ctx {
  actor: TerminalActor;
  log?: ServiceLogger;
}

/** The audit view of a terminal: no credentials (a terminal has none), the pairing and the states. */
export function terminalAuditView(t: PaymentTerminal): Record<string, unknown> {
  return {
    label: t.label,
    provider: t.provider,
    integrationMode: t.integrationMode,
    model: t.model,
    serialNumber: t.serialNumber,
    siteId: t.siteId,
    stationId: t.stationId,
    evseId: t.evseId,
    status: t.status,
  };
}

/**
 * Every site a terminal audit row names: the site it was written at and the
 * `siteId` of its before and after views, without duplicates or nulls.
 */
export function terminalAuditSiteIds(
  writtenAt: string | null,
  before: unknown,
  after: unknown,
): string[] {
  const named = [writtenAt];
  for (const view of [before, after]) {
    if (view != null && typeof view === 'object') {
      const site = (view as Record<string, unknown>)['siteId'];
      if (typeof site === 'string') named.push(site);
    }
  }
  return [...new Set(named.filter((s): s is string => s != null))];
}

async function audit(
  terminalId: string,
  action:
    | 'created'
    | 'updated'
    | 'paired'
    | 'unpaired'
    | 'deactivated'
    | 'reactivated'
    | 'deleted'
    | 'sim_attached'
    | 'sim_detached'
    | 'status_synced'
    | 'payment_started'
    | 'payment_voided',
  ctx: Ctx,
  before: unknown,
  after: unknown,
  notes: string | null = null,
  entityGone = false,
  site?: string | null,
): Promise<void> {
  // Every row carries the site it belongs to at write time (`auditSiteId`):
  // the audit routes scope by it, never by the terminal's current site, so a
  // terminal that moves leaves its history at the old site (security case
  // 268, the session-own-site rule of case 88). A payment row names the site
  // stamped on its transaction.
  let siteId: string | null;
  try {
    siteId = site !== undefined ? site : ((await getTerminal(terminalId))?.siteId ?? null);
  } catch (err: unknown) {
    ctx.log?.warn({ err, paymentTerminalId: terminalId }, 'Terminal audit site not read');
    siteId = null;
  }
  // The row also lists every site it names (`auditSiteIds`: the write-time
  // site and the `siteId` of its before and after views): a move from site B
  // back to site A names B's site and station in `before`, so the row shows to
  // a site-restricted user only when every site it names is theirs (security
  // case 277, the SIM case 48 pattern).
  const auditSiteIds = terminalAuditSiteIds(siteId, before, after);
  const stamp = (v: unknown): unknown =>
    v != null && typeof v === 'object'
      ? { ...(v as Record<string, unknown>), auditSiteId: siteId, auditSiteIds }
      : v;
  await writeAudit(
    { table: paymentTerminalAuditLog, idColumn: 'payment_terminal_id' },
    {
      entityId: entityGone ? null : terminalId,
      entityIdSnapshot: terminalId,
      action,
      ...ctx.actor.audit,
      before: stamp(before),
      after: after != null ? stamp(after) : after,
      notes,
    },
    db,
    ctx.log != null ? { warn: (obj: unknown, msg?: string) => ctx.log?.warn(obj, msg) } : undefined,
  );
}

/** A site change closed the terminal's SIM attachment (security case 276): both histories say so, at the old site. */
async function auditSiteChangeSim(
  id: string,
  simClosed: ClosedTerminalSim | null,
  oldSiteId: string | null,
  ctx: Ctx,
): Promise<void> {
  if (simClosed == null) return;
  await auditTerminalSimClosed(simClosed.open, simClosed.closed, ctx);
  await audit(
    id,
    'sim_detached',
    ctx,
    { attachmentId: simClosed.closed.id },
    null,
    'site_changed',
    false,
    oldSiteId,
  );
}

export async function createPaymentTerminal(
  input: Omit<CreateTerminalInput, 'createdBy'>,
  ctx: Ctx,
): Promise<CreateTerminalResult> {
  const result = await createTerminal({ ...input, createdBy: ctx.actor.userId });
  if (result.kind === 'created') {
    await audit(result.terminal.id, 'created', ctx, null, terminalAuditView(result.terminal));
  }
  return result;
}

export async function updatePaymentTerminal(
  id: string,
  changes: TerminalFieldChanges,
  ctx: Ctx,
): Promise<UpdateTerminalResult> {
  const result = await updateTerminal(id, changes);
  if (result.kind === 'updated') {
    const before = terminalAuditView(result.before);
    const after = terminalAuditView(result.after);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await audit(id, 'updated', ctx, before, after);
    }
    await auditSiteChangeSim(id, result.simClosed, result.before.siteId, ctx);
  }
  return result;
}

export async function pairPaymentTerminal(
  id: string,
  pairing: TerminalPairing,
  ctx: Ctx,
): Promise<PairTerminalResult> {
  const result = await pairTerminal(id, pairing);
  if (result.kind === 'paired') {
    await audit(
      id,
      'paired',
      ctx,
      terminalAuditView(result.before),
      terminalAuditView(result.after),
    );
    await auditSiteChangeSim(id, result.simClosed, result.before.siteId, ctx);
  }
  return result;
}

export async function unpairPaymentTerminal(id: string, ctx: Ctx): Promise<UnpairTerminalResult> {
  const result = await unpairTerminal(id);
  if (result.kind === 'unpaired') {
    await audit(
      id,
      'unpaired',
      ctx,
      terminalAuditView(result.before),
      terminalAuditView(result.after),
    );
  }
  return result;
}

export async function setPaymentTerminalStatus(
  id: string,
  status: 'active' | 'inactive',
  ctx: Ctx,
): Promise<SetTerminalStatusResult> {
  const result = await setTerminalStatus(id, status);
  if (result.kind === 'changed') {
    await audit(
      id,
      status === 'active' ? 'reactivated' : 'deactivated',
      ctx,
      terminalAuditView(result.before),
      terminalAuditView(result.after),
    );
  }
  return result;
}

export async function deletePaymentTerminal(id: string, ctx: Ctx): Promise<DeleteTerminalResult> {
  const result = await deleteTerminal(id);
  if (result.kind === 'deleted') {
    await audit(
      id,
      'deleted',
      ctx,
      terminalAuditView(result.terminal),
      null,
      null,
      true,
      result.terminal.siteId,
    );
  }
  return result;
}

/**
 * Stores a device report (status poll or webhook). Audited `status_synced`
 * only when the online flag changed. A reported ICCID attaches the terminal's
 * SIM when it holds none (`reported`, unconfirmed until an all-site person
 * confirms it, plan E10).
 */
export async function syncPaymentTerminalDevice(
  id: string,
  device: {
    online: boolean | null;
    lastSeenAt: Date | null;
    firmwareVersion?: string | null;
    iccid?: string | null;
  },
  ctx: Ctx,
  now: Date = new Date(),
): Promise<{ onlineChanged: boolean; online: boolean | null } | null> {
  const result = await recordTerminalDeviceStatus(
    id,
    {
      online: device.online,
      lastSeenAt: device.lastSeenAt,
      ...(device.firmwareVersion !== undefined ? { firmwareVersion: device.firmwareVersion } : {}),
    },
    now,
  );
  if (result == null) return null;
  if (result.onlineChanged) {
    await audit(id, 'status_synced', ctx, { online: result.before }, { online: result.after });
  }
  if (device.iccid != null) {
    try {
      const attached = await enterTerminalIccid(id, device.iccid, {
        ...ctx,
        source: 'reported',
        withAllSites: false,
      });
      if (attached.kind === 'attached') {
        await audit(id, 'sim_attached', ctx, null, {
          attachmentId: attached.attachment.id,
          source: 'reported',
        });
      }
    } catch (err: unknown) {
      ctx.log?.warn({ err, paymentTerminalId: id }, 'Reported terminal SIM not attached');
    }
  }
  return { onlineChanged: result.onlineChanged, online: result.after };
}

/** The ICCID a person entered on the terminal page. */
export async function attachPaymentTerminalSim(
  id: string,
  iccid: string,
  withAllSites: boolean,
  ctx: Ctx,
): Promise<TerminalSimResult> {
  const result = await enterTerminalIccid(id, iccid, { ...ctx, source: 'entered', withAllSites });
  if (result.kind === 'attached') {
    await audit(id, 'sim_attached', ctx, null, {
      attachmentId: result.attachment.id,
      source: 'entered',
      confirmed: result.attachment.confirmedAt != null,
    });
  }
  return result;
}

export async function detachPaymentTerminalSim(id: string, ctx: Ctx): Promise<boolean> {
  const closed = await detachTerminalSim(id, ctx);
  if (closed == null) return false;
  await audit(id, 'sim_detached', ctx, { attachmentId: closed.id }, null);
  return true;
}

/**
 * An operator money action on a terminal (a payment started from the CSMS, a
 * hold released): the transaction id, state and amounts, never card data.
 */
export async function auditPaymentTerminalAction(
  id: string,
  action: 'payment_started' | 'payment_voided',
  transaction: {
    id: string;
    siteId: string | null;
    state: string;
    requestedCents: number;
    authorizedCents: number | null;
    currency: string;
  },
  ctx: Ctx,
): Promise<void> {
  await audit(
    id,
    action,
    ctx,
    null,
    {
      transactionId: transaction.id,
      state: transaction.state,
      requestedCents: transaction.requestedCents,
      authorizedCents: transaction.authorizedCents,
      currency: transaction.currency,
    },
    null,
    false,
    transaction.siteId,
  );
}

export { getTerminal as getPaymentTerminal };
