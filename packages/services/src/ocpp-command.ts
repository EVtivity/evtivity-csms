// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import {
  awaitPubSubReply,
  createLogger,
  OCPP_COMMAND_RESULTS_CHANNEL,
  publishOcppCommand,
} from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

const logger = createLogger('ocpp-command');

const RESPONSE_TIMEOUT_MS = 35_000;

export interface CommandResult {
  commandId: string;
  response?: Record<string, unknown>;
  error?: string;
  /**
   * True when the station was not connected and the OCPP server held the
   * command in the offline command queue (sent on reconnect). `error` then
   * holds the queue note, not a failure.
   */
  queued?: boolean;
  /**
   * True when the station did not answer: the OCPP server's own wait for the
   * CALLRESULT ran out, or no result arrived on the results channel within
   * 35 s. `error` then holds the timeout text. Tell a station non-answer
   * apart from a failure by this flag, never by the error text.
   */
  timedOut?: boolean;
}

/**
 * Sends an OCPP command to a station and waits for its response.
 *
 * Without `version` the OCPP server translates an OCPP 2.1 command and payload
 * to the protocol of the connected station (e.g. RequestStopTransaction to
 * RemoteStopTransaction with an integer transactionId for OCPP 1.6). Pass
 * `version` only when `action` and `payload` are already in that version's
 * native format; the command is then sent unchanged.
 */
export async function sendOcppCommandAndWait(
  stationOcppId: string,
  action: string,
  payload: Record<string, unknown>,
  version?: string,
): Promise<CommandResult> {
  const commandId = crypto.randomUUID();
  const pubsub = getPubSub();

  try {
    const result = await awaitPubSubReply<CommandResult>(pubsub, {
      replyChannel: OCPP_COMMAND_RESULTS_CHANNEL,
      commandId,
      timeoutMs: RESPONSE_TIMEOUT_MS,
      send: () =>
        publishOcppCommand(pubsub, {
          commandId,
          stationId: stationOcppId,
          action,
          payload,
          version,
        }),
    });
    return result ?? { commandId, error: 'No response within 35s', timedOut: true };
  } catch (err) {
    logger.warn(
      { err, stationId: stationOcppId, action, commandId },
      'OCPP command send failed, returning an error result',
    );
    return { commandId, error: 'Internal error sending command' };
  }
}
