// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { MeterValuesRequest } from '../../generated/v2_1/types/messages/MeterValuesRequest.js';
import type { MeterValuesResponse } from '../../generated/v2_1/types/messages/MeterValuesResponse.js';

export async function handleMeterValues(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as MeterValuesRequest;

  ctx.logger.debug(
    {
      stationId: ctx.stationId,
      evseId: request.evseId,
      meterValueCount: request.meterValue.length,
    },
    'MeterValues received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.MeterValues',
    aggregateType: 'EVSE',
    aggregateId: ctx.stationId,
    payload: {
      stationId: ctx.stationId,
      evseId: request.evseId,
      meterValues: request.meterValue,
      source: 'MeterValues',
    },
  });

  const response: MeterValuesResponse = {};

  return response as unknown as Record<string, unknown>;
}
