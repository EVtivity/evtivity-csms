// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The one publisher of `ocpp.MessageLog` events: every CALL, CALLRESULT and
 * CALLERROR in both directions goes through here before the projection writes
 * the `ocpp_message_logs` row (event-projections.ts) and the notification
 * dispatcher reads the event. Station credentials in the payload (2.1
 * BasicAuthPassword values, the 1.6 AuthorizationKey, SetNetworkProfile
 * `basicAuthPassword`) and the password of a file transfer URL's userinfo
 * (GetLog, GetDiagnostics, UpdateFirmware, PublishFirmware locations, also in
 * a CALLERROR description) are masked here (`maskStationCredentials`, the rule
 * the AI redactor shares), so neither the log, the CSMS OCPP log view, the API
 * log routes, a notification nor the AI read them.
 */

import type { EventBus } from '@evtivity/lib';
import { maskStationCredentials } from '@evtivity/lib/secret-config';
import { projectionQueueFor } from './projection-queue.js';

export const MESSAGE_LOG_EVENT = 'ocpp.MessageLog';

/**
 * A logged payload larger than this (serialized JSON) is stored as
 * `{ truncated: true, bytes, keys }`: a station can send 1 MiB
 * frames, and the log runs before validation and the unknown-action answer.
 */
export const MESSAGE_LOG_MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Message log projections that may wait in one station's projection lane.
 * More are dropped (counted as `log_dropped` in the inbound frame stats), so a
 * database slower than the input cannot grow the lane without end. State
 * projections of the lane are never dropped.
 */
export const MESSAGE_LOG_MAX_PENDING_PER_LANE = 1000;

/**
 * A CALLERROR errorCode or errorDescription longer than this is cut (case
 * 210): the station picks both, up to the 1 MiB frame limit, and any JSON
 * type, and the payload bound does not cover them.
 */
export const MESSAGE_LOG_MAX_ERROR_TEXT_LENGTH = 1024;

function boundedText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    // A non-string error field from the station: stored as its JSON text.
    const json = JSON.stringify(value) as string | undefined;
    text = json ?? '';
  }
  return text.length > MESSAGE_LOG_MAX_ERROR_TEXT_LENGTH
    ? `${text.slice(0, MESSAGE_LOG_MAX_ERROR_TEXT_LENGTH)}...`
    : text;
}

function boundedPayload(payload: unknown): unknown {
  // JSON.stringify returns undefined for undefined and functions.
  const json = JSON.stringify(payload) as string | undefined;
  const bytes = json === undefined ? 0 : Buffer.byteLength(json);
  if (bytes <= MESSAGE_LOG_MAX_PAYLOAD_BYTES) return payload;
  const keys =
    payload != null && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.keys(payload).slice(0, 50)
      : [];
  return { truncated: true, bytes, keys };
}

export interface MessageLogEntry {
  stationId: string;
  /** `charging_stations.id` when the caller knows it (saves a lookup). */
  stationDbId?: string | null;
  direction: 'inbound' | 'outbound';
  messageType: number;
  messageId: string;
  action: string | null;
  payload?: unknown;
  /** Station-supplied for an inbound CALLERROR: any JSON value, bounded here. */
  errorCode?: unknown;
  errorDescription?: unknown;
}

/**
 * Publishes one message log event with the station credentials masked and the
 * payload bounded. Fire-and-forget. False when the station's projection lane
 * already holds MESSAGE_LOG_MAX_PENDING_PER_LANE log entries: nothing is
 * published, and the caller counts the drop.
 */
export function publishMessageLog(eventBus: EventBus, entry: MessageLogEntry): boolean {
  if (
    projectionQueueFor(eventBus).pending(entry.stationId, MESSAGE_LOG_EVENT) >=
    MESSAGE_LOG_MAX_PENDING_PER_LANE
  ) {
    return false;
  }
  const { payload, errorCode, errorDescription, ...rest } = entry;
  const code = boundedText(maskStationCredentials(errorCode));
  const description = boundedText(maskStationCredentials(errorDescription));
  void eventBus.publish({
    eventType: MESSAGE_LOG_EVENT,
    aggregateType: 'ChargingStation',
    aggregateId: entry.stationId,
    payload: {
      ...rest,
      ...(code !== undefined ? { errorCode: code } : {}),
      ...(description !== undefined ? { errorDescription: description } : {}),
      ...(payload !== undefined
        ? { payload: boundedPayload(maskStationCredentials(payload)) }
        : {}),
    },
  });
  return true;
}
