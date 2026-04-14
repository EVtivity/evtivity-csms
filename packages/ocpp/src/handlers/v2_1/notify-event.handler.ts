// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleNotifyEvent(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    generatedAt: string;
    seqNo: number;
    tbc?: boolean;
    eventData: unknown[];
  };

  ctx.logger.info(
    { stationId: ctx.stationId, seqNo: request.seqNo, eventCount: request.eventData.length },
    'NotifyEvent received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyEvent',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      generatedAt: request.generatedAt,
      seqNo: request.seqNo,
      tbc: request.tbc,
      eventData: request.eventData,
    },
  });

  return {};
}
