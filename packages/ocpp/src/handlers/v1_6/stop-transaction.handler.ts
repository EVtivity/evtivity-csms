// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { StopTransaction } from '../../generated/v1_6/types/messages/StopTransaction.js';

export async function handleStopTransaction(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as StopTransaction;

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      transactionId: request.transactionId,
      meterStop: request.meterStop,
      reason: request.reason,
    },
    'StopTransaction received (1.6)',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.TransactionEvent',
    aggregateType: 'Transaction',
    aggregateId: String(request.transactionId),
    payload: {
      stationId: ctx.stationId,
      eventType: 'Ended',
      triggerReason: request.reason ?? 'Local',
      seqNo: 0,
      transactionId: String(request.transactionId),
      stoppedReason: request.reason,
      timestamp: request.timestamp,
      idToken: request.idTag,
      tokenType: request.idTag != null ? 'ISO14443' : undefined,
      meterStop: request.meterStop,
    },
  });

  // Emit meter values from transactionData if present
  if (request.transactionData != null && Array.isArray(request.transactionData)) {
    await ctx.eventBus.publish({
      eventType: 'ocpp.MeterValues',
      aggregateType: 'EVSE',
      aggregateId: ctx.stationId,
      payload: {
        stationId: ctx.stationId,
        evseId: 0,
        meterValues: request.transactionData,
        transactionId: String(request.transactionId),
        source: 'TransactionEvent',
      },
    });
  }

  const response: Record<string, unknown> = {};
  if (request.idTag != null) {
    response.idTagInfo = { status: 'Accepted' };
  }
  return response;
}
