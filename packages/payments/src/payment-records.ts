// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  chargingSessions,
  db,
  driverTokens,
  getCompanyCurrency,
  paymentRecords,
  tokenAuditLog,
  writeAudit,
} from '@evtivity/database';
import type {
  PaymentChargeType,
  PendingPaymentOperation,
  ProviderRefundEntry,
} from '@evtivity/database';
import type { PaymentLogger } from './context.js';
import { stripeColumnValue } from './legacy-columns.js';
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
 * Provider ids go into the `provider*` columns and, for Stripe and simulated
 * payments, into the matching `stripe_*` column too (P4 dual write, see
 * `legacy-columns.ts`). Reads use only the `provider*` columns.
 */

export type PaymentRecord = typeof paymentRecords.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

const FROM_PENDING: PaymentStatus[] = ['pending'];
const FROM_HOLD: PaymentStatus[] = ['pre_authorized'];
const REFUNDABLE: PaymentStatus[] = ['captured', 'partially_refunded'];
/** A webhook failure moves only an open payment (F8). */
const FAILABLE: PaymentStatus[] = ['pending', 'pre_authorized'];

export type PaymentSource = 'web_portal' | 'guest' | 'prepaid' | 'ocpp_terminal';

/** The provider columns of a record and their `stripe_*` copies. */
function providerIds(
  provider: PaymentProviderId,
  ids: { paymentId?: string | null; customerId?: string | null; methodId?: string | null },
): Partial<typeof paymentRecords.$inferInsert> {
  return {
    provider,
    ...(ids.paymentId !== undefined
      ? {
          providerPaymentId: ids.paymentId,
          stripePaymentIntentId: stripeColumnValue(provider, ids.paymentId),
        }
      : {}),
    ...(ids.customerId !== undefined
      ? {
          providerCustomerId: ids.customerId,
          stripeCustomerId: stripeColumnValue(provider, ids.customerId),
        }
      : {}),
    ...(ids.methodId !== undefined
      ? {
          providerPaymentMethodId: ids.methodId,
          stripePaymentMethodId: stripeColumnValue(provider, ids.methodId),
        }
      : {}),
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
export async function recordHold(input: HoldRecordInput): Promise<number | null> {
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
  return row?.id ?? null;
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
export async function recordFailedHold(input: FailedHoldInput): Promise<number | null> {
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
  return row?.id ?? null;
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
): Promise<boolean> {
  const topUp = input.topUp ?? null;
  const authorizedCents = input.authorizedCents ?? null;
  return updated(
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
  pendingRef: string | null = null,
): Promise<boolean> {
  return updated(
    await db
      .update(paymentRecords)
      .set({
        status: 'cancelled',
        capturedAmountCents: 0,
        ...pendingFields('cancel', pendingRef),
        updatedAt: new Date(),
      })
      .where(and(eq(paymentRecords.id, id), inArray(paymentRecords.status, FROM_HOLD)))
      .returning({ id: paymentRecords.id }),
  );
}

/** pre_authorized -> failed (a capture that failed, or a hold given up on). */
export async function markHoldFailed(id: number, reason: string): Promise<boolean> {
  return updated(
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
  },
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
  return row ?? null;
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
  return row ?? null;
}

/**
 * pre_authorized -> cancelled without a request of ours: the provider expired
 * or cancelled the authorisation (Adyen EXPIRE, TECHNICAL_CANCEL, a cancel in
 * its dashboard). A pending cancel of ours is cleared instead when the record
 * is already cancelled, because the authorisation is gone either way.
 */
export async function markAuthorisationEnded(id: number, reason: string): Promise<boolean> {
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
  if (moved.length > 0) return true;
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
): Promise<RefundSettlement> {
  return db.transaction(async (tx): Promise<RefundSettlement> => {
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
    return { status: 'applied', record: row, entry };
  });
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
  },
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
  return row ?? null;
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
}

/**
 * A reservation fee before it is charged. Unique per reservation and fee
 * type, so a retry or a concurrent call gets null and charges nothing (P7).
 */
export async function recordPendingCharge(input: PendingChargeInput): Promise<number | null> {
  const [row] = await db
    .insert(paymentRecords)
    .values({
      chargeType: input.chargeType,
      reservationId: input.reservationId,
      driverId: input.driverId,
      sitePaymentConfigId: input.sitePaymentConfigId,
      ...providerIds(input.provider, { customerId: input.customerId, methodId: input.methodId }),
      paymentSource: 'web_portal',
      currency: input.currency,
      taxRate: String(input.taxRate),
      status: 'pending',
    })
    .onConflictDoNothing({
      target: [paymentRecords.reservationId, paymentRecords.chargeType],
      where: sql`${paymentRecords.reservationId} IS NOT NULL`,
    })
    .returning({ id: paymentRecords.id });
  return row?.id ?? null;
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
): Promise<boolean> {
  return updated(
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
}

/** pending -> failed (an immediate charge was declined). */
export async function markChargeFailed(id: number, reason: string): Promise<boolean> {
  return updated(
    await db
      .update(paymentRecords)
      .set({ status: 'failed', failureReason: reason.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(paymentRecords.id, id), inArray(paymentRecords.status, FROM_PENDING)))
      .returning({ id: paymentRecords.id }),
  );
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
export async function markOpenPaymentFailed(id: number, reason: string): Promise<boolean> {
  return updated(
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
export async function recordGuestHold(input: GuestHoldRecordInput): Promise<number | null> {
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
  return row?.id ?? null;
}

/**
 * A payment the station's terminal or the payment provider of an ad hoc
 * payment settled (OCPP 2.1 NotifySettlement): `ocpp_terminal`, captured, no
 * provider call. False when the session already has a record (a replay).
 */
export async function recordTerminalSettlement(input: {
  sessionId: string;
  driverId: string | null;
  currency: string;
  capturedCents: number;
}): Promise<boolean> {
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
  return rows.length > 0;
}

export interface PrepaidSettlement {
  tokenId: string;
  debitedCents: number;
  balanceCents: number;
}

/**
 * Debits the final cost of an ended session from the prepaid balance of the
 * token that started it (OCPP 2.1 C17). The `payment_records` row (unique per
 * session, `payment_source = 'prepaid'`) is the idempotency marker, so a
 * replayed Ended event never debits twice. The balance may go below zero when
 * the final cost exceeds the remaining credit; the next Authorize then answers
 * NoCredit.
 *
 * Returns null when the session has no prepaid token, no cost, a currency other
 * than the company currency (the balance is held in the company currency), or
 * was already settled.
 */
export async function settlePrepaidSession(
  sessionId: string,
  logger?: PaymentLogger,
): Promise<PrepaidSettlement | null> {
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
  const costCents = row.finalCostCents ?? 0;
  if (costCents <= 0) return null;

  const companyCurrency = await getCompanyCurrency();
  if (row.currency !== companyCurrency) {
    logger?.warn(
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
        metadata: { tokenId: row.tokenId },
      })
      .onConflictDoNothing({ target: paymentRecords.sessionId })
      .returning({ id: paymentRecords.id });
    if (inserted.length === 0) return null;

    const [updated] = await tx
      .update(driverTokens)
      .set({
        prepaidBalanceCents: sql`${driverTokens.prepaidBalanceCents} - ${costCents}`,
        updatedAt: new Date(),
      })
      .where(eq(driverTokens.id, row.tokenId))
      .returning({ balanceCents: driverTokens.prepaidBalanceCents });
    if (updated?.balanceCents == null) return null;
    return { before: updated.balanceCents + costCents, after: updated.balanceCents };
  });
  if (result == null) return null;

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
    logger != null
      ? {
          warn: (obj: unknown, msg?: string) => {
            logger.warn(typeof obj === 'object' && obj != null ? obj : { detail: obj }, msg);
          },
        }
      : undefined,
  );

  return { tokenId: row.tokenId, debitedCents: costCents, balanceCents: result.after };
}
