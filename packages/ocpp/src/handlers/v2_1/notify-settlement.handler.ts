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
      transactionId: request.transactionId,
      pspRef: request.pspRef,
      status: request.status,
      settlementAmount: request.settlementAmount,
      settlementTime: request.settlementTime,
    },
  });

  // Per OCPP 2.1, NotifySettlementResponse should include a receiptUrl
  // where the driver can view or download a payment receipt.
  const receiptUrl = `https://receipts.evtivity.com/transactions/${request.transactionId}`;

  return { receiptUrl };
}
