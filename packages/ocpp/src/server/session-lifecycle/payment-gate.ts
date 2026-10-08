// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  checkFleetCreditLimit,
  fleetCreditNoticesClaimed,
  readFleetCreditLimit,
  stampSessionBilling,
} from '@evtivity/database';
import type { FleetCreditCheck, SessionBilling, TariffPriceSnapshot } from '@evtivity/database';
import {
  authorizeSessionHold,
  classifySessionPayment,
  dispatchFleetCreditLimitNotices,
} from '@evtivity/payments';
import type { HoldOutcome } from '@evtivity/payments';
import { isTariffFree } from '@evtivity/lib';
import {
  dispatchDriverNotification,
  dispatchSystemNotification,
  ALL_TEMPLATES_DIRS,
} from '../notification-dispatcher.js';
import { activePaymentProvider } from '../../lib/payments.js';
import type { ProjectionDeps } from '../projection-support/context.js';
import { stopSessionForPayment } from './payment-stop.js';
import type { FleetCreditThrottle } from './state.js';

// Payment gate on session start: decides whether a started session may keep
// charging (allow, place a card hold, or stop), then applies that decision.

/** What the Started projection knows about the session when it runs the gate. */
export interface PaymentGateInput {
  sessionId: string;
  transactionId: string;
  driverId: string | null;
  stationDbId: string;
  ocppStationId: string;
  siteId: string | null;
  isRoaming: boolean;
  idToken: string | undefined;
  guestStatus: string | null;
  guestEmail: string | null;
  /** Balance of the session's prepaid token; null when the token is not prepaid. */
  prepaidBalanceCents: number | null;
  /** True when the session started from a reservation (its holding fee is billed). */
  reserved: boolean;
  /** The tariff snapshotted on the session at Started (null: no tariff applies). */
  sessionTariff: TariffPriceSnapshot | null;
  /**
   * The gate runs for an idToken first presented in TransactionEvent Ended
   * (`linkFirstPresentedToken`): a stop faults the session but sends the
   * station no RequestStopTransaction, the transaction is over.
   */
  transactionEnded?: boolean;
}

interface PreAuthFailedNotice {
  kind: 'preAuthFailed';
  driverId: string;
  reason: string;
}

interface MissingPaymentMethodNotice {
  kind: 'missingPaymentMethod';
  driverId: string;
}

interface GuestPreAuthFailedNotice {
  kind: 'guestPreAuthFailed';
  email: string;
}

type GateNotice = PreAuthFailedNotice | MissingPaymentMethodNotice | GuestPreAuthFailedNotice;

export type PaymentGateDecision =
  | {
      kind: 'allow';
      why:
        | 'roaming'
        | 'free_vend'
        | 'prepaid_funded'
        | 'account'
        | 'free_tariff'
        | 'payments_off'
        | 'hold_authorized'
        | 'hold_exists'
        | 'guest_authorized';
    }
  | { kind: 'allow'; why: 'provider_not_configured'; providerId: string }
  | { kind: 'hold'; driverId: string }
  | { kind: 'stop'; why: 'prepaid_no_credit'; reason: 'PaymentFailed'; notice: null }
  | {
      kind: 'stop';
      why: 'no_payment_method';
      reason: 'MissingPaymentMethod';
      notice: MissingPaymentMethodNotice;
    }
  | {
      kind: 'stop';
      why: 'hold_declined';
      reason: 'PaymentFailed';
      /** `declined`: the provider refused the card. `provider_error`: the provider call failed. */
      failure: 'declined' | 'provider_error';
      notice: PreAuthFailedNotice;
    }
  | {
      kind: 'stop';
      /** The session's hold record already ended `failed` or `cancelled` (P5: terminal). */
      why: 'hold_terminal';
      reason: 'PaymentFailed';
      status: 'failed' | 'cancelled';
      notice: null;
    }
  | {
      kind: 'stop';
      why: 'hold_record_failed';
      reason: 'PaymentFailed';
      notice: PreAuthFailedNotice;
    }
  | {
      kind: 'stop';
      why: 'guest_not_authorized';
      reason: 'GuestPaymentNotAuthorized';
      notice: GuestPreAuthFailedNotice | null;
    }
  | { kind: 'stop'; why: 'anonymous'; reason: 'AnonymousSession'; notice: null }
  | {
      kind: 'stop';
      /**
       * The billing fleet has no credit left for the session: its exposure is
       * at or above the limit (plan S7), or the reservations of its other
       * sessions leave a cost ceiling of 0 (plan S8).
       */
      why: 'account_credit_limit';
      reason: 'AccountCreditLimit';
      fleetId: string;
      /** The driver's notice goes out from stopSessionForPayment, once. */
      notice: null;
    };

