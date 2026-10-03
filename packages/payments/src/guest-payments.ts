// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, lte, sql } from 'drizzle-orm';
import {
  chargingSessions,
  chargingStations,
  client,
  db,
  getCompanyCurrency,
  getPlatformFeePercent,
  guestSessions,
} from '@evtivity/database';
import {
  costIncludesTax,
  dispatchSystemNotification,
  notificationMoney,
  sessionChargeTax,
} from '@evtivity/lib';
import type { PaymentContext } from './context.js';
import { errorMessage } from './context.js';
import { PaymentDeclinedError, PaymentProviderNotConfiguredError } from './errors.js';
import { activeProvider, pinnedProvider } from './pinning.js';
import {
  findSessionRecord,
  markCancelled,
  markCaptured,
  markHoldFailed,
  recordGuestHold,
} from './payment-records.js';
import { holdTerms } from './session-payments.js';
import type { PaymentProvider } from './types.js';

/**
 * Guest checkout (no account, one-time card): the hold at the start, its link
 * to the charging session, capture or cancel at the end, and the cleanup of
 * holds that never started or whose finalization gave up. Guest holds are
 * placed with the active provider and finished with the provider they are
 * pinned to. Idempotency keys: `guest_preauth_<token>` (hold),
 * `capture_<recordId>`, `cancel_<recordId>`, `cancel_guest_<token>` (a hold
 * without a record).
 */

export interface GuestHoldInput {
  sessionToken: string;
  stationOcppId: string;
  evseId: number;
  siteId: string | null;
  /** The provider's one-time method (Stripe: a PaymentMethod id from Stripe.js). */
  methodPayload: unknown;
  guestEmail: string;
  maxCostCents: number | null;
  maxEnergyWh: number | null;
  maxTimeSeconds: number | null;
  expiresAt: Date;
}

export type GuestHoldOutcome =
  | { outcome: 'authorized'; paymentId: string; preAuthAmountCents: number }
  | { outcome: 'declined'; reason: string }
  | { outcome: 'not_configured' };

/**
 * Places the guest's hold (the shopper is present) and stores the guest
 * session with it. The authorized amount is the cost ceiling (OCPP 2.1 C25
 * step 9): a capture cannot exceed it. A card that needs a 3DS step is
 * declined and its pending payment cancelled (the guest checkout has no
 * authentication step yet, plan P10c). When the guest session cannot be
 * stored, the hold is cancelled so the card is not held for a session that
 * does not exist (P4), and the error is rethrown.
 */
export async function authorizeGuestHold(
  input: GuestHoldInput,
  ctx: PaymentContext,
): Promise<GuestHoldOutcome> {
  let provider: PaymentProvider | null;
  try {
    provider = await activeProvider(ctx.registry);
  } catch (err) {
    if (err instanceof PaymentProviderNotConfiguredError) return { outcome: 'not_configured' };
    throw err;
  }
  if (provider == null) return { outcome: 'not_configured' };
  const [terms, currency] = await Promise.all([holdTerms(ctx, input.siteId), getCompanyCurrency()]);
  const merchantReference = `guest_${input.sessionToken}`;
  const cancelKey = `cancel_guest_${input.sessionToken}`;

  let paymentId: string;
  try {
    const hold = await provider.authorizeHold({
      method: { kind: 'one_time', payload: input.methodPayload },
      initiator: 'shopper',
      merchantReference,
      amountCents: terms.preAuthAmountCents,
      currency,
      payoutAccountId: terms.payoutAccountId,
      receiptEmail: input.guestEmail,
      idempotencyKey: `guest_preauth_${input.sessionToken}`,
    });
    if (hold.status !== 'authorized') {
      if (hold.paymentId != null) {
        await cancelQuietly(provider, hold.paymentId, merchantReference, cancelKey, ctx);
      }
      throw new PaymentDeclinedError('Your card requires authentication.', {
        code: 'authentication_required',
      });
    }
    paymentId = hold.paymentId;
  } catch (err) {
    if (err instanceof PaymentProviderNotConfiguredError) return { outcome: 'not_configured' };
    return { outcome: 'declined', reason: errorMessage(err, 'Payment failed') };
  }

  try {
    await db.insert(guestSessions).values({
      stationOcppId: input.stationOcppId,
      evseId: input.evseId,
      stripePaymentIntentId: paymentId,
      guestEmail: input.guestEmail,
      preAuthAmountCents: terms.preAuthAmountCents,
      status: 'payment_authorized',
      sessionToken: input.sessionToken,
      expiresAt: input.expiresAt,
      maxCostCents: Math.min(
        input.maxCostCents ?? terms.preAuthAmountCents,
        terms.preAuthAmountCents,
      ),
      maxEnergyWh: input.maxEnergyWh,
      maxTimeSeconds: input.maxTimeSeconds,
    });
  } catch (err) {
    ctx.logger.error(
      { err, paymentId, sessionToken: input.sessionToken },
      'guest_sessions insert failed after the hold; cancelling it',
    );
    await cancelQuietly(provider, paymentId, merchantReference, cancelKey, ctx);
    throw err;
  }
  return { outcome: 'authorized', paymentId, preAuthAmountCents: terms.preAuthAmountCents };
}

