// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { Sql } from 'postgres';
import type { PubSubClient } from './pubsub.js';
import {
  renderStationMessage,
  type StationMessageContext,
  type StationMessageState,
} from './station-message.js';

// One-shot display-message dispatch helper. Used for event-driven station
// messages that aren't tied to a MessageState slot (9000-9005) - payment
// failure, authorization required, etc. The template body is loaded from
// `station_message_templates` and edited by operators in
// Settings -> Integration -> Station Messages.
//
// On OCPP 2.1 the command is SetDisplayMessage with priority AlwaysFront and
// an endDateTime so the station auto-clears the message after the TTL. On
// OCPP 1.6 (no native SetDisplayMessage) the helper falls back to a
// DataTransfer with the same vendor channel that pricing-display uses.

export interface OneShotStationMessageOptions {
  /** Display slot id. Default 9010 (outside the 9000-9005 state range). */
  slotId?: number;
  /** OCPP 2.1 MessagePriorityEnum. Default AlwaysFront so it overrides the
   *  station's state-bound message immediately. */
  priority?: 'AlwaysFront' | 'InFront' | 'NormalCycle';
  /** TTL in seconds before the message auto-clears. Default 60. */
  ttlSeconds?: number;
  /** OCPP 1.6 DataTransfer messageId. Default 'OneShotMessage'. */
  dataTransferMessageId?: string;
}

/**
 * Renders a station-message template and dispatches it as a one-shot OCPP
 * command. Safe to call from any server-side flow (event projections, API
 * handlers, worker jobs). Best-effort: failures are swallowed so the caller
 * (which has its own primary effect, e.g. stopping a session) is not blocked
 * by a missing template or a station that doesn't implement display messages.
 *
 * Returns `true` when a command was published, `false` when skipped (no
 * protocol on file, no template body) or on a swallowed error.
 */
export async function dispatchOneShotStationMessage(
  pubsub: PubSubClient,
  sql: Sql,
  args: {
    stationOcppId: string;
    /** Internal UUID of the station; used to look up ocpp_protocol. */
    stationDbId: string;
    state: StationMessageState;
    context: StationMessageContext;
  },
  options: OneShotStationMessageOptions = {},
): Promise<boolean> {
  const {
    slotId = 9010,
    priority = 'AlwaysFront',
    ttlSeconds = 60,
    dataTransferMessageId = 'OneShotMessage',
  } = options;

  let protocol: string | null = null;
  try {
    const rows =
      await sql`SELECT ocpp_protocol FROM charging_stations WHERE id = ${args.stationDbId}`;
    protocol = (rows[0]?.['ocpp_protocol'] as string | null | undefined) ?? null;
  } catch {
    // If we can't read the protocol, fall through to skip the dispatch
    // instead of guessing.
    return false;
  }
  if (protocol == null) return false;

  let content = '';
  try {
    content = await renderStationMessage(args.state, args.context);
  } catch {
    return false;
  }
  if (content === '') return false;

  const endDateTime = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  try {
    if (protocol.startsWith('ocpp2')) {
      await pubsub.publish(
        'ocpp_commands',
        JSON.stringify({
          commandId: crypto.randomUUID(),
          stationId: args.stationOcppId,
          action: 'SetDisplayMessage',
          payload: {
            message: {
              id: slotId,
              priority,
              message: { format: 'UTF8', content },
              endDateTime,
            },
          },
          version: protocol,
        }),
      );
      return true;
    }
    if (protocol === 'ocpp1.6') {
      await pubsub.publish(
        'ocpp_commands',
        JSON.stringify({
          commandId: crypto.randomUUID(),
          stationId: args.stationOcppId,
          action: 'DataTransfer',
          payload: {
            vendorId: 'com.evtivity',
            messageId: dataTransferMessageId,
            data: JSON.stringify({ state: args.state, message: content }),
          },
          version: 'ocpp1.6',
        }),
      );
      return true;
    }
  } catch {
    // Best-effort: log nothing here because callers may swallow log calls
    // (e.g. test envs). Returning false signals the caller that delivery
    // wasn't confirmed.
    return false;
  }
  return false;
}