type StopDecision = Extract<PaymentGateDecision, { kind: 'stop' }>;

/**
 * The gate decision from what the Started projection knows, the session's
 * billing stamp (`billing`, written by runPaymentGate or the portal start;
 * null when the session has none) and, for an account session, the billing
 * fleet's credit check (`credit`, null when the fleet has no limit): an
 * exposure at or above the limit, or no credit left for the session (its
 * reserved cost ceiling, else the remaining credit, is 0), stops the
 * session. `hold` means a card session on a
 * priced tariff: the only path that reads the active provider
 * (runPaymentGate), so roaming, prepaid, account, guest and anonymous
 * sessions never read payment settings.
 */
export function planPaymentGate(
  input: PaymentGateInput,
  billing: SessionBilling | null = null,
  credit: Pick<
    FleetCreditCheck,
    'fleetId' | 'level' | 'remainingCents' | 'ceilingCents'
  > | null = null,
): PaymentGateDecision {
  const {
    driverId,
    isRoaming,
    guestStatus,
    guestEmail,
    prepaidBalanceCents,
    reserved,
    sessionTariff,
  } = input;

  // The session is billed at the tariff snapshotted on Started, so the gate
  // decides from that same tariff (no tariff: free). The reservation holding
  // fee makes the session paid only when it started from a reservation.
  const tariffIsFree = isTariffFree(sessionTariff, { reserved });

  // How the session is paid (one definition with the settlement on Ended).
  // Free vend never reaches the gate (the Started handler skips it).
  const mode = classifySessionPayment({
    isRoaming,
    freeVend: false,
    prepaid: prepaidBalanceCents != null,
    account: billing?.mode === 'account',
    driverId,
    guestSession: guestStatus != null,
  });

  // Roaming: billing handled by the eMSP via the CDR.
  if (mode === 'roaming' || mode === 'free_vend') return { kind: 'allow', why: mode };

  // Prepaid token (OCPP 2.1 C17): the station enforces the remaining credit
  // (transactionLimit.maxCost) and the settlement debits the final cost when
  // the session ends, so no card pre-authorization. A prepaid token without
  // credit is stopped (a station started it without asking first).
  if (mode === 'prepaid') {
    if (prepaidBalanceCents != null && prepaidBalanceCents > 0) {
      return { kind: 'allow', why: 'prepaid_funded' };
    }
    return { kind: 'stop', why: 'prepaid_no_credit', reason: 'PaymentFailed', notice: null };
  }

  // Charge on account: billed to the fleet on its invoice, so no card and no
  // hold, whatever the tariff (works with payments.provider none). A fleet at
  // its credit limit refuses the start (plan S7), and so does a fleet whose
  // running sessions reserve the rest of the limit (a cost ceiling of 0, plan
  // S8). A session with credit runs up to its ceiling.
  if (mode === 'account') {
    if (
      credit != null &&
      (credit.level === 'reached' || (credit.ceilingCents ?? credit.remainingCents) <= 0)
    ) {
      return {
        kind: 'stop',
        why: 'account_credit_limit',
        reason: 'AccountCreditLimit',
        fleetId: credit.fleetId,
        notice: null,
      };
    }
    return { kind: 'allow', why: 'account' };
  }

  if (mode === 'card' && driverId != null) {
    // A free session needs no payment method and no hold.
    if (tariffIsFree) return { kind: 'allow', why: 'free_tariff' };
    return { kind: 'hold', driverId };
  }

  // Token resolution already happened in the first subscriber:
  //   driver_tokens -> ocpi_external_tokens -> guest_sessions
  // guestStatus/guestEmail are pre-resolved from that chain.
  if (mode === 'guest') {
    // Pre-auth done at checkout.
    if (guestStatus === 'payment_authorized') return { kind: 'allow', why: 'guest_authorized' };
    return {
      kind: 'stop',
      why: 'guest_not_authorized',
      reason: 'GuestPaymentNotAuthorized',
      notice: guestEmail != null ? { kind: 'guestPreAuthFailed', email: guestEmail } : null,
    };
  }

  return { kind: 'stop', why: 'anonymous', reason: 'AnonymousSession', notice: null };
}

