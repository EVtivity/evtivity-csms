// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, sql } from 'drizzle-orm';
import {
  chargingSessions,
  chargingStations,
  db,
  driverPaymentMethods,
  driverTokens,
  getPlatformFeePercent,
  pgConnectionErrorKind,
} from '@evtivity/database';
import { sessionChargeTax } from '@evtivity/lib';
import { errorMessage, pendingRef } from './context.js';
import type { PaymentContext } from './context.js';
import { PaymentDeclinedError, PaymentProviderNotConfiguredError } from './errors.js';
import { adjustKey, cancelKey, captureKey, topUpKey, topUpRetryKey } from './idempotency-keys.js';
import { classifySessionPayment } from './payment-mode.js';
import { pinnedProvider } from './pinning.js';
import {
  clearPendingAdjustment,
  findRecord,
  findSessionHold,
  findSessionRecord,
  markCancelled,
  markCaptured,
  markAdjustmentPending,
  markHoldFailed,
  markShortfallRecovered,
  markShortfallRetryFailed,
  recordFailedHold,
  recordHold,
  setAdjustmentRef,
  reclaimStaleAdjustment,
  settlePrepaidSession,
  staleAdjustmentClaims,
} from './payment-records.js';
import type { PaymentRecord } from './payment-records.js';
import {
  PAYOUT_NOT_READY_FAILURE,
  PAYOUT_NOT_READY_REASON,
  sitePayoutReadiness,
} from './payout-accounts.js';
import { getSitePaymentConfig } from './settings.js';
import type { PaymentProvider, PaymentStatus, ProviderState } from './types.js';

/** Hold amount, site config and payout account of new holds at a site. */
export interface HoldTerms {
  preAuthAmountCents: number;
  sitePaymentConfigId: number | null;
  /** The payout account of a destination charge; set only when the account is ready. */
  payoutAccountId: string | null;
  /**
   * The site's payout account cannot receive payments yet (not `active`, or
   * its status could not be read): new holds and charges are refused (O5,
   * fail closed), never moved to the platform.
   */
  payoutBlocked: boolean;
}

/**
 * The enabled site config wins over the global `payments.preAuthAmountCents`.
 * Its payout account is used only when it is ready (`sitePayoutReadiness`).
 */
export async function holdTerms(ctx: PaymentContext, siteId: string | null): Promise<HoldTerms> {
  const site = siteId != null ? await getSitePaymentConfig(siteId) : null;
  if (siteId != null && site != null) {
    const readiness =
      site.payoutAccountId == null ? 'none' : await sitePayoutReadiness(siteId, ctx);
    return {
      preAuthAmountCents: site.preAuthAmountCents,
      sitePaymentConfigId: site.configId,
      payoutAccountId: readiness === 'ready' ? site.payoutAccountId : null,
      payoutBlocked: readiness === 'not_ready',
    };
  }
  const settings = await ctx.registry.settings();
  return {
    preAuthAmountCents: settings.preAuthAmountCents,
    sitePaymentConfigId: null,
    payoutAccountId: null,
    payoutBlocked: false,
  };
}

export interface SessionHoldInput {
  sessionId: string;
  /** The session's driver (null on an operator pre-auth of a session without one). */
  driverId: string | null;
  /** A `driver_payment_methods` row; null takes the driver's default method. */
  methodRowId: number | null;
  siteId: string | null;
  /** Operator override; default the site or global hold amount. */
  amountCents?: number;
  trigger: 'portal_start' | 'projection_gate' | 'operator';
}

export type HoldOutcome =
  | { outcome: 'authorized'; paymentRecordId: number; paymentId: string }
  /** The session already has a payment record (a replay, or the other trigger placed it). */
  | { outcome: 'exists'; paymentRecordId: number; status: PaymentStatus }
  /**
   * Declined or not authorizable off session; a `failed` record was written
   * when none existed. `failure` is `declined` when the provider refused the
   * payment (card declined, authentication required) or the site's payout
   * account is not ready (`code` set, no provider call was made), and
   * `provider_error` when the provider call failed (unreachable, rejected
   * credentials or configuration).
   */
  | {
      outcome: 'declined';
      reason: string;
      paymentRecordId: number | null;
      failure: 'declined' | 'provider_error';
      code?: 'payout_account_not_ready';
    }
  /** The provider the method is pinned to is not available in this process. */
  | { outcome: 'not_configured'; providerId: string }
  | { outcome: 'no_method' }
  /** The hold was placed but its record could not be written; the hold was cancelled. */
  | { outcome: 'record_failed'; reason: string };

interface MethodRow {
  id: number;
  provider: string;
  customerId: string;
  methodId: string;
}

async function sessionMethod(input: SessionHoldInput): Promise<MethodRow | null> {
  // The given row, else the default method of the session's driver.
  const condition =
    input.methodRowId != null
      ? eq(driverPaymentMethods.id, input.methodRowId)
      : input.driverId != null
        ? and(
            eq(driverPaymentMethods.driverId, input.driverId),
            eq(driverPaymentMethods.isDefault, true),
          )
        : null;
  if (condition == null) return null;
  const [row] = await db
    .select({
      id: driverPaymentMethods.id,
      provider: driverPaymentMethods.provider,
      customerId: driverPaymentMethods.providerCustomerId,
      methodId: driverPaymentMethods.providerPaymentMethodId,
    })
    .from(driverPaymentMethods)
    .where(condition)
    .limit(1);
  return row ?? null;
}

async function sessionCurrency(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ currency: sql<string>`upper(${chargingSessions.currency})` })
    .from(chargingSessions)
    .where(eq(chargingSessions.id, sessionId));
  return row?.currency ?? null;
}

/**
 * Places the manual-capture hold of a driver session and records it. The
 * three triggers (portal fail-fast start, OCPP projection gate, operator)
 * share the idempotency key `preauth_<sessionId>` (P7), so a retry or the
 * second trigger never places a second hold; an existing record is returned
 * as `exists` without calling the provider. The hold is off session
 * (merchant initiated), in the session's currency, on the site's payout
 * account. When the record cannot be written after the provider placed the
 * hold, the hold is cancelled (P4 compensation) and logged at error.
 */
