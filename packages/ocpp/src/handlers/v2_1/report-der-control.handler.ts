// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleReportDERControl(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    requestId: number;
    seqNo: number;
    tbc?: boolean;
    derControl?: unknown[];
  };

  ctx.logger.info(
    { stationId: ctx.stationId, requestId: request.requestId, seqNo: request.seqNo },
    'ReportDERControl received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.ReportDERControl',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      requestId: request.requestId,
      seqNo: request.seqNo,
      tbc: request.tbc,
      derControl: request.derControl,
    },
  });

  return {};
}
