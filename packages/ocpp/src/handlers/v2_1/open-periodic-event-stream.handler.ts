// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleOpenPeriodicEventStream(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    constantStreamData: {
      id: number;
      variableMonitoringId: number;
      params: { interval?: number; values?: number };
    };
  };

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      streamId: request.constantStreamData.id,
      variableMonitoringId: request.constantStreamData.variableMonitoringId,
    },
    'OpenPeriodicEventStream received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.OpenPeriodicEventStream',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      constantStreamData: request.constantStreamData,
    },
  });

  return {};
}
