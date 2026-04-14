// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { MeterValues } from '../../generated/v1_6/types/messages/MeterValues.js';

export async function handleMeterValues(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as MeterValues;

  ctx.logger.debug(
    {
      stationId: ctx.stationId,
      connectorId: request.connectorId,
      meterValueCount: request.meterValue.length,
    },
    'MeterValues received (1.6)',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.MeterValues',
    aggregateType: 'EVSE',
    aggregateId: ctx.stationId,
    payload: {
      stationId: ctx.stationId,
      evseId: request.connectorId,
      meterValues: request.meterValue,
      transactionId: request.transactionId != null ? String(request.transactionId) : undefined,
      source: 'MeterValues',
    },
  });

  return {};
}
