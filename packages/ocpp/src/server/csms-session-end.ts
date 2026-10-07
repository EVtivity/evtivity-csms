// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { z } from 'zod';
import type { EventBus, Logger, PubSubClient } from '@evtivity/lib';
import {
  CSMS_SESSION_END_REASONS,
  SESSION_END_FAILED_REASON,
  SESSION_END_REQUEST_CHANNEL,
  faultUnbilledSession,
} from '@evtivity/database';
import { cancelOpenSessionHold } from '@evtivity/payments';
import { paymentContext } from '../lib/payments.js';
import { notifySessionEndFailed } from './session-end-alert.js';
import type { CsmsSessionEndReason } from '@evtivity/database';

/**
 * Domain event of a session the CSMS ends because the station will not:
 * a new transaction superseded it on its EVSE, or the station has no record
 * of it (`TxNotFound`). Its payload has the shape of a `TransactionEvent`
 * `Ended`, so the event projections end it the normal way: completed, final
 * cost from the last metered energy, settlement, receipt.
 */
export const SESSION_ENDED_BY_CSMS = 'session.EndedByCsms';

/** The trigger reason recorded on the `ended` transaction event the CSMS writes. */
export const CSMS_END_TRIGGER_REASON = 'AbnormalCondition';

/**
 * How long a claim holds before the sweep may retry the end (the pod that
 * claimed it died, or its projection failed).
 */
export const SESSION_END_LEASE_SECONDS = 300;

/**
 * Claims after which the sweep stops retrying a session end that never
 * completes (its Ended projection keeps failing): the session is faulted
 * unbilled with stopped reason SESSION_END_FAILED_REASON and its hold is
 * cancelled.
 */
export const SESSION_END_MAX_ATTEMPTS = 5;

/** How often each OCPP pod sweeps for end requests nobody has processed. */
export const SESSION_END_SWEEP_INTERVAL_MS = 60_000;

/**
 * Claims an active session for a CSMS end and publishes SESSION_ENDED_BY_CSMS
 * for it. The claim records the request durably (end_request_reason) and
 * takes a lease (end_claimed_at), so the end runs once, whichever OCPP pod
 * (subscriber or sweep) gets there first, and is retried by the sweep when
 * the lease expires with the session still active. The session ends at its
 * last update, the time of its last metered energy. Returns false when the
 * session is unknown, not active (P5: a faulted or failed session is left
 * alone), or claimed by a lease that has not expired.
 */
export async function requestCsmsSessionEnd(
  sql: postgres.Sql,
  eventBus: EventBus,
  sessionId: string,
  reason: CsmsSessionEndReason,
): Promise<boolean> {
  const [claimed] = await sql`
    UPDATE charging_sessions cs
    SET stopped_reason = ${reason},
        end_request_reason = ${reason},
        end_claimed_at = now(),
        end_attempts = cs.end_attempts + 1
    FROM charging_stations st
    WHERE cs.id = ${sessionId}
      AND st.id = cs.station_id
      AND cs.status = 'active'
      AND cs.transaction_id IS NOT NULL
      AND cs.end_attempts < ${SESSION_END_MAX_ATTEMPTS}
      AND (cs.end_claimed_at IS NULL
        OR cs.end_claimed_at < now() - make_interval(secs => ${SESSION_END_LEASE_SECONDS}))
    RETURNING cs.transaction_id, cs.updated_at, st.station_id AS station_ocpp_id,
      (SELECT COALESCE(MAX(te.seq_no) + 1, 0) FROM transaction_events te
        WHERE te.session_id = cs.id) AS next_seq_no
  `;
  if (claimed == null) return false;
  const stationId = claimed['station_ocpp_id'] as string;
  const transactionId = claimed['transaction_id'] as string;
  const updatedAt = claimed['updated_at'] as Date | string;
  // Keyed by the transaction, as TransactionEvents are, so it is projected in
  // order with any event of that transaction still queued.
  await eventBus.publish({
    eventType: SESSION_ENDED_BY_CSMS,
    aggregateType: 'Transaction',
    aggregateId: transactionId,
    payload: {
      eventType: 'Ended',
      stationId,
      transactionId,
      seqNo: Number(claimed['next_seq_no']),
      triggerReason: CSMS_END_TRIGGER_REASON,
      timestamp: new Date(updatedAt).toISOString(),
      stoppedReason: reason,
    },
  });
  return true;
}

const sessionEndRequestSchema = z.object({
  sessionId: z.string().min(1),
  reason: z.enum(CSMS_SESSION_END_REASONS),
});

/**
 * Subscribes to the API's session end requests (SESSION_END_REQUEST_CHANNEL)
 * and ends each session through requestCsmsSessionEnd.
 */
