// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { DataTransfer } from '../../generated/v1_6/types/messages/DataTransfer.js';
import { PNC16_VENDOR_ID } from '@evtivity/lib';
import { handlePnc16DataTransfer } from './iso15118-pnc.handler.js';

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
      stationDbId: ctx.stationDbId,
      vendorId: request.vendorId,
      messageId: request.messageId,
      data: request.data,
    },
  });

  // ISO 15118 Plug and Charge (OCA application note for OCPP 1.6).
  if (request.vendorId === PNC16_VENDOR_ID) return handlePnc16DataTransfer(ctx, request);

  return { status: 'UnknownVendorId' };
}
