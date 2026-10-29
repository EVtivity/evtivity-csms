// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../config.js';
import { chargingStations, evses } from '../schema/assets.js';
import { paymentTerminals, paymentTerminalTransactions } from '../schema/payment-terminals.js';
import {
  closeAttachment,
  openTerminalAttachment,
  raiseTerminalSimHistoryFloor,
  type SimAttachment,
} from './sim-inventory.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from './pg-errors.js';

// The only writer of `payment_terminals` (P3, guard test
// `payment-terminal-writer-guard.test.ts`): create, edit, pair to a station
// and optionally one EVSE, unpair, the operator status, the device status and
// the delete. No audit rows and no site rules here: the payment terminal
// service decides and audits. Every function takes the caller's transaction.

export type PaymentTerminal = typeof paymentTerminals.$inferSelect;
export type PaymentTerminalDb = Pick<
  typeof db,
  'select' | 'insert' | 'update' | 'delete' | 'transaction'
>;

/** The transaction states that still hold or may move money (open). */
export const OPEN_TERMINAL_TXN_STATES = [
  'requested',
  'presenting',
  'authorized',
  'capture_requested',
  'void_requested',
  'refund_pending',
] as const;

export interface TerminalPairing {
  stationId: string;
  /** The `evses.id` of one connector, or null for a station-wide terminal. */
  evseId: string | null;
}

export type PairingCheck =
  | { kind: 'ok'; siteId: string | null }
  | { kind: 'station_not_found' }
  | { kind: 'evse_not_found' };

/**
 * The pairing's station row is read FOR UPDATE (so a station delete or site
 * move waits) and the EVSE must belong to it. Returns the station's site,
 * which the terminal takes.
 */
async function checkPairing(
  pairing: TerminalPairing,
  tx: PaymentTerminalDb,
): Promise<PairingCheck> {
  const [station] = await tx
    .select({ id: chargingStations.id, siteId: chargingStations.siteId })
    .from(chargingStations)
    .where(eq(chargingStations.id, pairing.stationId))
    .for('update');
  if (station == null) return { kind: 'station_not_found' };
  if (pairing.evseId != null) {
    const [evse] = await tx
      .select({ id: evses.id })
      .from(evses)
      .where(and(eq(evses.id, pairing.evseId), eq(evses.stationId, station.id)));
    if (evse == null) return { kind: 'evse_not_found' };
  }
  return { kind: 'ok', siteId: station.siteId };
}

function isEvseTaken(err: unknown): boolean {
  return pgErrorCode(err) === PG_UNIQUE_VIOLATION;
}

/** A terminal SIM attachment a site change closed: the caller audits it. */
export interface ClosedTerminalSim {
  open: SimAttachment;
  closed: SimAttachment;
}

/**
 * A terminal whose site changes leaves its SIM at the old site: the open SIM
 * attachment is closed in the same transaction (which raises the SIM's history
 * floor), so no attachment window spans two sites and the new site's users
 * see none of the SIM's history from the old one (security case 276, the
 * station rule of cases 42 to 59). The SIM can be entered again at once.
 */
async function closeSimOnSiteChange(
  before: PaymentTerminal,
  after: PaymentTerminal,
  tx: PaymentTerminalDb,
): Promise<ClosedTerminalSim | null> {
  if (before.siteId === after.siteId) return null;
  const open = await openTerminalAttachment(after.id, tx);
  if (open == null) return null;
  const closed = await closeAttachment(open.id, 'detached', null, tx);
  return closed != null ? { open, closed } : null;
}

export interface CreateTerminalInput {
  provider: string;
  integrationMode: 'cloud' | 'hardware';
  providerDeviceId: string | null;
  label: string | null;
  vendor: string | null;
  model: string | null;
  serialNumber: string | null;
  firmwareVersion: string | null;
  /** The site of an unpaired terminal; a pairing takes the station's site instead. */
  siteId: string | null;
  pairing: TerminalPairing | null;
  createdBy: string | null;
}

export type CreateTerminalResult =
  | { kind: 'created'; terminal: PaymentTerminal }
  | { kind: 'device_taken' }
  | { kind: 'evse_taken' }
  | Exclude<PairingCheck, { kind: 'ok' }>;

