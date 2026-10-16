// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { faultUnbilledSession, writeCsmsSessionAudit } from '@evtivity/database';
import { notificationMoney, publishOcppCommand } from '@evtivity/lib';
import type { StationMessageState } from '@evtivity/lib';
import {
  enqueueRefusedStartStop,
  REFUSED_START_STOP_GRACE_MS,
  showPaymentStopMessage,
} from '@evtivity/services/refused-start-stop';
import type { PaymentStopTarget } from '@evtivity/services/refused-start-stop';
import { dispatchDriverNotification, ALL_TEMPLATES_DIRS } from '../notification-dispatcher.js';
import type { ProjectionDeps } from '../projection-support/context.js';

/** What the claim of a ceiling stop returns for the driver's prepaid notice. */
interface CeilingStopRow {
  /** The session's driver, else the token's. */
  driver_id: string | null;
  id_token: string | null;
  cost_ceiling_cents: number | null;
  currency: string;
  site_name: string | null;
}

export type StopTarget = PaymentStopTarget;

export type PaymentStopReason =
  | 'PaymentFailed'
  | 'MissingPaymentMethod'
  | 'GuestPaymentNotAuthorized'
  | 'AnonymousSession'
  | 'PrepaidCreditExhausted'
  | 'GuestHoldExhausted'
  | 'AccountCreditLimit';

/** Driver notice of a session the fleet credit limit refused at its start or stopped at its ceiling. */
export const ACCOUNT_CREDIT_LIMIT_EVENT = 'payment.AccountCreditLimit';

/** The reasons of a stop at the session's cost ceiling (the MeterValues cost loop). */
export type CeilingStopReason =
  | 'PrepaidCreditExhausted'
  | 'GuestHoldExhausted'
  | 'AccountCreditLimit';

/**
 * The reason of a stop at the cost ceiling, from how the session is paid:
 * an account session (stamped `account`, its ceiling the fleet credit it
 * reserved at the start) stops with AccountCreditLimit, a session with a
 * driver token (a prepaid token's credit) with PrepaidCreditExhausted, and a
 * session without one (a guest's card hold) with GuestHoldExhausted. Account
 * sessions are never prepaid (prepaid comes before account), so the token of
 * an account driver's RFID card never makes it a prepaid stop.
 */
export function ceilingStopReason(session: {
  billingMode: string | null;
  tokenId: string | null;
}): CeilingStopReason {
  if (session.billingMode === 'account') return 'AccountCreditLimit';
  return session.tokenId != null ? 'PrepaidCreditExhausted' : 'GuestHoldExhausted';
}

