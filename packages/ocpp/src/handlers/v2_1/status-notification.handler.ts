// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { StatusNotificationRequest } from '../../generated/v2_1/types/messages/StatusNotificationRequest.js';
import type { StatusNotificationResponse } from '../../generated/v2_1/types/messages/StatusNotificationResponse.js';

export async function handleStatusNotification(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as StatusNotificationRequest;

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      evseId: request.evseId,
      connectorId: request.connectorId,
      status: request.connectorStatus,
    },
    'StatusNotification received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.StatusNotification',
    aggregateType: 'Connector',
    aggregateId: ctx.stationId,
    payload: {
      evseId: request.evseId,
      connectorId: request.connectorId,
      connectorStatus: request.connectorStatus,
      timestamp: request.timestamp,
    },
  });

  const response: StatusNotificationResponse = {};

  return response as unknown as Record<string, unknown>;
}
