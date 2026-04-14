// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleNotifyMonitoringReport(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    requestId: number;
    seqNo: number;
    generatedAt: string;
    monitor?: unknown[];
    tbc?: boolean;
  };

  ctx.logger.info(
    { stationId: ctx.stationId, requestId: request.requestId, seqNo: request.seqNo },
    'NotifyMonitoringReport received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyMonitoringReport',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      requestId: request.requestId,
      seqNo: request.seqNo,
      generatedAt: request.generatedAt,
      monitor: request.monitor,
      tbc: request.tbc,
    },
  });

  return {};
}
