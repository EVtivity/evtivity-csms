// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import {
  chargingSessions,
  chargingStations,
  client,
  db,
  getCompanyCurrency,
  getPlatformFeePercent,
  guestSessions,
  sessionFeeGrossCents,
} from '@evtivity/database';
import {
  costIncludesTax,
  dispatchSystemNotification,
  notificationMoney,
  parseSessionCostBreakdown,
  sessionChargeTax,
} from '@evtivity/lib';
import type { PaymentContext } from './context.js';
import { errorMessage, pendingRef } from './context.js';
import { PaymentDeclinedError, PaymentProviderNotConfiguredError } from './errors.js';
import { cancelKey, captureKey } from './idempotency-keys.js';
import { activeProvider, pinnedProvider } from './pinning.js';
import {
  findSessionRecord,
  markCancelled,
  markCaptured,
  markHoldFailed,
  recordGuestHold,
} from './payment-records.js';
import type { PaymentRecord } from './payment-records.js';
import { PAYOUT_NOT_READY_REASON } from './payout-accounts.js';
import { belowMinimumCaptureReason, belowMinimumCharge, holdTerms } from './session-payments.js';
import type { HoldTerms } from './session-payments.js';
import type {
  BrowserContext,
  ClientAction,
  HoldResult,
  PaymentProvider,
  PaymentProviderId,
} from './types.js';

/**
 * Guest checkout (no account, one-time card): the hold at the start, its link
 * to the charging session, capture or cancel at the end, and the cleanup of
 * holds that never started or whose finalization gave up. Guest holds are
 * placed with the active provider and finished with the provider they are
 * pinned to. Idempotency keys: `guest_preauth_<token>` (hold), and
 * `capture_<paymentId>`, `cancel_<paymentId>` (`idempotency-keys.ts`).
 */

/** The merchant reference of a guest hold is `guest_<sessionToken>`. */
export const GUEST_REFERENCE_PREFIX = 'guest_';

export interface GuestHoldInput {
  sessionToken: string;
  stationOcppId: string;
  evseId: number;
  siteId: string | null;
  /** The provider's one-time method (Stripe: a PaymentMethod id from Stripe.js). */
  methodPayload: unknown;
  /**
   * The guest's browser, for a 3DS round trip. Without it a card that needs
   * authentication is declined (the client cannot run a client action).
   */
  browser?: BrowserContext;
  guestEmail: string;
  maxCostCents: number | null;
  maxEnergyWh: number | null;
  maxTimeSeconds: number | null;
  expiresAt: Date;
}

export type GuestHoldOutcome =
  | { outcome: 'authorized'; paymentId: string; preAuthAmountCents: number }
  /**
   * The card needs a 3DS step: the guest session is stored as
   * `pending_payment`; the client runs the action and sends its details to
   * `continueGuestHold`.
   */
  | { outcome: 'action_required'; action: ClientAction }
  | { outcome: 'declined'; reason: string }
  | { outcome: 'not_configured' };

/**
 * The guest's hold terms: the site (or global) hold, or, when that hold is
 * below the session fee with tax of the tariff a guest pays at the station,
 * the session fee plus the configured hold (owner decision 2026-10-04, N18).
 * The guest hold is the station's maxCost (no saved card for a top-up): a hold
 * below the fee, or equal to it, stops the session at the first reading with
 * CostLimitReached, so the configured amount stays available for energy on
 * top of the fee. A hold at or above the fee is used as configured. The site
 * config save warns about such a hold; this is the layer that holds at every
 * start (P11), also for a tariff changed after the config was saved.
 */