export function decideAfterHold(outcome: HoldOutcome, driverId: string): PaymentGateDecision {
  switch (outcome.outcome) {
    case 'authorized':
      return { kind: 'allow', why: 'hold_authorized' };
    case 'exists':
      // A failed or cancelled hold is terminal (P5): the session has no
      // valid authorization, so it stops. The trigger that ended the hold
      // (portal start, earlier gate run, operator) already informed the
      // driver, so no second notice.
      if (outcome.status === 'failed' || outcome.status === 'cancelled') {
        return {
          kind: 'stop',
          why: 'hold_terminal',
          reason: 'PaymentFailed',
          status: outcome.status,
          notice: null,
        };
      }
      return { kind: 'allow', why: 'hold_exists' };
    case 'no_method':
      return {
        kind: 'stop',
        why: 'no_payment_method',
        reason: 'MissingPaymentMethod',
        notice: { kind: 'missingPaymentMethod', driverId },
      };
    case 'not_configured':
      // As the portal start without a provider: the session is not held.
      return { kind: 'allow', why: 'provider_not_configured', providerId: outcome.providerId };
    case 'declined':
      return {
        kind: 'stop',
        why: 'hold_declined',
        reason: 'PaymentFailed',
        failure: outcome.failure,
        notice: { kind: 'preAuthFailed', driverId, reason: outcome.reason },
      };
    case 'record_failed':
      // The service cancelled the hold it could not record.
      return {
        kind: 'stop',
        why: 'hold_record_failed',
        reason: 'PaymentFailed',
        notice: {
          kind: 'preAuthFailed',
          driverId,
          reason: 'Payment recording failed. Please contact support.',
        },
      };
    default: {
      // A new HoldOutcome must be decided here (compile error). At runtime an
      // unknown outcome fails loud (P9: payment gate decisions throw) instead
      // of returning no decision.
      const unknown: never = outcome;
      throw new Error(
        `Unknown hold outcome: ${String((unknown as { outcome?: unknown }).outcome)}`,
      );
    }
  }
}