export async function authorizeSessionHold(
  input: SessionHoldInput,
  ctx: PaymentContext,
): Promise<HoldOutcome> {
  const existing = await findSessionRecord(input.sessionId);
  if (existing != null) {
    return { outcome: 'exists', paymentRecordId: existing.id, status: existing.status };
  }
  const method = await sessionMethod(input);
  if (method == null) return { outcome: 'no_method' };

  let provider: PaymentProvider;
  try {
    provider = await pinnedProvider(ctx.registry, method.provider);
  } catch (err) {
    if (err instanceof PaymentProviderNotConfiguredError) {
      return { outcome: 'not_configured', providerId: err.providerId };
    }
    throw err;
  }

  const [terms, currency] = await Promise.all([
    holdTerms(ctx, input.siteId),
    sessionCurrency(input.sessionId),
  ]);
  if (currency == null) throw new Error(`Session ${input.sessionId} not found`);
  const amountCents = input.amountCents ?? terms.preAuthAmountCents;
  const failed = (reason: string): Promise<number | null> =>
    recordFailedHold({
      sessionId: input.sessionId,
      driverId: input.driverId,
      sitePaymentConfigId: terms.sitePaymentConfigId,
      provider: provider.id,
      customerId: method.customerId,
      methodId: method.methodId,
      source: 'web_portal',
      currency,
      preAuthAmountCents: input.trigger === 'operator' ? amountCents : null,
      reason,
    });

  if (terms.payoutBlocked) {
    ctx.logger.warn(
      { sessionId: input.sessionId, siteId: input.siteId, trigger: input.trigger },
      'Session pre-authorization refused: the payout account of the site is not ready',
    );
    let recordId: number | null = null;
    try {
      recordId = await failed(PAYOUT_NOT_READY_FAILURE);
    } catch (dbErr) {
      ctx.logger.error(
        { err: dbErr, sessionId: input.sessionId },
        'Failed to record the refused pre-authorization',
      );
    }
    return {
      outcome: 'declined',
      reason: PAYOUT_NOT_READY_REASON,
      paymentRecordId: recordId,
      failure: 'declined',
      code: 'payout_account_not_ready',
    };
  }

  let paymentId: string;
  let providerState: ProviderState | null = null;
  try {
    const hold = await provider.authorizeHold({
      method: { kind: 'saved', customerId: method.customerId, methodId: method.methodId },
      initiator: 'merchant',
      merchantReference: `sess_${input.sessionId}`,
      amountCents,
      currency,
      payoutAccountId: terms.payoutAccountId,
      idempotencyKey: `preauth_${input.sessionId}`,
    });
    if (hold.status !== 'authorized') {
      // Off session there is nobody to complete a 3DS step.
      throw new PaymentDeclinedError('Payment requires authentication', {
        code: 'authentication_required',
      });
    }
    paymentId = hold.paymentId;
    providerState = hold.providerState ?? null;
  } catch (err) {
    const reason = errorMessage(err, 'Unknown pre-auth error');
    ctx.logger.warn(
      { err, sessionId: input.sessionId, trigger: input.trigger },
      'Session pre-authorization declined',
    );
    let recordId: number | null = null;
    try {
      recordId = await failed(reason);
    } catch (dbErr) {
      ctx.logger.error(
        { err: dbErr, sessionId: input.sessionId },
        'Failed to record the declined pre-authorization',
      );
    }
    return {
      outcome: 'declined',
      reason,
      paymentRecordId: recordId,
      failure: err instanceof PaymentDeclinedError ? 'declined' : 'provider_error',
    };
  }

  try {
    const recordId = await recordHold({
      sessionId: input.sessionId,
      driverId: input.driverId,
      sitePaymentConfigId: terms.sitePaymentConfigId,
      provider: provider.id,
      paymentId,
      customerId: method.customerId,
      methodId: method.methodId,
      source: 'web_portal',
      currency,
      preAuthAmountCents: amountCents,
      providerState,
    });
    if (recordId != null) return { outcome: 'authorized', paymentRecordId: recordId, paymentId };
    // A concurrent trigger recorded first. With the shared key it is this hold.
    const winner = await findSessionRecord(input.sessionId);
    if (winner == null) throw new Error('Payment record vanished after a conflict');
    return { outcome: 'exists', paymentRecordId: winner.id, status: winner.status };
  } catch (err) {
    ctx.logger.error(
      { err, sessionId: input.sessionId, paymentId },
      'Failed to record successful pre-auth; reversing the hold',
    );
    try {
      await provider.cancelHold({
        paymentId,
        merchantReference: `sess_${input.sessionId}`,
        idempotencyKey: cancelKey(paymentId),
      });
    } catch (cancelErr) {
      ctx.logger.error(
        { err: cancelErr, sessionId: input.sessionId, paymentId },
        'Failed to cancel the hold after the record write failed; manual reconciliation required',
      );
    }
    return { outcome: 'record_failed', reason: errorMessage(err, 'Unknown database error') };
  }
}

interface SessionCharge {
  finalCostCents: number | null;
  tariffTaxRate: string | null;
  costBreakdown: unknown;
  siteId: string | null;
}

async function sessionCharge(sessionId: string): Promise<SessionCharge | null> {
  const [row] = await db
    .select({
      finalCostCents: chargingSessions.finalCostCents,
      tariffTaxRate: chargingSessions.tariffTaxRate,
      costBreakdown: chargingSessions.costBreakdown,
      siteId: chargingStations.siteId,
    })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
    .where(eq(chargingSessions.id, sessionId));
  return row ?? null;
}

export type ManualCaptureOutcome =
  | { status: 'captured' | 'cancelled'; record: PaymentRecord }
  | { status: 'no_hold' }
  | { status: 'missing_payment_id' }
  | { status: 'not_configured'; providerId: string };

/**
 * Operator capture of a session hold: `amountCents` (default the session's
 * final cost), or a cancel at 0. Same idempotency keys as the capture on
 * session end (`capture_<paymentId>`, `cancel_<paymentId>`).
 */