async function cancelQuietly(
  provider: PaymentProvider,
  paymentId: string,
  merchantReference: string,
  idempotencyKey: string,
  ctx: PaymentContext,
): Promise<void> {
  try {
    await provider.cancelHold({ paymentId, merchantReference, idempotencyKey });
  } catch (err) {
    // The hold expires by itself (Stripe: 7 days); P9 fail open.
    ctx.logger.warn({ err, paymentId }, 'Failed to cancel the guest hold');
  }
}

/**
 * Undoes a guest start the station did not accept: the guest session is
 * deleted and its hold, if any, cancelled (best effort).
 */
export async function rollbackGuestStart(
  input: { sessionToken: string; paymentId: string | null },
  ctx: PaymentContext,
): Promise<void> {
  await db.delete(guestSessions).where(eq(guestSessions.sessionToken, input.sessionToken));
  if (input.paymentId == null) return;
  try {
    const provider = await pinnedProvider(ctx.registry, { paymentId: input.paymentId });
    await cancelQuietly(
      provider,
      input.paymentId,
      `guest_${input.sessionToken}`,
      `cancel_guest_${input.sessionToken}`,
      ctx,
    );
  } catch (err) {
    ctx.logger.warn(
      { err, paymentId: input.paymentId },
      'Failed to cancel guest PaymentIntent after start failure',
    );
  }
}

export interface GuestSessionEvent {
  type: string;
  sessionId?: string;
  idToken?: { idToken: string; type?: string };
}

export interface GuestEventDeps extends PaymentContext {
  /** Notification template directories of the calling process (guest receipt). */
  templatesDirs: string[];
}

/**
 * The guest session events the worker receives from `csms_events`
 * (guest-session-events queue): TransactionStarted links the guest session
 * to its charging session (matched by the token only: OCPP 1.6 sends no token
 * type) and records its hold; TransactionEnded captures or cancels it.
 */
export async function handleGuestSessionEvent(
  event: GuestSessionEvent,
  deps: GuestEventDeps,
): Promise<void> {
  if (event.type === 'TransactionStarted' && event.idToken?.idToken != null) {
    await linkGuestSession(event.idToken.idToken, event.sessionId ?? null, deps);
  }
  if (event.type === 'TransactionEnded' && event.sessionId != null) {
    await finalizeGuestPayment(event.sessionId, deps);
  }
}

async function linkGuestSession(
  token: string,
  sessionId: string | null,
  deps: GuestEventDeps,
): Promise<void> {
  const [guest] = await db
    .select()
    .from(guestSessions)
    .where(
      and(eq(guestSessions.sessionToken, token), eq(guestSessions.status, 'payment_authorized')),
    );
  if (guest == null || sessionId == null) return;

  await db
    .update(guestSessions)
    .set({ chargingSessionId: sessionId, status: 'charging', updatedAt: new Date() })
    .where(eq(guestSessions.id, guest.id));

  if (guest.stripePaymentIntentId != null) {
    const [station] = await db
      .select({ siteId: chargingStations.siteId })
      .from(chargingStations)
      .where(eq(chargingStations.stationId, guest.stationOcppId));
    const [terms, [session]] = await Promise.all([
      holdTerms(deps, station?.siteId ?? null),
      db
        .select({ currency: sql<string>`upper(${chargingSessions.currency})` })
        .from(chargingSessions)
        .where(eq(chargingSessions.id, sessionId)),
    ]);
    await recordGuestHold({
      sessionId,
      sitePaymentConfigId: terms.sitePaymentConfigId,
      paymentId: guest.stripePaymentIntentId,
      currency: session?.currency ?? (await getCompanyCurrency()),
      preAuthAmountCents: guest.preAuthAmountCents,
    });
  }
  deps.logger.info(
    { guestSessionId: guest.id, chargingSessionId: sessionId },
    'Linked guest session to charging session',
  );
}

