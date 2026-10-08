// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import {
  AppError,
  dispatchDriverNotification,
  reconcileCostBreakdown,
  sessionReceiptVariables,
} from '@evtivity/lib';
import {
  SESSION_END_FAILED_REASON,
  SESSION_REBILL_LEASE_SECONDS,
  claimSessionRebill,
  client,
  completeRebilledSession,
  priceRebill,
  releaseSessionRebill,
  sessionAuditLog,
  writeAudit,
} from '@evtivity/database';
import {
  chargeSessionRebill,
  classifySessionPayment,
  dispatchPrepaidLowCreditNotice,
  isRebillRecord,
  isStaleRebillCharge,
  settlePrepaidSession,
} from '@evtivity/payments';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import { paymentContext } from '../lib/payments.js';

// The one path that re-bills a session the CSMS gave up ending (stopped
// reason EndRequestFailed: faulted, cost zeroed, hold cancelled). It claims
// the session, prices it with the one cost assembly (`priceRebill`), takes
// the payment through @evtivity/payments (a card charge on the driver's
// default saved method, or the prepaid balance), and moves the session from
// `faulted` to `completed` (`completeRebilledSession`, the audited P5
// override) with `rebill_status` billed or manual. A session that cannot be
// charged automatically (no saved method, a guest, a decline, a charge that
// needed the cardholder's authentication) falls back to manual billing: it is
// completed with its cost and `rebill_status = 'manual'`, and the operator
// collects it outside the platform.

/** Why a session cannot be re-billed (`details.reason` of SESSION_REBILL_NOT_ELIGIBLE). */
export type RebillRefusalReason =
  | 'status'
  | 'already_rebilled'
  | 'roaming'
  | 'free_vend'
  | 'no_tariff'
  | 'paid';

/** Why a re-billed session is left to manual billing. */
export type ManualBillingReason =
  | 'no_payment_method'
  | 'payment_failed'
  | 'guest'
  | 'no_driver'
  | 'prepaid_not_debited'
  | 'prepaid_record_exists';

export type RebillResult = 'charged' | 'prepaid' | 'account' | 'no_charge' | 'manual';

export interface RebillResponse {
  sessionId: string;
  rebillStatus: 'billed' | 'manual';
  result: RebillResult;
  manualReason: ManualBillingReason | null;
  finalCostCents: number;
  currency: string;
  endedAt: Date;
  paymentRecordId: number | null;
  failureReason: string | null;
}

/** A refusal with the reason the client shows (`details.reason`). */
export class SessionRebillRefusedError extends AppError {
  readonly reason: RebillRefusalReason;

  constructor(reason: RebillRefusalReason) {
    super('Session cannot be re-billed', 409, 'SESSION_REBILL_NOT_ELIGIBLE');
    this.name = 'SessionRebillRefusedError';
    this.reason = reason;
  }
}

const notFound = (): AppError => new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
const inProgress = (): AppError =>
  new AppError('The session is being re-billed', 409, 'SESSION_REBILL_IN_PROGRESS');
const paymentPending = (): AppError =>
  new AppError(
    'The session has a payment the provider has not settled yet',
    409,
    'SESSION_REBILL_PAYMENT_PENDING',
  );

export interface SessionRebillContext {
  actor: AuditActorInfo;
  log: FastifyBaseLogger;
  /** The sites the operator may access, null for all. */
  siteIds: string[] | null;
}

/** Why a session cannot be re-billed now (the detail's `rebillBlockedReason`). */
export type RebillBlockedReason = RebillRefusalReason | 'in_progress' | 'payment_pending';

interface RebillSession {
  id: string;
  status: string;
  stoppedReason: string | null;
  rebillStatus: string | null;
  rebillClaimedAt: Date | null;
  driverId: string | null;
  isRoaming: boolean;
  freeVend: boolean;
  tariffId: string | null;
  transactionId: string;
  startedAt: Date | string;
  currency: string;
  tariffTaxRate: string | null;
  energyDeliveredWh: number;
  stationUuid: string;
  stationOcppId: string;
  siteId: string | null;
  siteName: string | null;
  prepaid: boolean;
  guestSession: boolean;
  /** The session's billing stamp (charging_sessions.billing_mode). */
  billingMode: 'card' | 'account' | null;
  /** The fleet an account session is billed to. */
  billingFleetName: string | null;
}

