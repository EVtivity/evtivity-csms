// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { DomainEvent } from '@evtivity/lib';
import { notificationMoney, receiptBilling, sessionReceiptVariables } from '@evtivity/lib';
import {
  dispatchPrepaidLowCreditNotice,
  isReleasedBelowMinimum,
  recordTerminalSettlement,
  settleSessionPayment,
} from '@evtivity/payments';
import type { SettlementOutcome } from '@evtivity/payments';
import { pgConnectionErrorKind } from '@evtivity/database';
import { dispatchDriverNotification, ALL_TEMPLATES_DIRS } from '../notification-dispatcher.js';
import type { ProjectionDeps } from '../projection-support/context.js';
import type { ProjectionAttempt } from '../projection-retry.js';

/** NotifySettlement: the station settled the payment itself (terminal payment). */
export async function projectNotifySettlement(
  deps: ProjectionDeps,
  event: DomainEvent,
): Promise<void> {
  const { sql, eventBus, pubsub, logger, lookups, notify } = deps;
  const payload = event.payload;
  const transactionId = payload.transactionId as string | undefined;
  const settlementAmount = payload.settlementAmount as number | undefined;

  if (transactionId == null || settlementAmount == null) {
    logger.warn(
      { stationId: event.aggregateId, transactionId, settlementAmount },
      'NotifySettlement missing required fields; skipping',
    );
    return;
  }

  const sessionRows = await sql`
    SELECT cs.id, cs.driver_id, cs.station_id, UPPER(cs.currency) AS currency
    FROM charging_sessions cs
    JOIN charging_stations st ON st.id = cs.station_id
    WHERE st.station_id = ${event.aggregateId} AND cs.transaction_id = ${transactionId}
  `;
  const session = sessionRows[0];
  if (session == null) return;

  // Convert settlement amount to cents (OCPP sends in major currency units)
  const capturedAmountCents = Math.round(settlementAmount * 100);

  const recorded = await recordTerminalSettlement({
    sessionId: session.id as string,
    driverId: (session.driver_id as string | null) ?? null,
    currency: session.currency as string,
    capturedCents: capturedAmountCents,
  });

  if (!recorded) {
    logger.warn(
      { transactionId, sessionId: session.id },
      'Duplicate NotifySettlement ignored; payment already exists for session',
    );
    return;
  }

  await notify.notifyChange('payment.settled', null, null, session.id as string);

  // Driver notification: payment received
  if (session.driver_id != null) {
    const settleSiteName =
      session.station_id != null
        ? await lookups.resolveSiteName(session.station_id as string)
        : null;
    void eventBus.track(
      dispatchDriverNotification(
        sql,
        'session.PaymentReceived',
        session.driver_id as string,
        {
          siteName: settleSiteName ?? '',
          stationId: event.aggregateId,
          transactionId,
          amountCents: capturedAmountCents,
          amountFormatted: notificationMoney(capturedAmountCents, session.currency as string),
          currency: session.currency as string,
        },
        ALL_TEMPLATES_DIRS,
        pubsub,
      ),
    );

    // Driver notification: payment complete
    void eventBus.track(
      dispatchDriverNotification(
        sql,
        'payment.Complete',
        session.driver_id as string,
        {
          stationId: event.aggregateId,
          transactionId,
          amountCents: capturedAmountCents,
          amountFormatted: notificationMoney(capturedAmountCents, session.currency as string),
          currency: session.currency as string,
        },
        ALL_TEMPLATES_DIRS,
        pubsub,
      ),
    );
  }
}

