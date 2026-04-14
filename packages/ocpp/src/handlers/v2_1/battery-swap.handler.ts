// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleBatterySwap(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    eventType: string;
    transactionId: string;
    idToken: { idToken: string; type: string };
  };

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      eventType: request.eventType,
      transactionId: request.transactionId,
    },
    'BatterySwap received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.BatterySwap',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      eventType: request.eventType,
      transactionId: request.transactionId,
      idToken: request.idToken,
    },
  });

  return {};
}