interface RebillRecord {
  id: number;
  status: string;
  paymentSource: string;
  providerPaymentId: string | null;
  pendingOperation: string | null;
  capturedAmountCents: number | null;
  metadata: unknown;
}

async function loadSession(sessionId: string): Promise<RebillSession | null> {
  const [row] = await client`
    SELECT s.id, s.status, s.stopped_reason, s.rebill_status, s.rebill_claimed_at,
           s.driver_id, s.is_roaming, s.free_vend, s.tariff_id, s.transaction_id,
           s.started_at, upper(s.currency) AS currency, s.tariff_tax_rate,
           s.energy_delivered_wh, st.id AS station_uuid, st.station_id AS station_ocpp_id,
           st.site_id, si.name AS site_name,
           (t.prepaid_balance_cents IS NOT NULL) AS prepaid,
           s.billing_mode, bf.name AS billing_fleet_name,
           EXISTS (SELECT 1 FROM guest_sessions g WHERE g.charging_session_id = s.id) AS guest_session
    FROM charging_sessions s
    JOIN charging_stations st ON st.id = s.station_id
    LEFT JOIN sites si ON si.id = st.site_id
    LEFT JOIN driver_tokens t ON t.id = s.token_id
    LEFT JOIN fleets bf ON bf.id = s.billing_fleet_id
    WHERE s.id = ${sessionId}
  `;
  if (row == null) return null;
  return {
    id: row.id as string,
    status: row.status as string,
    stoppedReason: (row.stopped_reason as string | null) ?? null,
    rebillStatus: (row.rebill_status as string | null) ?? null,
    rebillClaimedAt:
      row.rebill_claimed_at != null ? new Date(row.rebill_claimed_at as string) : null,
    driverId: (row.driver_id as string | null) ?? null,
    isRoaming: row.is_roaming === true,
    freeVend: row.free_vend === true,
    tariffId: (row.tariff_id as string | null) ?? null,
    transactionId: row.transaction_id as string,
    startedAt: row.started_at as Date | string,
    currency: row.currency as string,
    tariffTaxRate: (row.tariff_tax_rate as string | null) ?? null,
    energyDeliveredWh: Number(row.energy_delivered_wh ?? 0),
    stationUuid: row.station_uuid as string,
    stationOcppId: row.station_ocpp_id as string,
    siteId: (row.site_id as string | null) ?? null,
    siteName: (row.site_name as string | null) ?? null,
    prepaid: row.prepaid === true,
    guestSession: row.guest_session === true,
    billingMode:
      row.billing_mode === 'card' || row.billing_mode === 'account'
        ? (row.billing_mode as 'card' | 'account')
        : null,
    billingFleetName: (row.billing_fleet_name as string | null) ?? null,
  };
}

async function loadRecord(sessionId: string): Promise<RebillRecord | null> {
  const [row] = await client`
    SELECT id, status, payment_source, provider_payment_id, pending_operation,
           captured_amount_cents, metadata
    FROM payment_records WHERE session_id = ${sessionId}
  `;
  if (row == null) return null;
  return {
    id: row.id as number,
    status: row.status as string,
    paymentSource: row.payment_source as string,
    providerPaymentId: (row.provider_payment_id as string | null) ?? null,
    pendingOperation: (row.pending_operation as string | null) ?? null,
    capturedAmountCents:
      row.captured_amount_cents != null ? Number(row.captured_amount_cents) : null,
    metadata: row.metadata,
  };
}

const OPEN_PAYMENT = new Set(['pending', 'pre_authorized']);
const PAID = new Set(['captured', 'partially_refunded', 'refunded']);

/**
 * Why the session cannot be re-billed now, null when it can. A record the
 * re-bill wrote (`metadata.rebill`, a request that died mid-way) does not
 * block it: the re-bill resumes it, unless its charge has had no answer for
 * REBILL_RESUME_MAX_HOURS (`payment_pending`: the provider may no longer
 * replay the key, an operator checks the provider; reconciliation reports it).
 */
