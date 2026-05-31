// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and } from 'drizzle-orm';
import { db, driverTokens } from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { TransactionEventRequest } from '../../generated/v2_1/types/messages/TransactionEventRequest.js';
import type { TransactionEventResponse } from '../../generated/v2_1/types/messages/TransactionEventResponse.js';
import { logAuthorizeAttempt } from '../authorize-log.js';

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
      stationDbId: ctx.stationDbId,
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
        stationDbId: ctx.stationDbId,
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
    let matchedTokenId: string | null = null;
    let matchedDriverId: string | null = null;
    let matchedExpiresAt: Date | null = null;
    let outcome: 'accepted' | 'blocked' | 'expired' | 'unknown' | 'db_error' = 'accepted';
    let reason: string | null = null;

    try {
      const [token] = await db
        .select({
          id: driverTokens.id,
          driverId: driverTokens.driverId,
          isActive: driverTokens.isActive,
          expiresAt: driverTokens.expiresAt,
          revokedAt: driverTokens.revokedAt,
        })
        .from(driverTokens)
        .where(and(eq(driverTokens.idToken, idToken), eq(driverTokens.tokenType, tokenType)));

      if (token != null) {
        matchedTokenId = token.id;
        matchedDriverId = token.driverId ?? null;
        const now = new Date();
        if (!token.isActive || token.revokedAt != null) {
          status = 'Blocked';
          outcome = 'blocked';
          reason = token.revokedAt != null ? 'revoked' : 'inactive';
        } else if (token.expiresAt != null && token.expiresAt.getTime() <= now.getTime()) {
          status = 'Expired';
          outcome = 'expired';
          reason = 'expired';
        } else {
          groupIdToken = { idToken, type: tokenType };
          matchedExpiresAt = token.expiresAt;
        }
      } else {
        // No row in driver_tokens. For Central/Local types this is expected
        // (CSMS-issued or station-local tokens). Accept without group.
        groupIdToken = { idToken, type: tokenType };
        outcome = 'unknown';
        reason = 'no_match';
      }
    } catch (err) {
      ctx.logger.warn(
        { err, stationId: ctx.stationId, idToken },
        'Token lookup failed on TransactionEvent; accepting without groupIdToken',
      );
      outcome = 'db_error';
      reason = 'db_unreachable';
    }

    response.idTokenInfo = {
      status,
      ...(groupIdToken != null ? { groupIdToken } : {}),
      ...(status === 'Accepted' && matchedExpiresAt != null
        ? { cacheExpiryDateTime: matchedExpiresAt.toISOString() }
        : {}),
    };

    // Forensic log on session start only: stations using LocalAuthList skip
    // the Authorize call and come straight to TransactionEvent[Started],
    // so this is the only record of the authorization decision for those
    // flows. Mirrors the 1.6 StartTransaction logging path.
    if (request.eventType === 'Started') {
      void logAuthorizeAttempt(
        {
          stationId: ctx.stationId,
          idToken,
          tokenType,
          matchedTokenId,
          matchedDriverId,
          outcome,
          ocppVersion: 'ocpp2.1',
          reason,
        },
        ctx.logger,
      );
    }
  }

  return response as unknown as Record<string, unknown>;
}
