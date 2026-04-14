// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleClosePeriodicEventStream(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    id: number;
  };

  ctx.logger.info(
    { stationId: ctx.stationId, streamId: request.id },
    'ClosePeriodicEventStream received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.ClosePeriodicEventStream',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      id: request.id,
    },
  });

  return {};
}