export async function captureSessionHold(
  input: { sessionId: string; amountCents?: number },
  ctx: PaymentContext,
): Promise<ManualCaptureOutcome> {
  const record = await findSessionHold(input.sessionId);
  if (record == null) return { status: 'no_hold' };
  const paymentId = record.providerPaymentId;
  if (paymentId == null) return { status: 'missing_payment_id' };
  const session = await sessionCharge(input.sessionId);
  const amountCents = input.amountCents ?? session?.finalCostCents ?? 0;

  let provider: PaymentProvider;
  try {
    provider = await pinnedProvider(ctx.registry, record.provider);
  } catch (err) {
    if (err instanceof PaymentProviderNotConfiguredError) {
      return { status: 'not_configured', providerId: err.providerId };
    }
    throw err;
  }

  if (amountCents === 0) {
    const cancelled = await provider.cancelHold({
      paymentId,
      merchantReference: `sess_${input.sessionId}`,
      idempotencyKey: cancelKey(paymentId),
    });
    if (!(await markCancelled(record.id, pendingRef(cancelled)))) {
      ctx.logger.warn({ paymentRecordId: record.id }, 'Hold cancelled but the record had moved on');
    }
    return { status: 'cancelled', record: (await findRecord(record.id)) ?? record };
  }

  const captured = await provider.capture({
    paymentId,
    amountCents,
    currency: record.currency,
    merchantReference: `sess_${input.sessionId}`,
    payoutAccountId: null,
    feeTax: sessionChargeTax({
      finalCostCents: session?.finalCostCents ?? null,
      tariffTaxRate: session?.tariffTaxRate ?? null,
      costBreakdown: session?.costBreakdown ?? null,
    }),
    platformFeePercent: await getPlatformFeePercent(session?.siteId ?? null),
    idempotencyKey: captureKey(paymentId),
  });
  if (
    !(await markCaptured(record.id, {
      capturedCents: amountCents,
      failureReason: null,
      pendingRef: pendingRef(captured),
    }))
  ) {
    ctx.logger.warn({ paymentRecordId: record.id }, 'Hold captured but the record had moved on');
  }
  return { status: 'captured', record: (await findRecord(record.id)) ?? record };
}

/** Cancels an open hold (cost 0, or a session given up on) and records it. */
export async function cancelSessionHold(
  record: PaymentRecord,
  reason: string,
  ctx: PaymentContext,
): Promise<void> {
  const paymentId = record.providerPaymentId;
  if (paymentId == null) return;
  const provider = await pinnedProvider(ctx.registry, record.provider);
  const cancelled = await provider.cancelHold({
    paymentId,
    merchantReference:
      record.sessionId != null ? `sess_${record.sessionId}` : `rec_${String(record.id)}`,
    idempotencyKey: cancelKey(paymentId),
  });
  if (!(await markCancelled(record.id, pendingRef(cancelled)))) {
    ctx.logger.warn(
      { paymentRecordId: record.id, reason },
      'Hold cancelled but the record had moved on',
    );
  }
}

export type OpenHoldCancelOutcome =
  | { status: 'cancelled'; paymentRecordId: number }
  /** No open hold on the session (none placed, or already settled). */
  | { status: 'none' };

/**
 * Cancels the open hold of a session that ended without being billed (a
 * remote start the driver never plugged in for, a stale session the cleanup
 * faulted), through the provider it is pinned to (`cancel_<paymentId>`). No
 * capture, whatever the session's cost. A provider error is thrown to the
 * caller.
 */
export async function cancelOpenSessionHold(
  sessionId: string,
  reason: string,
  ctx: PaymentContext,
): Promise<OpenHoldCancelOutcome> {
  const record = await findSessionHold(sessionId);
  if (record?.providerPaymentId == null) return { status: 'none' };
  await cancelSessionHold(record, reason, ctx);
  ctx.logger.info({ sessionId, paymentRecordId: record.id, reason }, 'Open session hold cancelled');
  return { status: 'cancelled', paymentRecordId: record.id };
}

export type ShortfallRetryOutcome =
  | { status: 'recovered'; record: PaymentRecord; shortfallCents: number; topUpId: string }
  | { status: 'failed'; reason: string }
  | { status: 'not_found' }
  | { status: 'not_recoverable'; reason: string }
  | { status: 'not_configured'; providerId: string };

interface ShortfallTarget {
  record: PaymentRecord;
  sessionId: string;
  finalCostCents: number;
  charge: SessionCharge;
}

/**
 * The provider's minimum charge when `amountCents` is below it (the provider
 * would refuse that charge), else null. Providers without a known minimum
 * never block.
 */
export function belowMinimumCharge(
  provider: PaymentProvider,
  currency: string,
  amountCents: number,
): number | null {
  const minimum = provider.minimumChargeCents?.(currency) ?? null;
  return minimum != null && amountCents > 0 && amountCents < minimum ? minimum : null;
}

/** Failure reason of a shortfall too small to charge. Not `Top-up declined:`, so never retried. */
function belowMinimumReason(
  shortfallCents: number,
  minimumCents: number,
  currency: string,
): string {
  return `Top-up below the provider minimum charge (${String(minimumCents)}c ${currency.toUpperCase()}); shortfall ${String(shortfallCents)}c not collectable`;
}

/** Start of the failure reason of a hold released because the cost is below the provider minimum. */
export const BELOW_MINIMUM_CAPTURE_PREFIX = 'Capture below the provider minimum charge';

/**
 * True when a payment record is a hold released, not captured, because the
 * session cost was below the provider minimum charge: nothing was charged.
 */
export function isReleasedBelowMinimum(record: {
  status: string;
  failureReason: string | null;
}): boolean {
  return (
    record.status === 'cancelled' &&
    record.failureReason != null &&
    record.failureReason.startsWith(BELOW_MINIMUM_CAPTURE_PREFIX)
  );
}

/**
 * Failure reason of a cost too small to capture: the hold is released and the
 * cost stays unpaid. A capture the provider refuses would leave the hold open.
 */
export function belowMinimumCaptureReason(
  costCents: number,
  minimumCents: number,
  currency: string,
): string {
  return `${BELOW_MINIMUM_CAPTURE_PREFIX} (${String(minimumCents)}c ${currency.toUpperCase()}); ${String(costCents)}c not collectable, hold released`;
}

