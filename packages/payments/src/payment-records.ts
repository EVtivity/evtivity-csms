// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  chargingSessions,
  db,
  driverTokens,
  getCompanyCurrency,
  paymentAuditLog,
  paymentRecords,
  SESSION_END_FAILED_REASON,
  tokenAuditLog,
  writeAudit,
} from '@evtivity/database';
import type {
  paymentAuditActionEnum,
  PaymentChargeType,
  PendingPaymentOperation,
  ProviderRefundEntry,
} from '@evtivity/database';
import { auditActorOf } from './context.js';
import type { PaymentAuditContext } from './context.js';
import { topUpCharges } from './top-ups.js';
import type { TopUpCharge } from './top-ups.js';
import type { PaymentProviderId, PaymentStatus, ProviderState } from './types.js';

/**
 * The only writer of `payment_records` (design principle P3). Every status
 * change names the statuses it may leave (P5), so a later, weaker event never
 * overwrites a stronger one:
 *
 * - `pending` -> `pre_authorized` | `captured` | `failed`
 * - `pre_authorized` -> `captured` | `cancelled` | `failed`
 * - `captured` | `partially_refunded` -> `partially_refunded` | `refunded`
 * - `captured` -> `failed` only by a capture failure webhook of the pending
 *   (or last confirmed) capture, before anything was refunded
 * - `cancelled` | `failed` -> `pending` only by the operator re-bill of a
 *   session the CSMS gave up ending (`claimRebillRecord`), for a hold that
 *   took no money, marked `metadata.rebill`
 *
 * Async providers (Adyen, the simulated provider in async mode) confirm
 * captures, cancels and refunds by webhook. A capture or cancel is written
 * optimistically (`captured`/`cancelled`) with `pending_operation` and the
 * provider's reference of the operation; the webhook clears it. Refunds go
 * into the `provider_refunds` ledger as `pending` and raise the refunded
 * total only when the provider confirms them. An authorisation adjustment
 * (P10 Part D) keeps the record `pre_authorized` with `pending_operation =
 * 'adjust'` until its webhook settles the session; every move out of the
 * hold clears it.
 *
 * Each update returns whether it applied; a false means the record had
 * already moved on (or does not exist), and the caller logs it.
 *
 * Every status change (and every insert) writes one `payment_audit_log` row
 * with the caller's actor (`auditPayment`), only when the write changed a row.
 */

export type PaymentRecord = typeof paymentRecords.$inferSelect;
type PaymentAuditAction = (typeof paymentAuditActionEnum.enumValues)[number];
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

const FROM_PENDING: PaymentStatus[] = ['pending'];
const FROM_HOLD: PaymentStatus[] = ['pre_authorized'];
const REFUNDABLE: PaymentStatus[] = ['captured', 'partially_refunded'];
/** A webhook failure moves only an open payment (F8). */
const FAILABLE: PaymentStatus[] = ['pending', 'pre_authorized'];
/** A hold given up on that the session re-bill may take over (`claimRebillRecord`). */
const FROM_GIVEN_UP: PaymentStatus[] = ['cancelled', 'failed'];

/**
 * Who started the payment. `operator`: an off-session charge the CSMS starts
 * for an operator, not the driver (the session re-bill and the reservation
 * cancellation and no-show fees).
 */
export type PaymentSource = 'web_portal' | 'guest' | 'prepaid' | 'ocpp_terminal' | 'operator';

/** The provider columns of a record. */
function providerIds(
  provider: PaymentProviderId,
  ids: { paymentId?: string | null; customerId?: string | null; methodId?: string | null },
): Partial<typeof paymentRecords.$inferInsert> {
  return {
    provider,
    ...(ids.paymentId !== undefined ? { providerPaymentId: ids.paymentId } : {}),
    ...(ids.customerId !== undefined ? { providerCustomerId: ids.customerId } : {}),
    ...(ids.methodId !== undefined ? { providerPaymentMethodId: ids.methodId } : {}),
  };
}

export interface HoldRecordInput {
  sessionId: string;
  driverId: string | null;
  sitePaymentConfigId: number | null;
  provider: PaymentProviderId;
  paymentId: string;
  customerId: string | null;
  methodId: string | null;
  source: PaymentSource;
  currency: string;
  preAuthAmountCents: number;
  /** Opaque provider state of the hold (Adyen `adjustAuthorisationData`). */
  providerState?: ProviderState | null;
}

/** A placed hold. Null when the session already has a record (unique per session). */
export async function recordHold(
  input: HoldRecordInput,
  audit: PaymentAuditContext,
): Promise<number | null> {
  const [row] = await db
    .insert(paymentRecords)
    .values({
      sessionId: input.sessionId,
      driverId: input.driverId,
      sitePaymentConfigId: input.sitePaymentConfigId,
      ...providerIds(input.provider, {
        paymentId: input.paymentId,
        customerId: input.customerId,
        methodId: input.methodId,
      }),
      paymentSource: input.source,
      currency: input.currency,
      preAuthAmountCents: input.preAuthAmountCents,
      ...(input.providerState != null ? { providerState: input.providerState } : {}),
      status: 'pre_authorized',
    })
    .onConflictDoNothing({ target: paymentRecords.sessionId })
    .returning({ id: paymentRecords.id });
  if (row == null) return null;
  await auditPayment(audit, row.id, 'pre_authorized', {
    before: null,
    after: {
      status: 'pre_authorized',
      sessionId: input.sessionId,
      provider: input.provider,
      paymentSource: input.source,
      preAuthAmountCents: input.preAuthAmountCents,
      currency: input.currency,
    },
  });
  return row.id;
}

export interface FailedHoldInput {
  sessionId: string;
  driverId: string | null;
  sitePaymentConfigId: number | null;
  provider: PaymentProviderId;
  customerId: string | null;
  methodId: string | null;
  source: PaymentSource;
  currency: string;
  preAuthAmountCents: number | null;
  reason: string;
}

/** A declined hold. Null when the session already has a record. */
export async function recordFailedHold(
  input: FailedHoldInput,
  audit: PaymentAuditContext,
): Promise<number | null> {
  const [row] = await db
    .insert(paymentRecords)
    .values({
      sessionId: input.sessionId,
      driverId: input.driverId,
      sitePaymentConfigId: input.sitePaymentConfigId,
      ...providerIds(input.provider, { customerId: input.customerId, methodId: input.methodId }),
      paymentSource: input.source,
      currency: input.currency,
      preAuthAmountCents: input.preAuthAmountCents,
      status: 'failed',
      failureReason: input.reason.slice(0, 500),
    })
    .onConflictDoNothing({ target: paymentRecords.sessionId })
    .returning({ id: paymentRecords.id });
  if (row == null) return null;
  await auditPayment(audit, row.id, 'failed', {
    before: null,
    after: {
      status: 'failed',
      sessionId: input.sessionId,
      provider: input.provider,
      paymentSource: input.source,
      preAuthAmountCents: input.preAuthAmountCents,
      currency: input.currency,
      failureReason: input.reason.slice(0, 500),
    },
  });
  return row.id;
}

