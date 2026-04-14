// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { DataTransfer } from '../../generated/v1_6/types/messages/DataTransfer.js';

export async function handleDataTransfer(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as DataTransfer;

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      vendorId: request.vendorId,
      messageId: request.messageId,
    },
    'DataTransfer received (1.6)',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.DataTransfer',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      stationId: ctx.stationId,
      vendorId: request.vendorId,
      messageId: request.messageId,
      data: request.data,
    },
  });

  return { status: 'UnknownVendorId' };
}
