// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq } from 'drizzle-orm';
import { db, driverPaymentMethods, getPlatformFeePercent } from '@evtivity/database';
import type { PaymentContext } from './context.js';
import { errorMessage } from './context.js';
import {
  PaymentDeclinedError,
  PaymentMethodOwnershipError,
  PaymentProviderNotConfiguredError,
  PaymentValidationError,
} from './errors.js';
import { rebillKey } from './idempotency-keys.js';
import {
  claimRebillRecord,
  findSessionRecord,
  markChargeCaptured,
  markChargeFailed,
  rebillChargeRequest,
} from './payment-records.js';
import type { RebillChargeRequest } from './payment-records.js';
import { PAYOUT_NOT_READY_FAILURE } from './payout-accounts.js';
import { pinnedProvider } from './pinning.js';
import { holdTerms } from './session-payments.js';
import type { PaymentProvider, PaymentProviderId, PaymentStatus } from './types.js';

/** The failure code of a re-bill refused because the site's payout account is not ready (O5). */
export const REBILL_PAYOUT_NOT_READY_CODE = 'payout_not_ready';

export interface SessionRebillChargeInput {
  sessionId: string;
  driverId: string;
  /** The session's site, for the payout account and the platform fee. */
  siteId: string | null;
  /** The recomputed cost, tax included, in cents of `currency`. */
  grossCents: number;
  /** The session's currency. */
  currency: string;
  /** The session's tariff tax rate (fraction), for the platform fee on the net amount. */
  taxRate: number;
}

export type SessionRebillChargeOutcome =
  | {
      status: 'charged';
      paymentRecordId: number;
      provider: PaymentProviderId;
      /** The amount charged: the stored request's (or the captured amount of an earlier attempt). */
      amountCents: number;
      /** False when the provider charged but the record could not be updated. */
      recorded: boolean;
    }
  /**
   * Declined (including an off-session charge that needed the cardholder's
   * authentication, `authentication_required`), refused before the charge
   * (`payout_not_ready`), or declined by an earlier attempt of this re-bill.
   * The record is `failed`; the session falls back to manual billing.
   * `amountCents` is the amount the re-bill requested, null when unknown.
   */
  | {
      status: 'failed';
      paymentRecordId: number;
      reason: string;
      code: string | null;
      amountCents: number | null;
    }
  /** The driver has no default saved method: manual billing. */
  | { status: 'no_payment_method' }
  /** The provider of the default method is not usable in this process: nothing written. */
  | { status: 'not_configured' }
  /**
   * The session's record holds another payment, or a charge of this re-bill
   * with an unknown outcome older than REBILL_RESUME_MAX_HOURS: nothing charged.
   */
  | { status: 'record_refused'; recordStatus: PaymentStatus }
  /** The session lost its re-bill claim (`claimRebillRecord`): nothing written. */
  | { status: 'session_not_claimed' };

type ResolvedRequest =
  | { kind: 'request'; provider: PaymentProvider; request: RebillChargeRequest }
  | { kind: 'no_payment_method' }
  | { kind: 'not_configured' };

async function pinned(
  ctx: PaymentContext,
  providerId: PaymentProviderId,
): Promise<PaymentProvider | null> {
  try {
    return await pinnedProvider(ctx.registry, providerId);
  } catch (err) {
    if (err instanceof PaymentProviderNotConfiguredError) return null;
    throw err;
  }
}

/**
 * The charge to send: the request a charge with an unknown outcome stored
 * (resumed exactly, through the provider it was sent to), else a new one on
 * the driver's default saved method.
 */
async function resolveRequest(
  input: SessionRebillChargeInput,
  terms: { payoutAccountId: string | null },
  ctx: PaymentContext,
): Promise<ResolvedRequest> {
  const record = await findSessionRecord(input.sessionId);
  const stored = record != null && record.status === 'pending' ? rebillChargeRequest(record) : null;
  if (stored != null) {
    const provider = await pinned(ctx, stored.provider);
    return provider == null
      ? { kind: 'not_configured' }
      : { kind: 'request', provider, request: stored };
  }
  const [method] = await db
    .select({
      provider: driverPaymentMethods.provider,
      customerId: driverPaymentMethods.providerCustomerId,
      methodId: driverPaymentMethods.providerPaymentMethodId,
    })
    .from(driverPaymentMethods)
    .where(
      and(
        eq(driverPaymentMethods.driverId, input.driverId),
        eq(driverPaymentMethods.isDefault, true),
      ),
    )
    .limit(1);
  if (method == null) return { kind: 'no_payment_method' };
  const provider = await pinned(ctx, method.provider);
  if (provider == null) return { kind: 'not_configured' };
  return {
    kind: 'request',
    provider,
    request: {
      provider: provider.id,
      customerId: method.customerId,
      methodId: method.methodId,
      grossCents: input.grossCents,
      currency: input.currency,
      feeTaxRate: input.taxRate,
      platformFeePercent: await getPlatformFeePercent(input.siteId),
      payoutAccountId: terms.payoutAccountId,
    },
  };
}

