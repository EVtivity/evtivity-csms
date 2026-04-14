// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handlePublishFirmwareStatusNotification(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    status: string;
    location?: string;
    requestId?: number;
  };

  ctx.logger.info(
    { stationId: ctx.stationId, status: request.status, requestId: request.requestId },
    'PublishFirmwareStatusNotification received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.PublishFirmwareStatusNotification',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      status: request.status,
      location: request.location,
      requestId: request.requestId,
    },
  });

  return {};
}
