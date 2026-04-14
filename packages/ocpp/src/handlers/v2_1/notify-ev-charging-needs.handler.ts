// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleNotifyEVChargingNeeds(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    evseId: number;
    chargingNeeds: {
      requestedEnergyTransfer?: string;
      controlMode?: string;
      [key: string]: unknown;
    };
    maxScheduleTuples?: number;
  };

  ctx.logger.info(
    { stationId: ctx.stationId, evseId: request.evseId },
    'NotifyEVChargingNeeds received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyEVChargingNeeds',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      evseId: request.evseId,
      chargingNeeds: request.chargingNeeds,
      maxScheduleTuples: request.maxScheduleTuples,
    },
  });

  // The CSMS does not generate ISO 15118 charging profiles.
  // Return NoChargingProfile so the station knows no profile will be sent.
  return { status: 'NoChargingProfile' };
}
