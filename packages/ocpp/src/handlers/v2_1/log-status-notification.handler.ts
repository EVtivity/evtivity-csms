// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleLogStatusNotification(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as { status: string; requestId?: number };

  ctx.logger.info(
    { stationId: ctx.stationId, status: request.status, requestId: request.requestId },
    'LogStatusNotification received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.LogStatusNotification',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: { status: request.status, requestId: request.requestId },
  });

  return {};
}