async function completeGuestSession(guestSessionId: number): Promise<void> {
  await db
    .update(guestSessions)
    .set({ status: 'completed', updatedAt: new Date() })
    .where(eq(guestSessions.id, guestSessionId));
}

/**
 * Captures the guest's hold at the session's final cost, at most the hold:
 * a guest has no saved card, so a cost above it cannot be topped up and the
 * uncollected rest is recorded as `Guest shortfall:` (not picked up by the
 * daily top-up retry). A cost of 0 cancels the hold. Idempotent: a record
 * already captured, cancelled or failed is left alone. A failed capture marks
 * the record failed and rethrows, so the worker retries the job.
 */
async function finalizeGuestPayment(sessionId: string, deps: GuestEventDeps): Promise<void> {
  const [guest] = await db
    .select({
      id: guestSessions.id,
      guestEmail: guestSessions.guestEmail,
      stationOcppId: guestSessions.stationOcppId,
    })
    .from(guestSessions)
    .where(eq(guestSessions.chargingSessionId, sessionId));
  if (guest == null) return;

  const record = await findSessionRecord(sessionId);
  if (
    record != null &&
    (record.status === 'captured' || record.status === 'cancelled' || record.status === 'failed')
  ) {
    deps.logger.info(
      { guestSessionId: guest.id, paymentRecordId: record.id, status: record.status },
      'Skipping guest payment finalization, already terminal',
    );
    return;
  }
  const paymentId = record?.stripePaymentIntentId ?? null;
  if (record == null || paymentId == null) {
    await completeGuestSession(guest.id);
    deps.logger.info({ guestSessionId: guest.id }, 'Free guest session completed');
    await sendGuestReceipt(guest, sessionId, deps);
    return;
  }

  const [session] = await db
    .select({
      finalCostCents: chargingSessions.finalCostCents,
      tariffTaxRate: chargingSessions.tariffTaxRate,
      costBreakdown: chargingSessions.costBreakdown,
      siteId: chargingStations.siteId,
    })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
    .where(eq(chargingSessions.id, sessionId));
  if (session == null) return;

  let provider: PaymentProvider;
  try {
    provider = await pinnedProvider(deps.registry, { paymentId });
  } catch (err) {
    if (!(err instanceof PaymentProviderNotConfiguredError)) throw err;
    deps.logger.error(
      { guestSessionId: guest.id },
      'No payment provider for guest payment capture',
    );
    await completeGuestSession(guest.id);
    return;
  }

  const merchantReference = `sess_${sessionId}`;
  try {
    const finalCost = session.finalCostCents ?? 0;
    if (finalCost > 0) {
      const holdCents = record.preAuthAmountCents ?? finalCost;
      const captureCents = Math.min(finalCost, holdCents);
      const shortfallCents = finalCost - captureCents;
      await provider.capture({
        paymentId,
        amountCents: captureCents,
        currency: record.currency,
        merchantReference,
        payoutAccountId: null,
        feeTax: sessionChargeTax(session),
        platformFeePercent: await getPlatformFeePercent(session.siteId),
        idempotencyKey: `capture_${String(record.id)}`,
      });
      const failureReason =
        shortfallCents > 0
          ? `Guest shortfall: hold ${String(holdCents)}c captured, ${String(shortfallCents)}c uncollected (no saved card for a top-up)`
          : null;
      if (shortfallCents > 0) {
        deps.logger.warn(
          { guestSessionId: guest.id, finalCost, holdCents, shortfallCents },
          'Guest session cost exceeds the hold; captured the hold, shortfall uncollected',
        );
      } else {
        deps.logger.info(
          { guestSessionId: guest.id, amountCents: captureCents },
          'Captured guest payment',
        );
      }
      await markCaptured(record.id, { capturedCents: captureCents, failureReason });
    } else {
      await provider.cancelHold({
        paymentId,
        merchantReference,
        idempotencyKey: `cancel_${String(record.id)}`,
      });
      deps.logger.info({ guestSessionId: guest.id }, 'Cancelled zero-cost guest payment intent');
      await markCancelled(record.id);
    }
    await completeGuestSession(guest.id);
    await sendGuestReceipt(guest, sessionId, deps);
  } catch (err) {
    deps.logger.error({ err, guestSessionId: guest.id }, 'Failed to finalize guest payment');
    await markHoldFailed(record.id, errorMessage(err, 'Unknown payment error'));
    // BullMQ retries the job (3 attempts); after the last one the worker's
    // failed hook fails the guest session and cancels the hold.
    throw err;
  }
}