export function rebillBlockedReason(
  session: RebillSession,
  record: RebillRecord | null,
  now: number = Date.now(),
): RebillBlockedReason | null {
  if (session.rebillStatus === 'billed' || session.rebillStatus === 'manual') {
    return 'already_rebilled';
  }
  if (session.status !== 'faulted' || session.stoppedReason !== SESSION_END_FAILED_REASON) {
    return 'status';
  }
  if (
    session.rebillStatus === 'in_progress' &&
    session.rebillClaimedAt != null &&
    now - session.rebillClaimedAt.getTime() < SESSION_REBILL_LEASE_SECONDS * 1000
  ) {
    return 'in_progress';
  }
  if (session.isRoaming) return 'roaming';
  if (session.freeVend) return 'free_vend';
  if (session.tariffId == null) return 'no_tariff';
  if (record == null) return null;
  if (isRebillRecord(record)) return isStaleRebillCharge(record, now) ? 'payment_pending' : null;
  if (OPEN_PAYMENT.has(record.status) || record.pendingOperation != null) return 'payment_pending';
  if (PAID.has(record.status)) return 'paid';
  return null;
}

/** Throws the refusal of `rebillBlockedReason` when the session cannot be re-billed now. */
export function assertRebillable(session: RebillSession, record: RebillRecord | null): void {
  const reason = rebillBlockedReason(session, record);
  if (reason == null) return;
  if (reason === 'in_progress') throw inProgress();
  if (reason === 'payment_pending') throw paymentPending();
  throw new SessionRebillRefusedError(reason);
}

export interface SessionRebillState {
  rebillable: boolean;
  blockedReason: RebillBlockedReason | null;
}

/**
 * Whether an operator can re-bill the session now (the session detail's
 * `rebillable`), with the same checks as the re-bill itself. Null for an
 * unknown session.
 */
export async function getSessionRebillState(sessionId: string): Promise<SessionRebillState | null> {
  const session = await loadSession(sessionId);
  if (session == null) return null;
  const blockedReason = rebillBlockedReason(session, await loadRecord(sessionId));
  return { rebillable: blockedReason == null, blockedReason };
}

interface PaymentOutcome {
  result: RebillResult;
  manualReason: ManualBillingReason | null;
  paymentRecordId: number | null;
  failureReason: string | null;
  /**
   * The amount an earlier attempt of this re-bill charged, debited or
   * requested, which the session is billed at instead of the recomputed
   * cost; null when this request priced it.
   */
  billedCents: number | null;
}

const manual = (
  manualReason: ManualBillingReason,
  paymentRecordId: number | null = null,
  failureReason: string | null = null,
  billedCents: number | null = null,
): PaymentOutcome => ({
  result: 'manual',
  manualReason,
  paymentRecordId,
  failureReason,
  billedCents,
});

