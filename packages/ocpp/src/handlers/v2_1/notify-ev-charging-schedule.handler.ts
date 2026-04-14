// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleNotifyEVChargingSchedule(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    timeBase: string;
    evseId: number;
    chargingSchedule: unknown;
  };

  ctx.logger.info(
    { stationId: ctx.stationId, evseId: request.evseId, timeBase: request.timeBase },
    'NotifyEVChargingSchedule received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyEVChargingSchedule',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      timeBase: request.timeBase,
      evseId: request.evseId,
      chargingSchedule: request.chargingSchedule,
    },
  });

  return { status: 'Accepted' };
}