export async function createTerminal(
  input: CreateTerminalInput,
  executor: PaymentTerminalDb = db,
): Promise<CreateTerminalResult> {
  return executor.transaction(async (tx) => {
    let siteId = input.siteId;
    if (input.pairing != null) {
      const check = await checkPairing(input.pairing, tx);
      if (check.kind !== 'ok') return check;
      siteId = check.siteId;
    }
    // ON CONFLICT DO NOTHING keeps the caller's transaction usable; the two
    // unique indexes (device, active EVSE) tell which one refused.
    const [row] = await tx
      .insert(paymentTerminals)
      .values({
        provider: input.provider,
        integrationMode: input.integrationMode,
        providerDeviceId: input.providerDeviceId,
        label: input.label,
        vendor: input.vendor,
        model: input.model,
        serialNumber: input.serialNumber,
        firmwareVersion: input.firmwareVersion,
        siteId,
        stationId: input.pairing?.stationId ?? null,
        evseId: input.pairing?.evseId ?? null,
        createdBy: input.createdBy,
      })
      .onConflictDoNothing()
      .returning();
    if (row != null) return { kind: 'created', terminal: row };
    if (input.providerDeviceId != null) {
      const [dup] = await tx
        .select({ id: paymentTerminals.id })
        .from(paymentTerminals)
        .where(
          and(
            eq(paymentTerminals.provider, input.provider),
            eq(paymentTerminals.providerDeviceId, input.providerDeviceId),
          ),
        );
      if (dup != null) return { kind: 'device_taken' };
    }
    return { kind: 'evse_taken' };
  });
}

export async function getTerminal(
  id: string,
  executor: PaymentTerminalDb = db,
): Promise<PaymentTerminal | null> {
  const [row] = await executor.select().from(paymentTerminals).where(eq(paymentTerminals.id, id));
  return row ?? null;
}

export interface TerminalFieldChanges {
  label?: string | null;
  vendor?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  /** Only for an unpaired terminal: a paired one follows its station's site. */
  siteId?: string | null;
}

export type UpdateTerminalResult =
  | {
      kind: 'updated';
      before: PaymentTerminal;
      after: PaymentTerminal;
      simClosed: ClosedTerminalSim | null;
    }
  | { kind: 'not_found' }
  | { kind: 'paired_site_change' };

/** Edits the operator fields. A paired terminal's site follows its station: changing it answers `paired_site_change`. */
export async function updateTerminal(
  id: string,
  changes: TerminalFieldChanges,
  executor: PaymentTerminalDb = db,
): Promise<UpdateTerminalResult> {
  return executor.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(paymentTerminals)
      .where(eq(paymentTerminals.id, id))
      .for('update');
    if (before == null) return { kind: 'not_found' };
    if (
      changes.siteId !== undefined &&
      changes.siteId !== before.siteId &&
      before.stationId != null
    ) {
      return { kind: 'paired_site_change' };
    }
    const [after] = await tx
      .update(paymentTerminals)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(paymentTerminals.id, id))
      .returning();
    if (after == null) return { kind: 'not_found' };
    const simClosed = await closeSimOnSiteChange(before, after, tx);
    return { kind: 'updated', before, after, simClosed };
  });
}

export type PairTerminalResult =
  | {
      kind: 'paired';
      before: PaymentTerminal;
      after: PaymentTerminal;
      simClosed: ClosedTerminalSim | null;
    }
  | { kind: 'not_found' }
  | { kind: 'evse_taken' }
  | Exclude<PairingCheck, { kind: 'ok' }>;

