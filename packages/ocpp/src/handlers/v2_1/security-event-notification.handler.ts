// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleSecurityEventNotification(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as { type: string; timestamp: string; techInfo?: string };

  ctx.logger.info(
    { stationId: ctx.stationId, type: request.type, timestamp: request.timestamp },
    'SecurityEventNotification received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.SecurityEventNotification',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      type: request.type,
      timestamp: request.timestamp,
      techInfo: request.techInfo,
    },
  });

  return {};
}