async function takePayment(
  session: RebillSession,
  record: RebillRecord | null,
  grossCents: number,
  ctx: SessionRebillContext,
): Promise<PaymentOutcome> {
  if (grossCents <= 0) {
    return {
      result: 'no_charge',
      manualReason: null,
      paymentRecordId: null,
      failureReason: null,
      billedCents: null,
    };
  }
  const mode = classifySessionPayment({
    isRoaming: session.isRoaming,
    freeVend: session.freeVend,
    prepaid: session.prepaid,
    account: session.billingMode === 'account',
    driverId: session.driverId,
    guestSession: session.guestSession,
  });
  // Charge on account: the re-billed cost goes on the fleet invoice (the
  // session stays unbilled until the fleet invoice claims it). No card. An
  // account session with a payment record (an operator hold the give-up
  // cancelled) is not billed on account: it is charged by card like a card
  // session, so the fleet invoice, which skips sessions with a record, and
  // the driver invoice agree.
  if (mode === 'account' && record == null) {
    return {
      result: 'account',
      manualReason: null,
      paymentRecordId: null,
      failureReason: null,
      billedCents: null,
    };
  }
  if (mode === 'prepaid') {
    // A request that died after the debit finds its own record.
    if (record != null && isRebillRecord(record) && record.paymentSource === 'prepaid') {
      return {
        result: 'prepaid',
        manualReason: null,
        paymentRecordId: record.id,
        failureReason: null,
        billedCents: record.capturedAmountCents,
      };
    }
    // The prepaid debit is the session's only record; another one (the hold
    // the give-up cancelled) leaves the balance alone.
    if (record != null) return manual('prepaid_record_exists', record.id);
    const settled = await settlePrepaidSession(session.id, ctx.log, {
      costCents: grossCents,
      rebill: true,
    });
    if (settled == null) return manual('prepaid_not_debited');
    // Low credit notice when this debit took the balance below the threshold
    // (fail-open, P9).
    try {
      await dispatchPrepaidLowCreditNotice(settled, {
        templatesDirs: ALL_TEMPLATES_DIRS,
        pubsub: getPubSub(),
      });
    } catch (err: unknown) {
      ctx.log.warn({ err, sessionId: session.id }, 'Prepaid low credit notice failed; continuing');
    }
    const debited = await loadRecord(session.id);
    return {
      result: 'prepaid',
      manualReason: null,
      paymentRecordId: debited?.id ?? null,
      failureReason: null,
      billedCents: null,
    };
  }
  if ((mode === 'card' || mode === 'account') && session.driverId != null) {
    const charge = await chargeSessionRebill(
      {
        sessionId: session.id,
        driverId: session.driverId,
        siteId: session.siteId,
        grossCents,
        currency: session.currency,
        taxRate: Number(session.tariffTaxRate ?? 0),
      },
      paymentContext(ctx.log),
    );
    switch (charge.status) {
      case 'charged':
        return {
          result: 'charged',
          manualReason: null,
          paymentRecordId: charge.paymentRecordId,
          failureReason: null,
          billedCents: charge.amountCents,
        };
      case 'failed':
        ctx.log.warn(
          { sessionId: session.id, paymentRecordId: charge.paymentRecordId, code: charge.code },
          'Session re-bill charge declined; the session falls back to manual billing',
        );
        return manual('payment_failed', charge.paymentRecordId, charge.reason, charge.amountCents);
      case 'no_payment_method':
        return manual('no_payment_method');
      case 'not_configured':
        await releaseSessionRebill(client, session.id);
        throw new AppError(
          'The payment provider of the saved card is not configured',
          400,
          'PAYMENT_PROVIDER_NOT_CONFIGURED',
        );
      case 'record_refused':
        await releaseSessionRebill(client, session.id);
        throw paymentPending();
      case 'session_not_claimed':
        throw inProgress();
    }
  }
  return manual(mode === 'guest' ? 'guest' : 'no_driver');
}

async function notifyRebilled(
  session: RebillSession,
  response: RebillResponse,
  ctx: SessionRebillContext,
): Promise<void> {
  try {
    const pubsub = getPubSub();
    const base = { stationId: session.stationUuid, siteId: session.siteId, sessionId: session.id };
    await pubsub.publish('csms_events', JSON.stringify({ eventType: 'session.updated', ...base }));
    if (response.paymentRecordId != null) {
      await pubsub.publish(
        'csms_events',
        JSON.stringify({ eventType: 'payment.settled', ...base }),
      );
    }
  } catch (err: unknown) {
    ctx.log.warn({ err, sessionId: session.id }, 'Session re-bill SSE publish failed');
  }
  if (response.rebillStatus !== 'billed' || session.driverId == null) return;
  try {
    await dispatchDriverNotification(
      client,
      'session.Receipt',
      session.driverId,
      sessionReceiptVariables({
        siteName: session.siteName,
        stationId: session.stationOcppId,
        transactionId: session.transactionId,
        energyDeliveredWh: session.energyDeliveredWh,
        finalCostCents: response.finalCostCents,
        currency: response.currency,
        tariffTaxRate: session.tariffTaxRate,
        startedAt: session.startedAt,
        endedAt: response.endedAt,
        notCharged: false,
        billingMode:
          response.result === 'account' ? 'account' : session.billingMode == null ? null : 'card',
        billedTo: response.result === 'account' ? session.billingFleetName : null,
      }),
      ALL_TEMPLATES_DIRS,
      getPubSub(),
    );
  } catch (err: unknown) {
    ctx.log.warn({ err, sessionId: session.id }, 'Session re-bill receipt dispatch failed');
  }
}