/** Pairs to a station (and one EVSE, or station-wide). The terminal takes the station's site. */
export async function pairTerminal(
  id: string,
  pairing: TerminalPairing,
  executor: PaymentTerminalDb = db,
): Promise<PairTerminalResult> {
  try {
    return await executor.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(paymentTerminals)
        .where(eq(paymentTerminals.id, id))
        .for('update');
      if (before == null) return { kind: 'not_found' };
      const check = await checkPairing(pairing, tx);
      if (check.kind !== 'ok') return check;
      const [after] = await tx
        .update(paymentTerminals)
        .set({
          stationId: pairing.stationId,
          evseId: pairing.evseId,
          siteId: check.siteId,
          updatedAt: new Date(),
        })
        .where(eq(paymentTerminals.id, id))
        .returning();
      if (after == null) return { kind: 'not_found' };
      const simClosed = await closeSimOnSiteChange(before, after, tx);
      return { kind: 'paired', before, after, simClosed };
    });
  } catch (err: unknown) {
    if (isEvseTaken(err)) return { kind: 'evse_taken' };
    throw err;
  }
}

export type UnpairTerminalResult =
  | { kind: 'unpaired'; before: PaymentTerminal; after: PaymentTerminal }
  | { kind: 'not_paired' }
  | { kind: 'not_found' };

/** Removes the station and EVSE; the site stays. */
export async function unpairTerminal(
  id: string,
  executor: PaymentTerminalDb = db,
): Promise<UnpairTerminalResult> {
  return executor.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(paymentTerminals)
      .where(eq(paymentTerminals.id, id))
      .for('update');
    if (before == null) return { kind: 'not_found' };
    if (before.stationId == null) return { kind: 'not_paired' };
    const [after] = await tx
      .update(paymentTerminals)
      .set({ stationId: null, evseId: null, updatedAt: new Date() })
      .where(eq(paymentTerminals.id, id))
      .returning();
    if (after == null) return { kind: 'not_found' };
    return { kind: 'unpaired', before, after };
  });
}

export type SetTerminalStatusResult =
  | { kind: 'changed'; before: PaymentTerminal; after: PaymentTerminal }
  | { kind: 'unchanged'; terminal: PaymentTerminal }
  | { kind: 'evse_taken' }
  | { kind: 'not_found' };

/** `active` or `inactive` (operator). Reactivating on an EVSE another active terminal took answers `evse_taken`. */
export async function setTerminalStatus(
  id: string,
  status: 'active' | 'inactive',
  executor: PaymentTerminalDb = db,
): Promise<SetTerminalStatusResult> {
  try {
    return await executor.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(paymentTerminals)
        .where(eq(paymentTerminals.id, id))
        .for('update');
      if (before == null) return { kind: 'not_found' };
      if (before.status === status) return { kind: 'unchanged', terminal: before };
      const [after] = await tx
        .update(paymentTerminals)
        .set({ status, updatedAt: new Date() })
        .where(eq(paymentTerminals.id, id))
        .returning();
      if (after == null) return { kind: 'not_found' };
      return { kind: 'changed', before, after };
    });
  } catch (err: unknown) {
    if (isEvseTaken(err)) return { kind: 'evse_taken' };
    throw err;
  }
}

export interface DeviceStatusInput {
  online: boolean | null;
  lastSeenAt: Date | null;
  firmwareVersion?: string | null;
}

export interface DeviceStatusResult {
  /** True when the online flag changed (audited as `status_synced`). */
  onlineChanged: boolean;
  before: boolean | null;
  after: boolean | null;
}

/**
 * Stores the device report: `status_fetched_at` always, the other fields only
 * when they changed. `offline_since` starts at the first offline report and
 * clears when the device is back. Null when the terminal is gone.
 */
export async function recordTerminalDeviceStatus(
  id: string,
  input: DeviceStatusInput,
  now: Date = new Date(),
  executor: PaymentTerminalDb = db,
): Promise<DeviceStatusResult | null> {
  return executor.transaction(async (tx) => {
    const [before] = await tx
      .select({
        online: paymentTerminals.online,
        offlineSince: paymentTerminals.offlineSince,
        lastSeenAt: paymentTerminals.lastSeenAt,
        firmwareVersion: paymentTerminals.firmwareVersion,
      })
      .from(paymentTerminals)
      .where(eq(paymentTerminals.id, id))
      .for('update');
    if (before == null) return null;
    const offlineSince =
      input.online === false
        ? (before.offlineSince ?? now)
        : input.online === true
          ? null
          : before.offlineSince;
    await tx
      .update(paymentTerminals)
      .set({
        statusFetchedAt: now,
        ...(input.online !== before.online ? { online: input.online } : {}),
        ...(offlineSince?.getTime() !== before.offlineSince?.getTime()
          ? // A new offline period (or back online) opens the next alert.
            { offlineSince, offlineAlertedAt: null }
          : {}),
        ...(input.lastSeenAt != null && input.lastSeenAt.getTime() !== before.lastSeenAt?.getTime()
          ? { lastSeenAt: input.lastSeenAt }
          : {}),
        ...(input.firmwareVersion != null && input.firmwareVersion !== before.firmwareVersion
          ? { firmwareVersion: input.firmwareVersion }
          : {}),
      })
      .where(eq(paymentTerminals.id, id));
    return {
      onlineChanged: input.online != null && input.online !== before.online,
      before: before.online,
      after: input.online ?? before.online,
    };
  });
}

