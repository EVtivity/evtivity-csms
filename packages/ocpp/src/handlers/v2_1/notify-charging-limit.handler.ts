// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleNotifyChargingLimit(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    chargingLimit: unknown;
    chargingSchedule?: unknown[];
    evseId?: number;
  };

  ctx.logger.info(
    { stationId: ctx.stationId, evseId: request.evseId },
    'NotifyChargingLimit received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyChargingLimit',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      chargingLimit: request.chargingLimit,
      chargingSchedule: request.chargingSchedule,
      evseId: request.evseId,
    },
  });

  return {};
}
