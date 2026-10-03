// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
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
import type { PaymentChargeType } from '@evtivity/database';
import type { PaymentLogger } from './context.js';
import type { TopUpCharge } from './top-ups.js';
import type { PaymentStatus } from './types.js';

/**
 * The only writer of `payment_records` (design principle P3). Every status
 * change names the statuses it may leave (P5), so a later, weaker event never
 * overwrites a stronger one:
 *
 * - `pending` -> `pre_authorized` | `captured` | `failed`
 * - `pre_authorized` -> `captured` | `cancelled` | `failed`
 * - `captured` | `partially_refunded` -> `partially_refunded` | `refunded`
 *
 * Each update returns whether it applied; a false means the record had
 * already moved on (or does not exist), and the caller logs it.
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

export interface HoldRecordInput {
  sessionId: string;
  driverId: string | null;
  sitePaymentConfigId: number | null;
  paymentId: string;
  customerId: string | null;
  methodId: string | null;
  source: PaymentSource;
  currency: string;
  preAuthAmountCents: number;
}

/** A placed hold. Null when the session already has a record (unique per session). */
export async function recordHold(input: HoldRecordInput): Promise<number | null> {
  const [row] = await db
    .insert(paymentRecords)
    .values({
      sessionId: input.sessionId,
      driverId: input.driverId,
      sitePaymentConfigId: input.sitePaymentConfigId,
      stripePaymentIntentId: input.paymentId,
      stripeCustomerId: input.customerId,
      stripePaymentMethodId: input.methodId,
      paymentSource: input.source,
      currency: input.currency,
      preAuthAmountCents: input.preAuthAmountCents,
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
      stripeCustomerId: input.customerId,
      stripePaymentMethodId: input.methodId,
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
 * the settlement top-up, recorded in `metadata.topUps`.
 */
export async function markCaptured(
  id: number,
  input: {
    capturedCents: number;
    failureReason: string | null;
    topUp?: { paymentId: string; amountCents: number } | null;
  },
): Promise<boolean> {
  const topUp = input.topUp ?? null;
  return updated(
    await db
      .update(paymentRecords)
      .set({
        status: 'captured',
        capturedAmountCents: input.capturedCents,
        failureReason: input.failureReason,
        ...(topUp != null ? { metadata: appendTopUp(topUp) } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(paymentRecords.id, id), inArray(paymentRecords.status, FROM_HOLD)))
      .returning({ id: paymentRecords.id }),
  );
}

/** pre_authorized -> cancelled (nothing captured). */
export async function markCancelled(id: number): Promise<boolean> {
  return updated(
    await db
      .update(paymentRecords)
      .set({ status: 'cancelled', capturedAmountCents: 0, updatedAt: new Date() })
      .where(and(eq(paymentRecords.id, id), inArray(paymentRecords.status, FROM_HOLD)))
      .returning({ id: paymentRecords.id }),
  );
}

/** pre_authorized -> failed (a capture that failed, or a hold given up on). */
export async function markHoldFailed(id: number, reason: string): Promise<boolean> {
  return updated(
    await db
      .update(paymentRecords)
      .set({ status: 'failed', failureReason: reason.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(paymentRecords.id, id), inArray(paymentRecords.status, FROM_HOLD)))
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
 * top-ups); a legacy `topUpIntentId` is dropped then, as `topUps` holds it.
 */
export async function markRefunded(
  id: number,
  input: {
    refundedTotalCents: number;
    full: boolean;
    actorUserId?: string | null;
    actionReason?: string | null;
    topUps?: TopUpCharge[];
  },
  executor: Executor = db,
): Promise<PaymentRecord | null> {
  const [row] = await executor
    .update(paymentRecords)
    .set({
      status: input.full ? 'refunded' : 'partially_refunded',
      refundedAmountCents: input.refundedTotalCents,
      ...(input.topUps != null
        ? {
            metadata: sql`jsonb_set(COALESCE(${paymentRecords.metadata}, '{}'::jsonb) - 'topUpIntentId', '{topUps}', ${JSON.stringify(input.topUps)}::jsonb)`,
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
      stripeCustomerId: input.customerId,
      stripePaymentMethodId: input.methodId,
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
  input: { paymentId: string; amountCents: number },
): Promise<boolean> {
  return updated(
    await db
      .update(paymentRecords)
      .set({
        status: 'captured',
        stripePaymentIntentId: input.paymentId,
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

export async function findByPaymentId(paymentId: string): Promise<PaymentRecord | null> {
  const [row] = await db
    .select()
    .from(paymentRecords)
    .where(eq(paymentRecords.stripePaymentIntentId, paymentId));
  return row ?? null;
}

/**
 * The record a provider payment belongs to: its own payment, else the record
 * that lists it as a top-up (`metadata.topUps`, or a legacy `topUpIntentId`).
 */
export async function findByChargePaymentId(paymentId: string): Promise<PaymentRecord | null> {
  const own = await findByPaymentId(paymentId);
  if (own != null) return own;
  const [row] = await db
    .select()
    .from(paymentRecords)
    .where(
      or(
        sql`${paymentRecords.metadata} -> 'topUps' @> ${JSON.stringify([{ paymentId }])}::jsonb`,
        sql`${paymentRecords.metadata} ->> 'topUpIntentId' = ${paymentId}`,
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
      .set({ status: 'failed', failureReason: reason.slice(0, 500), updatedAt: new Date() })
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
        sql`${paymentRecords.stripePaymentIntentId} IS NOT NULL`,
        sql`${paymentRecords.stripePaymentIntentId} <> ''`,
        sql`${paymentRecords.id} > ${afterId}`,
      ),
    )
    .orderBy(paymentRecords.id)
    .limit(limit);
}

export interface GuestHoldRecordInput {
  sessionId: string;
  sitePaymentConfigId: number | null;
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
      stripePaymentIntentId: input.paymentId,
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