class ShortfallBelowMinimumError extends Error {
  constructor(
    readonly shortfallCents: number,
    readonly minimumCents: number,
    readonly currency: string,
  ) {
    super(belowMinimumReason(shortfallCents, minimumCents, currency));
    this.name = 'ShortfallBelowMinimumError';
  }
}

async function chargeShortfall(
  target: ShortfallTarget,
  description: string,
  ctx: PaymentContext,
): Promise<{ topUpId: string; topUpCents: number; shortfallCents: number }> {
  const { record, finalCostCents, charge } = target;
  const captured = record.capturedAmountCents ?? 0;
  const paymentId = record.providerPaymentId as string;
  const provider = await pinnedProvider(ctx.registry, record.provider);
  const minimumCents = belowMinimumCharge(provider, record.currency, finalCostCents - captured);
  if (minimumCents != null) {
    throw new ShortfallBelowMinimumError(finalCostCents - captured, minimumCents, record.currency);
  }
  // Same card and payout account, with the platform fee of the increment on
  // its net amount, so capture and top-ups add up to the fee of the final cost.
  const topUp = await provider.chargeShortfall({
    originalPaymentId: paymentId,
    ...(record.providerCustomerId != null && record.providerPaymentMethodId != null
      ? {
          method: {
            customerId: record.providerCustomerId,
            methodId: record.providerPaymentMethodId,
          },
        }
      : {}),
    capturedCents: captured,
    finalCostCents,
    currency: record.currency,
    feeTax: sessionChargeTax({
      finalCostCents,
      tariffTaxRate: charge.tariffTaxRate,
      costBreakdown: charge.costBreakdown,
    }),
    platformFeePercent: await getPlatformFeePercent(charge.siteId),
    description,
    idempotencyKey: topUpRetryKey(paymentId, captured),
  });
  return {
    topUpId: topUp.paymentId,
    topUpCents: topUp.amountCents,
    shortfallCents: finalCostCents - captured,
  };
}

/**
 * Operator retry of a recorded shortfall (`captured` below the final cost).
 * Key `topup_retry_<paymentId>_<captured>`, shared with the daily retry, so the
 * same shortfall is charged once. A decline returns `failed` and leaves the
 * record for the next try.
 */
export async function retryShortfallForRecord(
  input: { recordId: number; actorUserId: string },
  ctx: PaymentContext,
): Promise<ShortfallRetryOutcome> {
  const record = await findRecord(input.recordId);
  if (record == null) return { status: 'not_found' };
  if (record.providerPaymentId == null) {
    return { status: 'not_recoverable', reason: 'Payment has no provider payment' };
  }
  if (record.sessionId == null) {
    return { status: 'not_recoverable', reason: 'Payment is not linked to a session' };
  }
  const charge = await sessionCharge(record.sessionId);
  const finalCostCents = charge?.finalCostCents ?? 0;
  const captured = record.capturedAmountCents ?? 0;
  if (charge == null || finalCostCents - captured <= 0) {
    return { status: 'not_recoverable', reason: 'No shortfall to recover' };
  }
  let result: { topUpId: string; topUpCents: number; shortfallCents: number };
  try {
    result = await chargeShortfall(
      { record, sessionId: record.sessionId, finalCostCents, charge },
      `Retry top-up for session ${record.sessionId}`,
      ctx,
    );
  } catch (err) {
    if (err instanceof PaymentProviderNotConfiguredError) {
      return { status: 'not_configured', providerId: err.providerId };
    }
    if (err instanceof ShortfallBelowMinimumError) {
      return { status: 'not_recoverable', reason: err.message };
    }
    return { status: 'failed', reason: errorMessage(err, 'Top-up failed', 400) };
  }
  const updated = await markShortfallRecovered(record.id, {
    capturedCents: finalCostCents,
    actorUserId: input.actorUserId,
    actionReason: `Operator retry top-up; recovered ${String(result.shortfallCents)}c via ${result.topUpId}`,
    topUp: { paymentId: result.topUpId, amountCents: result.topUpCents },
  });
  return {
    status: 'recovered',
    record: updated ?? record,
    shortfallCents: result.shortfallCents,
    topUpId: result.topUpId,
  };
}

interface ShortfallRow extends Record<string, unknown> {
  pr_id: number;
  session_id: string;
}

/**
 * Daily retry of declined top-ups (records `captured` below the final cost
 * with a `Top-up declined:` reason, last 30 days, oldest first, 100 per run).
 * A record still declined gets the new reason and is tried again next run.
 */
