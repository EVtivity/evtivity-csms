// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleNotifyDERAlarm(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    controlType: string;
    timestamp: string;
    gridEventFault?: unknown;
  };

  ctx.logger.info(
    { stationId: ctx.stationId, controlType: request.controlType, timestamp: request.timestamp },
    'NotifyDERAlarm received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyDERAlarm',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      controlType: request.controlType,
      timestamp: request.timestamp,
      gridEventFault: request.gridEventFault,
    },
  });

  return {};
}
