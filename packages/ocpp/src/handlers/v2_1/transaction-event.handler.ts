// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and } from 'drizzle-orm';
import { db, driverTokens } from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { TransactionEventRequest } from '../../generated/v2_1/types/messages/TransactionEventRequest.js';
import type { TransactionEventResponse } from '../../generated/v2_1/types/messages/TransactionEventResponse.js';

export async function handleTransactionEvent(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as TransactionEventRequest;

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      eventType: request.eventType,
      transactionId: request.transactionInfo.transactionId,
      triggerReason: request.triggerReason,
      seqNo: request.seqNo,
    },
    'TransactionEvent received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.TransactionEvent',
    aggregateType: 'Transaction',
    aggregateId: request.transactionInfo.transactionId,
    payload: {
      stationId: ctx.stationId,
      eventType: request.eventType,
      triggerReason: request.triggerReason,
      seqNo: request.seqNo,
      transactionId: request.transactionInfo.transactionId,
      chargingState: request.transactionInfo.chargingState,
      stoppedReason: request.transactionInfo.stoppedReason,
      timestamp: request.timestamp,
      idToken: request.idToken?.idToken,
      tokenType: request.idToken?.type,
      evseId: request.evse?.id ?? 0,
      reservationId: request.reservationId,
    },
  });

  if (request.meterValue != null && request.meterValue.length > 0) {
    await ctx.eventBus.publish({
      eventType: 'ocpp.MeterValues',
      aggregateType: 'EVSE',
      aggregateId: ctx.stationId,
      payload: {
        stationId: ctx.stationId,
        evseId: request.evse?.id ?? 0,
        meterValues: request.meterValue,
        source: 'TransactionEvent',
      },
    });
  }

  const response: TransactionEventResponse = {};

  // Per OCPP 2.1 spec, include idTokenInfo when the request contains an idToken.
  // Stations may suspend charging when idTokenInfo is missing.
  if (request.idToken != null) {
    const { idToken, type: tokenType } = request.idToken;
    let groupIdToken: { idToken: string; type: string } | undefined;

    // Look up token in DB. If found and active, include groupIdToken per OCPP spec.
    try {
      const [token] = await db
        .select({ isActive: driverTokens.isActive })
        .from(driverTokens)
        .where(and(eq(driverTokens.idToken, idToken), eq(driverTokens.tokenType, tokenType)));
      if (token != null && token.isActive) {
        groupIdToken = { idToken, type: tokenType };
      }
    } catch {
      // DB unavailable: accept without groupIdToken
    }

    response.idTokenInfo = {
      status: 'Accepted',
      ...(groupIdToken != null ? { groupIdToken } : {}),
    };
  }

  // Include transactionLimit for DirectPayment and prepaid sessions.
  // Stations use this to enforce spending or energy caps.
  if (request.eventType === 'Started' && request.idToken != null) {
    const isPrepaid = request.idToken.idToken.toUpperCase().includes('PREPAID');
    if (request.idToken.type === 'DirectPayment' || isPrepaid) {
      response.transactionLimit = { maxCost: 50.0, maxEnergy: 20000 };
    }
  }

  return response as unknown as Record<string, unknown>;
}