export async function findSessionRecord(sessionId: string): Promise<PaymentRecord | null> {
  const [row] = await db
    .select()
    .from(paymentRecords)
    .where(eq(paymentRecords.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

export async function findRecord(id: number): Promise<PaymentRecord | null> {
  const [row] = await db.select().from(paymentRecords).where(eq(paymentRecords.id, id));
  return row ?? null;
}

/** The session's open hold, if any. */
export async function findSessionHold(sessionId: string): Promise<PaymentRecord | null> {
  const [row] = await db
    .select()
    .from(paymentRecords)
    .where(
      and(eq(paymentRecords.sessionId, sessionId), eq(paymentRecords.status, 'pre_authorized')),
    )
    .limit(1);
  return row ?? null;
}

function updated(rows: Array<{ id: number }>): boolean {
  return rows.length > 0;
}

interface PaymentChange {
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  notes?: string | null;
}

/**
 * The audit row of one record transition (`payment_audit_log`, entity id the
 * record id), with the actor of the calling context (`system` `payments`
 * without one). Written on its own connection, never a caller's transaction,
 * so a failed audit insert cannot abort the payment write; writeAudit is
 * fail-open (P9) and logs the failure.
 */
async function auditPayment(
  audit: PaymentAuditContext,
  recordId: number,
  action: PaymentAuditAction,
  change: PaymentChange,
): Promise<void> {
  const { actor, logger } = auditActorOf(audit);
  await writeAudit(
    { table: paymentAuditLog, idColumn: 'payment_id' },
    {
      entityId: String(recordId),
      entityIdSnapshot: String(recordId),
      action,
      ...actor,
      before: change.before,
      after: change.after,
      notes: change.notes ?? null,
    },
    db,
    logger,
  );
}

/** The audit action of a refunded record's status. */
function refundAction(status: PaymentStatus): PaymentAuditAction {
  return status === 'refunded' ? 'refunded' : 'partially_refunded';
}

/**
 * Appends a top-up payment to `metadata.topUps` (see `top-ups.ts`), unless
 * the record already lists it (a replayed or concurrent retry charged the
 * same top-up under the same idempotency key).
 */
function appendTopUp(topUp: { paymentId: string; amountCents: number }): SQL {
  const list = sql`COALESCE(${paymentRecords.metadata} -> 'topUps', '[]'::jsonb)`;
  const entry = JSON.stringify({
    paymentId: topUp.paymentId,
    amountCents: topUp.amountCents,
    refundedCents: 0,
  });
  return sql`CASE WHEN ${list} @> jsonb_build_array(jsonb_build_object('paymentId', ${topUp.paymentId}::text)) THEN ${paymentRecords.metadata} ELSE jsonb_set(COALESCE(${paymentRecords.metadata}, '{}'::jsonb), '{topUps}', ${list} || jsonb_build_array(${entry}::jsonb)) END`;
}

/**
 * pre_authorized -> captured. `failureReason` carries an uncollected
 * shortfall (a declined top-up or a guest cost above the hold). `topUp` is
 * the settlement top-up, recorded in `metadata.topUps`. `authorizedCents` is
 * the hold raised by an authorisation adjustment: it becomes
 * `pre_auth_amount_cents`, so the capture above the original hold is not
 * taken for an unlisted top-up (`unlistedTopUpCents`).
 */
export async function markCaptured(
  id: number,
  input: {
    capturedCents: number;
    failureReason: string | null;
    topUp?: { paymentId: string; amountCents: number } | null;
    /** The provider's reference of a capture it confirms later by webhook. */
    pendingRef?: string | null;
    /** The authorized amount of an adjusted hold. */
    authorizedCents?: number | null;
  },
  audit: PaymentAuditContext,
): Promise<boolean> {
  const topUp = input.topUp ?? null;
  const authorizedCents = input.authorizedCents ?? null;
  const moved = updated(
    await db
      .update(paymentRecords)
      .set({
        status: 'captured',
        capturedAmountCents: input.capturedCents,
        failureReason: input.failureReason,
        ...(topUp != null ? { metadata: appendTopUp(topUp) } : {}),
        ...(authorizedCents != null ? { preAuthAmountCents: authorizedCents } : {}),
        ...pendingFields('capture', input.pendingRef ?? null),
        updatedAt: new Date(),
      })
      .where(and(eq(paymentRecords.id, id), inArray(paymentRecords.status, FROM_HOLD)))
      .returning({ id: paymentRecords.id }),
  );
  if (moved) {
    await auditPayment(audit, id, 'captured', {
      before: { status: 'pre_authorized' },
      after: {
        status: 'captured',
        capturedAmountCents: input.capturedCents,
        ...(input.failureReason != null ? { failureReason: input.failureReason } : {}),
        ...(topUp != null ? { topUpCents: topUp.amountCents } : {}),
        ...(authorizedCents != null ? { preAuthAmountCents: authorizedCents } : {}),
        ...(input.pendingRef != null ? { pendingOperation: 'capture' } : {}),
      },
    });
  }
  return moved;
}

/** No pending operation: a record leaving the hold ends a pending adjustment. */
const NO_PENDING_OPERATION = {
  pendingOperation: null,
  pendingOperationRef: null,
  pendingOperationAt: null,
} as const;

/**
 * The pending operation columns of an async result. A confirmed (synchronous)
 * result clears them: the only operation a hold can wait for is an
 * adjustment, which the capture or cancel ends.
 */
function pendingFields(
  operation: PendingPaymentOperation,
  ref: string | null,
): Partial<typeof paymentRecords.$inferInsert> {
  if (ref == null) return NO_PENDING_OPERATION;
  return { pendingOperation: operation, pendingOperationRef: ref, pendingOperationAt: new Date() };
}

/**
 * pre_authorized -> cancelled (nothing captured). `pendingRef` is the
 * provider's reference of a cancel it confirms later by webhook.
 */
export async function markCancelled(
  id: number,
  input: { pendingRef?: string | null; failureReason?: string | null },
  audit: PaymentAuditContext,
): Promise<boolean> {
  const pendingRef = input.pendingRef ?? null;
  const failureReason = input.failureReason ?? null;
  const moved = updated(
    await db
      .update(paymentRecords)
      .set({
        status: 'cancelled',
        capturedAmountCents: 0,
        ...(failureReason != null ? { failureReason: failureReason.slice(0, 500) } : {}),
        ...pendingFields('cancel', pendingRef),
        updatedAt: new Date(),
      })
      .where(and(eq(paymentRecords.id, id), inArray(paymentRecords.status, FROM_HOLD)))
      .returning({ id: paymentRecords.id }),
  );
  if (moved) {
    await auditPayment(audit, id, 'cancelled', {
      before: { status: 'pre_authorized' },
      after: {
        status: 'cancelled',
        capturedAmountCents: 0,
        ...(failureReason != null ? { failureReason: failureReason.slice(0, 500) } : {}),
        ...(pendingRef != null ? { pendingOperation: 'cancel' } : {}),
      },
    });
  }
  return moved;
}

/** pre_authorized -> failed (a capture that failed, or a hold given up on). */
export async function markHoldFailed(
  id: number,
  reason: string,
  audit: PaymentAuditContext,
): Promise<boolean> {
  const moved = updated(
    await db
      .update(paymentRecords)
      .set({
        status: 'failed',
        failureReason: reason.slice(0, 500),
        ...NO_PENDING_OPERATION,
        updatedAt: new Date(),
      })
      .where(and(eq(paymentRecords.id, id), inArray(paymentRecords.status, FROM_HOLD)))
      .returning({ id: paymentRecords.id }),
  );
  if (moved) {
    await auditPayment(audit, id, 'failed', {
      before: { status: 'pre_authorized' },
      after: { status: 'failed', failureReason: reason.slice(0, 500) },
    });
  }
  return moved;
}

/**
 * Claims an open hold for an authorisation adjustment before the provider is
 * asked (P4): `pending_operation = 'adjust'` with no reference yet, so an
 * adjustment webhook that arrives before `setAdjustmentRef` still matches.
 * False when the hold is gone or another settlement already claimed it.
 */
export async function markAdjustmentPending(id: number): Promise<boolean> {
  return updated(
    await db
      .update(paymentRecords)
      .set({
        pendingOperation: 'adjust',
        pendingOperationRef: null,
        pendingOperationAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(paymentRecords.id, id),
          inArray(paymentRecords.status, FROM_HOLD),
          sql`${paymentRecords.pendingOperation} IS NULL`,
        ),
      )
      .returning({ id: paymentRecords.id }),
  );
}

/** Stores the provider's reference of the pending adjustment (async answer). */
export async function setAdjustmentRef(id: number, ref: string): Promise<boolean> {
  return updated(
    await db
      .update(paymentRecords)
      .set({ pendingOperationRef: ref, updatedAt: new Date() })
      .where(
        and(
          eq(paymentRecords.id, id),
          inArray(paymentRecords.status, FROM_HOLD),
          eq(paymentRecords.pendingOperation, 'adjust'),
          sql`${paymentRecords.pendingOperationRef} IS NULL`,
        ),
      )
      .returning({ id: paymentRecords.id }),
  );
}

/**
 * The adjustment webhook of an open hold: matches the pending adjustment with
 * this reference (or one whose reference is not stored yet) and stores the
 * reference. Null when no adjustment of this hold is pending (a foreign,
 * late or replayed event).
 */
export async function matchPendingAdjustment(
  id: number,
  ref: string,
): Promise<PaymentRecord | null> {
  const [row] = await db
    .update(paymentRecords)
    .set({ pendingOperationRef: ref, updatedAt: new Date() })
    .where(
      and(
        eq(paymentRecords.id, id),
        inArray(paymentRecords.status, FROM_HOLD),
        eq(paymentRecords.pendingOperation, 'adjust'),
        sql`(${paymentRecords.pendingOperationRef} IS NULL OR ${paymentRecords.pendingOperationRef} = ${ref})`,
      ),
    )
    .returning();
  return row ?? null;
}

/** Ends the pending adjustment of an open hold (the request failed; the caller settles without it). */
export async function clearPendingAdjustment(id: number): Promise<boolean> {
  return updated(
    await db
      .update(paymentRecords)
      .set({ ...NO_PENDING_OPERATION, updatedAt: new Date() })
      .where(
        and(
          eq(paymentRecords.id, id),
          inArray(paymentRecords.status, FROM_HOLD),
          eq(paymentRecords.pendingOperation, 'adjust'),
        ),
      )
      .returning({ id: paymentRecords.id }),
  );
}

/** Locks a record by id for a refund webhook (inside the caller's transaction). */
export async function lockRecord(tx: Tx, id: number): Promise<PaymentRecord | null> {
  const [row] = await tx
    .select()
    .from(paymentRecords)
    .where(eq(paymentRecords.id, id))
    .for('update');
  return row ?? null;
}

/** Locks the session's record for a refund (inside the caller's transaction). */
export async function lockSessionRecord(tx: Tx, sessionId: string): Promise<PaymentRecord | null> {
  const [row] = await tx
    .select()
    .from(paymentRecords)
    .where(eq(paymentRecords.sessionId, sessionId))
    .for('update');
  return row ?? null;
}

/**
 * captured | partially_refunded -> partially_refunded | refunded. Never lowers
 * the refunded total (a delayed event or a replay). `topUps` replaces
 * `metadata.topUps` with the per-charge refunded totals (a record with
 * top-ups).
 */
export async function markRefunded(
  id: number,
  input: {
    refundedTotalCents: number;
    full: boolean;
    actorUserId?: string | null;
    actionReason?: string | null;
    topUps?: TopUpCharge[];
    /** Refunds the provider made now, appended to `provider_refunds` (synchronous providers). */
    ledger?: ProviderRefundEntry[];
    /** The record as the caller read (or locked) it: the audit row's `before`. */
    previous: Pick<PaymentRecord, 'status' | 'refundedAmountCents'>;
  },
  audit: PaymentAuditContext,
  executor: Executor = db,
): Promise<PaymentRecord | null> {
  const [row] = await executor
    .update(paymentRecords)
    .set({
      status: input.full ? 'refunded' : 'partially_refunded',
      refundedAmountCents: input.refundedTotalCents,
      ...(input.ledger != null && input.ledger.length > 0
        ? {
            providerRefunds: sql`${paymentRecords.providerRefunds} || ${JSON.stringify(input.ledger)}::jsonb`,
          }
        : {}),
      ...(input.topUps != null
        ? {
            metadata: sql`jsonb_set(COALESCE(${paymentRecords.metadata}, '{}'::jsonb), '{topUps}', ${JSON.stringify(input.topUps)}::jsonb)`,
          }
        : {}),
      ...(input.actorUserId != null ? { lastActorUserId: input.actorUserId } : {}),
      ...(input.actionReason != null ? { lastActionReason: input.actionReason } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paymentRecords.id, id),
        inArray(paymentRecords.status, REFUNDABLE),
        lte(paymentRecords.refundedAmountCents, input.refundedTotalCents),
      ),
    )
    .returning();
  if (row == null) return null;
  await auditPayment(audit, id, refundAction(row.status), {
    before: {
      status: input.previous.status,
      refundedAmountCents: input.previous.refundedAmountCents,
    },
    after: { status: row.status, refundedAmountCents: row.refundedAmountCents },
    notes: input.actionReason ?? null,
  });
  return row;
}

/**
 * Webhook confirmation of the pending operation: clears it when the
 * provider's reference matches (B6.5: a foreign or out-of-order event changes
 * nothing). The reference stays, so a capture failure reported after the
 * capture's success still matches.
 */
export async function confirmOperation(
  id: number,
  operation: PendingPaymentOperation,
  ref: string,
): Promise<boolean> {
  return updated(
    await db
      .update(paymentRecords)
      .set({ pendingOperation: null, pendingOperationAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(paymentRecords.id, id),
          eq(paymentRecords.pendingOperation, operation),
          eq(paymentRecords.pendingOperationRef, ref),
        ),
      )
      .returning({ id: paymentRecords.id }),
  );
}

/**
 * captured -> failed: the provider reports that a capture it accepted failed.
 * Applies only to the capture with this reference (pending, or confirmed and
 * then reported failed), and only before anything was refunded. Returns the
 * row for the driver notification, null when the guard did not match.
 */
export async function failPendingCapture(
  id: number,
  ref: string,
  reason: string,
  audit: PaymentAuditContext,
): Promise<PaymentRecord | null> {
  const [row] = await db
    .update(paymentRecords)
    .set({
      status: 'failed',
      failureReason: reason.slice(0, 500),
      pendingOperation: null,
      pendingOperationAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paymentRecords.id, id),
        eq(paymentRecords.status, 'captured'),
        eq(paymentRecords.pendingOperationRef, ref),
        sql`(${paymentRecords.pendingOperation} IS NULL OR ${paymentRecords.pendingOperation} = 'capture')`,
        eq(paymentRecords.refundedAmountCents, 0),
      ),
    )
    .returning();
  if (row == null) return null;
  await auditPayment(audit, id, 'failed', {
    before: { status: 'captured', capturedAmountCents: row.capturedAmountCents },
    after: { status: 'failed', failureReason: row.failureReason },
  });
  return row;
}

/**
 * pre_authorized -> cancelled without a request of ours: the provider expired
 * or cancelled the authorisation (Adyen EXPIRE, TECHNICAL_CANCEL, a cancel in
 * its dashboard). A pending cancel of ours is cleared instead when the record
 * is already cancelled, because the authorisation is gone either way.
 */
export async function markAuthorisationEnded(
  id: number,
  reason: string,
  audit: PaymentAuditContext,
): Promise<boolean> {
  const moved = await db
    .update(paymentRecords)
    .set({
      status: 'cancelled',
      capturedAmountCents: 0,
      lastActionReason: reason.slice(0, 500),
      ...NO_PENDING_OPERATION,
      updatedAt: new Date(),
    })
    .where(and(eq(paymentRecords.id, id), inArray(paymentRecords.status, FROM_HOLD)))
    .returning({ id: paymentRecords.id });
  if (moved.length > 0) {
    await auditPayment(audit, id, 'cancelled', {
      before: { status: 'pre_authorized' },
      after: { status: 'cancelled', capturedAmountCents: 0 },
      notes: reason.slice(0, 500),
    });
    return true;
  }
  return updated(
    await db
      .update(paymentRecords)
      .set({ pendingOperation: null, pendingOperationAt: null, updatedAt: new Date() })
      .where(and(eq(paymentRecords.id, id), eq(paymentRecords.pendingOperation, 'cancel')))
      .returning({ id: paymentRecords.id }),
  );
}

/**
 * Appends refunds the provider accepted but confirms later (`pending`), inside
 * the refund's transaction, with the operator and reason of the request. The
 * refunded total does not change. A refund id already listed is skipped (a
 * retried request reuses the provider's refund).
 */
export async function addPendingRefunds(
  id: number,
  entries: Array<{ refundId: string; paymentId: string; amountCents: number }>,
  input: { actorUserId?: string | null; actionReason?: string | null },
  executor: Executor = db,
): Promise<PaymentRecord | null> {
  const [current] = await executor
    .select({ refunds: paymentRecords.providerRefunds })
    .from(paymentRecords)
    .where(eq(paymentRecords.id, id));
  if (current == null) return null;
  const listed = new Set(current.refunds.map((r) => r.refundId));
  const requestedAt = new Date().toISOString();
  const added: ProviderRefundEntry[] = entries
    .filter((e) => !listed.has(e.refundId))
    .map((e) => ({ ...e, state: 'pending', requestedAt }));
  const [row] = await executor
    .update(paymentRecords)
    .set({
      providerRefunds: [...current.refunds, ...added],
      ...(input.actorUserId != null ? { lastActorUserId: input.actorUserId } : {}),
      ...(input.actionReason != null ? { lastActionReason: input.actionReason } : {}),
      updatedAt: new Date(),
    })
    .where(eq(paymentRecords.id, id))
    .returning();
  return row ?? null;
}

export type RefundSettlement =
  /** The entry moved from pending, or was added for a refund made outside EVtivity. */
  | { status: 'applied'; record: PaymentRecord; entry: ProviderRefundEntry }
  /** The entry was settled before (a replayed or duplicate event). */
  | { status: 'already_settled' }
  /** A succeeded refund the record cannot take (not captured, or above the captured total). */
  | { status: 'not_refundable'; recordStatus: PaymentStatus }
  | { status: 'not_found' };

/**
 * A provider's confirmation of one refund (an increment, not a cumulative
 * total). Under the record lock the ledger entry moves from `pending` to
 * `succeeded` or `failed` once. A success raises the refunded total, the
 * refunded total of the charge it refunds (`metadata.topUps`) and the status
 * (`partially_refunded`, or `refunded` at the captured total) with the
 * from-state guard of `markRefunded` (P5). A refund the ledger does not list
 * (made in the provider's dashboard) is appended in its final state.
 */
export async function settleRefund(
  id: number,
  input: {
    refundId: string;
    /** The charge refunded: the hold or a top-up. */
    paymentId: string;
    amountCents: number;
    outcome: 'succeeded' | 'failed';
  },
  audit: PaymentAuditContext,
): Promise<RefundSettlement> {
  // The raised totals, audited after the commit.
  const raised: { change: PaymentChange | null } = { change: null };
  const result = await db.transaction(async (tx): Promise<RefundSettlement> => {
    const locked = await lockRecord(tx, id);
    if (locked == null) return { status: 'not_found' };
    const existing = locked.providerRefunds.find((r) => r.refundId === input.refundId);
    if (existing != null && existing.state !== 'pending') return { status: 'already_settled' };
    const settledAt = new Date().toISOString();
    const amountCents = existing?.amountCents ?? input.amountCents;
    const entry: ProviderRefundEntry = {
      refundId: input.refundId,
      paymentId: existing?.paymentId ?? input.paymentId,
      amountCents,
      state: input.outcome,
      requestedAt: existing?.requestedAt ?? settledAt,
      settledAt,
    };
    const ledger =
      existing != null
        ? locked.providerRefunds.map((r) => (r.refundId === input.refundId ? entry : r))
        : [...locked.providerRefunds, entry];

    const captured = locked.capturedAmountCents ?? 0;
    const total = locked.refundedAmountCents + amountCents;
    const raises =
      input.outcome === 'succeeded' && REFUNDABLE.includes(locked.status) && total <= captured;
    if (!raises) {
      // The provider's answer goes into the ledger; the totals stay.
      const [row] = await tx
        .update(paymentRecords)
        .set({ providerRefunds: ledger, updatedAt: new Date() })
        .where(eq(paymentRecords.id, id))
        .returning();
      if (row == null) return { status: 'not_found' };
      if (input.outcome === 'succeeded') {
        return { status: 'not_refundable', recordStatus: locked.status };
      }
      return { status: 'applied', record: row, entry };
    }
    const topUps = topUpCharges(locked);
    const refundedTopUps = topUps.map((t) =>
      t.paymentId === entry.paymentId
        ? { ...t, refundedCents: Math.min(t.amountCents, t.refundedCents + amountCents) }
        : t,
    );
    const [row] = await tx
      .update(paymentRecords)
      .set({
        status: total >= captured ? 'refunded' : 'partially_refunded',
        refundedAmountCents: total,
        providerRefunds: ledger,
        ...(topUps.some((t) => t.paymentId === entry.paymentId)
          ? {
              metadata: sql`jsonb_set(COALESCE(${paymentRecords.metadata}, '{}'::jsonb), '{topUps}', ${JSON.stringify(refundedTopUps)}::jsonb)`,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(paymentRecords.id, id),
          inArray(paymentRecords.status, REFUNDABLE),
          lte(paymentRecords.refundedAmountCents, total),
        ),
      )
      .returning();
    if (row == null) return { status: 'not_refundable', recordStatus: locked.status };
    raised.change = {
      before: { status: locked.status, refundedAmountCents: locked.refundedAmountCents },
      after: {
        status: row.status,
        refundedAmountCents: row.refundedAmountCents,
        // The operator who requested the refund; the provider confirms it.
        lastActorUserId: row.lastActorUserId,
      },
      notes: `Refund ${entry.refundId} confirmed by the provider`,
    };
    return { status: 'applied', record: row, entry };
  });
  if (raised.change != null && result.status === 'applied') {
    await auditPayment(audit, id, refundAction(result.record.status), raised.change);
  }
  return result;
}

/**
 * Records whose async operation or refund the provider has not confirmed
 * since `olderThan`, for reconciliation of providers without a status lookup.
 * Pending operations use the partial index `idx_payment_records_pending_operation`;
 * pending refunds are looked for in records created since `since`.
 */
export async function recordsAwaitingConfirmation(
  olderThan: Date,
  since: Date,
  limit: number,
): Promise<PaymentRecord[]> {
  return db
    .select()
    .from(paymentRecords)
    .where(
      sql`(${paymentRecords.pendingOperation} IS NOT NULL AND ${paymentRecords.pendingOperationAt} < ${olderThan})
        OR (${paymentRecords.createdAt} >= ${since} AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(${paymentRecords.providerRefunds}) AS r
          WHERE r ->> 'state' = 'pending' AND (r ->> 'requestedAt')::timestamptz < ${olderThan}
        ))`,
    )
    .orderBy(paymentRecords.id)
    .limit(limit);
}

/**
 * Open holds whose authorisation adjustment was claimed before `olderThan`
 * and never got a provider reference: the settlement that claimed it lost
 * its connection before the provider answered or before the reference was
 * stored. `resumeStaleAdjustments` asks the provider again with the same key.
 */
export async function staleAdjustmentClaims(
  olderThan: Date,
  limit = 200,
): Promise<PaymentRecord[]> {
  return db
    .select()
    .from(paymentRecords)
    .where(
      and(
        eq(paymentRecords.status, 'pre_authorized'),
        eq(paymentRecords.pendingOperation, 'adjust'),
        sql`${paymentRecords.pendingOperationRef} IS NULL`,
        sql`${paymentRecords.pendingOperationAt} < ${olderThan}`,
      ),
    )
    .orderBy(paymentRecords.id)
    .limit(limit);
}

/**
 * Takes over an adjustment claim without a provider reference, atomically:
 * only when the hold is still open, the claim still has no reference (a
 * webhook or another settlement did not store one meanwhile) and it was made
 * before `olderThan`. Moves `pending_operation_at` to now, so a concurrent
 * re-drive of the same claim finds it fresh and skips it. Returns the record,
 * or null when the claim is not there to take.
 */
export async function reclaimStaleAdjustment(
  id: number,
  olderThan: Date,
): Promise<PaymentRecord | null> {
  const [row] = await db
    .update(paymentRecords)
    .set({ pendingOperationAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(paymentRecords.id, id),
        inArray(paymentRecords.status, FROM_HOLD),
        eq(paymentRecords.pendingOperation, 'adjust'),
        sql`${paymentRecords.pendingOperationRef} IS NULL`,
        sql`${paymentRecords.pendingOperationAt} < ${olderThan}`,
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * A recovered shortfall: the captured total reaches the final cost, and the
 * retry top-up is appended to `metadata.topUps`.
 */
export async function markShortfallRecovered(
  id: number,
  input: {
    capturedCents: number;
    actorUserId: string | null;
    actionReason: string;
    topUp: { paymentId: string; amountCents: number };
    /** The captured total before the retry: the audit row's `before`. */
    previousCapturedCents: number | null;
  },
  audit: PaymentAuditContext,
): Promise<PaymentRecord | null> {
  const [row] = await db
    .update(paymentRecords)
    .set({
      capturedAmountCents: input.capturedCents,
      metadata: appendTopUp(input.topUp),
      failureReason: null,
      ...(input.actorUserId != null ? { lastActorUserId: input.actorUserId } : {}),
      lastActionReason: input.actionReason,
      updatedAt: new Date(),
    })
    .where(and(eq(paymentRecords.id, id), eq(paymentRecords.status, 'captured')))
    .returning();
  if (row == null) return null;
  await auditPayment(audit, id, 'captured', {
    before: { status: 'captured', capturedAmountCents: input.previousCapturedCents },
    after: {
      status: 'captured',
      capturedAmountCents: input.capturedCents,
      topUpCents: input.topUp.amountCents,
    },
    notes: input.actionReason,
  });
  return row;
}

/** A shortfall retry that failed again: the reason the next retry reads. */
export async function markShortfallRetryFailed(id: number, reason: string): Promise<boolean> {
  return updated(
    await db
      .update(paymentRecords)
      .set({ failureReason: reason.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(paymentRecords.id, id), eq(paymentRecords.status, 'captured')))
      .returning({ id: paymentRecords.id }),
  );
}

export interface PendingChargeInput {
  chargeType: Exclude<PaymentChargeType, 'session'>;
  reservationId: string;
  driverId: string;
  sitePaymentConfigId: number | null;
  provider: PaymentProviderId;
  customerId: string;
  methodId: string;
  currency: string;
  taxRate: number;
  /**
   * The provider request of the charge (`metadata.feeRequest`), so a resume
   * sends the same parameters with the same key.
   */
  feeRequest: ReservationFeeRequest;
}

export interface ReservationFeeRequest {
  grossCents: number;
  platformFeePercent: number;
  payoutAccountId: string | null;
}

/** The stored provider request of a reservation fee record, or null for an older record. */
export function reservationFeeRequest(metadata: unknown): ReservationFeeRequest | null {
  if (metadata == null || typeof metadata !== 'object') return null;
  const req = (metadata as Record<string, unknown>)['feeRequest'];
  if (req == null || typeof req !== 'object') return null;
  const r = req as Record<string, unknown>;
  if (typeof r['grossCents'] !== 'number' || typeof r['platformFeePercent'] !== 'number') {
    return null;
  }
  return {
    grossCents: r['grossCents'],
    platformFeePercent: r['platformFeePercent'],
    payoutAccountId: typeof r['payoutAccountId'] === 'string' ? r['payoutAccountId'] : null,
  };
}

/**
 * A reservation fee before it is charged. Unique per reservation and fee
 * type, so a retry or a concurrent call gets null and charges nothing (P7).
 */
export async function recordPendingCharge(
  input: PendingChargeInput,
  audit: PaymentAuditContext,
): Promise<number | null> {
  const [row] = await db
    .insert(paymentRecords)
    .values({
      chargeType: input.chargeType,
      reservationId: input.reservationId,
      driverId: input.driverId,
      sitePaymentConfigId: input.sitePaymentConfigId,
      ...providerIds(input.provider, { customerId: input.customerId, methodId: input.methodId }),
      paymentSource: 'operator',
      currency: input.currency,
      taxRate: String(input.taxRate),
      status: 'pending',
      metadata: { feeRequest: input.feeRequest },
    })
    .onConflictDoNothing({
      target: [paymentRecords.reservationId, paymentRecords.chargeType],
      where: sql`${paymentRecords.reservationId} IS NOT NULL`,
    })
    .returning({ id: paymentRecords.id });
  if (row == null) return null;
  await auditPayment(audit, row.id, 'created', {
    before: null,
    after: {
      status: 'pending',
      chargeType: input.chargeType,
      reservationId: input.reservationId,
      provider: input.provider,
      amountCents: input.feeRequest.grossCents,
      currency: input.currency,
    },
  });
  return row.id;
}

export async function findReservationCharge(
  reservationId: string,
  chargeType: PaymentChargeType,
): Promise<number | null> {
  const [row] = await db
    .select({ id: paymentRecords.id })
    .from(paymentRecords)
    .where(
      and(
        eq(paymentRecords.reservationId, reservationId),
        eq(paymentRecords.chargeType, chargeType),
      ),
    );
  return row?.id ?? null;
}

/** pending -> captured (an immediate charge succeeded). */
export async function markChargeCaptured(
  id: number,
  input: { provider: PaymentProviderId; paymentId: string; amountCents: number },
  audit: PaymentAuditContext,
): Promise<boolean> {
  const moved = updated(
    await db
      .update(paymentRecords)
      .set({
        status: 'captured',
        ...providerIds(input.provider, { paymentId: input.paymentId }),
        capturedAmountCents: input.amountCents,
        updatedAt: new Date(),
      })
      .where(and(eq(paymentRecords.id, id), inArray(paymentRecords.status, FROM_PENDING)))
      .returning({ id: paymentRecords.id }),
  );
  if (moved) {
    await auditPayment(audit, id, 'captured', {
      before: { status: 'pending' },
      after: { status: 'captured', capturedAmountCents: input.amountCents },
    });
  }
  return moved;
}

/** pending -> failed (an immediate charge was declined). */
export async function markChargeFailed(
  id: number,
  reason: string,
  audit: PaymentAuditContext,
): Promise<boolean> {
  const moved = updated(
    await db
      .update(paymentRecords)
      .set({ status: 'failed', failureReason: reason.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(paymentRecords.id, id), inArray(paymentRecords.status, FROM_PENDING)))
      .returning({ id: paymentRecords.id }),
  );
  if (moved) {
    await auditPayment(audit, id, 'failed', {
      before: { status: 'pending' },
      after: { status: 'failed', failureReason: reason.slice(0, 500) },
    });
  }
  return moved;
}

/**
 * Claims reservation fee charges for an invoice, inside the invoice
 * transaction: invoice_id is set only while it is null, so a fee is never on
 * two invoices. Returns the ids it claimed; fewer than asked means another
 * invoice claimed one first and the caller rolls back.
 */
export async function claimFeeRecordsForInvoice(
  tx: Tx,
  ids: number[],
  invoiceId: string,
): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .update(paymentRecords)
    .set({ invoiceId, updatedAt: new Date() })
    .where(and(inArray(paymentRecords.id, ids), isNull(paymentRecords.invoiceId)))
    .returning({ id: paymentRecords.id });
  return rows.map((row) => row.id);
}

/**
 * Releases the reservation fee charges a voided invoice claimed, inside the
 * void transaction, so they can be invoiced again. Returns their ids.
 */
export async function releaseInvoiceFeeRecords(tx: Tx, invoiceId: string): Promise<number[]> {
  const rows = await tx
    .update(paymentRecords)
    .set({ invoiceId: null, updatedAt: new Date() })
    .where(eq(paymentRecords.invoiceId, invoiceId))
    .returning({ id: paymentRecords.id });
  return rows.map((row) => row.id);
}

/**
 * How long after its first claim a re-bill charge whose outcome is unknown
 * (`pending`, no provider payment id) may be resumed with the same
 * `rebill_<sessionId>` key. Providers replay the first answer of a key only
 * while they keep it: Stripe 24 hours, Adyen at least 7 days. After 23 hours
 * (inside the shorter, Stripe's) a retry could be a new charge, so the claim
 * refuses it and reconciliation reports the record for an operator to check
 * at the provider.
 */
export const REBILL_RESUME_MAX_HOURS = 23;

/**
 * The provider request of a re-bill charge, stored in `metadata.rebill.request`
 * on the first claim. A resume sends exactly this request again (same key,
 * same parameters), never a recomputed one.
 */
export interface RebillChargeRequest {
  provider: PaymentProviderId;
  customerId: string;
  methodId: string;
  /** The amount charged, tax included, in cents of `currency`. */
  grossCents: number;
  currency: string;
  /** The tax rate (fraction) the platform fee is taken on the net amount with. */
  feeTaxRate: number;
  platformFeePercent: number;
  payoutAccountId: string | null;
}

/**
 * The re-bill of a session the CSMS gave up ending (`session-rebill.ts`):
 * `metadata.rebill` marks a record the re-bill wrote or took over.
 */
export interface RebillRecordInput {
  sessionId: string;
  driverId: string;
  sitePaymentConfigId: number | null;
  /** The charge to send when the record has none stored yet. */
  request: RebillChargeRequest;
}

export type RebillRecordClaim =
  /**
   * The record is `pending` for the re-bill charge (new, taken over, or a
   * retry of it), with the request to send: the stored one when `resumed`.
   */
  | { state: 'claimed'; id: number; request: RebillChargeRequest; resumed: boolean }
  /** An earlier attempt of this re-bill charged (a retry after the charge). */
  | { state: 'charged'; id: number; amountCents: number }
  /** An earlier attempt of this re-bill was declined: manual billing, no second charge. */
  | { state: 'failed'; id: number; reason: string; amountCents: number | null }
  /**
   * The record holds another payment (open, paid, or with a pending
   * operation), or a re-bill charge with an unknown outcome older than
   * REBILL_RESUME_MAX_HOURS.
   */
  | { state: 'refused'; status: PaymentStatus }
  /** The session is no longer faulted with its re-bill claim held: nothing written. */
  | { state: 'session_not_claimed' };

/** Whether the re-bill wrote or took over this record (`metadata.rebill`). */
export function isRebillRecord(record: { metadata: unknown }): boolean {
  const metadata = record.metadata;
  return typeof metadata === 'object' && metadata != null && 'rebill' in metadata;
}

function rebillMetadata(record: { metadata: unknown }): Record<string, unknown> | null {
  if (!isRebillRecord(record)) return null;
  const rebill = (record.metadata as { rebill: unknown }).rebill;
  return typeof rebill === 'object' && rebill != null ? (rebill as Record<string, unknown>) : null;
}

/** The stored request of a re-bill record (`metadata.rebill.request`), null when it has none. */
export function rebillChargeRequest(record: { metadata: unknown }): RebillChargeRequest | null {
  const request = rebillMetadata(record)?.['request'];
  if (typeof request !== 'object' || request == null) return null;
  const r = request as Record<string, unknown>;
  if (
    typeof r['provider'] !== 'string' ||
    typeof r['customerId'] !== 'string' ||
    typeof r['methodId'] !== 'string' ||
    typeof r['grossCents'] !== 'number' ||
    typeof r['currency'] !== 'string' ||
    typeof r['feeTaxRate'] !== 'number' ||
    typeof r['platformFeePercent'] !== 'number'
  ) {
    return null;
  }
  return {
    provider: r['provider'],
    customerId: r['customerId'],
    methodId: r['methodId'],
    grossCents: r['grossCents'],
    currency: r['currency'],
    feeTaxRate: r['feeTaxRate'],
    platformFeePercent: r['platformFeePercent'],
    payoutAccountId: typeof r['payoutAccountId'] === 'string' ? r['payoutAccountId'] : null,
  };
}

/** When the re-bill first claimed the record (`metadata.rebill.requestedAt`). */
export function rebillRequestedAt(record: { metadata: unknown }): Date | null {
  const requestedAt = rebillMetadata(record)?.['requestedAt'];
  if (typeof requestedAt !== 'string') return null;
  const date = new Date(requestedAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Whether a re-bill charge has an unknown outcome (`pending`, no provider
 * payment id) for longer than REBILL_RESUME_MAX_HOURS: a retry is refused
 * (the provider may no longer replay the key) and reconciliation reports it.
 */
export function isStaleRebillCharge(
  record: { status: string; providerPaymentId: string | null; metadata: unknown },
  now: number = Date.now(),
): boolean {
  if (!isRebillRecord(record) || record.status !== 'pending' || record.providerPaymentId != null) {
    return false;
  }
  const requestedAt = rebillRequestedAt(record);
  return requestedAt != null && now - requestedAt.getTime() >= REBILL_RESUME_MAX_HOURS * 3_600_000;
}

/**
 * Re-bill charges with an unknown outcome older than REBILL_RESUME_MAX_HOURS
 * (`isStaleRebillCharge`), for reconciliation.
 */
export async function staleRebillCharges(limit: number): Promise<PaymentRecord[]> {
  const olderThan = new Date(Date.now() - REBILL_RESUME_MAX_HOURS * 3_600_000);
  return db
    .select()
    .from(paymentRecords)
    .where(
      sql`${paymentRecords.status} = 'pending'
        AND ${paymentRecords.providerPaymentId} IS NULL
        AND ${paymentRecords.metadata} ? 'rebill'
        AND (${paymentRecords.metadata} -> 'rebill' ->> 'requestedAt')::timestamptz < ${olderThan}`,
    )
    .orderBy(paymentRecords.id)
    .limit(limit);
}

/**
 * Claims the session's record for its re-bill charge, under a row lock, only
 * while the session is faulted with stopped reason EndRequestFailed and its
 * re-bill claim is held (`session_not_claimed` otherwise, P11). No record: a
 * new `pending` one. A `cancelled` or `failed` record (the hold the CSMS
 * cancelled when it gave up ending the session) with nothing captured,
 * refunded or pending goes back to `pending` with the re-bill's provider ids,
 * keeping the hold's ids in `metadata.rebill` (the one exception to sticky
 * terminal records, matched by that marker: the hold took no money). Both
 * store the request and `requestedAt` in `metadata.rebill`. A record the
 * re-bill already wrote reports its state, so a retry charges once: a
 * `pending` one is resumed with its stored request (the same
 * `rebill_<sessionId>` key and parameters), unless it is older than
 * REBILL_RESUME_MAX_HOURS (refused). Any other record is refused.
 */
export async function claimRebillRecord(
  input: RebillRecordInput,
  audit: PaymentAuditContext,
): Promise<RebillRecordClaim> {
  // The record the claim wrote or took over, audited after the commit.
  const written: { change: PaymentChange | null } = { change: null };
  const claim = await db.transaction(async (tx): Promise<RebillRecordClaim> => {
    const held = await tx
      .select({ id: chargingSessions.id })
      .from(chargingSessions)
      .where(
        and(
          eq(chargingSessions.id, input.sessionId),
          eq(chargingSessions.status, 'faulted'),
          eq(chargingSessions.stoppedReason, SESSION_END_FAILED_REASON),
          eq(chargingSessions.rebillStatus, 'in_progress'),
        ),
      )
      .for('share');
    if (held.length === 0) return { state: 'session_not_claimed' };
    const record = await lockSessionRecord(tx, input.sessionId);
    const { request } = input;
    const ids = providerIds(request.provider, {
      paymentId: null,
      customerId: request.customerId,
      methodId: request.methodId,
    });
    const requestedAt = new Date().toISOString();
    if (record == null) {
      const [row] = await tx
        .insert(paymentRecords)
        .values({
          sessionId: input.sessionId,
          driverId: input.driverId,
          sitePaymentConfigId: input.sitePaymentConfigId,
          ...ids,
          paymentSource: 'operator',
          currency: request.currency,
          status: 'pending',
          metadata: { rebill: { requestedAt, request } },
        })
        .onConflictDoNothing({ target: paymentRecords.sessionId })
        .returning({ id: paymentRecords.id });
      if (row == null) return { state: 'refused', status: 'pending' };
      written.change = {
        before: null,
        after: rebillAuditAfter(input.sessionId, request),
        notes: 'Session re-bill charge',
      };
      return { state: 'claimed', id: row.id, request, resumed: false };
    }
    if (isRebillRecord(record)) {
      const stored = rebillChargeRequest(record);
      if (record.status === 'pending') {
        if (isStaleRebillCharge(record)) return { state: 'refused', status: record.status };
        if (stored != null)
          return { state: 'claimed', id: record.id, request: stored, resumed: true };
        // A pending record without a stored request: store this one, as the first claim does.
        await tx
          .update(paymentRecords)
          .set({
            metadata: sql`jsonb_set(${paymentRecords.metadata}, '{rebill,request}', ${JSON.stringify(request)}::jsonb)`,
            updatedAt: new Date(),
          })
          .where(eq(paymentRecords.id, record.id));
        return { state: 'claimed', id: record.id, request, resumed: false };
      }
      if (record.status === 'captured') {
        return { state: 'charged', id: record.id, amountCents: record.capturedAmountCents ?? 0 };
      }
      if (record.status === 'failed') {
        return {
          state: 'failed',
          id: record.id,
          reason: record.failureReason ?? '',
          amountCents: stored?.grossCents ?? null,
        };
      }
      return { state: 'refused', status: record.status };
    }
    const untouched =
      (record.status === 'cancelled' || record.status === 'failed') &&
      (record.capturedAmountCents ?? 0) === 0 &&
      record.refundedAmountCents === 0 &&
      record.pendingOperation == null &&
      record.providerRefunds.length === 0;
    if (!untouched) return { state: 'refused', status: record.status };
    const rebill = {
      requestedAt,
      request,
      previousStatus: record.status,
      previousProvider: record.provider,
      previousPaymentId: record.providerPaymentId,
      previousFailureReason: record.failureReason,
    };
    const [row] = await tx
      .update(paymentRecords)
      .set({
        status: 'pending',
        driverId: input.driverId,
        sitePaymentConfigId: input.sitePaymentConfigId,
        ...ids,
        paymentSource: 'operator',
        currency: request.currency,
        preAuthAmountCents: null,
        capturedAmountCents: null,
        failureReason: null,
        providerState: null,
        ...NO_PENDING_OPERATION,
        metadata: sql`COALESCE(${paymentRecords.metadata}, '{}'::jsonb) || ${JSON.stringify({ rebill })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(paymentRecords.id, record.id), inArray(paymentRecords.status, FROM_GIVEN_UP)))
      .returning({ id: paymentRecords.id });
    if (row == null) return { state: 'refused', status: record.status };
    written.change = {
      before: { status: record.status, provider: record.provider },
      after: rebillAuditAfter(input.sessionId, request),
      notes: 'Session re-bill took over the given-up hold',
    };
    return { state: 'claimed', id: row.id, request, resumed: false };
  });
  if (written.change != null && claim.state === 'claimed') {
    await auditPayment(audit, claim.id, 'created', written.change);
  }
  return claim;
}

/** The `after` of a re-bill claim's audit row. */
function rebillAuditAfter(
  sessionId: string,
  request: RebillChargeRequest,
): Record<string, unknown> {
  return {
    status: 'pending',
    sessionId,
    provider: request.provider,
    amountCents: request.grossCents,
    currency: request.currency,
  };
}

/** The record of a provider's payment (`payment_records_provider_payment_id_key`). */
export async function findByPaymentId(
  provider: PaymentProviderId,
  paymentId: string,
): Promise<PaymentRecord | null> {
  const [row] = await db
    .select()
    .from(paymentRecords)
    .where(
      and(eq(paymentRecords.provider, provider), eq(paymentRecords.providerPaymentId, paymentId)),
    );
  return row ?? null;
}

/**
 * The record a provider payment belongs to: its own payment, else the record
 * of that provider that lists it as a top-up (`metadata.topUps`, GIN index
 * `idx_payment_records_top_ups`).
 */
export async function findByChargePaymentId(
  provider: PaymentProviderId,
  paymentId: string,
): Promise<PaymentRecord | null> {
  const own = await findByPaymentId(provider, paymentId);
  if (own != null) return own;
  const [row] = await db
    .select()
    .from(paymentRecords)
    .where(
      and(
        eq(paymentRecords.provider, provider),
        sql`${paymentRecords.metadata} -> 'topUps' @> ${JSON.stringify([{ paymentId }])}::jsonb`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Webhook: an open payment failed. Terminal records are left as they are (F8). */
export async function markOpenPaymentFailed(
  id: number,
  reason: string,
  /** The status the caller read: the audit row's `before`. */
  previousStatus: PaymentStatus,
  audit: PaymentAuditContext,
): Promise<boolean> {
  const moved = updated(
    await db
      .update(paymentRecords)
      .set({
        status: 'failed',
        failureReason: reason.slice(0, 500),
        ...NO_PENDING_OPERATION,
        updatedAt: new Date(),
      })
      .where(and(eq(paymentRecords.id, id), inArray(paymentRecords.status, FAILABLE)))
      .returning({ id: paymentRecords.id }),
  );
  if (moved) {
    await auditPayment(audit, id, 'failed', {
      before: { status: previousStatus },
      after: { status: 'failed', failureReason: reason.slice(0, 500) },
    });
  }
  return moved;
}

/** Records of the last `lookbackHours` with a provider payment, after `afterId`, for reconciliation. */
export async function recordsWithPayments(
  since: Date,
  afterId: number,
  limit: number,
): Promise<PaymentRecord[]> {
  return db
    .select()
    .from(paymentRecords)
    .where(
      and(
        sql`${paymentRecords.createdAt} >= ${since}`,
        sql`${paymentRecords.providerPaymentId} IS NOT NULL`,
        sql`${paymentRecords.id} > ${afterId}`,
      ),
    )
    .orderBy(paymentRecords.id)
    .limit(limit);
}

export interface GuestHoldRecordInput {
  sessionId: string;
  sitePaymentConfigId: number | null;
  provider: PaymentProviderId;
  paymentId: string;
  currency: string;
  preAuthAmountCents: number | null;
}

/** A guest checkout hold, linked to its charging session. Null when the session already has a record. */
export async function recordGuestHold(
  input: GuestHoldRecordInput,
  audit: PaymentAuditContext,
): Promise<number | null> {
  const [row] = await db
    .insert(paymentRecords)
    .values({
      sessionId: input.sessionId,
      driverId: null,
      sitePaymentConfigId: input.sitePaymentConfigId,
      ...providerIds(input.provider, { paymentId: input.paymentId }),
      paymentSource: 'guest',
      currency: input.currency,
      preAuthAmountCents: input.preAuthAmountCents,
      status: 'pre_authorized',
    })
    .onConflictDoNothing({ target: paymentRecords.sessionId })
    .returning({ id: paymentRecords.id });
  if (row == null) return null;
  await auditPayment(audit, row.id, 'pre_authorized', {
    before: null,
    after: {
      status: 'pre_authorized',
      sessionId: input.sessionId,
      provider: input.provider,
      paymentSource: 'guest',
      preAuthAmountCents: input.preAuthAmountCents,
      currency: input.currency,
    },
  });
  return row.id;
}

/**
 * A payment the station's terminal or the payment provider of an ad hoc
 * payment settled (OCPP 2.1 NotifySettlement): `ocpp_terminal`, captured, no
 * provider call. False when the session already has a record (a replay).
 */
export async function recordTerminalSettlement(
  input: {
    sessionId: string;
    driverId: string | null;
    currency: string;
    capturedCents: number;
  },
  audit: PaymentAuditContext,
): Promise<boolean> {
  const rows = await db
    .insert(paymentRecords)
    .values({
      sessionId: input.sessionId,
      driverId: input.driverId,
      paymentSource: 'ocpp_terminal',
      currency: input.currency,
      capturedAmountCents: input.capturedCents,
      status: 'captured',
    })
    .onConflictDoNothing({ target: paymentRecords.sessionId })
    .returning({ id: paymentRecords.id });
  const [row] = rows;
  if (row == null) return false;
  await auditPayment(audit, row.id, 'captured', {
    before: null,
    after: {
      status: 'captured',
      sessionId: input.sessionId,
      paymentSource: 'ocpp_terminal',
      capturedAmountCents: input.capturedCents,
      currency: input.currency,
    },
  });
  return true;
}

export interface PrepaidSettlementOptions {
  /**
   * The cost to debit instead of the session's stored final cost: the re-bill
   * of a session the CSMS gave up ending debits the recomputed cost before it
   * stores it on the session.
   */
  costCents?: number;
  /** Marks the record as the re-bill's (`metadata.rebill`). */
  rebill?: boolean;
}

export interface PrepaidSettlement {
  tokenId: string;
  debitedCents: number;
  balanceCents: number;
  /** Set when the debit was already recorded (a repeated settlement). */
  repeated?: true;
}

/**
 * Debits the final cost of an ended session from the prepaid balance of the
 * token that started it (OCPP 2.1 C17). The `payment_records` row (unique per
 * session, `payment_source = 'prepaid'`) is the idempotency marker, so a
 * replayed Ended event never debits twice. The balance may go below zero when
 * the final cost exceeds the remaining credit; the next Authorize then answers
 * NoCredit.
 *
 * When the session was already debited (a rerun after a lost connection, or a
 * replayed Ended), returns that debit from its record and the token's current
 * balance without debiting again, so the caller still reports it.
 *
 * Returns null when the session has no prepaid token, no cost, a currency other
 * than the company currency (the balance is held in the company currency), or
 * was already settled another way.
 */
export async function settlePrepaidSession(
  sessionId: string,
  audit: PaymentAuditContext,
  options: PrepaidSettlementOptions = {},
): Promise<PrepaidSettlement | null> {
  const logger = audit.logger;
  const [row] = await db
    .select({
      tokenId: driverTokens.id,
      tokenDriverId: driverTokens.driverId,
      balanceCents: driverTokens.prepaidBalanceCents,
      driverId: chargingSessions.driverId,
      finalCostCents: chargingSessions.finalCostCents,
      currency: sql<string>`upper(${chargingSessions.currency})`,
    })
    .from(chargingSessions)
    .innerJoin(driverTokens, eq(driverTokens.id, chargingSessions.tokenId))
    .where(eq(chargingSessions.id, sessionId));

  if (row?.balanceCents == null) return null;
  const costCents = options.costCents ?? row.finalCostCents ?? 0;
  if (costCents <= 0) return null;

  const companyCurrency = await getCompanyCurrency();
  if (row.currency !== companyCurrency) {
    logger.warn(
      { sessionId, sessionCurrency: row.currency, companyCurrency },
      'Prepaid session billed in another currency than the company currency; balance not debited',
    );
    return null;
  }

  const result = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(paymentRecords)
      .values({
        sessionId,
        driverId: row.driverId ?? row.tokenDriverId,
        paymentSource: 'prepaid',
        currency: row.currency,
        capturedAmountCents: costCents,
        status: 'captured',
        metadata: {
          tokenId: row.tokenId,
          ...(options.rebill === true ? { rebill: { requestedAt: new Date().toISOString() } } : {}),
        },
      })
      .onConflictDoNothing({ target: paymentRecords.sessionId })
      .returning({ id: paymentRecords.id });
    if (inserted.length === 0) {
      // Already settled: report the prepaid debit already recorded.
      const [existing] = await tx
        .select({
          capturedCents: paymentRecords.capturedAmountCents,
          source: paymentRecords.paymentSource,
          status: paymentRecords.status,
        })
        .from(paymentRecords)
        .where(eq(paymentRecords.sessionId, sessionId));
      // Only a debit still standing is reported; a refunded or partially
      // refunded one is not.
      if (
        existing?.source !== 'prepaid' ||
        existing.status !== 'captured' ||
        existing.capturedCents == null
      ) {
        return null;
      }
      const [token] = await tx
        .select({ balanceCents: driverTokens.prepaidBalanceCents })
        .from(driverTokens)
        .where(eq(driverTokens.id, row.tokenId));
      if (token?.balanceCents == null) return null;
      return {
        kind: 'existing' as const,
        debitedCents: existing.capturedCents,
        after: token.balanceCents,
      };
    }

    const [updated] = await tx
      .update(driverTokens)
      .set({
        prepaidBalanceCents: sql`${driverTokens.prepaidBalanceCents} - ${costCents}`,
        updatedAt: new Date(),
      })
      .where(eq(driverTokens.id, row.tokenId))
      .returning({ balanceCents: driverTokens.prepaidBalanceCents });
    if (updated?.balanceCents == null) return null;
    return {
      kind: 'debited' as const,
      recordId: inserted[0]?.id ?? null,
      before: updated.balanceCents + costCents,
      after: updated.balanceCents,
    };
  });
  if (result == null) return null;
  if (result.kind === 'existing') {
    return {
      tokenId: row.tokenId,
      debitedCents: result.debitedCents,
      balanceCents: result.after,
      repeated: true,
    };
  }

  if (result.recordId != null) {
    await auditPayment(audit, result.recordId, 'captured', {
      before: null,
      after: {
        status: 'captured',
        sessionId,
        paymentSource: 'prepaid',
        capturedAmountCents: costCents,
        currency: row.currency,
        tokenId: row.tokenId,
      },
      notes: options.rebill === true ? 'Session re-bill prepaid debit' : null,
    });
  }
  await writeAudit(
    { table: tokenAuditLog, idColumn: 'token_id' },
    {
      entityId: row.tokenId,
      entityIdSnapshot: row.tokenId,
      action: 'updated',
      actor: 'system',
      actorLabel: 'prepaid_debit',
      before: { prepaidBalanceCents: result.before },
      after: { prepaidBalanceCents: result.after },
      notes: `Prepaid debit of ${String(costCents)} for session ${sessionId}`,
    },
    db,
    auditActorOf(audit).logger,
  );

  return { tokenId: row.tokenId, debitedCents: costCents, balanceCents: result.after };
}