export type DeleteTerminalResult =
  | { kind: 'deleted'; terminal: PaymentTerminal }
  | { kind: 'not_found' }
  | { kind: 'has_transactions' };

/**
 * Deletes a terminal that never took a payment. One with transactions is kept
 * for the payment history (RESTRICT): deactivate it instead. The SIM history
 * floor is raised first (its SIM attachments cascade away, security case 44).
 */
export async function deleteTerminal(
  id: string,
  executor: PaymentTerminalDb = db,
): Promise<DeleteTerminalResult> {
  return executor.transaction(async (tx) => {
    const [terminal] = await tx
      .select()
      .from(paymentTerminals)
      .where(eq(paymentTerminals.id, id))
      .for('update');
    if (terminal == null) return { kind: 'not_found' };
    const [txn] = await tx
      .select({ id: paymentTerminalTransactions.id })
      .from(paymentTerminalTransactions)
      .where(eq(paymentTerminalTransactions.paymentTerminalId, id))
      .limit(1);
    if (txn != null) return { kind: 'has_transactions' };
    await raiseTerminalSimHistoryFloor([id], tx);
    await tx.delete(paymentTerminals).where(eq(paymentTerminals.id, id));
    return { kind: 'deleted', terminal };
  });
}

/**
 * The active, paired terminals of stations: the station page card and the
 * terminal flow. A station-wide terminal has `evseId` null.
 */
export async function activeTerminalsOfStations(
  stationIds: readonly string[],
  executor: PaymentTerminalDb = db,
): Promise<PaymentTerminal[]> {
  if (stationIds.length === 0) return [];
  return executor
    .select()
    .from(paymentTerminals)
    .where(
      and(
        inArray(paymentTerminals.stationId, [...stationIds]),
        eq(paymentTerminals.status, 'active'),
        ne(paymentTerminals.integrationMode, 'hardware'),
      ),
    );
}

/**
 * Claims the offline alert of terminals offline since before `offlineBefore`
 * that were not alerted in this offline period (once per period, P7), active
 * cloud terminals only. Returns the claimed terminals.
 */
export async function claimTerminalOfflineAlerts(
  offlineBefore: Date,
  now: Date = new Date(),
  executor: PaymentTerminalDb = db,
): Promise<PaymentTerminal[]> {
  return executor
    .update(paymentTerminals)
    .set({ offlineAlertedAt: now })
    .where(
      and(
        eq(paymentTerminals.status, 'active'),
        eq(paymentTerminals.integrationMode, 'cloud'),
        eq(paymentTerminals.online, false),
        sql`${paymentTerminals.offlineSince} <= ${offlineBefore.toISOString()}::timestamptz`,
        sql`${paymentTerminals.offlineAlertedAt} IS NULL`,
      ),
    )
    .returning();
}

/** True when the terminal has a transaction in an open state. */
export async function terminalHasOpenTransaction(
  id: string,
  executor: PaymentTerminalDb = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ one: sql<number>`1` })
    .from(paymentTerminalTransactions)
    .where(
      and(
        eq(paymentTerminalTransactions.paymentTerminalId, id),
        inArray(paymentTerminalTransactions.state, [...OPEN_TERMINAL_TXN_STATES]),
      ),
    )
    .limit(1);
  return row != null;
}
