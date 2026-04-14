// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleNotifyPriorityCharging(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    transactionId: string;
    activated: boolean;
  };

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      transactionId: request.transactionId,
      activated: request.activated,
    },
    'NotifyPriorityCharging received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyPriorityCharging',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      transactionId: request.transactionId,
      activated: request.activated,
    },
  });

  return {};
}
