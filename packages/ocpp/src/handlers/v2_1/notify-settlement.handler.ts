// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleNotifySettlement(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    transactionId: string;
    pspRef?: string;
    status?: string;
    settlementAmount?: number;
    settlementTime?: string;
  };

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      transactionId: request.transactionId,
      settlementAmount: request.settlementAmount,
      status: request.status,
    },
    'NotifySettlement received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifySettlement',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      stationId: ctx.stationId,
      stationDbId: ctx.stationDbId,
      transactionId: request.transactionId,
      pspRef: request.pspRef,
      status: request.status,
      settlementAmount: request.settlementAmount,
      settlementTime: request.settlementTime,
    },
  });

  // OCPP 2.1 NotifySettlementResponse.receiptUrl is optional. It is only
  // useful when the CSMS actually generates a receipt page that the station
  // can QR-encode for the driver. Returning a fabricated URL (e.g. a
  // hardcoded operator-specific domain that does not host a receipt page)
  // would make every station show drivers a broken link. Omit the field
  // until per-operator receipt generation is implemented and surfaced via
  // a configurable receiptUrlTemplate setting.
  return {};
}