/**
 * Charges the recomputed cost of a session the CSMS gave up ending (stopped
 * reason EndRequestFailed) on the driver's default saved method, off session,
 * through the provider the method is saved with, the site's payout account
 * (destination charge with the platform fee of the net amount; a payout
 * account that is not ready refuses the charge, O5) and the key
 * `rebill_<sessionId>`. The session's record is `pending` before the provider
 * call (`claimRebillRecord`, which stores the request), then `captured` or
 * `failed`, so two requests or a retry charge once. An off-session charge
 * cannot challenge the cardholder: a 3DS answer is a decline
 * (`authentication_required`). A provider error other than a refusal
 * (network, 5xx) leaves the record `pending` and is thrown: the outcome is
 * unknown, and a retry within REBILL_RESUME_MAX_HOURS sends the stored
 * request again with the same key, so the provider returns its first answer;
 * later, the claim refuses it (`record_refused`). Notifications stay with the
 * caller.
 */
export async function chargeSessionRebill(
  input: SessionRebillChargeInput,
  ctx: PaymentContext,
): Promise<SessionRebillChargeOutcome> {
  const terms = await holdTerms(ctx, input.siteId);
  const resolved = await resolveRequest(input, terms, ctx);
  if (resolved.kind !== 'request') return { status: resolved.kind };
  const { provider } = resolved;

  const claim = await claimRebillRecord({
    sessionId: input.sessionId,
    driverId: input.driverId,
    sitePaymentConfigId: terms.sitePaymentConfigId,
    request: resolved.request,
  });
  if (claim.state === 'session_not_claimed') return { status: 'session_not_claimed' };
  if (claim.state === 'refused') return { status: 'record_refused', recordStatus: claim.status };
  if (claim.state === 'charged') {
    return {
      status: 'charged',
      paymentRecordId: claim.id,
      provider: provider.id,
      amountCents: claim.amountCents,
      recorded: true,
    };
  }
  if (claim.state === 'failed') {
    return {
      status: 'failed',
      paymentRecordId: claim.id,
      reason: claim.reason,
      code: null,
      amountCents: claim.amountCents,
    };
  }
  const recordId = claim.id;
  const { request } = claim;

  // A resumed charge passed this check when it was first sent.
  if (!claim.resumed && terms.payoutBlocked) {
    await markChargeFailed(recordId, PAYOUT_NOT_READY_FAILURE);
    ctx.logger.warn(
      { paymentRecordId: recordId, sessionId: input.sessionId, siteId: input.siteId },
      'Session re-bill not charged: the payout account of the site is not ready',
    );
    return {
      status: 'failed',
      paymentRecordId: recordId,
      reason: PAYOUT_NOT_READY_FAILURE,
      code: REBILL_PAYOUT_NOT_READY_CODE,
      amountCents: request.grossCents,
    };
  }

  let paymentId: string;
  try {
    const result = await provider.chargeSavedMethod({
      customerId: request.customerId,
      methodId: request.methodId,
      grossCents: request.grossCents,
      currency: request.currency,
      feeTaxRate: request.feeTaxRate,
      platformFeePercent: request.platformFeePercent,
      payoutAccountId: request.payoutAccountId,
      description: 'Charging session',
      metadata: { sessionId: input.sessionId, type: 'session_rebill' },
      idempotencyKey: rebillKey(input.sessionId),
    });
    paymentId = result.paymentId;
  } catch (err) {
    if (
      err instanceof PaymentDeclinedError ||
      err instanceof PaymentValidationError ||
      err instanceof PaymentMethodOwnershipError
    ) {
      const reason = errorMessage(err, 'Payment declined');
      await markChargeFailed(recordId, reason);
      return {
        status: 'failed',
        paymentRecordId: recordId,
        reason,
        code: err instanceof PaymentDeclinedError ? err.code : null,
        amountCents: request.grossCents,
      };
    }
    throw err;
  }

  const recorded = await markChargeCaptured(recordId, {
    provider: provider.id,
    paymentId,
    amountCents: request.grossCents,
  });
  if (!recorded) {
    ctx.logger.error(
      { paymentRecordId: recordId, paymentId, sessionId: input.sessionId },
      'Session re-bill charged but its record had moved on; manual reconciliation required',
    );
  }
  return {
    status: 'charged',
    paymentRecordId: recordId,
    provider: provider.id,
    amountCents: request.grossCents,
    recorded,
  };
}