// Driver notifications at the end of a session: session.Completed and
// session.Receipt. Sent after the settlement so the state is read at dispatch
// (P5): no notification for a faulted or failed session (a payment failure
// or a missing payment method faults it, which also covers the path that
// never wrote a payment record), no receipt when the capture failed (the
// payment record is failed: there is no payment to confirm, and
// payment.CaptureFailed tells the driver), no receipt yet while an async
// provider has not confirmed the capture (the record's pending_operation is
// capture or adjust: the webhook that confirms it sends the receipt through
// dispatchPaymentWebhookNotices, and a capture that fails then sends
// payment.CaptureFailed instead, finding JB-3), and `notCharged` when the
// hold was released because the cost is below the provider minimum charge.
// Each notice goes out at most once per session: a one-statement claim on the
// session (completed_notified_at, receipt_notified_at, set WHERE IS NULL
// RETURNING) picks the run that sends it, so a station that resends its Ended
// event gets no second notice. The claim result is memoized, so a projection
// rerun after the claim still sends the notice it claimed; a claim that
// committed but whose reply was lost reads as claimed on the rerun and that
// notice is skipped.
async function notifySessionEnded(
  deps: ProjectionDeps,
  attempt: ProjectionAttempt,
  sessionId: string,
  stationId: string,
  transactionId: string,
  stationUuid: string,
): Promise<void> {
  const { sql, eventBus, pubsub, lookups } = deps;
  const [endedSession] = await sql`
    SELECT cs.driver_id, cs.energy_delivered_wh, cs.final_cost_cents, cs.started_at, cs.ended_at,
           cs.status, cs.tariff_tax_rate, UPPER(cs.currency) AS currency, cs.billing_mode,
           f.name AS billing_fleet_name
    FROM charging_sessions cs
    LEFT JOIN fleets f ON f.id = cs.billing_fleet_id
    WHERE cs.id = ${sessionId}`;
  if (endedSession == null || endedSession.driver_id == null) return;
  const status = endedSession.status as string;
  if (status === 'faulted' || status === 'failed' || status === 'active') return;
  const [record] = await sql`
    SELECT status, failure_reason, pending_operation FROM payment_records
    WHERE session_id = ${sessionId}
    ORDER BY id LIMIT 1`;
  const captureFailed = record != null && record.status === 'failed';
  const capturePending =
    record != null &&
    (record.pending_operation === 'capture' || record.pending_operation === 'adjust');
  const notCharged =
    record != null &&
    isReleasedBelowMinimum({
      status: record.status as string,
      failureReason: record.failure_reason as string | null,
    });
  const endedSiteName = await lookups.resolveSiteName(stationUuid);
  const variables = sessionReceiptVariables({
    siteName: endedSiteName,
    stationId,
    transactionId,
    energyDeliveredWh: endedSession.energy_delivered_wh as number,
    finalCostCents: endedSession.final_cost_cents as number | null,
    currency: endedSession.currency as string,
    tariffTaxRate: endedSession.tariff_tax_rate as string | null,
    startedAt: endedSession.started_at as string,
    endedAt: endedSession.ended_at as string,
    notCharged,
    // The stamp, not the current fleet state: an account session without a
    // payment record says "billed to <fleet>, no card charged". One with a
    // record (an operator hold) was paid by card.
    ...receiptBilling(
      endedSession.billing_mode,
      (endedSession.billing_fleet_name as string | null) ?? null,
      record != null,
    ),
  });
  const claims = {
    'session.Completed': () => sql`
      UPDATE charging_sessions SET completed_notified_at = now()
      WHERE id = ${sessionId} AND completed_notified_at IS NULL
      RETURNING id`,
    'session.Receipt': () => sql`
      UPDATE charging_sessions SET receipt_notified_at = now()
      WHERE id = ${sessionId} AND receipt_notified_at IS NULL
      RETURNING id`,
  };
  const eventTypes =
    captureFailed || capturePending
      ? (['session.Completed'] as const)
      : (['session.Completed', 'session.Receipt'] as const);
  for (const eventType of eventTypes) {
    const claimed = await attempt.memo(`settle:${eventType}:claim`, claims[eventType]);
    if (claimed.length === 0) continue;
    await attempt.once(`settle:${eventType}`, () => {
      void eventBus.track(
        dispatchDriverNotification(
          sql,
          eventType,
          endedSession.driver_id as string,
          variables,
          ALL_TEMPLATES_DIRS,
          pubsub,
        ),
      );
      return Promise.resolve();
    });
  }
}

