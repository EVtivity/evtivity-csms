// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Card payments at a payment terminal (features/payment-terminals.md). The
// only caller of a terminal provider's money operations and the only writer of
// `payment_terminal_transactions` (P3, guard test
// `terminal-transaction-writer-guard.test.ts`); it writes `payment_records`
// through payment-records.ts. Every provider call is preceded by a row in a
// known intermediate state (P4), every UPDATE names its from-states (P5), and
// every key comes from a globally unique id (P7). Starting the charging
// transaction, prompts and notices are the caller's (services).

import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import {
  chargingSessions,
  db,
  getCompanyCurrency,
  guestSessions,
  paymentTerminals,
  paymentTerminalTransactions,
  webhookEvents,
} from '@evtivity/database';
import {
  isTerminalAmount,
  isTerminalProviderId,
  TerminalProviderError,
  type PaymentTerminalProvider,
  type PaymentTerminalRegistry,
  type TerminalEvent,
  type TerminalProviderId,
  type TerminalTxnResult,
} from '@evtivity/payment-terminals';
import {
  PAYMENT_TERMINAL_CARD_TIMEOUT_SECONDS,
  PAYMENT_TERMINAL_DEFAULT_HOLD_CENTS,
} from '@evtivity/lib';
import type { PaymentContext } from './context.js';
import { WebhookNotConfiguredError } from './errors.js';
import {
  terminalAuthKey,
  terminalCaptureKey,
  terminalRefundKey,
  terminalVoidKey,
} from './idempotency-keys.js';
import {
  addPendingRefunds,
  markRefunded,
  recordTerminalCapture,
  settleRefund,
} from './payment-records.js';
import type { PaymentRecord } from './payment-records.js';
import type { RefundOutcome, RefundRequest } from './refunds.js';
import { holdTerms } from './session-payments.js';
import { withWebhookEventLock } from './webhooks.js';

export type TerminalTransaction = typeof paymentTerminalTransactions.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A stale claim older than this is resumed by the reconciliation. */
export const TERMINAL_CLAIM_STALE_MS = 2 * 60_000;
/** An authorized hold whose charging never started is voided after this. */
export const TERMINAL_UNSTARTED_HOLD_MS = 2 * 60_000;
/** An ended session whose hold is still authorized is settled by the reconciliation after this. */
export const TERMINAL_ENDED_SETTLE_DELAY_MS = 10 * 60_000;

/** The registry of the context, or a loud failure: a terminal operation outside a terminal process is a bug. */
export function terminalRegistry(ctx: PaymentContext): PaymentTerminalRegistry {
  if (ctx.terminals == null) {
    throw new Error('This process has no payment terminal registry');
  }
  return ctx.terminals;
}

async function providerOf(
  ctx: PaymentContext,
  id: string,
): Promise<PaymentTerminalProvider | null> {
  if (!isTerminalProviderId(id)) return null;
  return terminalRegistry(ctx).getProvider(id);
}