async function sendGuestReceipt(
  guest: { id: number; guestEmail: string; stationOcppId: string },
  sessionId: string,
  deps: GuestEventDeps,
): Promise<void> {
  if (guest.guestEmail === '') return;
  try {
    const [session] = await db
      .select({
        energyDeliveredWh: chargingSessions.energyDeliveredWh,
        finalCostCents: chargingSessions.finalCostCents,
        tariffTaxRate: chargingSessions.tariffTaxRate,
        currency: sql<string>`upper(${chargingSessions.currency})`,
        startedAt: chargingSessions.startedAt,
        endedAt: chargingSessions.endedAt,
      })
      .from(chargingSessions)
      .where(eq(chargingSessions.id, sessionId));
    if (session == null) return;
    const startedAt = session.startedAt != null ? new Date(session.startedAt) : new Date();
    const endedAt = session.endedAt != null ? new Date(session.endedAt) : new Date();
    await dispatchSystemNotification(
      client,
      'session.Receipt',
      { email: guest.guestEmail },
      {
        stationId: guest.stationOcppId,
        energyDeliveredWh:
          session.energyDeliveredWh != null ? Number(session.energyDeliveredWh) : 0,
        finalCostCents: session.finalCostCents ?? 0,
        costFormatted: notificationMoney(session.finalCostCents ?? 0, session.currency),
        costIncludesTax: costIncludesTax(session.finalCostCents, session.tariffTaxRate),
        currency: session.currency,
        durationMinutes: Math.round((endedAt.getTime() - startedAt.getTime()) / 60000),
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
      },
      deps.templatesDirs,
    );
    deps.logger.info({ guestSessionId: guest.id }, 'Guest receipt notification sent');
  } catch (err) {
    deps.logger.error(
      { err, guestSessionId: guest.id },
      'Failed to send guest receipt notification',
    );
  }
}

/**
 * After the last finalization attempt: the guest session fails, its open hold
 * is recorded failed and cancelled at once (P4) instead of waiting for the
 * provider's expiry. The cancel is best effort.
 */
export async function failExhaustedGuestCapture(
  sessionId: string,
  reason: string,
  ctx: PaymentContext,
): Promise<void> {
  await db
    .update(guestSessions)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(eq(guestSessions.chargingSessionId, sessionId));
  const record = await findSessionRecord(sessionId);
  if (record?.status !== 'pre_authorized') return;
  await markHoldFailed(record.id, `Capture worker exhausted retries: ${reason}`);
  const paymentId = record.stripePaymentIntentId;
  if (paymentId == null) return;
  try {
    const provider = await pinnedProvider(ctx.registry, { paymentId });
    await provider.cancelHold({
      paymentId,
      merchantReference: `sess_${sessionId}`,
      idempotencyKey: `cancel_${String(record.id)}`,
    });
  } catch (err) {
    ctx.logger.warn(
      { sessionId, paymentRecordId: record.id, err },
      'Failed to cancel the guest hold after exhausted retries; it expires by itself',
    );
  }
}

/**
 * Guest checkouts that never started charging before their token expired:
 * the hold is cancelled (best effort; it expires by itself) and the guest
 * session marked expired, in independent steps so a cancel failure never
 * leaves the row open.
 */
export async function expireGuestSessions(ctx: PaymentContext): Promise<number> {
  const expired = await db
    .select()
    .from(guestSessions)
    .where(
      and(
        sql`${guestSessions.status} IN ('pending_payment', 'payment_authorized')`,
        lte(guestSessions.expiresAt, new Date()),
      ),
    );
  for (const gs of expired) {
    if (gs.stripePaymentIntentId != null) {
      try {
        const provider = await pinnedProvider(ctx.registry, {
          paymentId: gs.stripePaymentIntentId,
        });
        await provider.cancelHold({
          paymentId: gs.stripePaymentIntentId,
          merchantReference: `guest_${gs.sessionToken}`,
          idempotencyKey: `cancel_guest_${gs.sessionToken}`,
        });
      } catch (err) {
        ctx.logger.warn(
          { guestSessionId: gs.id, err },
          'Failed to cancel the guest hold on expiry; it expires by itself',
        );
      }
    }
    try {
      await db
        .update(guestSessions)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(guestSessions.id, gs.id));
    } catch (err) {
      ctx.logger.error({ guestSessionId: gs.id, err }, 'Failed to mark guest session expired');
    }
  }
  return expired.length;
}
