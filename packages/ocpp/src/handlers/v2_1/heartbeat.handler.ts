// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { HeartbeatResponse } from '../../generated/v2_1/types/messages/HeartbeatResponse.js';

export async function handleHeartbeat(ctx: HandlerContext): Promise<Record<string, unknown>> {
  ctx.session.lastHeartbeat = new Date();

  ctx.logger.debug({ stationId: ctx.stationId }, 'Heartbeat received');

  await ctx.eventBus.publish({
    eventType: 'ocpp.Heartbeat',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: { stationDbId: ctx.stationDbId },
  });

  const response: HeartbeatResponse = {
    currentTime: new Date().toISOString(),
  };

  return response as unknown as Record<string, unknown>;
}
