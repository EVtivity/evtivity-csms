// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleNotifyCustomerInformation(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    data: string;
    seqNo: number;
    generatedAt: string;
    requestId: number;
    tbc?: boolean;
  };

  ctx.logger.info(
    { stationId: ctx.stationId, requestId: request.requestId, seqNo: request.seqNo },
    'NotifyCustomerInformation received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyCustomerInformation',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      data: request.data,
      seqNo: request.seqNo,
      generatedAt: request.generatedAt,
      requestId: request.requestId,
      tbc: request.tbc,
    },
  });

  return {};
}