// Payment auto-capture on session end (separate subscriber, no race with session creation).
// Returns the settlement outcome, or null when the event is not an Ended one
// or the session is unknown.
export async function settleTransactionEnded(
  deps: ProjectionDeps,
  event: DomainEvent,
  attempt: ProjectionAttempt,
): Promise<SettlementOutcome | null> {
  const { sql, eventBus, pubsub, logger, payments, lookups, notify } = deps;
  const payload = event.payload;
  const eventType = payload.eventType as string;
  const transactionId = payload.transactionId as string;
  const stationId = payload.stationId as string;

  if (eventType === 'Ended') {
    // Settlement on session end
    const sessionRows = await sql`
      SELECT cs.id, cs.final_cost_cents, cs.station_id AS station_uuid,
             UPPER(cs.currency) AS currency,
             cs2.station_id AS station_ocpp_id, cs2.site_id
      FROM charging_sessions cs
      JOIN charging_stations cs2 ON cs2.id = cs.station_id
      WHERE cs2.station_id = ${stationId} AND cs.transaction_id = ${transactionId}
    `;
    const session = sessionRows[0];
    if (session == null) return null;

    // Prepaid debit, or capture/cancel of the driver's hold, through the
    // provider the payment is pinned to. Guest holds are left to the
    // guest-session worker. Idempotent: the record moves only from its
    // open state, and the provider calls carry keys derived from it. A rerun
    // keeps the first outcome (a second call would find the record settled).
    // Before the last run, a lost connection before any provider call is
    // thrown so the retry settles again; on the last run the payment service
    // keeps its behavior without retry. A rerun resumes an adjustment claim
    // the first run made but never got a provider reference for.
    const outcome = await attempt.memo('settle:outcome', () =>
      settleSessionPayment(session.id as string, payments, {
        rethrowConnectionErrors: !attempt.isLast,
        resumeAdjustment: attempt.number > 1,
      }),
    );
    try {
      await notifySessionEnded(
        deps,
        attempt,
        session.id as string,
        stationId,
        transactionId,
        session.station_uuid as string,
      );
    } catch (err) {
      // A lost connection goes to the projection retry; on the last run the
      // notices are given up so the payment notices below still go out.
      if (pgConnectionErrorKind(err) != null && !attempt.isLast) throw err;
      logger.warn({ err, sessionId: session.id }, 'Session end notifications failed; continuing');
    }
    const sessionCurrency = session.currency as string;
    const finalCostCents = session.final_cost_cents as number | null;

    if (outcome.mode === 'prepaid') {
      logger.info(
        {
          sessionId: session.id,
          tokenId: outcome.tokenId,
          debitedCents: outcome.debitedCents,
        },
        outcome.repeated === true ? 'Prepaid debit already recorded' : 'Prepaid balance debited',
      );
      await notify.notifyChange(
        'payment.settled',
        session.station_uuid as string,
        (session.site_id as string | null) ?? null,
        session.id as string,
      );
      await attempt.once('settle:token-changed', async () => {
        try {
          await pubsub.publish(
            'csms_events',
            JSON.stringify({ eventType: 'token.changed', tokenId: outcome.tokenId }),
          );
        } catch (err) {
          logger.debug({ err }, 'token.changed SSE publish failed; continuing');
        }
      });
      // Low credit notice when this debit took the balance below the
      // threshold (once per debit: a repeated settlement sends nothing, and a
      // rerun keeps the first outcome and skips the done step). Fire-and-forget
      // and fail-open (P9).
      if (outcome.repeated !== true) {
        await attempt.once('settle:prepaid-low-credit', () => {
          void eventBus.track(
            dispatchPrepaidLowCreditNotice(outcome, {
              templatesDirs: ALL_TEMPLATES_DIRS,
              pubsub,
            }).catch((err: unknown) => {
              logger.warn(
                { err, sessionId: session.id, tokenId: outcome.tokenId },
                'Prepaid low credit notice failed; continuing',
              );
            }),
          );
          return Promise.resolve();
        });
      }
      return outcome;
    }
    if (outcome.mode !== 'card') return outcome;

    if (outcome.status === 'failed') {
      await attempt.once('settle:capture-failed', () => {
        // The dispatch is fire-and-forget and fail-open (it never rejects);
        // this catch only guards a synchronous throw from the call itself, so
        // the once step always succeeds and the settlement returns.
        try {
          void eventBus.track(
            dispatchDriverNotification(
              sql,
              'payment.CaptureFailed',
              outcome.driverId,
              {
                stationId: event.aggregateId,
                transactionId,
                amountFormatted: notificationMoney(finalCostCents ?? 0, sessionCurrency),
                reason: outcome.reason.slice(0, 200),
              },
              ALL_TEMPLATES_DIRS,
              pubsub,
            ),
          );
        } catch (err) {
          logger.debug(
            { err, driverId: outcome.driverId, transactionId },
            'CaptureFailed notification dispatch failed; continuing',
          );
        }
        return Promise.resolve();
      });
      return outcome;
    }

    // Notify on capture only when it was recorded (a capture whose record
    // update failed is logged for manual reconciliation instead).
    if (outcome.status === 'captured' && outcome.recorded) {
      const stationUuid = session.station_uuid as string | null;
      const captureSiteName =
        stationUuid != null ? await lookups.resolveSiteName(stationUuid) : null;
      await attempt.once('settle:payment-received', () => {
        void eventBus.track(
          dispatchDriverNotification(
            sql,
            'session.PaymentReceived',
            outcome.driverId,
            {
              siteName: captureSiteName ?? '',
              stationId: session.station_ocpp_id as string,
              transactionId,
              amountCents: outcome.capturedCents,
              amountFormatted: notificationMoney(outcome.capturedCents, sessionCurrency),
              currency: sessionCurrency,
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          ),
        );
        return Promise.resolve();
      });
    }
    return outcome;
  }
  return null;
}