export async function subscribeSessionEndRequests(
  pubsub: PubSubClient,
  sql: postgres.Sql,
  eventBus: EventBus,
  logger: Logger,
): Promise<{ unsubscribe: () => Promise<void> }> {
  return pubsub.subscribe(SESSION_END_REQUEST_CHANNEL, (raw: string) => {
    let message: z.infer<typeof sessionEndRequestSchema>;
    try {
      message = sessionEndRequestSchema.parse(JSON.parse(raw));
    } catch (err: unknown) {
      logger.warn({ err }, 'Bad session end request payload');
      return;
    }
    void eventBus.track(
      requestCsmsSessionEnd(sql, eventBus, message.sessionId, message.reason).catch(
        (err: unknown) => {
          logger.error(
            { err, sessionId: message.sessionId, reason: message.reason },
            'Failed to end the session',
          );
          return false;
        },
      ),
    );
  });
}

/**
 * Ends every active session with an end request that no pod holds a lease on:
 * a request whose pub/sub message was lost, or whose processing died. Every
 * OCPP pod sweeps; the claim lets one of them end each session.
 */
export async function sweepSessionEndRequests(
  sql: postgres.Sql,
  eventBus: EventBus,
  logger: Logger,
): Promise<number> {
  const pending = await sql`
    SELECT id, end_request_reason, end_attempts FROM charging_sessions
    WHERE status = 'active'
      AND end_request_reason IS NOT NULL
      AND (end_claimed_at IS NULL
        OR end_claimed_at < now() - make_interval(secs => ${SESSION_END_LEASE_SECONDS}))
    ORDER BY id
    LIMIT 100
  `;
  let ended = 0;
  for (const row of pending) {
    const sessionId = row['id'] as string;
    if (Number(row['end_attempts']) >= SESSION_END_MAX_ATTEMPTS) {
      await giveUpSessionEnd(sql, sessionId, logger);
      continue;
    }
    const parsed = z.enum(CSMS_SESSION_END_REASONS).safeParse(row['end_request_reason']);
    if (!parsed.success) {
      logger.warn({ sessionId, reason: row['end_request_reason'] }, 'Unknown session end request');
      continue;
    }
    try {
      if (await requestCsmsSessionEnd(sql, eventBus, sessionId, parsed.data)) ended++;
    } catch (err: unknown) {
      logger.error({ err, sessionId }, 'Failed to end a session with a pending end request');
    }
  }
  if (ended > 0) logger.info({ ended }, 'Ended sessions with pending end requests');
  return ended;
}

/**
 * Stops retrying a session end that failed SESSION_END_MAX_ATTEMPTS times:
 * faults the session unbilled (only while active, P5), closes its open tariff
 * segment, cancels its hold (fail-open, P9), logs at error, and alerts the
 * operators (session.EndRequestFailed, fail-open). Only the call whose fault
 * update changed the session sends the alert, so a retry or a second pod
 * never alerts twice (P7). Returns whether this call faulted it.
 */
export async function giveUpSessionEnd(
  sql: postgres.Sql,
  sessionId: string,
  logger: Logger,
): Promise<boolean> {
  try {
    const faulted = await faultUnbilledSession(sql, {
      sessionId,
      reason: SESSION_END_FAILED_REASON,
      endedAt: new Date(),
    });
    if (!faulted) return false;
    await sql`
      UPDATE session_tariff_segments
      SET ended_at = now(),
          duration_minutes = EXTRACT(EPOCH FROM (now() - started_at)) / 60
      WHERE session_id = ${sessionId} AND ended_at IS NULL
    `;
    logger.error(
      { sessionId, attempts: SESSION_END_MAX_ATTEMPTS },
      'Session end failed repeatedly; session faulted unbilled and its hold cancelled',
    );
    try {
      await cancelOpenSessionHold(sessionId, 'Session end failed', paymentContext(logger));
    } catch (err: unknown) {
      logger.warn({ err, sessionId }, 'Failed to cancel the hold of a session whose end failed');
    }
    await notifySessionEndFailed(sql, sessionId, logger);
    return true;
  } catch (err: unknown) {
    logger.error({ err, sessionId }, 'Failed to fault a session whose end failed');
    return false;
  }
}

/** Starts the periodic sweep (SESSION_END_SWEEP_INTERVAL_MS). Returns its stop function. */
export function startSessionEndSweep(
  sql: postgres.Sql,
  eventBus: EventBus,
  logger: Logger,
  intervalMs: number = SESSION_END_SWEEP_INTERVAL_MS,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void eventBus
      .track(sweepSessionEndRequests(sql, eventBus, logger))
      .catch((err: unknown) => {
        logger.error({ err }, 'Session end request sweep failed');
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