/** True when the station reported reaching the cost limit of the session (E16.FR.05). */
export async function costLimitReported(sql: postgres.Sql, sessionId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM transaction_events
    WHERE session_id = ${sessionId} AND trigger_reason = 'CostLimitReached'
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Stops the session by publishing RequestStopTransaction. For
 * payment-failure reasons (PaymentFailed, MissingPaymentMethod,
 * AccountCreditLimit) we first
 * eagerly mark the DB row faulted and close its tariff segment, then
 * publish (P4), so the operator UI clears the connector even if the
 * process dies before the publish, the station ignores the stop, or the
 * message is lost. This is the ghost-session prevention path: a card
 * declined at the gate must not leave a stranded `active` session that no
 * event can ever close. A failed fault is logged and the stop is still
 * published: stopping the unpaid charge matters more than the row, and the
 * station's TransactionEvent.Ended then closes the session.
 *
 * Anonymous and guest-not-authorized stops only publish the OCPP command;
 * the natural TransactionEvent.Ended that follows handles the DB
 * transition. Eager cleanup for those would race the legitimate Ended
 * handler.
 *
 * PrepaidCreditExhausted and GuestHoldExhausted record stopped_reason
 * first and publish only when they claimed the session, so repeated
 * MeterValues send one stop.
 *
 * AccountCreditLimit (an account start refused by the fleet credit limit)
 * faults like a payment failure and tells the driver
 * (`payment.AccountCreditLimit`) only from the call whose fault changed the
 * session, so a repeated Started sends one notice (P7). With `atCeiling` (a
 * running account session reached the fleet credit it reserved, plan S8) it
 * takes the ceiling claim instead: the session is not faulted, it is billed
 * up to its ceiling, and the station message and the driver notice go out
 * from the call that claimed it, shared with a 2.1 CostLimitReached report
 * (noteCostLimitReached).
 *
 * With `startRefused` (an AccountCreditLimit stop of a start the CSMS
 * already refused: a 1.6 StartTransaction answered Blocked for no credit)
 * the session is still faulted at once, but RequestStopTransaction and the
 * station message wait REFUSED_START_STOP_GRACE_MS in a delayed worker job
 * (`refused-start-stop`, job id per session, P7), which sends nothing when
 * the station ended the transaction itself by then: a stop sent while a
 * station ends a refused transaction crossed its own StopTransaction. When
 * the job cannot be queued the stop goes out at once.
 */
export async function stopSessionForPayment(
  deps: ProjectionDeps,
  target: StopTarget,
  reason: PaymentStopReason,
  options: { atCeiling?: boolean; transactionEnded?: boolean; startRefused?: boolean } = {},
): Promise<void> {
  const { sql, pubsub, logger, notify } = deps;
  const { sessionId, transactionId, ocppStationId } = target;

  // A session at its cost ceiling (a prepaid token's credit or a guest's
  // hold, see the MeterValues cost loop): mark the stop request on the session before
  // publishing, once. The session stays active until the station ends the
  // transaction, which keeps this stopped_reason (COALESCE) and settles.
  // The claim is shared with a 2.1 station's CostLimitReached report
  // (noteCostLimitReached), so the notices go out once.
  const accountAtCeiling = reason === 'AccountCreditLimit' && options.atCeiling === true;
  let ceilingStop: CeilingStopRow | null = null;
  if (reason === 'PrepaidCreditExhausted' || reason === 'GuestHoldExhausted' || accountAtCeiling) {
    try {
      ceilingStop = await claimCeilingStop(sql, sessionId, reason, 'any');
      if (ceilingStop == null) return;
    } catch (err) {
      logger.error({ err, sessionId }, 'Failed to record the payment stop of the session');
      return;
    }
  }

  const eagerCleanup =
    reason === 'PaymentFailed' ||
    reason === 'MissingPaymentMethod' ||
    (reason === 'AccountCreditLimit' && !accountAtCeiling);
  let faulted = false;
  if (eagerCleanup) {
    try {
      // Zero out cost columns: the driver never authorized payment so we
      // must not display or persist a session-fee charge. Without this,
      // the cost calc on the Ended event (or MeterValues if a stray one
      // arrives) applies pricePerSession + tax and the portal Recent
      // Sessions list shows a phantom $0.81 next to a 0 kWh row.
      faulted = await faultUnbilledSession(sql, {
        sessionId,
        reason,
        endedAt: new Date(),
      });
      await sql`
        UPDATE session_tariff_segments
        SET ended_at = now(),
            duration_minutes = EXTRACT(EPOCH FROM (now() - started_at)) / 60
        WHERE session_id = ${sessionId} AND ended_at IS NULL
      `;
    } catch (err) {
      logger.error({ err, sessionId, reason }, 'Failed to mark session faulted');
    }
  }

  // A start the CSMS refused: the station ends the transaction itself, so
  // the stop waits for the grace period (the fault above is already done).
  let stopDeferred = false;
  if (
    reason === 'AccountCreditLimit' &&
    !accountAtCeiling &&
    options.startRefused === true &&
    options.transactionEnded !== true
  ) {
    try {
      await enqueueRefusedStartStop(target);
      stopDeferred = true;
    } catch (err) {
      logger.warn(
        { err, sessionId },
        'Refused start stop not queued; stopping the transaction now',
      );
    }
  }

  // A transaction the station already ended (the gate ran for an idToken
  // first presented in TransactionEvent Ended) needs no stop.
  let stopSent = false;
  if (options.transactionEnded !== true && !stopDeferred) {
    try {
      await publishOcppCommand(pubsub, {
        stationId: ocppStationId,
        action: 'RequestStopTransaction',
        payload: { transactionId },
      });
      stopSent = true;
    } catch (err) {
      logger.error({ err }, 'Failed to publish RequestStopTransaction');
    }
  }

  await auditPaymentStop(deps, target, reason, {
    faulted,
    stopSent,
    stopDeferred,
    ceiling: ceilingStop != null,
  });

  if (reason === 'PrepaidCreditExhausted') {
    // Only the call that claimed the stop gets here.
    if (ceilingStop != null) await sendPrepaidExhaustedNotices(deps, target, ceilingStop);
  } else if (accountAtCeiling) {
    // Only the call that claimed the stop gets here.
    await sendAccountCeilingNotices(deps, target);
  } else {
    // A guest paid by card at the QR checkout; the hold ended the session
    // as the checkout said. No station message.
    const stateByReason: Record<PaymentStopReason, StationMessageState | null> = {
      PaymentFailed: 'payment_failed',
      MissingPaymentMethod: 'payment_required',
      GuestPaymentNotAuthorized: 'guest_unauthorized',
      AnonymousSession: 'unauthorized',
      PrepaidCreditExhausted: 'prepaid_exhausted',
      GuestHoldExhausted: null,
      AccountCreditLimit: 'account_credit_limit',
    };
    // A deferred stop shows its message from the job, with the stop.
    const messageState = stopDeferred ? null : stateByReason[reason];
    if (messageState != null) await showPaymentStopMessage(deps, target, messageState);
  }

  if (reason === 'AccountCreditLimit' && faulted) {
    await sendAccountCreditLimitNotice(deps, target);
  }

  // The audit helper logs its own failures (fail-open).
  if (faulted) {
    await notify.auditLinkedReservationFault(sessionId, `faulted: ${reason}`);
  }
}

/**
 * The session audit row of a payment stop (fail-open): `faulted` when this
 * call faulted the session (its notes say whether the stop went out), else
 * `stopped_by_csms` when the stop was sent. A ceiling stop records the
 * stopped reason its claim set. Nothing when neither happened (a repeated
 * call, or a stop that could not be published to a session left as it was).
 */
async function auditPaymentStop(
  deps: ProjectionDeps,
  target: StopTarget,
  reason: PaymentStopReason,
  outcome: { faulted: boolean; stopSent: boolean; stopDeferred: boolean; ceiling: boolean },
): Promise<void> {
  const { sessionId, transactionId } = target;
  if (outcome.faulted) {
    await writeCsmsSessionAudit(
      {
        sessionId,
        action: 'faulted',
        actor: 'ocpp',
        actorLabel: reason,
        before: { status: 'active' },
        after: { status: 'faulted', stoppedReason: reason, finalCostCents: 0 },
        notes: outcome.stopSent
          ? `RequestStopTransaction sent for transaction ${transactionId}`
          : outcome.stopDeferred
            ? `Start refused: RequestStopTransaction for transaction ${transactionId} in ${String(REFUSED_START_STOP_GRACE_MS / 1000)} s unless the station ends it`
            : null,
      },
      undefined,
      deps.logger,
    );
    return;
  }
  if (!outcome.stopSent) return;
  await writeCsmsSessionAudit(
    {
      sessionId,
      action: 'stopped_by_csms',
      actor: 'ocpp',
      actorLabel: reason,
      before: outcome.ceiling ? { stoppedReason: null } : null,
      after: {
        command: 'RequestStopTransaction',
        transactionId,
        ...(outcome.ceiling ? { stoppedReason: reason } : { reason }),
      },
    },
    undefined,
    deps.logger,
  );
}

/**
 * The driver's `payment.AccountCreditLimit` notice: the fleet the session is
 * billed to reached its credit limit, so the start was refused or the session
 * was stopped at the credit it reserved. Read after the fault or the ceiling
 * claim, from the session's billing stamp. Fire-and-forget and fail-open
 * (P9).
 */
async function sendAccountCreditLimitNotice(
  deps: ProjectionDeps,
  target: StopTarget,
): Promise<void> {
  const { sql, eventBus, pubsub, logger } = deps;
  try {
    const [row] = await sql<
      Array<{ driver_id: string | null; fleet_name: string | null; site_name: string | null }>
    >`
      SELECT cs.driver_id, f.name AS fleet_name, s.name AS site_name
      FROM charging_sessions cs
      LEFT JOIN fleets f ON f.id = cs.billing_fleet_id
      LEFT JOIN charging_stations st ON st.id = cs.station_id
      LEFT JOIN sites s ON s.id = st.site_id
      WHERE cs.id = ${target.sessionId}
    `;
    if (row?.driver_id == null) return;
    void eventBus.track(
      dispatchDriverNotification(
        sql,
        ACCOUNT_CREDIT_LIMIT_EVENT,
        row.driver_id,
        {
          fleetName: row.fleet_name ?? '',
          siteName: row.site_name ?? '',
          stationId: target.ocppStationId,
          transactionId: target.transactionId,
        },
        ALL_TEMPLATES_DIRS,
        pubsub,
      ).catch((err: unknown) => {
        logger.warn(
          { err, sessionId: target.sessionId },
          'Account credit limit notice failed; continuing',
        );
      }),
    );
  } catch (err) {
    logger.warn(
      { err, sessionId: target.sessionId },
      'Account credit limit notice failed; continuing',
    );
  }
}

/**
 * A 2.1 station reported reaching the cost limit (TransactionEvent
 * triggerReason CostLimitReached, E16.FR.05) of a session with a prepaid
 * token's credit (C17.FR.03) or an account session's reserved fleet credit
 * (plan S8) as its ceiling: the station suspended it, so the CSMS does not
 * stop it. Claims the session with the same stopped_reason claim as
 * `stopSessionForPayment` (PrepaidCreditExhausted, else AccountCreditLimit),
 * so the station message and the driver notice go out once per session,
 * whichever comes first, and a later CSMS stop finds the session claimed and
 * sends nothing. A guest session (no token, no account) is left alone.
 * `accountCeilingRaised` (the TransactionEvent handler raised an account
 * session's ceiling above the limit the station reached, and the response
 * sent it so the station resumes) leaves the account session unclaimed: it
 * is claimed only when its ceiling cannot grow. Returns true when it claimed.
 * A failed claim throws (the caller decides the retry); the notices are
 * fail-open.
 */
export async function noteCostLimitReached(
  deps: ProjectionDeps,
  target: StopTarget,
  options: { accountCeilingRaised?: boolean } = {},
): Promise<boolean> {
  const prepaid = await claimCeilingStop(
    deps.sql,
    target.sessionId,
    'PrepaidCreditExhausted',
    'prepaid',
  );
  if (prepaid != null) {
    await sendPrepaidExhaustedNotices(deps, target, prepaid);
    return true;
  }
  if (options.accountCeilingRaised === true) return false;
  const account = await claimCeilingStop(
    deps.sql,
    target.sessionId,
    'AccountCreditLimit',
    'account',
  );
  if (account == null) return false;
  await sendAccountCeilingNotices(deps, target);
  return true;
}

/**
 * Records the ceiling stop on an active session that has none yet and returns
 * what the driver's prepaid notice needs, or null when another call claimed
 * it. `prepaid` also requires a token and a ceiling and no account stamp (a
 * prepaid session); `account` requires the account stamp and a ceiling.
 */
async function claimCeilingStop(
  sql: postgres.Sql,
  sessionId: string,
  reason: CeilingStopReason,
  only: 'any' | 'prepaid' | 'account',
): Promise<CeilingStopRow | null> {
  const claimed = await sql<CeilingStopRow[]>`
    WITH claimed AS (
      UPDATE charging_sessions
      SET stopped_reason = ${reason}, updated_at = now()
      WHERE id = ${sessionId} AND status = 'active' AND stopped_reason IS NULL
        AND (${only} <> 'prepaid' OR (token_id IS NOT NULL AND cost_ceiling_cents IS NOT NULL
             AND billing_mode IS DISTINCT FROM 'account'))
        AND (${only} <> 'account' OR (billing_mode = 'account' AND cost_ceiling_cents IS NOT NULL))
      RETURNING id, driver_id, token_id, station_id, cost_ceiling_cents, currency
    )
    SELECT COALESCE(claimed.driver_id, dt.driver_id) AS driver_id,
           dt.id_token, claimed.cost_ceiling_cents,
           UPPER(claimed.currency) AS currency, s.name AS site_name
    FROM claimed
    LEFT JOIN driver_tokens dt ON dt.id = claimed.token_id
    LEFT JOIN charging_stations st ON st.id = claimed.station_id
    LEFT JOIN sites s ON s.id = st.site_id
  `;
  return claimed[0] ?? null;
}

/**
 * The account_credit_limit station message and the driver's
 * `payment.AccountCreditLimit` notice of an account session stopped at the
 * fleet credit it reserved (plan S8). Both fail-open (P9).
 */
async function sendAccountCeilingNotices(deps: ProjectionDeps, target: StopTarget): Promise<void> {
  await showPaymentStopMessage(deps, target, 'account_credit_limit');
  await sendAccountCreditLimitNotice(deps, target);
}

/**
 * The prepaid_exhausted station message and the driver's
 * `prepaid.CreditExhausted` notice. Fire-and-forget and fail-open (P9).
 */
async function sendPrepaidExhaustedNotices(
  deps: ProjectionDeps,
  target: StopTarget,
  row: CeilingStopRow,
): Promise<void> {
  const { sql, eventBus, pubsub, logger } = deps;
  await showPaymentStopMessage(deps, target, 'prepaid_exhausted');
  if (row.driver_id == null) return;
  const currency = row.currency;
  // Fail-open (P9): the notice runs in the background and logs its failure.
  void eventBus.track(
    dispatchDriverNotification(
      sql,
      'prepaid.CreditExhausted',
      row.driver_id,
      {
        idToken: row.id_token ?? '',
        siteName: row.site_name ?? '',
        stationId: target.ocppStationId,
        transactionId: target.transactionId,
        creditFormatted:
          row.cost_ceiling_cents != null ? notificationMoney(row.cost_ceiling_cents, currency) : '',
        currency,
      },
      ALL_TEMPLATES_DIRS,
      pubsub,
    ).catch((err: unknown) => {
      logger.warn(
        { err, sessionId: target.sessionId },
        'Prepaid credit exhausted notice failed; continuing',
      );
    }),
  );
}