export async function runPaymentGate(
  deps: ProjectionDeps,
  input: PaymentGateInput,
): Promise<PaymentGateDecision> {
  const { logger, payments } = deps;
  const { sessionId, siteId } = input;

  // How a driver session is paid, stamped once before the start is allowed
  // (P4, P5): only after roaming and prepaid are ruled out (free vend never
  // reaches the gate). A stamp the portal start or an earlier run wrote is
  // kept, so a fleet change never changes a started session.
  const billing =
    !input.isRoaming && input.prepaidBalanceCents == null && input.driverId != null
      ? await stampSessionBilling(deps.sql, sessionId, input.driverId)
      : null;

  // The billing fleet's credit limit, checked under the fleet row lock
  // (checkFleetCreditLimit) with this session left out of the exposure. In
  // the same transaction the session gets a bounded reservation as its cost
  // ceiling (plan S8, written once): the smaller of the credit left and the
  // fleet.creditReservationCents slice, so the fleet's other drivers can
  // still start. Billing is capped at it, a 2.1 station gets it as
  // transactionLimit.maxCost, and the MeterValues cost loop grows it while
  // the fleet has credit (growAccountCeiling) and stops a station that
  // ignores it once the fleet has none. A failed check throws (P9: the limit
  // check is critical) and the gate runs again (memo('started:gate')).
  const credit =
    billing?.mode === 'account'
      ? await checkFleetCreditLimit(deps.sql, billing.fleetId, { reserveForSessionId: sessionId })
      : null;

  let decision = planPaymentGate(input, billing, credit);

  // Warning and reached notices to the fleet, once per month each.
  // Fire-and-forget and fail-open (P9).
  if (credit != null && credit.level !== 'ok') {
    void deps.eventBus.track(
      dispatchFleetCreditLimitNotices(credit, { templatesDirs: ALL_TEMPLATES_DIRS }, logger),
    );
  }

  // Payments off (payments.provider = none, or a selected provider this
  // process cannot use): no hold, as the portal start (owner decision
  // 2026-10-06). Holds already placed still settle through their pinned
  // provider. Resolved only for a hold, the one path that would charge.
  if (decision.kind === 'hold' && (await activePaymentProvider(logger)) == null) {
    decision = { kind: 'allow', why: 'payments_off' };
  }

  if (decision.kind === 'hold') {
    // The hold on the driver's default card, through the provider the card
    // is saved with (key preauth_<sessionId>, shared with the portal start:
    // an existing record means the portal start already placed it).
    const hold = await authorizeSessionHold(
      {
        sessionId,
        driverId: decision.driverId,
        methodRowId: null,
        siteId,
        trigger: 'projection_gate',
      },
      payments,
    );
    decision = decideAfterHold(hold, decision.driverId);
  }

  if (decision.kind === 'allow' && decision.why === 'payments_off') {
    logger.warn({ sessionId }, 'No active payment provider; session not pre-authorized');
  }

  if (decision.kind === 'allow' && decision.why === 'provider_not_configured') {
    logger.warn(
      { sessionId, providerId: decision.providerId },
      'Payment provider not configured; session not pre-authorized',
    );
  }

  if (decision.kind === 'stop') {
    logStop(deps, input, decision);
    await stopSessionForPayment(
      deps,
      {
        sessionId,
        transactionId: input.transactionId,
        ocppStationId: input.ocppStationId,
        stationDbId: input.stationDbId,
      },
      decision.reason,
      { transactionEnded: input.transactionEnded === true },
    );
    if (decision.notice != null) await sendNotice(deps, input, decision.notice);
  }

  return decision;
}

/**
 * The fleet credit limit notices while an account session charges (plan S8):
 * its running cost raises the fleet's exposure, so the warning and reached
 * notices go out when it passes them, once per fleet and month each (the
 * claim in dispatchFleetCreditLimitNotices). Reads the limit and exposure
 * without the fleet row lock and reserves nothing. Fire-and-forget and
 * fail-open (P9): a failure is logged at warn.
 *
 * P6, a hot path (every meter reading of every account session): at most one
 * check per fleet and throttle interval in this process, and the fleet-wide
 * exposure aggregate runs only while a notice of this month is still
 * unclaimed (fleetCreditNoticesClaimed reads the claim rows by primary key).
 */
export function trackRunningFleetCreditNotices(
  deps: Pick<ProjectionDeps, 'sql' | 'eventBus' | 'logger'>,
  fleetId: string,
  throttle: FleetCreditThrottle,
  now: number = Date.now(),
): void {
  const { sql, eventBus, logger } = deps;
  if (!throttle.due('notices', fleetId, now)) return;
  throttle.mark('notices', fleetId, now);
  void eventBus.track(
    (async () => {
      try {
        if (await fleetCreditNoticesClaimed(sql, fleetId)) return;
        const check = await readFleetCreditLimit(sql, fleetId);
        if (check == null || check.level === 'ok') return;
        await dispatchFleetCreditLimitNotices(check, { templatesDirs: ALL_TEMPLATES_DIRS }, logger);
      } catch (err) {
        logger.warn({ err, fleetId }, 'Fleet credit limit notice check failed; continuing');
      }
    })(),
  );
}

