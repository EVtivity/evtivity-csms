// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleHeartbeat(ctx: HandlerContext): Promise<Record<string, unknown>> {
  ctx.logger.debug({ stationId: ctx.stationId }, 'Heartbeat received (1.6)');

  ctx.session.lastHeartbeat = new Date();

  await ctx.eventBus.publish({
    eventType: 'ocpp.Heartbeat',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: { stationId: ctx.stationId },
  });

  return { currentTime: new Date().toISOString() };
}