async function readTxn(
  id: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<TerminalTransaction | null> {
  const [row] = await executor
    .select()
    .from(paymentTerminalTransactions)
    .where(eq(paymentTerminalTransactions.id, id));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export interface StartTerminalPaymentInput {
  terminalId: string;
  /** Operator override (a test payment); default the site or company hold amount. */
  amountCents?: number;
  /** The receipt address the driver gave, if any. */
  receiptEmail?: string | null;
  /** The OCPP EVSE ids a station-wide terminal offers (empty: paired to one EVSE). */
  evseChoices: readonly number[];
  /** The OCPP EVSE id of a terminal paired to one connector, else null. */
  evseNumber: number | null;
}

export type StartTerminalPaymentOutcome =
  | { kind: 'started'; transaction: TerminalTransaction }
  | { kind: 'not_found' }
  | { kind: 'inactive' }
  | { kind: 'not_paired' }
  | { kind: 'hardware' }
  | { kind: 'busy' }
  | { kind: 'invalid_amount' }
  | { kind: 'not_configured'; provider: string }
  | { kind: 'provider_error'; error: TerminalProviderError; transaction: TerminalTransaction };

/**
 * Opens a hold on the terminal: the transaction row first (`requested`, with
 * the site, station and EVSE of the pairing stamped), then the provider call
 * keyed by the row id. One open payment per device: a terminal with a
 * payment `requested` or `presenting` answers `busy`. A provider failure whose
 * outcome is unknown (timeout, 5xx) leaves the row `requested` for the
 * reconciliation (never a second start with a new key); a refusal fails it.
 */
export async function startTerminalPayment(
  input: StartTerminalPaymentInput,
  ctx: PaymentContext,
): Promise<StartTerminalPaymentOutcome> {
  const prepared = await db.transaction(async (tx) => {
    const [terminal] = await tx
      .select()
      .from(paymentTerminals)
      .where(eq(paymentTerminals.id, input.terminalId))
      .for('update');
    if (terminal == null) return { kind: 'not_found' as const };
    if (terminal.status !== 'active') return { kind: 'inactive' as const };
    if (terminal.integrationMode !== 'cloud') return { kind: 'hardware' as const };
    if (terminal.stationId == null || terminal.providerDeviceId == null) {
      return { kind: 'not_paired' as const };
    }
    const [open] = await tx
      .select({ id: paymentTerminalTransactions.id })
      .from(paymentTerminalTransactions)
      .where(
        and(
          eq(paymentTerminalTransactions.paymentTerminalId, terminal.id),
          inArray(paymentTerminalTransactions.state, ['requested', 'presenting']),
        ),
      )
      .limit(1);
    if (open != null) return { kind: 'busy' as const };
    // The site's hold amount (the payout account is not involved: the
    // operator's own merchant account at the gateway takes the money).
    const siteHold = (await holdTerms(ctx, terminal.siteId)).preAuthAmountCents;
    const amount =
      input.amountCents ?? (siteHold > 0 ? siteHold : PAYMENT_TERMINAL_DEFAULT_HOLD_CENTS);
    if (!isTerminalAmount(amount)) return { kind: 'invalid_amount' as const };
    const currency = (await getCompanyCurrency()).toUpperCase();
    const now = new Date();
    const [row] = await tx
      .insert(paymentTerminalTransactions)
      .values({
        paymentTerminalId: terminal.id,
        provider: terminal.provider,
        siteId: terminal.siteId,
        stationId: terminal.stationId,
        evseNumber: input.evseNumber,
        state: 'requested',
        currency,
        requestedCents: amount,
        receiptEmail: input.receiptEmail ?? null,
        requestedAt: now,
        expiresAt: new Date(now.getTime() + (PAYMENT_TERMINAL_CARD_TIMEOUT_SECONDS + 120) * 1000),
      })
      .returning();
    if (row == null) throw new Error('Terminal transaction insert returned no row');
    return { kind: 'ready' as const, row, deviceId: terminal.providerDeviceId };
  });
  if (prepared.kind !== 'ready') return prepared;
  const { row, deviceId } = prepared;
  const provider = await providerOf(ctx, row.provider);
  if (provider == null) {
    await failTxn(row.id, ['requested'], 'provider_not_configured');
    return { kind: 'not_configured', provider: row.provider };
  }
  let result: TerminalTxnResult;
  try {
    result = await provider.startPayment({
      providerDeviceId: deviceId,
      amountCents: row.requestedCents,
      currency: row.currency,
      idempotencyKey: terminalAuthKey(row.id),
      reference: row.id,
      timeoutSeconds: PAYMENT_TERMINAL_CARD_TIMEOUT_SECONDS,
      evseChoices: input.evseChoices,
    });
  } catch (err: unknown) {
    const error =
      err instanceof TerminalProviderError
        ? err
        : new TerminalProviderError('unavailable', 'The terminal provider call failed', {
            cause: err,
          });
    if (!error.retryable && error.kind !== 'unavailable') {
      await failTxn(row.id, ['requested'], `start_${error.kind}`);
    } else {
      ctx.logger.warn(
        { terminalTransactionId: row.id, kind: error.kind },
        'Terminal payment start outcome unknown; the reconciliation looks it up',
      );
    }
    return { kind: 'provider_error', error, transaction: (await readTxn(row.id)) ?? row };
  }
  const applied = await applyTerminalTxnResult(row.id, result, ctx);
  return { kind: 'started', transaction: applied.transaction ?? row };
}

async function failTxn(
  id: string,
  from: TerminalTransaction['state'][],
  reason: string,
  executor: Pick<typeof db, 'update'> = db,
): Promise<boolean> {
  const rows = await executor
    .update(paymentTerminalTransactions)
    .set({ state: 'failed', failureReason: reason.slice(0, 500), updatedAt: new Date() })
    .where(
      and(eq(paymentTerminalTransactions.id, id), inArray(paymentTerminalTransactions.state, from)),
    )
    .returning({ id: paymentTerminalTransactions.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Provider results (call answers, webhooks, the reconciliation)
// ---------------------------------------------------------------------------

export type TerminalTransition =
  | 'presenting'
  | 'authorized'
  | 'declined'
  | 'expired'
  | 'failed'
  | 'voided'
  | 'captured'
  /** An authorization for a row that had already ended: voided at the provider (P5). */
  | 'late_void'
  | 'none';

export interface AppliedTerminalResult {
  transition: TerminalTransition;
  transaction: TerminalTransaction | null;
}

/**
 * Applies a provider answer with compare-and-set (P5). An authorization is
 * accepted only for 1 cent up to the requested hold, in the row's currency
 * (case 102 and 106 rules); anything else is failed and voided. An
 * authorization for a row that already ended (voided, expired, failed,
 * declined) never revives it: the hold is voided at the provider.
 */
export async function applyTerminalTxnResult(
  txnId: string,
  result: TerminalTxnResult,
  ctx: PaymentContext,
): Promise<AppliedTerminalResult> {
  const row = await readTxn(txnId);
  if (row == null) return { transition: 'none', transaction: null };
  if (row.providerTxnRef != null && row.providerTxnRef !== result.providerTxnRef) {
    ctx.logger.error(
      { terminalTransactionId: txnId },
      'Terminal provider answered with another transaction reference; ignored',
    );
    return { transition: 'none', transaction: row };
  }
  if (result.currency != null && result.currency !== row.currency) {
    ctx.logger.error(
      { terminalTransactionId: txnId, currency: result.currency, expected: row.currency },
      'Terminal provider answered in another currency; nothing changed',
    );
    return { transition: 'none', transaction: row };
  }
  const now = new Date();
  const ref = result.providerTxnRef;
  const guard = (states: TerminalTransaction['state'][]) =>
    and(
      eq(paymentTerminalTransactions.id, txnId),
      inArray(paymentTerminalTransactions.state, states),
    );
  const set = async (
    states: TerminalTransaction['state'][],
    values: Partial<typeof paymentTerminalTransactions.$inferInsert>,
  ): Promise<TerminalTransaction | null> => {
    const [updated] = await db
      .update(paymentTerminalTransactions)
      .set({ providerTxnRef: ref, updatedAt: now, ...values })
      .where(guard(states))
      .returning();
    return updated ?? null;
  };
  switch (result.state) {
    case 'presenting': {
      const updated = await set(['requested'], { state: 'presenting' });
      return { transition: updated != null ? 'presenting' : 'none', transaction: updated ?? row };
    }
    case 'authorized': {
      const authorized = result.authorizedCents ?? row.requestedCents;
      if (!isTerminalAmount(authorized) || authorized > row.requestedCents) {
        ctx.logger.error(
          { terminalTransactionId: txnId, authorized, requested: row.requestedCents },
          'Terminal authorized an amount outside the hold; voiding it',
        );
        await set(['requested', 'presenting'], {
          state: 'void_requested',
          failureReason: 'authorized_amount_out_of_range',
          pendingOperationAt: now,
        });
        const voided = await voidTerminalTransaction(txnId, 'authorized_amount_out_of_range', ctx);
        return { transition: 'late_void', transaction: voided.transaction };
      }
      const updated = await set(['requested', 'presenting'], {
        state: 'authorized',
        authorizedCents: authorized,
        authorizedAt: now,
        cardLast4: result.cardLast4,
        cardBin: result.cardBin,
        cardBrand: result.cardBrand,
        ...(row.evseNumber == null && result.evseId != null ? { evseNumber: result.evseId } : {}),
        ...(result.receiptUrl != null ? { receiptUrl: result.receiptUrl } : {}),
      });
      if (updated != null) return { transition: 'authorized', transaction: updated };
      const current = (await readTxn(txnId)) ?? row;
      if (['voided', 'expired', 'failed', 'declined'].includes(current.state)) {
        ctx.logger.warn(
          { terminalTransactionId: txnId, state: current.state },
          'Terminal authorization arrived after the payment ended; voiding the hold',
        );
        await voidAtProvider(current.provider, ref, ctx);
        return { transition: 'late_void', transaction: current };
      }
      return { transition: 'none', transaction: current };
    }
    case 'declined': {
      const updated = await set(['requested', 'presenting'], {
        state: 'declined',
        declineCode: result.declineCode,
      });
      return { transition: updated != null ? 'declined' : 'none', transaction: updated ?? row };
    }
    case 'expired': {
      const updated = await set(['requested', 'presenting', 'authorized'], { state: 'expired' });
      return { transition: updated != null ? 'expired' : 'none', transaction: updated ?? row };
    }
    case 'failed': {
      const updated = await set(['requested', 'presenting'], {
        state: 'failed',
        failureReason: 'provider_failed',
      });
      return { transition: updated != null ? 'failed' : 'none', transaction: updated ?? row };
    }
    case 'voided': {
      const updated = await set(['void_requested', 'authorized', 'presenting', 'requested'], {
        state: 'voided',
        voidedAt: now,
      });
      return { transition: updated != null ? 'voided' : 'none', transaction: updated ?? row };
    }
    case 'captured': {
      // An async capture confirmed later; the capture path records it.
      if (row.state !== 'capture_requested') return { transition: 'none', transaction: row };
      const amount = Math.min(result.capturedCents ?? 0, row.authorizedCents ?? 0);
      const captured = await finishCapture(row, amount, result.receiptUrl, ctx);
      return { transition: captured != null ? 'captured' : 'none', transaction: captured ?? row };
    }
    default:
      return { transition: 'none', transaction: row };
  }
}

/** Voids a provider reference with the void key, for a hold no row tracks any more. Fail-open (warn). */
async function voidAtProvider(provider: string, ref: string, ctx: PaymentContext): Promise<void> {
  try {
    const p = await providerOf(ctx, provider);
    await p?.void(ref, terminalVoidKey(ref));
  } catch (err: unknown) {
    ctx.logger.warn({ err, provider }, 'Void of a late terminal authorization failed');
  }
}

// ---------------------------------------------------------------------------
// Charging link
// ---------------------------------------------------------------------------

/**
 * Claims the start of charging for an authorized hold, so the call answer
 * and a webhook (or two webhook deliveries) never both send
 * RequestStartTransaction. A claim older than two minutes (its owner died)
 * may be taken again. Null when another start owns it or the hold is gone.
 */
export async function claimTerminalStart(
  txnId: string,
  now: Date = new Date(),
): Promise<TerminalTransaction | null> {
  const [row] = await db
    .update(paymentTerminalTransactions)
    .set({ pendingOperationRef: 'start', pendingOperationAt: now, updatedAt: now })
    .where(
      and(
        eq(paymentTerminalTransactions.id, txnId),
        eq(paymentTerminalTransactions.state, 'authorized'),
        isNull(paymentTerminalTransactions.guestSessionId),
        or(
          isNull(paymentTerminalTransactions.pendingOperationRef),
          lt(
            paymentTerminalTransactions.pendingOperationAt,
            new Date(now.getTime() - TERMINAL_CLAIM_STALE_MS),
          ),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

/** Stores the guest session the start created and ends the start claim; only an authorized row without one. */
export async function linkTerminalGuestSession(
  txnId: string,
  guestSessionId: number,
  evseNumber: number,
): Promise<boolean> {
  const rows = await db
    .update(paymentTerminalTransactions)
    .set({
      guestSessionId,
      evseNumber,
      pendingOperationRef: null,
      pendingOperationAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paymentTerminalTransactions.id, txnId),
        eq(paymentTerminalTransactions.state, 'authorized'),
        isNull(paymentTerminalTransactions.guestSessionId),
      ),
    )
    .returning({ id: paymentTerminalTransactions.id });
  return rows.length > 0;
}

/**
 * The terminal transaction of a guest session, for the Started gate and the
 * cost ceiling: the authorized amount when the hold is `authorized`, null when
 * the guest session has no terminal transaction (a third-party kiosk through
 * POST /v1/ad-hoc-payments). `held: false` means the transaction exists but no
 * longer holds money (the gate stops the session).
 */
export async function terminalHoldOfGuestSession(
  guestSessionId: number,
): Promise<{ held: boolean; authorizedCents: number | null } | null> {
  const [row] = await db
    .select({
      state: paymentTerminalTransactions.state,
      authorizedCents: paymentTerminalTransactions.authorizedCents,
    })
    .from(paymentTerminalTransactions)
    .where(eq(paymentTerminalTransactions.guestSessionId, guestSessionId));
  if (row == null) return null;
  return { held: row.state === 'authorized', authorizedCents: row.authorizedCents };
}

/** Stamps the charging session on the transaction of its guest session (the Started projection). */
export async function linkTerminalSession(
  guestSessionId: number,
  sessionId: string,
): Promise<void> {
  await db
    .update(paymentTerminalTransactions)
    .set({ sessionId, updatedAt: new Date() })
    .where(
      and(
        eq(paymentTerminalTransactions.guestSessionId, guestSessionId),
        isNull(paymentTerminalTransactions.sessionId),
      ),
    );
}

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

/**
 * Releases a hold: `void_requested` first (P4), then the provider void keyed
 * by the reference. A row without a reference yet (the start never answered)
 * expires without a call. An unknown outcome stays `void_requested` for the
 * reconciliation; a refusal fails the row with the kind.
 */
export async function voidTerminalTransaction(
  txnId: string,
  reason: string,
  ctx: PaymentContext,
): Promise<AppliedTerminalResult> {
  const now = new Date();
  const [noRef] = await db
    .update(paymentTerminalTransactions)
    .set({ state: 'expired', failureReason: reason.slice(0, 500), updatedAt: now })
    .where(
      and(
        eq(paymentTerminalTransactions.id, txnId),
        inArray(paymentTerminalTransactions.state, ['requested', 'presenting']),
        isNull(paymentTerminalTransactions.providerTxnRef),
      ),
    )
    .returning();
  if (noRef != null) return { transition: 'expired', transaction: noRef };
  await db
    .update(paymentTerminalTransactions)
    .set({
      state: 'void_requested',
      failureReason: reason.slice(0, 500),
      pendingOperationAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(paymentTerminalTransactions.id, txnId),
        inArray(paymentTerminalTransactions.state, ['requested', 'presenting', 'authorized']),
      ),
    );
  const row = await readTxn(txnId);
  if (row?.state !== 'void_requested' || row.providerTxnRef == null) {
    return { transition: 'none', transaction: row };
  }
  const provider = await providerOf(ctx, row.provider);
  if (provider == null) {
    ctx.logger.error(
      { terminalTransactionId: txnId },
      'Terminal void without a configured provider; retried',
    );
    return { transition: 'none', transaction: row };
  }
  try {
    const result = await provider.void(row.providerTxnRef, terminalVoidKey(row.providerTxnRef));
    if (result.state === 'voided' || result.state === 'expired') {
      const [voided] = await db
        .update(paymentTerminalTransactions)
        .set({ state: 'voided', voidedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(paymentTerminalTransactions.id, txnId),
            eq(paymentTerminalTransactions.state, 'void_requested'),
          ),
        )
        .returning();
      return { transition: 'voided', transaction: voided ?? row };
    }
    return { transition: 'none', transaction: row };
  } catch (err: unknown) {
    const kind = err instanceof TerminalProviderError ? err.kind : 'unavailable';
    if (kind === 'not_found') {
      await failTxn(txnId, ['void_requested'], 'void_not_found');
    } else {
      ctx.logger.warn(
        { err, terminalTransactionId: txnId },
        'Terminal void failed; the reconciliation retries it',
      );
    }
    return { transition: 'none', transaction: await readTxn(txnId) };
  }
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export type TerminalSettlementOutcome =
  | { kind: 'none' }
  | { kind: 'not_ended' }
  | {
      kind: 'captured';
      transaction: TerminalTransaction;
      capturedCents: number;
      paymentRecordId: number;
    }
  | { kind: 'voided'; transaction: TerminalTransaction | null }
  | { kind: 'pending'; transaction: TerminalTransaction }
  | { kind: 'failed'; transaction: TerminalTransaction | null; reason: string };

/** The terminal transaction of a session: linked by session id, else through its guest session. */
export async function terminalTransactionOfSession(
  sessionId: string,
): Promise<TerminalTransaction | null> {
  const [direct] = await db
    .select()
    .from(paymentTerminalTransactions)
    .where(eq(paymentTerminalTransactions.sessionId, sessionId));
  if (direct != null) return direct;
  const [viaGuest] = await db
    .select({ txn: paymentTerminalTransactions })
    .from(paymentTerminalTransactions)
    .innerJoin(guestSessions, eq(guestSessions.id, paymentTerminalTransactions.guestSessionId))
    .where(eq(guestSessions.chargingSessionId, sessionId));
  if (viaGuest == null) return null;
  await linkTerminalSession(viaGuest.txn.guestSessionId ?? -1, sessionId);
  return { ...viaGuest.txn, sessionId };
}

/**
 * Captures the final cost of an ended session at the terminal (C24.FR.10):
 * the final cost capped at the authorized amount (never above, layer 1 of
 * P11; the adapter and the CHECK are the others). A final cost of 0 voids.
 * `capture_requested` is written before the call (P4); an unknown outcome
 * stays there and the reconciliation retries with the same key; a refused
 * capture records a failed payment.
 */
export async function settleTerminalSession(
  sessionId: string,
  ctx: PaymentContext,
): Promise<TerminalSettlementOutcome> {
  const txn = await terminalTransactionOfSession(sessionId);
  if (txn == null) return { kind: 'none' };
  if (txn.state === 'captured') {
    return {
      kind: 'captured',
      transaction: txn,
      capturedCents: txn.capturedCents ?? 0,
      paymentRecordId: txn.paymentRecordId ?? 0,
    };
  }
  if (txn.state !== 'authorized' && txn.state !== 'capture_requested') return { kind: 'none' };
  const [session] = await db
    .select({
      status: chargingSessions.status,
      finalCostCents: chargingSessions.finalCostCents,
      currency: chargingSessions.currency,
    })
    .from(chargingSessions)
    .where(eq(chargingSessions.id, sessionId));
  if (session == null) return { kind: 'none' };
  if (session.status === 'active') return { kind: 'not_ended' };
  if (session.currency.toUpperCase() !== txn.currency) {
    ctx.logger.error(
      { sessionId, terminalTransactionId: txn.id },
      'Session currency differs from the terminal hold; releasing the hold uncollected',
    );
    return {
      kind: 'voided',
      transaction: (await voidTerminalTransaction(txn.id, 'currency_mismatch', ctx)).transaction,
    };
  }
  const authorized = txn.authorizedCents ?? 0;
  const amount = Math.min(Math.max(session.finalCostCents ?? 0, 0), authorized);
  if (amount <= 0) {
    return {
      kind: 'voided',
      transaction: (await voidTerminalTransaction(txn.id, 'no_cost', ctx)).transaction,
    };
  }
  const now = new Date();
  const [claimed] = await db
    .update(paymentTerminalTransactions)
    .set({ state: 'capture_requested', pendingOperationAt: now, updatedAt: now, sessionId })
    .where(
      and(
        eq(paymentTerminalTransactions.id, txn.id),
        inArray(paymentTerminalTransactions.state, ['authorized', 'capture_requested']),
      ),
    )
    .returning();
  if (claimed?.providerTxnRef == null) return { kind: 'none' };
  const ref = claimed.providerTxnRef;
  const provider = await providerOf(ctx, claimed.provider);
  if (provider == null) {
    ctx.logger.error(
      { terminalTransactionId: txn.id },
      'Terminal capture without a configured provider; retried',
    );
    return { kind: 'pending', transaction: claimed };
  }
  try {
    const result = await provider.capture(ref, amount, terminalCaptureKey(ref));
    if (result.state !== 'captured') {
      return { kind: 'pending', transaction: claimed };
    }
    const capturedCents = Math.min(result.capturedCents ?? amount, amount);
    const done = await finishCapture(claimed, capturedCents, result.receiptUrl, ctx);
    if (done == null) return { kind: 'none' };
    return {
      kind: 'captured',
      transaction: done,
      capturedCents,
      paymentRecordId: done.paymentRecordId ?? 0,
    };
  } catch (err: unknown) {
    const error = err instanceof TerminalProviderError ? err : null;
    if (error == null || error.retryable || error.kind === 'unavailable') {
      ctx.logger.warn(
        { err, terminalTransactionId: txn.id },
        'Terminal capture outcome unknown; retried with the same key',
      );
      return { kind: 'pending', transaction: claimed };
    }
    const reason = `capture_${error.kind}`;
    const failed = await db.transaction(async (tx) => {
      const record = await recordTerminalCapture(
        {
          sessionId,
          driverId: null,
          provider: claimed.provider,
          providerTxnRef: ref,
          currency: claimed.currency,
          authorizedCents: authorized,
          capturedCents: 0,
          status: 'failed',
          failureReason: reason,
        },
        ctx,
        tx,
      );
      const [row] = await tx
        .update(paymentTerminalTransactions)
        .set({
          state: 'failed',
          failureReason: reason,
          paymentRecordId: record.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(paymentTerminalTransactions.id, txn.id),
            eq(paymentTerminalTransactions.state, 'capture_requested'),
          ),
        )
        .returning();
      return row ?? null;
    });
    ctx.logger.error(
      { terminalTransactionId: txn.id, kind: error.kind },
      'Terminal capture refused',
    );
    return { kind: 'failed', transaction: failed, reason };
  }
}

/** Records a confirmed capture: the payment record and the row, in one transaction. */
async function finishCapture(
  row: TerminalTransaction,
  capturedCents: number,
  receiptUrl: string | null,
  ctx: PaymentContext,
): Promise<TerminalTransaction | null> {
  if (row.providerTxnRef == null || row.authorizedCents == null) return null;
  const ref = row.providerTxnRef;
  const authorized = row.authorizedCents;
  return db.transaction(async (tx) => {
    const record = await recordTerminalCapture(
      {
        sessionId: row.sessionId,
        driverId: null,
        provider: row.provider,
        providerTxnRef: ref,
        currency: row.currency,
        authorizedCents: authorized,
        capturedCents: Math.min(capturedCents, authorized),
        status: 'captured',
      },
      ctx,
      tx,
    );
    const now = new Date();
    const [done] = await tx
      .update(paymentTerminalTransactions)
      .set({
        state: 'captured',
        capturedCents: Math.min(capturedCents, authorized),
        capturedAt: now,
        paymentRecordId: record.id,
        ...(receiptUrl != null ? { receiptUrl } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(paymentTerminalTransactions.id, row.id),
          eq(paymentTerminalTransactions.state, 'capture_requested'),
        ),
      )
      .returning();
    return done ?? null;
  });
}

// ---------------------------------------------------------------------------
// Refunds (from refunds.ts, the record locked by the caller)
// ---------------------------------------------------------------------------

/**
 * Refunds part or all of a terminal capture through the terminal provider
 * (owner decision 7), inside the refund route's transaction with the record
 * locked. Same outcome shape as a card refund.
 */
export async function refundTerminalRecordLocked(
  tx: Tx,
  locked: PaymentRecord,
  input: { requestedCents: number; alreadyRefundedCents: number },
  request: RefundRequest,
  ctx: PaymentContext,
): Promise<RefundOutcome> {
  const ref = locked.providerPaymentId;
  if (ref == null || locked.provider == null) return { status: 'missing_payment_id' };
  const provider = await providerOf(ctx, locked.provider);
  if (provider == null) return { status: 'not_configured', providerId: locked.provider };
  const [txn] = await tx
    .select()
    .from(paymentTerminalTransactions)
    .where(eq(paymentTerminalTransactions.paymentRecordId, locked.id))
    .for('update');
  const result = await provider.refund(
    ref,
    input.requestedCents,
    terminalRefundKey(ref, input.alreadyRefundedCents, input.requestedCents),
  );
  const captured = locked.capturedAmountCents ?? 0;
  const actor = {
    actorUserId: request.actorUserId ?? null,
    actionReason:
      request.actionReason?.(input.alreadyRefundedCents + input.requestedCents >= captured) ?? null,
  };
  const now = new Date();
  if (result.state === 'succeeded') {
    const refundedTotal = locked.refundedAmountCents + input.requestedCents;
    const full = refundedTotal >= captured;
    const record = await markRefunded(
      locked.id,
      {
        refundedTotalCents: refundedTotal,
        full,
        ...actor,
        ledger: [
          {
            refundId: result.refundRef,
            paymentId: ref,
            amountCents: input.requestedCents,
            state: 'succeeded',
            requestedAt: now.toISOString(),
            settledAt: now.toISOString(),
          },
        ],
        previous: locked,
      },
      ctx,
      tx,
    );
    if (record == null)
      throw new Error(`Payment record ${String(locked.id)} could not be marked refunded`);
    if (txn != null) {
      await tx
        .update(paymentTerminalTransactions)
        .set({
          refundedCents: Math.min(refundedTotal, txn.capturedCents ?? refundedTotal),
          state: full ? 'refunded' : 'partially_refunded',
          updatedAt: now,
        })
        .where(eq(paymentTerminalTransactions.id, txn.id));
    }
    return {
      status: 'refunded',
      record,
      refundedNowCents: input.requestedCents,
      pendingCents: 0,
      refundStatus: 'succeeded',
      full,
      refunds: [
        {
          paymentId: ref,
          kind: 'hold',
          amountCents: input.requestedCents,
          refundId: result.refundRef,
          state: 'succeeded',
        },
      ],
    };
  }
  const record = await addPendingRefunds(
    locked.id,
    [{ refundId: result.refundRef, paymentId: ref, amountCents: input.requestedCents }],
    actor,
    tx,
  );
  if (record == null)
    throw new Error(`Payment record ${String(locked.id)} could not list the refund`);
  if (txn != null) {
    await tx
      .update(paymentTerminalTransactions)
      .set({
        state: 'refund_pending',
        pendingOperationRef: result.refundRef,
        pendingOperationAt: now,
        updatedAt: now,
      })
      .where(eq(paymentTerminalTransactions.id, txn.id));
  }
  return {
    status: 'refunded',
    record,
    refundedNowCents: 0,
    pendingCents: input.requestedCents,
    refundStatus: 'pending',
    full: false,
    refunds: [
      {
        paymentId: ref,
        kind: 'hold',
        amountCents: input.requestedCents,
        refundId: result.refundRef,
        state: 'pending',
      },
    ],
  };
}

/** A refund the provider confirms later (webhook): settles the record's ledger entry and the row. */
async function applyTerminalRefundEvent(
  provider: TerminalProviderId,
  event: TerminalEvent,
  ctx: PaymentContext,
): Promise<void> {
  if (event.refund == null || event.providerTxnRef == null) return;
  const [txn] = await db
    .select()
    .from(paymentTerminalTransactions)
    .where(
      and(
        eq(paymentTerminalTransactions.provider, provider),
        eq(paymentTerminalTransactions.providerTxnRef, event.providerTxnRef),
      ),
    );
  if (txn?.paymentRecordId == null) return;
  const settled = await settleRefund(
    txn.paymentRecordId,
    {
      refundId: event.refund.refundRef,
      paymentId: event.providerTxnRef,
      amountCents: event.refund.amountCents,
      outcome: event.refund.state,
    },
    ctx,
  );
  if (settled.status === 'applied') {
    const record = settled.record;
    await db
      .update(paymentTerminalTransactions)
      .set({
        refundedCents: Math.min(record.refundedAmountCents, txn.capturedCents ?? 0),
        state:
          record.status === 'refunded'
            ? 'refunded'
            : record.refundedAmountCents > 0
              ? 'partially_refunded'
              : 'captured',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(paymentTerminalTransactions.id, txn.id),
          inArray(paymentTerminalTransactions.state, [
            'refund_pending',
            'partially_refunded',
            'captured',
          ]),
        ),
      );
  }
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface AppliedTerminalEvent {
  eventId: string;
  kind: TerminalEvent['kind'];
  /** Set for transaction events. */
  applied?: AppliedTerminalResult;
  /** Set for device events: the caller records the status (service, audit). */
  device?: {
    providerDeviceId: string;
    online: boolean | null;
    lastSeenAt: Date | null;
    iccid: string | null;
  };
}

export interface TerminalWebhookResult {
  applied: AppliedTerminalEvent[];
  duplicates: number;
}

/** The dedupe and lock key of a terminal provider's events in `webhook_events`. */
export function terminalWebhookProvider(provider: TerminalProviderId): string {
  return `terminal:${provider}`;
}

/**
 * Verifies and applies a terminal provider's webhook body. The signature is
 * checked by the adapter (HMAC over the raw body, five-minute tolerance);
 * each event is claimed once in `webhook_events` under its advisory lock
 * (security case 100). A money state change is never taken from the event
 * alone: with `stateLookup` the transaction is read back from the provider
 * first. Throws WebhookNotConfiguredError without a configured provider and
 * TerminalProviderError('auth') for a bad signature.
 */
export async function ingestTerminalWebhook(
  providerId: TerminalProviderId,
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  callerCtx: PaymentContext,
): Promise<TerminalWebhookResult> {
  const ctx: PaymentContext = {
    ...callerCtx,
    actor: { actor: 'system', actorLabel: `terminal-webhook:${providerId}` },
  };
  const provider = await terminalRegistry(ctx).getProvider(providerId);
  if (provider == null) throw new WebhookNotConfiguredError(terminalWebhookProvider(providerId));
  const events = provider.verifyWebhook(rawBody, headers);
  const lockProvider = terminalWebhookProvider(providerId);
  const applied: AppliedTerminalEvent[] = [];
  let duplicates = 0;
  for (const event of events) {
    const thisEvent = and(
      eq(webhookEvents.provider, lockProvider),
      eq(webhookEvents.eventId, event.eventId),
    );
    const outcome = await withWebhookEventLock(lockProvider, event.eventId, async () => {
      const inserted = await db
        .insert(webhookEvents)
        .values({
          provider: lockProvider,
          eventId: event.eventId,
          eventType: event.kind,
          processedAt: null,
        })
        .onConflictDoNothing()
        .returning({ eventId: webhookEvents.eventId });
      if (inserted.length === 0) {
        const [row] = await db
          .select({ processedAt: webhookEvents.processedAt })
          .from(webhookEvents)
          .where(thisEvent);
        if (row?.processedAt != null) return null;
      }
      let result: AppliedTerminalEvent;
      try {
        result = await applyTerminalEvent(providerId, provider, event, ctx);
      } catch (err) {
        await db.delete(webhookEvents).where(thisEvent);
        throw err;
      }
      await db.update(webhookEvents).set({ processedAt: new Date() }).where(thisEvent);
      return result;
    });
    if (outcome == null) duplicates++;
    else applied.push(outcome);
  }
  return { applied, duplicates };
}

async function applyTerminalEvent(
  providerId: TerminalProviderId,
  provider: PaymentTerminalProvider,
  event: TerminalEvent,
  ctx: PaymentContext,
): Promise<AppliedTerminalEvent> {
  if (event.kind === 'device_status') {
    if (event.providerDeviceId == null || event.device == null)
      return { eventId: event.eventId, kind: event.kind };
    return {
      eventId: event.eventId,
      kind: event.kind,
      device: { providerDeviceId: event.providerDeviceId, ...event.device },
    };
  }
  if (event.kind === 'refund') {
    await applyTerminalRefundEvent(providerId, event, ctx);
    return { eventId: event.eventId, kind: event.kind };
  }
  if (event.txn == null) return { eventId: event.eventId, kind: event.kind };
  const ref = event.txn.providerTxnRef;
  const [row] = await db
    .select()
    .from(paymentTerminalTransactions)
    .where(
      and(
        eq(paymentTerminalTransactions.provider, providerId),
        or(
          eq(paymentTerminalTransactions.providerTxnRef, ref),
          event.reference != null
            ? and(
                eq(paymentTerminalTransactions.id, event.reference),
                isNull(paymentTerminalTransactions.providerTxnRef),
              )
            : sql`false`,
        ),
      ),
    );
  if (row == null) {
    // A hold the CSMS did not start (or no longer tracks): never charged
    // through the CSMS. An authorized one is voided so the card is released.
    if (event.txn.state === 'authorized') await voidAtProvider(providerId, ref, ctx);
    ctx.logger.warn({ provider: providerId }, 'Terminal event for an unknown transaction');
    return { eventId: event.eventId, kind: event.kind };
  }
  let result = event.txn;
  if (provider.capabilities.stateLookup) {
    const confirmed = await provider.getTransaction(ref);
    if (confirmed == null) {
      ctx.logger.warn(
        { terminalTransactionId: row.id },
        'Terminal event not confirmed by the provider; ignored',
      );
      return { eventId: event.eventId, kind: event.kind };
    }
    result = confirmed;
  }
  return {
    eventId: event.eventId,
    kind: event.kind,
    applied: await applyTerminalTxnResult(row.id, result, ctx),
  };
}

// ---------------------------------------------------------------------------
// Reconciliation (worker, P4 sweeper)
// ---------------------------------------------------------------------------

export interface TerminalReconcileResult {
  lookedUp: number;
  voided: number;
  settled: number;
  /** Sessions settled now: the caller finishes their guest sessions (completion, receipt). */
  settledSessionIds: string[];
  errors: number;
}

/**
 * Resolves terminal transactions a lost answer, webhook or process left in
 * an intermediate state: a start past its expiry is looked up (or replayed
 * with its key) and voided, a stale capture or void is retried with its key,
 * a hold whose charging never started is voided, and an ended session whose
 * hold is still authorized is settled. Fail-open per row (warn).
 */
export async function reconcileTerminalTransactions(
  ctx: PaymentContext,
  now: Date = new Date(),
): Promise<TerminalReconcileResult> {
  const out: TerminalReconcileResult = {
    lookedUp: 0,
    voided: 0,
    settled: 0,
    settledSessionIds: [],
    errors: 0,
  };
  const stale = new Date(now.getTime() - TERMINAL_CLAIM_STALE_MS);
  const rows = await db
    .select({
      txn: paymentTerminalTransactions,
      deviceId: paymentTerminals.providerDeviceId,
      guestStatus: guestSessions.status,
      sessionStatus: chargingSessions.status,
      sessionEndedAt: chargingSessions.endedAt,
    })
    .from(paymentTerminalTransactions)
    .innerJoin(
      paymentTerminals,
      eq(paymentTerminals.id, paymentTerminalTransactions.paymentTerminalId),
    )
    .leftJoin(guestSessions, eq(guestSessions.id, paymentTerminalTransactions.guestSessionId))
    .leftJoin(chargingSessions, eq(chargingSessions.id, paymentTerminalTransactions.sessionId))
    .where(
      and(
        inArray(paymentTerminalTransactions.state, [
          'requested',
          'presenting',
          'authorized',
          'capture_requested',
          'void_requested',
        ]),
        lt(paymentTerminalTransactions.updatedAt, stale),
      ),
    )
    .limit(200);
  for (const { txn, deviceId, guestStatus, sessionStatus, sessionEndedAt } of rows) {
    try {
      if (txn.state === 'requested' || txn.state === 'presenting') {
        if (txn.expiresAt > now) continue;
        out.lookedUp++;
        const provider = await providerOf(ctx, txn.provider);
        if (provider != null && txn.providerTxnRef == null && deviceId != null) {
          // The start never answered: replay it with its key to learn the reference.
          try {
            const replay = await provider.startPayment({
              providerDeviceId: deviceId,
              amountCents: txn.requestedCents,
              currency: txn.currency,
              idempotencyKey: terminalAuthKey(txn.id),
              reference: txn.id,
              timeoutSeconds: PAYMENT_TERMINAL_CARD_TIMEOUT_SECONDS,
              evseChoices: [],
            });
            await db
              .update(paymentTerminalTransactions)
              .set({ providerTxnRef: replay.providerTxnRef, updatedAt: now })
              .where(
                and(
                  eq(paymentTerminalTransactions.id, txn.id),
                  isNull(paymentTerminalTransactions.providerTxnRef),
                ),
              );
          } catch (err: unknown) {
            ctx.logger.warn({ err, terminalTransactionId: txn.id }, 'Terminal start replay failed');
          }
        }
        // The driver has gone: whatever the provider holds is released.
        const voided = await voidTerminalTransaction(txn.id, 'start_expired', ctx);
        if (voided.transition === 'voided' || voided.transition === 'expired') out.voided++;
      } else if (txn.state === 'authorized') {
        const ended = sessionStatus != null && sessionStatus !== 'active';
        if (txn.sessionId != null && ended) {
          if (
            sessionEndedAt != null &&
            now.getTime() - sessionEndedAt.getTime() < TERMINAL_ENDED_SETTLE_DELAY_MS
          )
            continue;
          const settled = await settleTerminalSession(txn.sessionId, ctx);
          if (settled.kind === 'captured' || settled.kind === 'voided') {
            out.settled++;
            out.settledSessionIds.push(txn.sessionId);
          }
          continue;
        }
        const unstarted =
          txn.guestSessionId == null
            ? txn.authorizedAt != null &&
              now.getTime() - txn.authorizedAt.getTime() > TERMINAL_UNSTARTED_HOLD_MS
            : txn.sessionId == null && (guestStatus === 'expired' || guestStatus === 'failed');
        if (unstarted) {
          const voided = await voidTerminalTransaction(txn.id, 'charging_not_started', ctx);
          if (voided.transition === 'voided') out.voided++;
        }
      } else if (txn.state === 'capture_requested' && txn.sessionId != null) {
        const settled = await settleTerminalSession(txn.sessionId, ctx);
        if (settled.kind === 'captured') {
          out.settled++;
          out.settledSessionIds.push(txn.sessionId);
        }
      } else if (txn.state === 'void_requested') {
        const voided = await voidTerminalTransaction(
          txn.id,
          txn.failureReason ?? 'void_retry',
          ctx,
        );
        if (voided.transition === 'voided') out.voided++;
      }
    } catch (err: unknown) {
      out.errors++;
      ctx.logger.warn(
        { err, terminalTransactionId: txn.id },
        'Terminal transaction reconciliation failed',
      );
    }
  }
  return out;
}

/** True when an authorized hold exists on a terminal transaction with a provider reference (the operator void button). */
export function isVoidable(txn: Pick<TerminalTransaction, 'state'>): boolean {
  return txn.state === 'authorized' || txn.state === 'requested' || txn.state === 'presenting';
}

/** The open transactions of a terminal that hold money now (for a deactivation warning). */
export async function openTerminalHolds(terminalId: string): Promise<number> {
  const rows = await db
    .select({ id: paymentTerminalTransactions.id })
    .from(paymentTerminalTransactions)
    .where(
      and(
        eq(paymentTerminalTransactions.paymentTerminalId, terminalId),
        inArray(paymentTerminalTransactions.state, ['authorized', 'capture_requested']),
        isNotNull(paymentTerminalTransactions.providerTxnRef),
      ),
    );
  return rows.length;
}
