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
// Either path can opt into a defensive in-process clear by passing
// `autoClearMs` - the helper schedules a follow-up ClearDisplayMessage /
// DataTransfer-clear after the delay, so 1.6 stations and any 2.1 firmware
// that ignores endDateTime still get the message removed on time.

export interface OneShotStationMessageOptions {
  /** Display slot id. Default 9010 (outside the 9000-9005 state range). */
  slotId?: number;
  /** OCPP 2.1 MessagePriorityEnum. Default AlwaysFront so it overrides the
   *  station's state-bound message immediately. */
  priority?: 'AlwaysFront' | 'InFront' | 'NormalCycle';
  /** TTL in seconds for the OCPP 2.1 endDateTime field. Default 30. The
   *  station SHOULD auto-clear at this time per OCPP 2.1, but real
   *  firmwares sometimes ignore endDateTime - pair with autoClearMs for a
   *  defensive in-process ClearDisplayMessage. */
  ttlSeconds?: number;
  /** OCPP 1.6 DataTransfer messageId for the SET. Default 'OneShotMessage'. */
  dataTransferMessageId?: string;
  /** When set, schedules a follow-up ClearDisplayMessage (2.1) /
   *  DataTransfer-clear (1.6) after this many milliseconds. Use to
   *  guarantee clearing on OCPP 1.6 (no native TTL) and as defense on 2.1
   *  stations that ignore endDateTime. Typically set to ttlSeconds*1000. */
  autoClearMs?: number;
  /** OCPP 1.6 DataTransfer messageId for the CLEAR scheduled via autoClearMs.
   *  Default 'ClearOneShotMessage'. */
  dataTransferClearMessageId?: string;
}

export interface ClearStationMessageOptions {
  /** Display slot id to clear. Default 9010. */
  slotId?: number;
  /** OCPP 1.6 DataTransfer messageId for the CLEAR. Default
   *  'ClearOneShotMessage'. */
  dataTransferMessageId?: string;
}

/**
 * Publishes a ClearDisplayMessage (OCPP 2.1) or vendor DataTransfer (OCPP 1.6)
 * for a single display slot. Returns `true` when a command was published,
 * `false` when skipped or on swallowed error. Standalone helper so any
 * caller (the auto-clear path below, an operator-triggered clear button,
 * a status-change projection that wants to clear the slot, etc.) can use
 * the same dispatch shape.
 */
export async function clearStationMessage(
  pubsub: PubSubClient,
  sql: Sql,
  args: {
    stationOcppId: string;
    /** Internal UUID of the station; used to look up ocpp_protocol. */
    stationDbId: string;
  },
  options: ClearStationMessageOptions = {},
): Promise<boolean> {
  const { slotId = 9010, dataTransferMessageId = 'ClearOneShotMessage' } = options;

  let protocol: string | null = null;
  try {
    const rows =
      await sql`SELECT ocpp_protocol FROM charging_stations WHERE id = ${args.stationDbId}`;
    protocol = (rows[0]?.['ocpp_protocol'] as string | null | undefined) ?? null;
  } catch {
    return false;
  }
  if (protocol == null) return false;

  try {
    if (protocol.startsWith('ocpp2')) {
      await pubsub.publish(
        'ocpp_commands',
        JSON.stringify({
          commandId: crypto.randomUUID(),
          stationId: args.stationOcppId,
          action: 'ClearDisplayMessage',
          payload: { id: slotId },
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
            data: JSON.stringify({ slotId }),
          },
          version: 'ocpp1.6',
        }),
      );
      return true;
    }
  } catch {
    return false;
  }
  return false;
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
    ttlSeconds = 30,
    dataTransferMessageId = 'OneShotMessage',
    autoClearMs,
    dataTransferClearMessageId = 'ClearOneShotMessage',
  } = options;

  let protocol: string | null = null;
  try {
    const rows =
      await sql`SELECT ocpp_protocol FROM charging_stations WHERE id = ${args.stationDbId}`;
    protocol = (rows[0]?.['ocpp_protocol'] as string | null | undefined) ?? null;
  } catch {
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
  let published = false;

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
      published = true;
    } else if (protocol === 'ocpp1.6') {
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
      published = true;
    }
  } catch {
    return false;
  }

  // Schedule the in-process clear when requested. setTimeout is fine here:
  // if the process restarts before it fires the clear is lost, but the next
  // state-message refresh / connector status change overwrites the slot
  // anyway, and the OCPP 2.1 endDateTime is the primary clearing mechanism.
  if (published && autoClearMs != null && autoClearMs > 0) {
    const timer = setTimeout(() => {
      void clearStationMessage(
        pubsub,
        sql,
        { stationOcppId: args.stationOcppId, stationDbId: args.stationDbId },
        { slotId, dataTransferMessageId: dataTransferClearMessageId },
      );
    }, autoClearMs);
    // Don't keep the event loop alive just for the clear timer.
    if (typeof timer.unref === 'function') timer.unref();
  }

  return published;
}