export async function retryShortfalls(
  ctx: PaymentContext,
): Promise<{ total: number; recovered: number; stillFailed: number; notCollectable: number }> {
  const rows = await db.execute<ShortfallRow>(sql`
    SELECT pr.id AS pr_id, cs.id AS session_id
    FROM payment_records pr
    JOIN charging_sessions cs ON cs.id = pr.session_id
    WHERE pr.status = 'captured'
      AND pr.failure_reason IS NOT NULL
      AND pr.failure_reason LIKE 'Top-up declined:%'
      AND pr.captured_amount_cents IS NOT NULL
      AND cs.final_cost_cents IS NOT NULL
      AND cs.final_cost_cents > pr.captured_amount_cents
      AND pr.created_at > now() - interval '30 days'
    ORDER BY pr.created_at ASC
    LIMIT 100
  `);
  let recovered = 0;
  let stillFailed = 0;
  let notCollectable = 0;
  for (const row of rows) {
    const record = await findRecord(row.pr_id);
    const charge = await sessionCharge(row.session_id);
    if (record?.providerPaymentId == null || charge == null) continue;
    const finalCostCents = charge.finalCostCents ?? 0;
    const shortfall = finalCostCents - (record.capturedAmountCents ?? 0);
    if (shortfall <= 0) continue;
    try {
      const result = await chargeShortfall(
        { record, sessionId: row.session_id, finalCostCents, charge },
        `Capture retry for session ${row.session_id}`,
        ctx,
      );
      await markShortfallRecovered(record.id, {
        capturedCents: finalCostCents,
        actorUserId: null,
        actionReason: `Cron retry top-up; recovered ${String(shortfall)}c via ${result.topUpId}`,
        topUp: { paymentId: result.topUpId, amountCents: result.topUpCents },
      });
      recovered++;
      ctx.logger.info(
        { paymentRecordId: record.id, shortfall, topUpIntentId: result.topUpId },
        'Recovered capture shortfall via cron retry',
      );
    } catch (err) {
      if (err instanceof PaymentProviderNotConfiguredError) {
        ctx.logger.warn(
          { paymentRecordId: record.id, providerId: err.providerId },
          'Payment provider not configured; cannot retry the shortfall',
        );
        continue;
      }
      if (err instanceof ShortfallBelowMinimumError) {
        // A record declined before the minimum check (or under a lower
        // minimum): give it the non-retryable reason so later runs skip it.
        notCollectable++;
        ctx.logger.warn(
          { paymentRecordId: record.id, shortfall, minimumCents: err.minimumCents },
          'Shortfall below the provider minimum charge; no further retries',
        );
        try {
          await markShortfallRetryFailed(record.id, err.message);
        } catch (updateErr) {
          ctx.logger.warn(
            { err: updateErr, paymentRecordId: record.id },
            'Failed to record the not collectable shortfall',
          );
        }
        continue;
      }
      stillFailed++;
      const message = errorMessage(err, 'Unknown error', 350);
      ctx.logger.warn(
        { paymentRecordId: record.id, shortfall, err },
        'Capture retry failed; will try again next run',
      );
      try {
        await markShortfallRetryFailed(
          record.id,
          `Top-up declined: ${message}; shortfall ${String(shortfall)}c (last retry ${new Date().toISOString()})`,
        );
      } catch (updateErr) {
        // The record keeps its previous reason and is retried next run (P9).
        ctx.logger.warn(
          { err: updateErr, paymentRecordId: record.id },
          'Failed to record the capture retry failure reason',
        );
      }
    }
  }
  return { total: rows.length, recovered, stillFailed, notCollectable };
}

export type SettlementOutcome =
  /** The prepaid balance of the session's token was debited. */
  | {
      mode: 'prepaid';
      tokenId: string;
      debitedCents: number;
      balanceCents: number;
      /** The debit was already recorded (a repeated settlement); nothing was debited now. */
      repeated?: true;
    }
  | {
      mode: 'card';
      status: 'captured';
      paymentRecordId: number;
      driverId: string;
      /** The hold capture plus a successful top-up. */
      capturedCents: number;
      /** Final cost above what was collected (a declined top-up); 0 otherwise. */
      shortfallCents: number;
      /** False when the provider charged but the record could not be updated. */
      recorded: boolean;
    }
  | { mode: 'card'; status: 'cancelled'; paymentRecordId: number; recorded: boolean }
  | { mode: 'card'; status: 'failed'; paymentRecordId: number; driverId: string; reason: string }
  /**
   * The hold is being raised to the final cost (an async authorisation
   * adjustment). The record stays `pre_authorized` with `pending_operation =
   * 'adjust'`; the adjustment webhook captures (`settleAdjustedHold`) and the
   * driver hears about the payment then.
   */
  | { mode: 'card'; status: 'adjusting'; paymentRecordId: number; driverId: string }
  /**
   * Charge on account (`billing_mode = 'account'`): billed to the fleet on its
   * invoice. No provider call and no payment record; the billing state is the
   * session's invoice (`invoice_id`).
   */
  | { mode: 'account'; billingFleetId: string }
  /** A guest hold (no driver): the worker finalizes it. */
  | { mode: 'guest' }
  /** Nothing to settle (no open hold, a free or roaming session). */
  | { mode: 'none' };

interface SettlementSession extends SessionCharge {
  id: string;
  driverId: string | null;
  isRoaming: boolean;
  freeVend: boolean;
  prepaid: boolean;
  account: boolean;
  billingFleetId: string | null;
}

async function settlementSession(sessionId: string): Promise<SettlementSession | null> {
  const [row] = await db
    .select({
      id: chargingSessions.id,
      driverId: chargingSessions.driverId,
      isRoaming: chargingSessions.isRoaming,
      freeVend: chargingSessions.freeVend,
      prepaid: sql<boolean>`${driverTokens.prepaidBalanceCents} IS NOT NULL`,
      account: sql<boolean>`${chargingSessions.billingMode} IS NOT DISTINCT FROM 'account'`,
      billingFleetId: chargingSessions.billingFleetId,
      finalCostCents: chargingSessions.finalCostCents,
      tariffTaxRate: chargingSessions.tariffTaxRate,
      costBreakdown: chargingSessions.costBreakdown,
      siteId: chargingStations.siteId,
    })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
    .leftJoin(driverTokens, eq(driverTokens.id, chargingSessions.tokenId))
    .where(eq(chargingSessions.id, sessionId));
  return row ?? null;
}

/**
 * Settles an ended session (TransactionEvent Ended, 1.6 StopTransaction). A
 * prepaid token's balance is debited (once: its record is the idempotency
 * marker). An account session (stamped `billing_mode = 'account'`) returns
 * `account` with no provider call and no payment record. A driver's open hold is captured by the provider it is pinned to,
 * at most the hold (`capture_<paymentId>`); a final cost above the hold is
 * charged as a top-up on the same card and payout account (`topup_<paymentId>`),
 * and a declined top-up leaves the record `captured` with a `Top-up declined:`
 * reason for the daily retry. A provider whose shortfall is `adjust_hold`
 * (Adyen with `adyen.authorisationAdjustment`) first raises the hold to the
 * final cost (`adjust_<paymentId>_<finalCost>`): a synchronous success
 * captures the final cost, an async answer returns `adjusting` and the
 * adjustment webhook settles (`settleAdjustedHold`), a refusal or an error
 * falls back to the top-up. A cost of 0 cancels the hold
 * (`cancel_<paymentId>`). An async provider's capture or cancel is recorded
 * optimistically with its pending operation, which the webhook confirms or
 * fails (`webhooks.ts`). A failed capture or cancel marks the record `failed`
 * (only from `pre_authorized`, P5). When the provider charged but the record
 * cannot be updated, the outcome says `recorded: false` and the error is
 * logged; no failure is reported to the driver. A guest hold is left to the
 * worker. Notifications stay with the caller. See `SettlementOptions` for a
 * caller that retries the settlement after a lost database connection.
 */
