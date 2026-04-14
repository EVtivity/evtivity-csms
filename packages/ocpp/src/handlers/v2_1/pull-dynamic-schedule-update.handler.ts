// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handlePullDynamicScheduleUpdate(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    chargingProfileId: number;
  };

  ctx.logger.info(
    { stationId: ctx.stationId, chargingProfileId: request.chargingProfileId },
    'PullDynamicScheduleUpdate received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.PullDynamicScheduleUpdate',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      chargingProfileId: request.chargingProfileId,
    },
  });

  // The CSMS does not manage dynamic charging schedules.
  // Reject the request since the profile ID is not tracked by the CSMS.
  return { status: 'Rejected' };
}
