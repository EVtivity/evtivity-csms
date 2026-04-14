// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleNotifyWebPaymentStarted(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    evseId: number;
    timeout: number;
  };

  ctx.logger.info(
    { stationId: ctx.stationId, evseId: request.evseId, timeout: request.timeout },
    'NotifyWebPaymentStarted received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyWebPaymentStarted',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      evseId: request.evseId,
      timeout: request.timeout,
    },
  });

  return {};
}