/**
 * Re-bills a session the CSMS gave up ending. Refusals: 404
 * SESSION_NOT_FOUND (unknown, or a site the operator cannot access), 409
 * SESSION_REBILL_NOT_ELIGIBLE (`SessionRebillRefusedError.reason`), 409
 * SESSION_REBILL_PAYMENT_PENDING, 409 SESSION_REBILL_IN_PROGRESS, 400
 * PAYMENT_PROVIDER_NOT_CONFIGURED. A provider error with an unknown outcome
 * is thrown with the claim kept: a retry after the lease
 * (SESSION_REBILL_LEASE_SECONDS) resumes with the same idempotency key.
 */
export async function rebillSession(
  sessionId: string,
  ctx: SessionRebillContext,
): Promise<RebillResponse> {
  const session = await loadSession(sessionId);
  if (session == null) throw notFound();
  if (ctx.siteIds != null && session.siteId != null && !ctx.siteIds.includes(session.siteId)) {
    throw notFound();
  }
  const record = await loadRecord(sessionId);
  assertRebillable(session, record);

  if (!(await claimSessionRebill(client, sessionId))) throw inProgress();

  let pricing: Awaited<ReturnType<typeof priceRebill>>;
  try {
    pricing = await priceRebill(client, sessionId);
  } catch (err: unknown) {
    try {
      await releaseSessionRebill(client, sessionId);
    } catch (releaseErr: unknown) {
      ctx.log.warn(
        { err: releaseErr, sessionId },
        'Session re-bill claim not released after a pricing failure; it expires with its lease',
      );
    }
    throw err;
  }
  if (pricing == null) {
    await releaseSessionRebill(client, sessionId);
    throw new SessionRebillRefusedError('no_tariff');
  }

  const payment = await takePayment(session, record, pricing.breakdown.grossCents, ctx);
  const rebillStatus = payment.result === 'manual' ? 'manual' : 'billed';
  // An earlier attempt fixed the amount: bill the session at what was charged
  // (or requested), with the recomputed split reconciled to it.
  const breakdown =
    payment.billedCents != null
      ? reconcileCostBreakdown(
          pricing.breakdown,
          payment.billedCents,
          Number(session.tariffTaxRate ?? 0),
        )
      : pricing.breakdown;
  const completed = await completeRebilledSession(client, {
    sessionId,
    breakdown,
    endedAt: pricing.endedAt,
    outcome: rebillStatus,
  });
  if (!completed) {
    ctx.log.error(
      { sessionId, paymentRecordId: payment.paymentRecordId },
      'Session re-bill could not complete the session: another request took the claim over',
    );
    throw inProgress();
  }

  const response: RebillResponse = {
    sessionId,
    rebillStatus,
    result: payment.result,
    manualReason: payment.manualReason,
    finalCostCents: breakdown.grossCents,
    currency: session.currency,
    endedAt: pricing.endedAt,
    paymentRecordId: payment.paymentRecordId,
    failureReason: payment.failureReason,
  };

  await writeAudit(
    { table: sessionAuditLog, idColumn: 'session_id' },
    {
      entityId: sessionId,
      entityIdSnapshot: sessionId,
      action: rebillStatus === 'manual' ? 'manual_billing' : 'rebilled',
      ...ctx.actor,
      before: { status: 'faulted', stoppedReason: SESSION_END_FAILED_REASON, finalCostCents: 0 },
      after: {
        status: 'completed',
        rebillStatus,
        result: payment.result,
        manualReason: payment.manualReason,
        finalCostCents: response.finalCostCents,
        currency: response.currency,
        endedAt: response.endedAt.toISOString(),
        paymentRecordId: payment.paymentRecordId,
        failureReason: payment.failureReason,
      },
      notes: null,
    },
    undefined,
    ctx.log,
  );
  await notifyRebilled(session, response, ctx);
  return response;
}
