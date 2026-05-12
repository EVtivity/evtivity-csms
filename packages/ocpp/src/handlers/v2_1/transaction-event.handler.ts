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
  // Stations may suspend charging when idTokenInfo is missing. We mirror the
  // Authorize handler's column-driven status so a card revoked or expired
  // mid-session sends the station an explicit Blocked/Expired and lets it
  // abort, rather than a stale Accepted from a hardcoded response.
  if (request.idToken != null) {
    const { idToken, type: tokenType } = request.idToken;
    let groupIdToken: { idToken: string; type: string } | undefined;
    let status: TransactionEventResponse['idTokenInfo'] extends infer T
      ? T extends { status: infer S }
        ? S
        : never
      : never = 'Accepted';

    try {
      const [token] = await db
        .select({
          isActive: driverTokens.isActive,
          expiresAt: driverTokens.expiresAt,
          revokedAt: driverTokens.revokedAt,
        })
        .from(driverTokens)
        .where(and(eq(driverTokens.idToken, idToken), eq(driverTokens.tokenType, tokenType)));

      if (token != null) {
        const now = new Date();
        if (!token.isActive || token.revokedAt != null) {
          status = 'Blocked';
        } else if (token.expiresAt != null && token.expiresAt.getTime() <= now.getTime()) {
          status = 'Expired';
        } else {
          groupIdToken = { idToken, type: tokenType };
        }
      } else {
        // No row in driver_tokens. For Central/Local types this is expected
        // (CSMS-issued or station-local tokens). Accept without group.
        groupIdToken = { idToken, type: tokenType };
      }
    } catch {
      // DB unavailable: accept without groupIdToken (fail-open mirrors authorize)
    }

    response.idTokenInfo = {
      status,
      ...(groupIdToken != null ? { groupIdToken } : {}),
    };
  }

  return response as unknown as Record<string, unknown>;
}
