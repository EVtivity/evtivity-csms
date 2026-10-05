// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and } from 'drizzle-orm';
import { client, db, driverTokens } from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { TransactionEventRequest } from '../../generated/v2_1/types/messages/TransactionEventRequest.js';
import type { TransactionEventResponse } from '../../generated/v2_1/types/messages/TransactionEventResponse.js';
import { logAuthorizeAttempt } from '../authorize-log.js';
import { prepaidCacheExpiry, prepaidCredit, prepaidMaxCost } from '../prepaid.js';
import { findAdHocTransactionLimit } from '../ad-hoc-payment-limit.js';
import { energyRegisterWh } from '../../server/meter-units.js';
import {
  projectionQueueFor,
  sessionPricedKey,
  transactionKey,
} from '../../server/projection-queue.js';
import { transactionCostAt } from '../../server/session-cost.js';
import type { TransactionCost } from '../../server/session-cost.js';

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

  const transactionId = request.transactionInfo.transactionId;
  const queue = projectionQueueFor(ctx.eventBus);
  // A transactionId is unique per station only: the projection lane of this
  // transaction is keyed by both.
  const transactionLane = transactionKey(ctx.stationId, transactionId);
  // The energy register reading of this event, in whole Wh (meter_stop is an
  // integer column). The Ended reading is the session's final meter value, as
  // the 1.6 StopTransaction meterStop is.
  const register = energyRegisterWh(request.meterValue);
  const registerWh = register != null ? Math.round(register) : null;
  const meterStopWh = request.eventType === 'Ended' ? registerWh : null;

  // Central cost calculation: the response carries the running cost for
  // Updated (I02 alternative scenario) and the final cost for Ended
  // (I03.FR.02). A station that sends costDetails calculates the cost itself,
  // and the CSMS then omits totalCost (OCTT TC_E_108_CSMS). Updated and Ended
  // wait for the projections already queued for the transaction and the
  // station (the station sends each event right after the previous response).
  const centralCost = request.costDetails == null;
  let cost: TransactionCost | null = null;
  if (centralCost && request.eventType !== 'Started') {
    cost = await costForTransaction(ctx, request, registerWh, () =>
      queue.settled([transactionLane, ctx.stationId], PROJECTION_SETTLE_TIMEOUT_MS),
    );
  }

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
      connectorId: request.evse?.connectorId,
      reservationId: request.reservationId,
      ...(meterStopWh != null ? { meterStop: meterStopWh } : {}),
      ...(request.eventType === 'Ended' && cost?.calculated === true
        ? { finalCostCents: cost.totalCostCents }
        : {}),
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
        // Stations send evse only in the first event of a transaction, so later
        // readings are matched to their session by transactionId.
        transactionId: request.transactionInfo.transactionId,
        source: 'TransactionEvent',
      },
    });
  }

  // Started: the session row exists only once this event is projected, so the
  // running cost waits for the projection to snapshot the tariff (a signal
  // before its notifications and payment gate), or for the whole projection
  // when it ends without one.
  if (centralCost && request.eventType === 'Started') {
    cost = await costForTransaction(ctx, request, registerWh, () =>
      Promise.race([
        queue.waitForSignal(
          sessionPricedKey(ctx.stationId, transactionId),
          PROJECTION_SETTLE_TIMEOUT_MS,
        ),
        queue.settled([transactionLane], PROJECTION_SETTLE_TIMEOUT_MS),
      ]),
    );
  }

  const response: TransactionEventResponse = {};
  if (cost != null) {
    // Major units of the session currency (two-decimal currencies only).
    response.totalCost = cost.totalCostCents / 100;
  }

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
    let matchedPrepaidBalanceCents: number | null = null;
    let outcome: 'accepted' | 'blocked' | 'expired' | 'no_credit' | 'unknown' | 'db_error' =
      'accepted';
    let reason: string | null = null;

    try {
      const [token] = await db
        .select({
          id: driverTokens.id,
          driverId: driverTokens.driverId,
          isActive: driverTokens.isActive,
          expiresAt: driverTokens.expiresAt,
          revokedAt: driverTokens.revokedAt,
          prepaidBalanceCents: driverTokens.prepaidBalanceCents,
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
          matchedPrepaidBalanceCents = token.prepaidBalanceCents ?? null;
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

    // Prepaid token (C17): the remaining credit is the transaction's cost
    // limit (C17.FR.03), sent once: stations send the idToken only in the event
    // after authorization. The cacheExpiryDateTime repeats the Authorize one.
    let prepaidExpiry: string | undefined;
    const credit =
      status === 'Accepted' ? prepaidCredit(matchedPrepaidBalanceCents) : 'not_prepaid';
    if (credit === 'credit' && matchedPrepaidBalanceCents != null) {
      prepaidExpiry = prepaidCacheExpiry(ctx.stationId, idToken);
      if (request.eventType !== 'Ended') {
        response.transactionLimit = { maxCost: prepaidMaxCost(matchedPrepaidBalanceCents) };
      }
    } else if (credit === 'no_credit') {
      prepaidExpiry = new Date().toISOString();
      status = 'NoCredit';
      outcome = 'no_credit';
      reason = 'no_credit';
      groupIdToken = undefined;
    }

    // Ad hoc payment (C24 payment terminal, C25 QR code): the CSMS started the
    // transaction with the payment's idToken and returns its limit when the
    // transaction starts (C24.FR.02, C25.FR.24).
    if (request.eventType === 'Started' && matchedTokenId == null && status === 'Accepted') {
      try {
        const limit = await findAdHocTransactionLimit(ctx.stationId, idToken);
        if (limit != null) response.transactionLimit = limit;
      } catch (err) {
        ctx.logger.error(
          { err, stationId: ctx.stationId, transactionId: request.transactionInfo.transactionId },
          'Ad hoc payment limit lookup failed; responding without transactionLimit',
        );
      }
    }

    response.idTokenInfo = {
      status,
      ...(groupIdToken != null ? { groupIdToken } : {}),
      ...(prepaidExpiry != null
        ? { cacheExpiryDateTime: prepaidExpiry }
        : status === 'Accepted' && matchedExpiresAt != null
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

/** Bound on waiting for the projections a TransactionEvent response depends on. */
const PROJECTION_SETTLE_TIMEOUT_MS = 5000;

/**
 * Cost of the transaction at this event, or null when it is not known. Waits
 * with `waitForSession` for the projections the session row depends on first.
 * Fail-open: when the wait times out or the lookup fails, the response omits
 * totalCost (for Ended, the projection then computes the final cost itself).
 */
async function costForTransaction(
  ctx: HandlerContext,
  request: TransactionEventRequest,
  registerWh: number | null,
  waitForSession: () => Promise<boolean>,
): Promise<TransactionCost | null> {
  const transactionId = request.transactionInfo.transactionId;
  try {
    if (!(await waitForSession())) {
      ctx.logger.warn(
        { stationId: ctx.stationId, transactionId, eventType: request.eventType },
        'Projections still running; responding to TransactionEvent without totalCost',
      );
      return null;
    }
    return await transactionCostAt(client, {
      stationId: ctx.stationId,
      transactionId,
      at: new Date(request.timestamp),
      meterRegisterWh: registerWh,
      ...(request.eventType === 'Ended'
        ? {
            end: {
              triggerReason: request.triggerReason,
              stoppedReason: request.transactionInfo.stoppedReason,
            },
          }
        : {}),
    });
  } catch (err) {
    ctx.logger.warn(
      { err, stationId: ctx.stationId, transactionId, eventType: request.eventType },
      'Transaction cost lookup failed; responding to TransactionEvent without totalCost',
    );
    return null;
  }
}