export async function settleSessionPayment(
  sessionId: string,
  ctx: PaymentContext,
  options: SettlementOptions = SETTLEMENT_DEFAULTS,
): Promise<SettlementOutcome> {
  const session = await settlementSession(sessionId);
  if (session == null) return { mode: 'none' };
  const mode = classifySessionPayment({ ...session, guestSession: false });

  if (mode === 'prepaid') {
    try {
      const settled = await settlePrepaidSession(sessionId, ctx.logger);
      if (settled != null) return { mode: 'prepaid', ...settled };
    } catch (err) {
      // A lost connection is the caller's to retry: reporting no debit here
      // would leave the balance undebited for good.
      if (options.rethrowConnectionErrors && pgConnectionErrorKind(err) != null) throw err;
      ctx.logger.error({ err, sessionId }, 'Prepaid balance debit failed');
    }
  }

  // An open hold is settled whatever the mode: an operator can place one on
  // any session, and it must not stay held. An account session collected by
  // a card this way has a payment record, so the fleet invoice leaves it out.
  const record = await findSessionHold(sessionId);
  if (record == null) {
    // Account: the stamp (read, not the current fleet state) says the fleet
    // bills it; nothing to charge here.
    if (mode === 'account' && session.billingFleetId != null) {
      return { mode: 'account', billingFleetId: session.billingFleetId };
    }
    return { mode: 'none' };
  }
  if (record.driverId == null) return { mode: 'guest' };
  if (record.providerPaymentId == null) return { mode: 'none' };
  if (record.pendingOperation === 'adjust') {
    // A rerun finds a claim without a provider reference that no settlement
    // in flight can still own (older than RESUME_ADJUSTMENT_MIN_AGE_MS): it
    // takes the claim over atomically and asks the provider again with the
    // same key. A fresher claim, its own first run's included, stays with its
    // owner, its webhook, or the reconciliation re-drive.
    if (options.resumeAdjustment && record.pendingOperationRef == null) {
      const claimed = await reclaimStaleAdjustment(
        record.id,
        new Date(Date.now() - RESUME_ADJUSTMENT_MIN_AGE_MS),
      );
      if (claimed != null) {
        return settleHold(claimed, session, { adjust: true, resume: true }, ctx, options);
      }
    }
    // An earlier settlement is raising the hold; its webhook settles.
    return {
      mode: 'card',
      status: 'adjusting',
      paymentRecordId: record.id,
      driverId: record.driverId,
    };
  }
  return settleHold(record, session, { adjust: true, resume: false }, ctx, options);
}

/**
 * How a caller that retries the settlement wants it run. The defaults keep
 * the behavior of a caller that does not retry.
 */
export interface SettlementOptions {
  /**
   * Throw a lost database connection (`pgConnectionErrorKind`) raised before
   * any provider call, and in the prepaid debit, for the caller to retry.
   * False (the default, and a retrying caller's last run): the prepaid
   * debit failure is logged and the hold is marked failed, as without retry.
   */
  rethrowConnectionErrors: boolean;
  /**
   * A rerun: a hold whose adjustment is claimed without a provider reference
   * (`pending_operation = 'adjust'`, no `pending_operation_ref`) is adjusted
   * again with the same key (`adjust_<paymentId>_<finalCost>`) instead of
   * being left to a webhook that may never come.
   */
  resumeAdjustment: boolean;
}

export const SETTLEMENT_DEFAULTS: SettlementOptions = {
  rethrowConnectionErrors: false,
  resumeAdjustment: false,
};

/** Adjustment claims without a provider reference older than this are re-driven. */
export const STALE_ADJUSTMENT_HOURS = 1;

/**
 * How old a claim without a reference must be before a settlement rerun takes
 * it over. A settlement in flight holds its claim without a reference for at
 * most its provider call: the Adyen client allows 3 attempts of 30 s with 0.5
 * and 1 s backoff (about 92 s), then stores the reference. Two minutes is past
 * that, and far past the projection retry window (about 1.5 s of backoff plus
 * the pool's connect timeouts), so a rerun only takes over a claim whose owner
 * is gone, never one a delivery in flight or its webhook may still settle.
 */
export const RESUME_ADJUSTMENT_MIN_AGE_MS = 120_000;

export interface StaleAdjustmentResult {
  resumed: number;
  /** Claims that could not be re-driven, with why (reported by the caller). */
  skipped: Array<{ paymentRecordId: number; reason: string }>;
}

/**
 * Re-drives adjustment claims the provider never answered or whose reference
 * was never stored (a settlement that lost its connection, P11 second layer
 * behind the settlement's own rerun). Each claim older than
 * STALE_ADJUSTMENT_HOURS is adjusted again with the same key, so the provider
 * replays its first answer, and the settlement continues as on session end.
 * Fail-open per record (warn): one record does not stop the rest.
 */
export async function resumeStaleAdjustments(
  ctx: PaymentContext,
  now: Date = new Date(),
): Promise<StaleAdjustmentResult> {
  const olderThan = new Date(now.getTime() - STALE_ADJUSTMENT_HOURS * 3600_000);
  const records = await staleAdjustmentClaims(olderThan);
  const result: StaleAdjustmentResult = { resumed: 0, skipped: [] };
  for (const stale of records) {
    try {
      // Taken over atomically: a concurrent re-drive, or a webhook that stored
      // the reference since the read, leaves nothing to take.
      const record = await reclaimStaleAdjustment(stale.id, olderThan);
      if (record == null) {
        ctx.logger.info(
          { paymentRecordId: stale.id },
          'Stale adjustment already taken over or settled; skipped',
        );
        continue;
      }
      const session = record.sessionId != null ? await settlementSession(record.sessionId) : null;
      if (
        session == null ||
        session.finalCostCents == null ||
        record.driverId == null ||
        record.providerPaymentId == null
      ) {
        const reason = 'no session final cost to adjust the hold to';
        ctx.logger.warn({ paymentRecordId: record.id }, `Stale adjustment not resumed: ${reason}`);
        result.skipped.push({ paymentRecordId: record.id, reason });
        continue;
      }
      await settleHold(record, session, { adjust: true, resume: true }, ctx, SETTLEMENT_DEFAULTS);
      result.resumed++;
    } catch (err) {
      const reason = errorMessage(err, 'Unknown error');
      ctx.logger.warn({ err, paymentRecordId: stale.id }, 'Stale adjustment resume failed');
      result.skipped.push({ paymentRecordId: stale.id, reason });
    }
  }
  return result;
}

