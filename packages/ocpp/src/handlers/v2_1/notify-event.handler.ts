// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

const CONNECTOR_STATUSES = new Set(['Available', 'Occupied', 'Reserved', 'Unavailable', 'Faulted']);

interface EventDataItem {
  timestamp?: string;
  actualValue?: string;
  component?: { name?: string; evse?: { id?: number; connectorId?: number } };
  variable?: { name?: string };
}

export async function handleNotifyEvent(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    generatedAt: string;
    seqNo: number;
    tbc?: boolean;
    eventData: unknown[];
  };

  ctx.logger.info(
    { stationId: ctx.stationId, seqNo: request.seqNo, eventCount: request.eventData.length },
    'NotifyEvent received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyEvent',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      stationId: ctx.stationId,
      stationDbId: ctx.stationDbId,
      generatedAt: request.generatedAt,
      seqNo: request.seqNo,
      tbc: request.tbc,
      eventData: request.eventData,
    },
  });

  // OCPP 2.1 Edition 2 stations report status as AvailabilityState events
  // (StatusNotification is deprecated), so apply them the same way as a
  // StatusNotification: a Connector for that plug, the ChargingStation as
  // EVSE 0, which the projection keeps on the station.
  for (const item of request.eventData as EventDataItem[]) {
    if (
      item.variable?.name !== 'AvailabilityState' ||
      item.actualValue == null ||
      !CONNECTOR_STATUSES.has(item.actualValue)
    ) {
      continue;
    }
    const evse = item.component?.evse;
    let target: { evseId: number; connectorId: number } | null = null;
    if (item.component?.name === 'ChargingStation') {
      target = { evseId: 0, connectorId: 0 };
    } else if (
      item.component?.name === 'Connector' &&
      evse?.id != null &&
      evse.connectorId != null
    ) {
      target = { evseId: evse.id, connectorId: evse.connectorId };
    }
    if (target == null) continue;
    await ctx.eventBus.publish({
      eventType: 'ocpp.StatusNotification',
      aggregateType: 'Connector',
      aggregateId: ctx.stationId,
      payload: {
        stationId: ctx.stationId,
        stationDbId: ctx.stationDbId,
        evseId: target.evseId,
        connectorId: target.connectorId,
        connectorStatus: item.actualValue,
        timestamp: item.timestamp ?? request.generatedAt,
        source: 'NotifyEvent',
      },
    });
  }

  return {};
}
