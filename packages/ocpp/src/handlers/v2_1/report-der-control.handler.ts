// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

/** Control lists a ReportDERControlRequest can carry (schemas/ocpp-2.1/ReportDERControlRequest.json). */
const DER_CONTROL_FIELDS = [
  'curve',
  'enterService',
  'fixedPFAbsorb',
  'fixedPFInject',
  'fixedVar',
  'freqDroop',
  'gradient',
  'limitMaxDischarge',
] as const;

export async function handleReportDERControl(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    requestId: number;
    tbc?: boolean;
  } & Partial<Record<(typeof DER_CONTROL_FIELDS)[number], unknown[]>>;

  // The reported controls, keyed by control list, with only the lists present.
  const derControl: Record<string, unknown[]> = {};
  for (const field of DER_CONTROL_FIELDS) {
    const list = request[field];
    if (list != null) derControl[field] = list;
  }

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      requestId: request.requestId,
      tbc: request.tbc ?? false,
      controls: Object.keys(derControl),
    },
    'ReportDERControl received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.ReportDERControl',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      stationId: ctx.stationId,
      stationDbId: ctx.stationDbId,
      requestId: request.requestId,
      tbc: request.tbc ?? false,
      derControl,
    },
  });

  return {};
}