/**
 * Settles a session hold after its authorisation adjustment webhook (P10
 * Part D). The caller matched the pending adjustment
 * (`matchPendingAdjustment`). A raised hold captures the final cost up to
 * the authorised amount; a refused adjustment captures the original hold and
 * charges the rest as a top-up, as without adjustment. Same idempotency keys
 * as the settlement on session end.
 */
export async function settleAdjustedHold(
  record: PaymentRecord,
  adjustment: { success: boolean; authorizedCents: number },
  ctx: PaymentContext,
): Promise<SettlementOutcome> {
  if (record.sessionId == null || record.driverId == null) return { mode: 'none' };
  if (record.providerPaymentId == null) return { mode: 'none' };
  const session = await settlementSession(record.sessionId);
  if (session == null) return { mode: 'none' };
  const holdCents = record.preAuthAmountCents ?? session.finalCostCents ?? 0;
  const heldCents = adjustment.success
    ? Math.max(holdCents, adjustment.authorizedCents)
    : holdCents;
  return settleHold(record, session, { adjust: false, heldCents }, ctx, SETTLEMENT_DEFAULTS);
}

type HoldAdjustment = { kind: 'held'; heldCents: number } | { kind: 'pending' };

/** Set once the settlement asked the provider anything. */
interface ProviderCalls {
  provider: boolean;
}

/**
 * Raises the hold to the final cost when the provider adjusts holds. The
 * record is claimed (`pending_operation = 'adjust'`) before the provider is
 * asked (P4), so the webhook matches even when it is faster than this
 * process. A refusal or an error ends the claim and keeps the original hold.
 */
async function adjustHoldToFinalCost(
  provider: PaymentProvider,
  record: PaymentRecord,
  paymentId: string,
  finalCostCents: number,
  holdCents: number,
  ctx: PaymentContext,
  calls: ProviderCalls,
  resume: boolean,
): Promise<HoldAdjustment> {
  if (provider.capabilities.shortfall !== 'adjust_hold' || provider.adjustHold == null) {
    return { kind: 'held', heldCents: holdCents };
  }
  // A resume finds the claim already made (by the run it continues).
  if (!resume && !(await markAdjustmentPending(record.id))) {
    ctx.logger.info(
      { paymentRecordId: record.id },
      'Hold already being adjusted by another settlement; its webhook settles',
    );
    return { kind: 'pending' };
  }
  try {
    calls.provider = true;
    const result = await provider.adjustHold({
      paymentId,
      newTotalCents: finalCostCents,
      currency: record.currency,
      ...(record.providerState != null ? { providerState: record.providerState } : {}),
      idempotencyKey: adjustKey(paymentId, finalCostCents),
    });
    if (result.state === 'pending') {
      // The provider accepted the adjustment: from here the claim must stay,
      // or the hold would be captured while the provider raises it. A failed
      // reference write keeps the claim; the webhook matches a claim without
      // a reference, and resumeStaleAdjustments asks again with the same key
      // (the provider replays the same reference).
      try {
        if (!(await setAdjustmentRef(record.id, result.operationRef))) {
          ctx.logger.info(
            { paymentRecordId: record.id, operationRef: result.operationRef },
            'Adjustment settled by its webhook before its reference was stored',
          );
        }
      } catch (refErr) {
        ctx.logger.warn(
          { err: refErr, paymentRecordId: record.id, operationRef: result.operationRef },
          'Adjustment reference not stored; the claim stays for its webhook or the reconciliation',
        );
      }
      return { kind: 'pending' };
    }
    return { kind: 'held', heldCents: Math.max(holdCents, result.authorizedCents) };
  } catch (err) {
    ctx.logger.warn(
      { err, paymentRecordId: record.id, finalCostCents, holdCents },
      'Authorisation adjustment failed; capturing the hold and charging the rest as a top-up',
    );
    try {
      await clearPendingAdjustment(record.id);
    } catch (dbErr) {
      // The capture below clears it as well.
      ctx.logger.warn(
        { err: dbErr, paymentRecordId: record.id },
        'Failed to clear the pending adjustment',
      );
    }
    return { kind: 'held', heldCents: holdCents };
  }
}

/**
 * Captures or cancels a driver's open hold for the session's final cost: a
 * capture up to the held amount, a top-up for the rest, or a cancel at 0.
 * With `adjust: true` the hold is first raised to the final cost
 * (`adjustHoldToFinalCost`); otherwise `heldCents` is what the hold covers.
 */