export async function guestHoldTerms(
  ctx: PaymentContext,
  siteId: string | null,
  stationOcppId: string,
): Promise<HoldTerms & { sessionFeeCents: number }> {
  const [terms, [station]] = await Promise.all([
    holdTerms(ctx, siteId),
    db
      .select({ id: chargingStations.id })
      .from(chargingStations)
      .where(eq(chargingStations.stationId, stationOcppId)),
  ]);
  const sessionFeeCents =
    station == null
      ? 0
      : await sessionFeeGrossCents({ stationUuid: station.id, driverUuid: null }, client);
  if (sessionFeeCents > terms.preAuthAmountCents) {
    const raisedCents = sessionFeeCents + terms.preAuthAmountCents;
    ctx.logger.warn(
      {
        siteId,
        stationOcppId,
        preAuthAmountCents: terms.preAuthAmountCents,
        sessionFeeCents,
        holdCents: raisedCents,
      },
      'Guest hold below the session fee: holding the session fee plus the configured hold',
    );
    return { ...terms, preAuthAmountCents: raisedCents, sessionFeeCents };
  }
  return { ...terms, sessionFeeCents };
}

/**
 * Places the guest's hold (the shopper is present) and stores the guest
 * session with it. The authorized amount is the cost ceiling (OCPP 2.1 C25
 * step 9): a capture cannot exceed it. A card that needs a 3DS step returns
 * the client action when the guest's browser context came with the request
 * (the session waits in `pending_payment`); without one it is declined and
 * its pending payment cancelled. When the guest session cannot be stored,
 * the hold is cancelled so the card is not held for a session that does not
 * exist (P4), and the error is rethrown.
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
  const [terms, currency] = await Promise.all([
    guestHoldTerms(ctx, input.siteId, input.stationOcppId),
    getCompanyCurrency(),
  ]);
  if (terms.payoutBlocked) {
    // O5, fail closed: no hold on the platform instead of the site host.
    ctx.logger.warn(
      { siteId: input.siteId, sessionToken: input.sessionToken },
      'Guest hold refused: the payout account of the site is not ready',
    );
    return { outcome: 'declined', reason: PAYOUT_NOT_READY_REASON };
  }
  const merchantReference = `${GUEST_REFERENCE_PREFIX}${input.sessionToken}`;

  let hold: HoldResult;
  try {
    hold = await provider.authorizeHold({
      method: {
        kind: 'one_time',
        payload: input.methodPayload,
        ...(input.browser != null ? { browser: input.browser } : {}),
      },
      initiator: 'shopper',
      merchantReference,
      amountCents: terms.preAuthAmountCents,
      currency,
      payoutAccountId: terms.payoutAccountId,
      receiptEmail: input.guestEmail,
      idempotencyKey: `guest_preauth_${input.sessionToken}`,
    });
    if (hold.status !== 'authorized' && input.browser == null) {
      if (hold.paymentId != null) {
        await cancelQuietly(provider, hold.paymentId, merchantReference, ctx);
      }
      throw new PaymentDeclinedError('Your card requires authentication.', {
        code: 'authentication_required',
      });
    }
  } catch (err) {
    if (err instanceof PaymentProviderNotConfiguredError) return { outcome: 'not_configured' };
    return { outcome: 'declined', reason: errorMessage(err, 'Payment failed') };
  }

  const paymentId = hold.paymentId;
  try {
    await db.insert(guestSessions).values({
      stationOcppId: input.stationOcppId,
      evseId: input.evseId,
      provider: provider.id,
      providerPaymentId: paymentId,
      guestEmail: input.guestEmail,
      preAuthAmountCents: terms.preAuthAmountCents,
      status: hold.status === 'authorized' ? 'payment_authorized' : 'pending_payment',
      // An authorized hold is started by the calling route right away; a
      // 3DS hold is started later by the one request that claims it.
      startRequestedAt: hold.status === 'authorized' ? new Date() : null,
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
    if (paymentId != null) {
      await cancelQuietly(provider, paymentId, merchantReference, ctx);
    }
    throw err;
  }
  if (hold.status !== 'authorized') return { outcome: 'action_required', action: hold.action };
  return {
    outcome: 'authorized',
    paymentId: hold.paymentId,
    preAuthAmountCents: terms.preAuthAmountCents,
  };
}

export type GuestContinueOutcome =
  | { outcome: 'authorized'; paymentId: string; preAuthAmountCents: number }
  | { outcome: 'action_required'; action: ClientAction }
  | { outcome: 'declined'; reason: string }
  /** No guest session waiting for its payment under this token (unknown, expired or finished). */
  | { outcome: 'not_pending' }
  | { outcome: 'not_configured' };

