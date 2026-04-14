// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleNotifyDERStartStop(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    controlType: string;
    started: boolean;
    timestamp: string;
  };

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      controlType: request.controlType,
      started: request.started,
      timestamp: request.timestamp,
    },
    'NotifyDERStartStop received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyDERStartStop',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      controlType: request.controlType,
      started: request.started,
      timestamp: request.timestamp,
    },
  });

  return {};
}
