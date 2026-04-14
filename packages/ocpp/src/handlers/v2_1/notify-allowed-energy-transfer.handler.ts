// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleNotifyAllowedEnergyTransfer(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    allowedEnergyTransfer: string[];
    transactionId: string;
  };

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      transactionId: request.transactionId,
      allowedEnergyTransfer: request.allowedEnergyTransfer,
    },
    'NotifyAllowedEnergyTransfer received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyAllowedEnergyTransfer',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      allowedEnergyTransfer: request.allowedEnergyTransfer,
      transactionId: request.transactionId,
    },
  });

  return { status: 'Accepted' };
}