/**
 * The second step of a guest hold that needed a 3DS round trip: the details
 * the client collected (`onAdditionalDetails`, or the `redirectResult` of the
 * return page) go to the provider the guest session is pinned to. An
 * authorized hold moves the session to `payment_authorized` (also when the
 * provider's webhook attached it first, `attachGuestAuthorisation`); a
 * refusal fails it. Key `guest_details_<token>_<sha256(details)>` (P7): a
 * replay of the same details reaches the same provider answer. A hold
 * authorized for a session that expired meanwhile is cancelled.
 */
export async function continueGuestHold(
  input: { sessionToken: string; details: unknown },
  ctx: PaymentContext,
): Promise<GuestContinueOutcome> {
  const [guest] = await db
    .select()
    .from(guestSessions)
    .where(eq(guestSessions.sessionToken, input.sessionToken));
  if (guest == null) return { outcome: 'not_pending' };
  if (guest.status === 'payment_authorized' && guest.providerPaymentId != null) {
    return {
      outcome: 'authorized',
      paymentId: guest.providerPaymentId,
      preAuthAmountCents: guest.preAuthAmountCents ?? 0,
    };
  }
  if (guest.status !== 'pending_payment' || guest.expiresAt.getTime() <= Date.now()) {
    return { outcome: 'not_pending' };
  }

  let provider: PaymentProvider;
  try {
    provider = await pinnedProvider(ctx.registry, guest.provider);
  } catch (err) {
    if (err instanceof PaymentProviderNotConfiguredError) return { outcome: 'not_configured' };
    throw err;
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(input.details ?? null))
    .digest('hex')
    .slice(0, 24);
  let hold: HoldResult;
  try {
    hold = await provider.continueHold({
      paymentId: guest.providerPaymentId,
      details: input.details,
      idempotencyKey: `guest_details_${input.sessionToken}_${digest}`,
    });
  } catch (err) {
    if (err instanceof PaymentProviderNotConfiguredError) return { outcome: 'not_configured' };
    const reason = errorMessage(err, 'Payment failed');
    ctx.logger.warn({ err, guestSessionId: guest.id }, 'Guest 3DS authorisation declined');
    await db
      .update(guestSessions)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(and(eq(guestSessions.id, guest.id), eq(guestSessions.status, 'pending_payment')));
    return { outcome: 'declined', reason };
  }

  if (hold.status !== 'authorized') {
    if (hold.paymentId != null && hold.paymentId !== guest.providerPaymentId) {
      await db
        .update(guestSessions)
        .set({
          providerPaymentId: hold.paymentId,
          updatedAt: new Date(),
        })
        .where(and(eq(guestSessions.id, guest.id), eq(guestSessions.status, 'pending_payment')));
    }
    return { outcome: 'action_required', action: hold.action };
  }

  const paymentId = hold.paymentId;
  const moved = await db
    .update(guestSessions)
    .set({
      providerPaymentId: paymentId,
      status: 'payment_authorized',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(guestSessions.id, guest.id),
        sql`${guestSessions.expiresAt} > now()`,
        sql`(${guestSessions.status} = 'pending_payment' OR (${guestSessions.status} = 'payment_authorized' AND ${guestSessions.providerPaymentId} = ${paymentId}))`,
      ),
    )
    .returning({ id: guestSessions.id });
  if (moved.length === 0) {
    ctx.logger.warn(
      { guestSessionId: guest.id, paymentId },
      'Guest hold authorized for a session that is no longer waiting; cancelling it',
    );
    await cancelQuietly(provider, paymentId, `${GUEST_REFERENCE_PREFIX}${input.sessionToken}`, ctx);
    return { outcome: 'not_pending' };
  }
  return {
    outcome: 'authorized',
    paymentId,
    preAuthAmountCents: guest.preAuthAmountCents ?? 0,
  };
}

