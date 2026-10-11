// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The one publisher of `ocpp.MessageLog` events: every CALL, CALLRESULT and
 * CALLERROR in both directions goes through here before the projection writes
 * the `ocpp_message_logs` row (event-projections.ts) and the notification
 * dispatcher reads the event. Station credentials in the payload (2.1
 * BasicAuthPassword values, the 1.6 AuthorizationKey, SetNetworkProfile
 * `basicAuthPassword`) are masked here (`maskStationCredentials`, the rule the
 * AI redactor shares), so neither the log, the CSMS OCPP log view, the API log
 * routes, a notification nor the AI read them.
 */

import type { EventBus } from '@evtivity/lib';
import { maskStationCredentials } from '@evtivity/lib/secret-config';

export const MESSAGE_LOG_EVENT = 'ocpp.MessageLog';

export interface MessageLogEntry {
  stationId: string;
  /** `charging_stations.id` when the caller knows it (saves a lookup). */
  stationDbId?: string | null;
  direction: 'inbound' | 'outbound';
  messageType: number;
  messageId: string;
  action: string | null;
  payload?: unknown;
  errorCode?: string;
  errorDescription?: string;
}

/** Publishes one message log event with the station credentials masked. Fire-and-forget. */
export function publishMessageLog(eventBus: EventBus, entry: MessageLogEntry): void {
  const { payload, ...rest } = entry;
  void eventBus.publish({
    eventType: MESSAGE_LOG_EVENT,
    aggregateType: 'ChargingStation',
    aggregateId: entry.stationId,
    payload: {
      ...rest,
      ...(payload !== undefined ? { payload: maskStationCredentials(payload) } : {}),
    },
  });
}
