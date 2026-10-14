// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  writeCsmsSessionAudit,
  writeReservationAudit,
  EV_CONNECT_TIMEOUT_REASON,
} from '@evtivity/database';
import type { RemoteStartTimeoutTarget, UnstartedSession } from '@evtivity/database';
import type { PubSubClient } from '@evtivity/lib';
import {
  closeUnstartedRemoteStart,
  failUnstartedGuestSession,
  PaymentProviderNotConfiguredError,
} from '@evtivity/payments';
import type { Logger } from 'pino';
import { paymentContext } from '../lib/payments.js';

/**
 * The timeout job of an accepted portal or guest start (queue
 * `remote-start-timeouts`), run the station's connection timeout plus a
 * margin after the start. When the station reported no transaction for it,
 * the driver session fails (`EVConnectTimeout`, cost 0) or the guest session
 * fails, and the hold is cancelled through the payments service: no capture,
 * no receipt, no PaymentReceived. A start whose transaction began is left
 * alone. A provider error is thrown so BullMQ retries; the retry finds the
 * session already closed and cancels again under the same key. A provider
 * this process cannot use is logged and not retried (the hold expires at the
 * provider).
 */
export async function handleRemoteStartTimeout(
  target: RemoteStartTimeoutTarget,
  log: Logger,
  pubsub: PubSubClient | null,
): Promise<void> {
  try {
    if (target.kind === 'guest') {
      const result = await failUnstartedGuestSession(
        target.guestSessionId,
        paymentContext(log, 'remote-start-timeout'),
      );
      log.info(
        { guestSessionId: target.guestSessionId, ...result },
        'Remote start timeout checked (guest)',
      );
      return;
    }
    const result = await closeUnstartedRemoteStart(
      target.sessionId,
      paymentContext(log, 'remote-start-timeout'),
    );
    log.info(
      {
        sessionId: target.sessionId,
        outcome: result.outcome,
        ...('hold' in result ? { hold: result.hold.status } : {}),
      },
      'Remote start timeout checked',
    );
    if (result.outcome === 'failed') {
      await announceFailedSession(result.session, log, pubsub);
    }
  } catch (err) {
    if (err instanceof PaymentProviderNotConfiguredError) {
      log.error(
        { err, target },
        'Payment provider of the hold not configured; hold of the unstarted start left open',
      );
      return;
    }
    throw err;
  }
}

/**
 * The session audit row, the operator UI refresh and the reservation timeline,
 * as the projection's failure paths. Only the job whose update failed the
 * session gets here (outcome `failed`, P7). Fail-open (P9).
 */
async function announceFailedSession(
  session: UnstartedSession,
  log: Logger,
  pubsub: PubSubClient | null,
): Promise<void> {
  await writeCsmsSessionAudit(
    {
      sessionId: session.id,
      action: 'faulted',
      actor: 'system',
      actorLabel: 'remote-start-timeout',
      before: { status: 'active' },
      after: { status: 'failed', stoppedReason: EV_CONNECT_TIMEOUT_REASON, finalCostCents: 0 },
      notes: 'The station reported no transaction for the remote start',
    },
    undefined,
    log,
  );
  if (session.reservationId != null) {
    try {
      await writeReservationAudit(
        {
          reservationId: session.reservationId,
          action: 'session_failed',
          actor: 'system',
          notes: `session ${session.id}: failed: ${EV_CONNECT_TIMEOUT_REASON}`,
        },
        undefined,
        log,
      );
    } catch (err) {
      log.warn({ err, sessionId: session.id }, 'Failed to write session_failed reservation audit');
    }
  }
  if (pubsub == null) return;
  try {
    await pubsub.publish(
      'csms_events',
      JSON.stringify({
        eventType: 'session.ended',
        stationId: session.stationUuid,
        siteId: session.siteId,
        sessionId: session.id,
      }),
    );
  } catch (err) {
    log.warn({ err, sessionId: session.id }, 'session.ended publish failed; continuing');
  }
}
