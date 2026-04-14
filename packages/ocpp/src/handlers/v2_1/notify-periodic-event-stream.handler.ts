// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleNotifyPeriodicEventStream(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    id: number;
    data: unknown[];
  };

  ctx.logger.info(
    { stationId: ctx.stationId, id: request.id },
    'NotifyPeriodicEventStream received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyPeriodicEventStream',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      id: request.id,
      data: request.data,
    },
  });

  return {};
}