export type GuestAttachOutcome =
  /** The waiting guest session now holds the authorisation. */
  | 'attached'
  /** The session already holds this payment (the client's details step came first). */
  | 'already_attached'
  /** No guest session with this token: it was never stored (its start rolled back). */
  | 'missing'
  /** The session expired, failed or holds another payment: the authorisation is an orphan. */
  | 'orphan';

/**
 * An authorisation the provider reports for a guest checkout (Adyen
 * `AUTHORISATION`, merchant reference `guest_<token>`), for a guest who
 * finished 3DS at the issuer but whose browser never sent the details (owner
 * decision O4). A session still waiting for its payment, not expired and
 * pinned to the same provider, takes the hold (`payment_authorized`). The
 * caller cancels an orphan.
 */
export async function attachGuestAuthorisation(input: {
  provider: PaymentProviderId;
  sessionToken: string;
  paymentId: string;
}): Promise<GuestAttachOutcome> {
  const [guest] = await db
    .select({
      id: guestSessions.id,
      provider: guestSessions.provider,
      providerPaymentId: guestSessions.providerPaymentId,
    })
    .from(guestSessions)
    .where(eq(guestSessions.sessionToken, input.sessionToken));
  if (guest == null) return 'missing';
  const moved = await db
    .update(guestSessions)
    .set({
      providerPaymentId: input.paymentId,
      status: 'payment_authorized',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(guestSessions.id, guest.id),
        eq(guestSessions.status, 'pending_payment'),
        eq(guestSessions.provider, input.provider),
        sql`${guestSessions.expiresAt} > now()`,
        sql`(${guestSessions.providerPaymentId} IS NULL OR ${guestSessions.providerPaymentId} = ${input.paymentId})`,
      ),
    )
    .returning({ id: guestSessions.id });
  if (moved.length > 0) return 'attached';
  return guest.provider === input.provider && guest.providerPaymentId === input.paymentId
    ? 'already_attached'
    : 'orphan';
}

export type GuestStartClaim =
  /** This caller sends RequestStartTransaction. */
  | { claim: 'claimed'; stationOcppId: string; evseId: number; paymentId: string | null }
  /** Another request already sent it (a replayed details step); the session runs or failed. */
  | { claim: 'already_requested' }
  /** No authorized, unexpired guest session under this token. */
  | { claim: 'not_startable' };

/**
 * Claims the station start of a guest session whose hold is authorized: the
 * first caller sets `start_requested_at` and sends RequestStartTransaction;
 * every later caller (a reloaded return page, a second details post after the
 * webhook attached the hold) gets `already_requested`, so the station never
 * receives two starts for one guest (P7).
 */
export async function claimGuestStart(sessionToken: string): Promise<GuestStartClaim> {
  const [claimed] = await db
    .update(guestSessions)
    .set({ startRequestedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(guestSessions.sessionToken, sessionToken),
        eq(guestSessions.status, 'payment_authorized'),
        sql`${guestSessions.startRequestedAt} IS NULL`,
        sql`${guestSessions.expiresAt} > now()`,
      ),
    )
    .returning({
      stationOcppId: guestSessions.stationOcppId,
      evseId: guestSessions.evseId,
      paymentId: guestSessions.providerPaymentId,
    });
  if (claimed != null) return { claim: 'claimed', ...claimed };
  const [guest] = await db
    .select({ startRequestedAt: guestSessions.startRequestedAt })
    .from(guestSessions)
    .where(eq(guestSessions.sessionToken, sessionToken));
  return guest?.startRequestedAt != null
    ? { claim: 'already_requested' }
    : { claim: 'not_startable' };
}

