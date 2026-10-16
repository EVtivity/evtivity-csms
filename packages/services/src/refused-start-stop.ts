// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { client } from '@evtivity/database';
import { writeCsmsSessionAudit } from '@evtivity/database';
import { dispatchOneShotStationMessage, publishOcppCommand } from '@evtivity/lib';
import type { PubSubClient, ServiceLogger, StationMessageState } from '@evtivity/lib';
import { jobQueue } from '@evtivity/lib/job-queues';
import { PAYMENT_STOP_JOB_OPTIONS, PAYMENT_STOP_QUEUE } from '@evtivity/lib/worker-queues';

/** The shared postgres client type (the OCPP projections and the worker pass theirs). */
type Sql = typeof client;

/** The session and station a payment stop targets. */
export interface PaymentStopTarget {
  sessionId: string;
  transactionId: string;
  ocppStationId: string;
  stationDbId: string;
}

/**
 * How long the CSMS waits before it stops a transaction whose start it
 * refused (a 1.6 StartTransaction answered Blocked because the fleet has no
 * credit left). A compliant station ends such a transaction itself
 * (StopTransactionOnInvalidId, reason DeAuthorized) within seconds; a
 * RequestStopTransaction and a display message sent while it does crossed
 * the station's own StopTransaction on a KEBA KC-P30, which then stopped
 * answering for 90 seconds. 30 seconds is well past that station stop and
 * bounds what a station that ignores the refusal can charge before the stop.
 * A constant, not a setting: it follows station protocol timing, not an
 * operator preference.
 */
export const REFUSED_START_STOP_GRACE_MS = 30_000;

export const REFUSED_START_STOP_JOB = 'refused-start-stop';

/** One delayed stop per session (P7): BullMQ ids reject ':', so '.' separates. */
export function refusedStartStopJobId(sessionId: string): string {
  return `refused-start-stop.${sessionId}`;
}

/**
 * Hands the stop of a refused start to the worker as a delayed job
 * (REFUSED_START_STOP_GRACE_MS), so it waits in Redis while no worker runs
 * and a later add for the same session adds nothing. Throws when the job
 * cannot be added (Redis down, a Redis ACL without the queue grant): the
 * caller then stops the transaction at once.
 */
export async function enqueueRefusedStartStop(target: PaymentStopTarget): Promise<void> {
  await jobQueue(PAYMENT_STOP_QUEUE, PAYMENT_STOP_JOB_OPTIONS).add(REFUSED_START_STOP_JOB, target, {
    jobId: refusedStartStopJobId(target.sessionId),
    delay: REFUSED_START_STOP_GRACE_MS,
  });
}

/**
 * The worker job of a refused start, after the grace period: nothing when the
 * station ended the transaction itself (its Ended is recorded), else
 * RequestStopTransaction, the account_credit_limit station message and the
 * `stopped_by_csms` audit row. The session was faulted when the start was
 * refused (P4), so the job changes no session state, and the station's later
 * Ended keeps the fault (P5). A failed publish throws, so the queue retries;
 * the message and the audit are fail-open (P9).
 */
export async function runRefusedStartStop(
  deps: { sql: Sql; pubsub: PubSubClient; logger: ServiceLogger },
  target: PaymentStopTarget,
): Promise<'station_ended' | 'stopped'> {
  const { sql, pubsub, logger } = deps;
  const ended = await sql`
    SELECT 1 FROM transaction_events
    WHERE session_id = ${target.sessionId} AND event_type = 'ended'
    LIMIT 1
  `;
  if (ended.length > 0) {
    logger.info(
      { sessionId: target.sessionId, transactionId: target.transactionId },
      'Station ended the refused transaction itself; no stop sent',
    );
    return 'station_ended';
  }
  await publishOcppCommand(pubsub, {
    stationId: target.ocppStationId,
    action: 'RequestStopTransaction',
    payload: { transactionId: target.transactionId },
  });
  await showPaymentStopMessage({ sql, pubsub, logger }, target, 'account_credit_limit');
  await writeCsmsSessionAudit(
    {
      sessionId: target.sessionId,
      action: 'stopped_by_csms',
      actor: 'system',
      actorLabel: REFUSED_START_STOP_JOB,
      before: null,
      after: {
        command: 'RequestStopTransaction',
        transactionId: target.transactionId,
        reason: 'AccountCreditLimit',
      },
      notes: `The station did not end the refused transaction within ${String(REFUSED_START_STOP_GRACE_MS / 1000)} s`,
    },
    undefined,
    logger,
  );
  logger.warn(
    { sessionId: target.sessionId, transactionId: target.transactionId },
    'Station did not end the refused transaction; RequestStopTransaction sent',
  );
  return 'stopped';
}

/**
 * Pushes a one-shot driver-facing message to the station screen so the
 * physical UX matches the email/SMS notification fan-out. The template body
 * is operator-editable in Settings -> Integration -> Station Messages,
 * rendered with the standard StationMessageContext, and dispatched via
 * dispatchOneShotStationMessage. Fail-open (P9).
 */
export async function showPaymentStopMessage(
  deps: { sql: Sql; pubsub: PubSubClient; logger: ServiceLogger },
  target: Pick<PaymentStopTarget, 'ocppStationId' | 'stationDbId'>,
  state: StationMessageState,
): Promise<void> {
  const { sql, pubsub, logger } = deps;
  try {
    const settingRows = await sql`
      SELECT key, value FROM settings
      WHERE key IN ('company.name', 'company.supportPhone', 'stationMessage.eventMessageTtlSeconds')
    `;
    const settingsMap = new Map<string, unknown>();
    for (const row of settingRows) {
      settingsMap.set(row['key'] as string, row['value']);
    }
    const companyName = (settingsMap.get('company.name') as string | undefined) ?? 'EVtivity';
    const supportPhone = settingsMap.get('company.supportPhone') as string | undefined;
    const ttlSetting = settingsMap.get('stationMessage.eventMessageTtlSeconds');
    const ttlSeconds = typeof ttlSetting === 'number' && ttlSetting > 0 ? ttlSetting : 30;
    await dispatchOneShotStationMessage(
      pubsub,
      sql,
      {
        stationOcppId: target.ocppStationId,
        stationDbId: target.stationDbId,
        state,
        context: {
          companyName,
          stationOcppId: target.ocppStationId,
          ...(supportPhone != null && supportPhone !== '' ? { supportPhone } : {}),
        },
      },
      {
        ttlSeconds,
        // Defensive in-process clear for OCPP 1.6 (no native endDateTime)
        // and 2.1 firmwares that ignore endDateTime. Same window so the
        // operator can tune one knob.
        autoClearMs: ttlSeconds * 1000,
      },
    );
  } catch (err) {
    logger.warn({ err, state }, 'Failed to publish payment-failure display message');
  }
}