async function settleHold(
  record: PaymentRecord,
  session: SettlementSession,
  hold: { adjust: true; resume: boolean } | { adjust: false; heldCents: number },
  ctx: PaymentContext,
  options: SettlementOptions,
): Promise<SettlementOutcome> {
  const sessionId = session.id;
  const paymentId = record.providerPaymentId as string;
  const driverId = record.driverId as string;
  const merchantReference = `sess_${sessionId}`;

  const finalCostCents = session.finalCostCents;
  let capturedCents = 0;
  let shortfallCents = 0;
  let topUp: { paymentId: string; amountCents: number } | null = null;
  let topUpFailureReason: string | null = null;
  // The hold after an authorisation adjustment raised it; null otherwise.
  let adjustedHoldCents: number | null = null;
  // The reference of a capture or cancel an async provider confirms later.
  let operationRef: string | null = null;
  // Set when the cost is below the provider minimum: the hold is released, not captured.
  let uncollectableReason: string | null = null;
  const calls: ProviderCalls = { provider: false };
  try {
    const provider = await pinnedProvider(ctx.registry, record.provider);
    const captureMinimumCents =
      finalCostCents != null && finalCostCents > 0
        ? belowMinimumCharge(provider, record.currency, finalCostCents)
        : null;
    if (finalCostCents != null && captureMinimumCents != null) {
      // The provider refuses a charge this small, and a refused capture left the
      // hold open until it expired (P4): release it now; the cost is not collectable.
      calls.provider = true;
      operationRef = pendingRef(
        await provider.cancelHold({
          paymentId,
          merchantReference,
          idempotencyKey: cancelKey(paymentId),
        }),
      );
      uncollectableReason = belowMinimumCaptureReason(
        finalCostCents,
        captureMinimumCents,
        record.currency,
      );
      ctx.logger.warn(
        { paymentRecordId: record.id, finalCostCents, minimumCents: captureMinimumCents },
        'Cost below the provider minimum charge; hold released, cost uncollected',
      );
    } else if (finalCostCents == null || finalCostCents <= 0) {
      calls.provider = true;
      operationRef = pendingRef(
        await provider.cancelHold({
          paymentId,
          merchantReference,
          idempotencyKey: cancelKey(paymentId),
        }),
      );
    } else {
      const holdCents = record.preAuthAmountCents ?? finalCostCents;
      let heldCents = hold.adjust ? holdCents : hold.heldCents;
      if (hold.adjust && finalCostCents > holdCents) {
        const adjusted = await adjustHoldToFinalCost(
          provider,
          record,
          paymentId,
          finalCostCents,
          holdCents,
          ctx,
          calls,
          hold.resume,
        );
        if (adjusted.kind === 'pending') {
          return { mode: 'card', status: 'adjusting', paymentRecordId: record.id, driverId };
        }
        heldCents = adjusted.heldCents;
      }
      if (heldCents > holdCents) adjustedHoldCents = heldCents;
      const captureCents = Math.min(finalCostCents, heldCents);
      // The platform fee is a percent of the net amount charged, set on the
      // capture and on the top-up so the two add up to the fee of the final cost.
      const feeTax = sessionChargeTax({
        finalCostCents,
        tariffTaxRate: session.tariffTaxRate,
        costBreakdown: session.costBreakdown,
      });
      const platformFeePercent = await getPlatformFeePercent(session.siteId);
      calls.provider = true;
      operationRef = pendingRef(
        await provider.capture({
          paymentId,
          amountCents: captureCents,
          currency: record.currency,
          merchantReference,
          payoutAccountId: null,
          feeTax,
          platformFeePercent,
          idempotencyKey: captureKey(paymentId),
        }),
      );
      capturedCents = captureCents;
      const deltaCents = finalCostCents - captureCents;
      const minimumCents = belowMinimumCharge(provider, record.currency, deltaCents);
      if (deltaCents > 0 && minimumCents != null) {
        // The provider refuses a charge this small: the shortfall can never be
        // collected, so no top-up is tried and the daily retry skips it.
        shortfallCents = deltaCents;
        topUpFailureReason = belowMinimumReason(deltaCents, minimumCents, record.currency);
        ctx.logger.warn(
          { paymentRecordId: record.id, deltaCents, minimumCents },
          'Top-up below the provider minimum charge; the rest is uncollected',
        );
      } else if (deltaCents > 0) {
        try {
          const charged = await provider.chargeShortfall({
            originalPaymentId: paymentId,
            ...(record.providerCustomerId != null && record.providerPaymentMethodId != null
              ? {
                  method: {
                    customerId: record.providerCustomerId,
                    methodId: record.providerPaymentMethodId,
                  },
                }
              : {}),
            capturedCents: captureCents,
            finalCostCents,
            currency: record.currency,
            feeTax,
            platformFeePercent,
            description: `Top-up for session ${sessionId}`,
            idempotencyKey: topUpKey(paymentId),
          });
          topUp = { paymentId: charged.paymentId, amountCents: charged.amountCents };
          capturedCents = finalCostCents;
        } catch (topUpErr) {
          shortfallCents = deltaCents;
          topUpFailureReason =
            topUpErr instanceof Error
              ? `Top-up declined: ${topUpErr.message.slice(0, 350)}; shortfall ${String(deltaCents)}c`
              : `Top-up failed; shortfall ${String(deltaCents)}c`;
          ctx.logger.warn(
            { err: topUpErr, paymentRecordId: record.id, deltaCents },
            'Top-up failed; the hold was captured but the rest is uncollected',
          );
        }
      }
    }
  } catch (err) {
    // A lost database connection before the provider was asked anything is
    // the caller's to retry: the hold is untouched, so it is not a capture
    // failure. After a provider call the failure is recorded as before.
    if (options.rethrowConnectionErrors && !calls.provider && pgConnectionErrorKind(err) != null) {
      throw err;
    }
    ctx.logger.error({ err, sessionId, paymentRecordId: record.id }, 'Auto capture/cancel failed');
    const reason = errorMessage(err, 'Unknown capture error');
    try {
      await markHoldFailed(record.id, reason);
    } catch (dbErr) {
      ctx.logger.error(
        { err: dbErr, paymentRecordId: record.id },
        'Failed to record capture failure',
      );
    }
    return { mode: 'card', status: 'failed', paymentRecordId: record.id, driverId, reason };
  }

  const cancelled = finalCostCents == null || finalCostCents <= 0 || uncollectableReason != null;
  let recorded: boolean;
  try {
    recorded = cancelled
      ? await markCancelled(record.id, operationRef, uncollectableReason)
      : await markCaptured(record.id, {
          capturedCents,
          failureReason: topUpFailureReason,
          topUp,
          pendingRef: operationRef,
          ...(adjustedHoldCents != null ? { authorizedCents: adjustedHoldCents } : {}),
        });
    if (!recorded) {
      ctx.logger.warn(
        { paymentRecordId: record.id, paymentId },
        'Payment settled at the provider but the record had moved on',
      );
    }
  } catch (dbErr) {
    recorded = false;
    ctx.logger.error(
      { err: dbErr, paymentRecordId: record.id, paymentId, capturedCents },
      'Payment settled at the provider but the record update failed; manual reconciliation required',
    );
  }
  if (cancelled) {
    return { mode: 'card', status: 'cancelled', paymentRecordId: record.id, recorded };
  }
  return {
    mode: 'card',
    status: 'captured',
    paymentRecordId: record.id,
    driverId,
    capturedCents,
    shortfallCents,
    recorded,
  };
}