async function cancelQuietly(
  provider: PaymentProvider,
  paymentId: string,
  merchantReference: string,
  ctx: PaymentContext,
): Promise<void> {
  try {
    await provider.cancelHold({
      paymentId,
      merchantReference,
      idempotencyKey: cancelKey(paymentId),
    });
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
  const [deleted] = await db
    .delete(guestSessions)
    .where(eq(guestSessions.sessionToken, input.sessionToken))
    .returning({ provider: guestSessions.provider });
  if (input.paymentId == null) return;
  try {
    const provider = await pinnedProvider(ctx.registry, deleted?.provider ?? null);
    await cancelQuietly(
      provider,
      input.paymentId,
      `${GUEST_REFERENCE_PREFIX}${input.sessionToken}`,
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

  if (guest.providerPaymentId != null && guest.provider == null) {
    deps.logger.error(
      { guestSessionId: guest.id, paymentId: guest.providerPaymentId },
      'Guest hold has no provider; its payment record was not written',
    );
  } else if (guest.providerPaymentId != null && guest.provider != null) {
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
      provider: guest.provider,
      paymentId: guest.providerPaymentId,
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
 * Captures the guest's hold at the session's final cost. The hold is the
 * session's cost ceiling (stamped at Started), so the cost assembly bills at
 * most the hold and keeps a tariff price above it in the cost breakdown
 * (pricedGrossCents). A session without a ceiling (started before it was
 * stamped) can still end above the hold: the capture stays at the hold, as a
 * guest has no saved card for a top-up, and the uncollected rest is recorded
 * as `Guest shortfall:` (not picked up by the daily top-up retry). A cost of
 * 0 cancels the hold.
 *
 * Failures (finding J7):
 * - A definitive decline (`PaymentDeclinedError`) marks the record failed,
 *   fails the guest session and releases the hold at once (P4). No retry.
 * - Any other error (provider 5xx or timeout, a database error, also one
 *   after the provider captured) leaves the record `pre_authorized` and
 *   rethrows, so the BullMQ retry captures again with the same `captureKey`
 *   (P7): the provider answers with the capture it already made, and the
 *   retry records it. After the last attempt the worker's failed hook runs
 *   `failExhaustedGuestCapture`.
 *
 * Idempotent: a record already captured or cancelled is not sent to the
 * provider again; a retry only completes the guest session (and sends the
 * receipt) when an earlier run recorded the payment but stopped before that.
 */
async function finalizeGuestPayment(sessionId: string, deps: GuestEventDeps): Promise<void> {
  const [guest] = await db
    .select({
      id: guestSessions.id,
      guestEmail: guestSessions.guestEmail,
      stationOcppId: guestSessions.stationOcppId,
      status: guestSessions.status,
    })
    .from(guestSessions)
    .where(eq(guestSessions.chargingSessionId, sessionId));
  if (guest == null) return;

  const record = await findSessionRecord(sessionId);
  if (record?.status === 'failed') {
    // Only a decline or the exhausted hook fails the record, and both fail the
    // guest session and release the hold. A retry that finds it failed (the
    // earlier run stopped before the guest session update) finishes that now
    // (P4); the cancel is keyed by the hold, so a second one is harmless.
    deps.logger.warn(
      { guestSessionId: guest.id, paymentRecordId: record.id },
      'Guest capture failed earlier; failing the guest session and releasing the hold',
    );
    await failGuestSessionAndReleaseHold(sessionId, record, deps);
    return;
  }
  if (record != null && (record.status === 'captured' || record.status === 'cancelled')) {
    if (guest.status === 'charging') {
      // An earlier run recorded the payment and stopped before completing the
      // guest session, so it sent no receipt either. A release below the
      // provider minimum (a cancel with a reason) charged nothing: no receipt.
      // A capture the provider has not confirmed yet gets its receipt from
      // the confirming webhook (finding JB-3).
      deps.logger.warn(
        { guestSessionId: guest.id, paymentRecordId: record.id, status: record.status },
        'Guest payment recorded earlier; completing the guest session',
      );
      await completeGuestSession(guest.id);
      if (
        (record.status === 'captured' && record.pendingOperation !== 'capture') ||
        (record.status === 'cancelled' && record.failureReason == null)
      ) {
        await sendGuestReceipt(guest, sessionId, deps);
      }
      return;
    }
    deps.logger.info(
      { guestSessionId: guest.id, paymentRecordId: record.id, status: record.status },
      'Skipping guest payment finalization, already terminal',
    );
    return;
  }
  const paymentId = record?.providerPaymentId ?? null;
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
    provider = await pinnedProvider(deps.registry, record.provider);
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
    const minimumCents =
      finalCost > 0 ? belowMinimumCharge(provider, record.currency, finalCost) : null;
    if (minimumCents != null) {
      // The provider refuses a charge this small, and every retry of a refused
      // capture failed until the exhausted hook released the hold: release it now.
      const cancelled = await provider.cancelHold({
        paymentId,
        merchantReference,
        idempotencyKey: cancelKey(paymentId),
      });
      deps.logger.warn(
        { guestSessionId: guest.id, finalCost, minimumCents },
        'Guest cost below the provider minimum charge; hold released, cost uncollected',
      );
      await markCancelled(
        record.id,
        pendingRef(cancelled),
        belowMinimumCaptureReason(finalCost, minimumCents, record.currency),
      );
      // Nothing was charged, so no receipt.
      await completeGuestSession(guest.id);
      return;
    }
    if (finalCost > 0) {
      const holdCents = record.preAuthAmountCents ?? finalCost;
      const captureCents = Math.min(finalCost, holdCents);
      const shortfallCents = finalCost - captureCents;
      const captured = await provider.capture({
        paymentId,
        amountCents: captureCents,
        currency: record.currency,
        merchantReference,
        payoutAccountId: null,
        feeTax: sessionChargeTax(session),
        platformFeePercent: await getPlatformFeePercent(session.siteId),
        idempotencyKey: captureKey(paymentId),
      });
      const failureReason =
        shortfallCents > 0
          ? `Guest shortfall: hold ${String(holdCents)}c captured, ${String(shortfallCents)}c uncollected (no saved card for a top-up)`
          : null;
      const pricedCents = parseSessionCostBreakdown(session.costBreakdown)?.pricedGrossCents;
      if (shortfallCents > 0) {
        deps.logger.warn(
          { guestSessionId: guest.id, finalCost, holdCents, shortfallCents },
          'Guest session cost exceeds the hold; captured the hold, shortfall uncollected',
        );
      } else if (pricedCents != null) {
        deps.logger.info(
          { guestSessionId: guest.id, amountCents: captureCents, pricedCents },
          'Captured guest payment at the hold; the tariff price above it was not billed',
        );
      } else {
        deps.logger.info(
          { guestSessionId: guest.id, amountCents: captureCents },
          'Captured guest payment',
        );
      }
      const captureRef = pendingRef(captured);
      await markCaptured(record.id, {
        capturedCents: captureCents,
        failureReason,
        pendingRef: captureRef,
      });
      await completeGuestSession(guest.id);
      // An async capture is not final until the provider confirms it: the
      // confirming webhook sends the receipt, a failure sends none (JB-3).
      if (captureRef == null) await sendGuestReceipt(guest, sessionId, deps);
      return;
    } else {
      const cancelled = await provider.cancelHold({
        paymentId,
        merchantReference,
        idempotencyKey: cancelKey(paymentId),
      });
      deps.logger.info({ guestSessionId: guest.id }, 'Cancelled zero-cost guest payment intent');
      await markCancelled(record.id, pendingRef(cancelled));
    }
    await completeGuestSession(guest.id);
    await sendGuestReceipt(guest, sessionId, deps);
  } catch (err) {
    if (err instanceof PaymentDeclinedError) {
      // Definitive: a retry would be declined again.
      deps.logger.error(
        { err, guestSessionId: guest.id },
        'Guest capture declined; failing the guest session and releasing the hold',
      );
      await markHoldFailed(record.id, errorMessage(err, 'Capture declined'));
      await failGuestSessionAndReleaseHold(sessionId, record, deps);
      return;
    }
    // Transient, or the capture went through and recording it failed: the
    // record stays pre_authorized and BullMQ retries the job (3 attempts)
    // with the same captureKey. After the last one the worker's failed hook
    // fails the guest session and cancels the hold.
    deps.logger.error({ err, guestSessionId: guest.id }, 'Failed to finalize guest payment');
    throw err;
  }
}

/**
 * The guest's session.Receipt once the provider confirmed an async capture
 * (`dispatchPaymentWebhookNotices`, finding JB-3). Nothing for a session
 * without a guest session.
 */
export async function sendGuestReceiptForSession(
  sessionId: string,
  deps: Pick<GuestEventDeps, 'templatesDirs' | 'logger'>,
): Promise<void> {
  const [guest] = await db
    .select({
      id: guestSessions.id,
      guestEmail: guestSessions.guestEmail,
      stationOcppId: guestSessions.stationOcppId,
    })
    .from(guestSessions)
    .where(eq(guestSessions.chargingSessionId, sessionId));
  if (guest == null) return;
  await sendGuestReceipt(guest, sessionId, deps);
}

/**
 * Sends the guest receipt once per session: the claim (`receipt_notified_at`,
 * the column the driver receipt uses) also requires that the session's
 * payment is final, neither failed nor waiting for an async capture or
 * adjustment, so a finalization rerun and the confirming webhook send it once.
 */
async function sendGuestReceipt(
  guest: { id: number; guestEmail: string; stationOcppId: string },
  sessionId: string,
  deps: Pick<GuestEventDeps, 'templatesDirs' | 'logger'>,
): Promise<void> {
  if (guest.guestEmail === '') return;
  try {
    const claimed = await db
      .update(chargingSessions)
      .set({ receiptNotifiedAt: new Date() })
      .where(
        and(
          eq(chargingSessions.id, sessionId),
          sql`${chargingSessions.receiptNotifiedAt} IS NULL AND NOT EXISTS (
            SELECT 1 FROM (
              SELECT pr.status, pr.pending_operation FROM payment_records pr
              WHERE pr.session_id = ${sessionId}
              ORDER BY pr.id LIMIT 1
            ) first_record
            WHERE first_record.status = 'failed'
              OR first_record.pending_operation IN ('capture', 'adjust')
          )`,
        ),
      )
      .returning({ id: chargingSessions.id });
    if (claimed.length === 0) return;
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
  const record = await findSessionRecord(sessionId);
  if (record?.status === 'pre_authorized') {
    await markHoldFailed(record.id, `Capture worker exhausted retries: ${reason}`);
  }
  await failGuestSessionAndReleaseHold(
    sessionId,
    record?.status === 'pre_authorized' || record?.status === 'failed' ? record : null,
    ctx,
  );
}

/**
 * Fails the guest session of a charging session and cancels the hold of its
 * failed payment record (best effort, keyed by the hold, so a second call
 * sends the same cancel). `record` null: nothing to cancel.
 */
async function failGuestSessionAndReleaseHold(
  sessionId: string,
  record: PaymentRecord | null,
  ctx: PaymentContext,
): Promise<void> {
  await db
    .update(guestSessions)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(eq(guestSessions.chargingSessionId, sessionId));
  const paymentId = record?.providerPaymentId ?? null;
  if (record == null || paymentId == null) return;
  try {
    const provider = await pinnedProvider(ctx.registry, record.provider);
    await provider.cancelHold({
      paymentId,
      merchantReference: `sess_${sessionId}`,
      idempotencyKey: cancelKey(paymentId),
    });
  } catch (err) {
    ctx.logger.warn(
      { sessionId, paymentRecordId: record.id, err },
      'Failed to cancel the guest hold after the capture failed; it expires by itself',
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
    if (gs.providerPaymentId != null) {
      try {
        const provider = await pinnedProvider(ctx.registry, gs.provider);
        await provider.cancelHold({
          paymentId: gs.providerPaymentId,
          merchantReference: `${GUEST_REFERENCE_PREFIX}${gs.sessionToken}`,
          idempotencyKey: cancelKey(gs.providerPaymentId),
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
