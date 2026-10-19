// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { PubSubClient } from './pubsub.js';

/** Channel the OCPP server's CommandListener reads CSMS-initiated commands from. */
export const OCPP_COMMANDS_CHANNEL = 'ocpp_commands';

/** Channel the OCPP server publishes each command's result on, keyed by `commandId`. */
export const OCPP_COMMAND_RESULTS_CHANNEL = 'ocpp_command_results';

/**
 * Result `code` of a command the OCPP server refused before sending it, because
 * the station's OCPP version cannot express it (a 2.1-only action or value sent
 * to an OCPP 2.0.1 station). The station never saw the command.
 */
export const OCPP_VERSION_MISMATCH = 'OCPP_VERSION_MISMATCH';

export interface OcppCommand {
  /** The station's OCPP identity (charging_stations.station_id). */
  stationId: string;
  action: string;
  payload: Record<string, unknown>;
  /**
   * Protocol of `action` and `payload` when they are already in that version's
   * native format; they are then sent unchanged. Without it the OCPP server
   * translates an OCPP 2.1 command for the connected station's protocol.
   */
  version?: string | null | undefined;
  /** Correlates the result on `ocpp_command_results`. Generated when omitted. */
  commandId?: string | undefined;
  /**
   * Never queue the command for an offline station: the OCPP server answers
   * with an error result instead. For callers whose command means nothing
   * later (an OCPI partner's remote start or unlock).
   */
  noQueue?: boolean | undefined;
}

/**
 * Publishes a command for a station on `ocpp_commands` and returns its command
 * id. The OCPP pod holding the station's connection sends it. Publish errors
 * propagate; callers decide whether a lost command is recoverable (P9).
 */
export async function publishOcppCommand(
  pubsub: PubSubClient,
  command: OcppCommand,
): Promise<string> {
  const commandId = command.commandId ?? crypto.randomUUID();
  await pubsub.publish(
    OCPP_COMMANDS_CHANNEL,
    JSON.stringify({
      commandId,
      stationId: command.stationId,
      action: command.action,
      payload: command.payload,
      ...(command.version != null ? { version: command.version } : {}),
      ...(command.noQueue === true ? { noQueue: true } : {}),
    }),
  );
  return commandId;
}
