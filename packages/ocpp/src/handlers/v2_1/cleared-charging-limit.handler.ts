// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleClearedChargingLimit(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    chargingLimitSource: string;
    evseId?: number;
  };

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      source: request.chargingLimitSource,
      evseId: request.evseId,
    },
    'ClearedChargingLimit received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.ClearedChargingLimit',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      chargingLimitSource: request.chargingLimitSource,
      evseId: request.evseId,
    },
  });

  return {};
}
