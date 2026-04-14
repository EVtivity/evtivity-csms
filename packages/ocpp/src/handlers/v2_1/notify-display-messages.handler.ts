// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleNotifyDisplayMessages(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    requestId: number;
    messageInfo?: unknown[];
  };

  ctx.logger.info(
    { stationId: ctx.stationId, requestId: request.requestId },
    'NotifyDisplayMessages received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyDisplayMessages',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      requestId: request.requestId,
      messageInfo: request.messageInfo,
    },
  });

  return {};
}
