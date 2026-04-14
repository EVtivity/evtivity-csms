// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { StatusNotification } from '../../generated/v1_6/types/messages/StatusNotification.js';

export async function handleStatusNotification(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as StatusNotification;

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      connectorId: request.connectorId,
      status: request.status,
      ...(request.errorCode !== 'NoError' && { faultCode: request.errorCode }),
    },
    'StatusNotification received (1.6)',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.StatusNotification',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      stationId: ctx.stationId,
      evseId: request.connectorId,
      connectorId: request.connectorId,
      connectorStatus: request.status,
      timestamp: request.timestamp ?? new Date().toISOString(),
    },
  });

  return {};
}
