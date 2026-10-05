// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import { client, SESSION_END_REQUEST_CHANNEL, recordSessionEndRequest } from '@evtivity/database';
import type { SessionEndRequestMessage } from '@evtivity/database';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

/**
 * Ends a ghost session: the station answered a stop with TxNotFound, so it has no
 * record of the transaction. The OCPP server ends the session the normal way, as
 * completed at its last metered energy with its final cost, settlement, and
 * receipt (owner decision 2026-10-04). The request is recorded on the session
 * first (P4): the OCPP sweep ends it should the message be lost, and the
 * stale-session cleanup skips it. Only an active session is requested (P5).
 * Returns whether the request was recorded.
 */
export async function requestGhostSessionEnd(
  sessionId: string,
  log: FastifyBaseLogger,
): Promise<boolean> {
  const requested = await recordSessionEndRequest(client, sessionId, 'GhostRecovered');
  if (!requested) return false;
  const message: SessionEndRequestMessage = { sessionId, reason: 'GhostRecovered' };
  try {
    await getPubSub().publish(SESSION_END_REQUEST_CHANNEL, JSON.stringify(message));
  } catch (err) {
    log.warn(
      { err, sessionId },
      'Session end request publish failed; the OCPP sweep ends the session',
    );
  }
  return true;
}
