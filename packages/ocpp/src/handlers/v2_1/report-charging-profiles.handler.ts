// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleReportChargingProfiles(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    requestId: number;
    chargingLimitSource: string;
    evseId: number;
    chargingProfile: unknown[];
    tbc?: boolean;
  };

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      requestId: request.requestId,
      evseId: request.evseId,
      chargingLimitSource: request.chargingLimitSource,
    },
    'ReportChargingProfiles received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.ReportChargingProfiles',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      requestId: request.requestId,
      chargingLimitSource: request.chargingLimitSource,
      evseId: request.evseId,
      chargingProfile: request.chargingProfile,
      tbc: request.tbc,
    },
  });

  return {};
}