function logStop(deps: ProjectionDeps, input: PaymentGateInput, decision: StopDecision): void {
  const { logger } = deps;
  const { sessionId, transactionId, idToken } = input;
  switch (decision.why) {
    case 'prepaid_no_credit':
      logger.warn(`Prepaid token without credit started session ${transactionId}, stopping`);
      return;
    case 'no_payment_method':
      logger.warn(
        `Driver ${decision.notice.driverId} has no payment method for non-free session ${transactionId}, stopping`,
      );
      return;
    case 'hold_declined':
      // A card decline is an expected driver outcome (warn). A provider
      // failure (unreachable, rejected credentials) needs an operator (error).
      if (decision.failure === 'declined') {
        logger.warn(
          { sessionId, reason: decision.notice.reason },
          'Auto pre-auth declined, stopping session',
        );
      } else {
        logger.error(
          { sessionId, reason: decision.notice.reason },
          'Auto pre-auth failed, stopping session',
        );
      }
      return;
    case 'hold_terminal':
      logger.warn(
        { sessionId, status: decision.status },
        'Session hold record is not valid, stopping session',
      );
      return;
    case 'hold_record_failed':
      return;
    case 'guest_not_authorized':
      logger.warn(
        `No valid guest session for idToken ${String(idToken).slice(0, 8)}..., stopping session ${transactionId}`,
      );
      return;
    case 'anonymous':
      logger.warn(
        `Anonymous session ${transactionId} has no driver, no roaming token, and no guest session, stopping`,
      );
      return;
    case 'account_credit_limit':
      logger.warn(
        { sessionId, fleetId: decision.fleetId },
        'Fleet credit limit reached, stopping account session',
      );
      return;
  }
}

// Notices are fail-open: the stop already happened and is the decision.
async function sendNotice(
  deps: ProjectionDeps,
  input: PaymentGateInput,
  notice: GateNotice,
): Promise<void> {
  const { sql, eventBus, pubsub, logger } = deps;
  const { sessionId, transactionId, ocppStationId } = input;

  switch (notice.kind) {
    case 'preAuthFailed':
      try {
        void eventBus.track(
          dispatchDriverNotification(
            sql,
            'payment.PreAuthFailed',
            notice.driverId,
            {
              stationId: ocppStationId,
              transactionId,
              reason: notice.reason.slice(0, 200),
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          ),
        );
      } catch (err) {
        logger.debug(
          { err, driverId: notice.driverId, sessionId },
          'PreAuthFailed notification dispatch failed; continuing',
        );
      }
      try {
        await pubsub.publish(
          'csms_events',
          JSON.stringify({
            type: 'payment.preAuthFailed',
            sessionId,
            transactionId,
            reason: notice.reason.slice(0, 200),
          }),
        );
      } catch (err) {
        logger.debug({ err, sessionId }, 'PreAuthFailed SSE publish failed; continuing');
      }
      return;
    case 'missingPaymentMethod':
      try {
        void eventBus.track(
          dispatchDriverNotification(
            sql,
            'payment.MissingPaymentMethod',
            notice.driverId,
            {
              stationId: ocppStationId,
              transactionId,
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          ),
        );
      } catch (notifyErr) {
        logger.error({ err: notifyErr }, 'Failed to notify driver of missing payment method');
      }
      try {
        await pubsub.publish(
          'csms_events',
          JSON.stringify({
            type: 'payment.missingPaymentMethod',
            sessionId,
            transactionId,
          }),
        );
      } catch (err) {
        logger.debug({ err, sessionId }, 'MissingPaymentMethod SSE publish failed; continuing');
      }
      return;
    case 'guestPreAuthFailed':
      try {
        void eventBus.track(
          dispatchSystemNotification(
            sql,
            'payment.PreAuthFailed',
            { email: notice.email },
            {
              stationId: ocppStationId,
              transactionId,
              reason: 'Payment authorization not found',
            },
            ALL_TEMPLATES_DIRS,
          ),
        );
      } catch (notifyErr) {
        logger.error({ err: notifyErr }, 'Failed to notify guest of session stop');
      }
      return;
  }
}
