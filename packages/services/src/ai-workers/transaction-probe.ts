// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Asks an online OCPP 2.1 station whether a stuck session's transaction is
 * still running (GetTransactionStatus, E14), so the stop suggestion can say
 * how the session will be billed: a station that still runs it ends it and
 * bills from its final meter reading (E14.FR.02, `ongoingIndicator` true); a
 * station that ended it or never knew it (E14.FR.01, E14.FR.03, false)
 * answers the stop with TxNotFound, and the CSMS ends it at its last metered
 * energy. The command goes through the OCPP server (`ocpp_commands`, P8).
 * Fail-open (P9): a 1.6 station, a timeout, an error, a refused or queued
 * command gives `null`, and the suggestion keeps its symptom-based wording.
 */

import type { Logger } from '@evtivity/lib';
import { isOcpp2x } from '@evtivity/lib';
import { sendOcppCommandAndWait } from '../ocpp-command.js';
import type { StuckSession } from './stuck-sessions.js';

/** How long one probe waits for the station: a stuck-session scan must not hang on it. */
export const TRANSACTION_PROBE_TIMEOUT_MS = 10_000;

/** Most stations one stuck-session run asks (one call per session, never retried). */
export const MAX_TRANSACTION_PROBES = 20;

/** The station's answer: whether it still runs the transaction, null when unknown. */
export type TransactionProbeResult = boolean | null;

type ProbeLogger = Pick<Logger, 'warn' | 'debug'>;

/** The command sender, injectable for tests. */
export type ProbeSender = typeof sendOcppCommandAndWait;

/**
 * Whether the station still runs the session's transaction. Only an online
 * OCPP 2.x station is asked (OCPP 1.6 has no GetTransactionStatus with this
 * meaning); any other session, and any failure, gives null.
 */
export async function probeTransactionOngoing(
  session: Pick<
    StuckSession,
    'sessionId' | 'ocppStationId' | 'ocppProtocol' | 'transactionId' | 'reason'
  >,
  log: ProbeLogger,
  send: ProbeSender = sendOcppCommandAndWait,
): Promise<TransactionProbeResult> {
  const context = { sessionId: session.sessionId, stationId: session.ocppStationId };
  if (session.reason === 'station_offline') return null;
  if (!isOcpp2x(session.ocppProtocol)) {
    log.debug(context, 'Stuck session probe skipped: the station does not use OCPP 2.x');
    return null;
  }
  try {
    const result = await send(
      session.ocppStationId,
      'GetTransactionStatus',
      { transactionId: session.transactionId },
      '2.1',
      { timeoutMs: TRANSACTION_PROBE_TIMEOUT_MS },
    );
    if (result.queued === true) {
      log.warn(context, 'Stuck session probe: the station went offline, status unknown');
      return null;
    }
    if (result.error != null) {
      log.warn(
        { ...context, error: result.error, timedOut: result.timedOut === true },
        'Stuck session probe: no transaction status from the station',
      );
      return null;
    }
    const ongoing = result.response?.['ongoingIndicator'];
    // E14: with a transactionId the station always answers the indicator; a
    // missing one tells nothing.
    if (typeof ongoing !== 'boolean') {
      log.debug(context, 'Stuck session probe: the station answered without ongoingIndicator');
      return null;
    }
    return ongoing;
  } catch (err: unknown) {
    log.warn({ ...context, err }, 'Stuck session probe failed');
    return null;
  }
}
