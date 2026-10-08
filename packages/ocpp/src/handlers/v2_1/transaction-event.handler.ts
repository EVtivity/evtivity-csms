// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { TransactionEventRequest } from '../../generated/v2_1/types/messages/TransactionEventRequest.js';
import type { TransactionEventResponse } from '../../generated/v2_1/types/messages/TransactionEventResponse.js';
import { prepaidCacheExpiry, prepaidMaxCost } from '../../authorization/prepaid.js';
import type { AuthorizeTokenInput } from '../../authorization/authorize-context.js';
import {
  authorizeToken,
  logAuthorizeDecision,
  recordAuthorizeDecision,
} from '../../authorization/authorize-token.js';
import { groupIdTokenFor, idTokenStatusFor } from './id-token-info.js';
import { findAdHocTransactionLimit } from '../ad-hoc-payment-limit.js';
import { prepaidSessionCeilingCents } from '../prepaid-session-limit.js';
import { limitToSupported, stationSupportedLimits } from '../supported-limits.js';
import type { TransactionLimitType } from '../../generated/v2_1/types/common/TransactionLimitType.js';
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
  // The prepaid limit below waits the same way: the projection links the
  // token and reserves its credit before that signal.
  const startedSessionReady = (): Promise<boolean> =>
    Promise.race([
      queue.waitForSignal(
        sessionPricedKey(ctx.stationId, transactionId),
        PROJECTION_SETTLE_TIMEOUT_MS,
      ),
      queue.settled([transactionLane], PROJECTION_SETTLE_TIMEOUT_MS),
    ]);
  if (centralCost && request.eventType === 'Started') {
    cost = await costForTransaction(ctx, request, registerWh, startedSessionReady);
  }

  const response: TransactionEventResponse = {};
  if (cost != null) {
    // Major units of the session currency (two-decimal currencies only).
    response.totalCost = cost.totalCostCents / 100;
  }

  // Per OCPP 2.1 spec, include idTokenInfo when the request contains an idToken.
  // Stations may suspend charging when idTokenInfo is missing. The token goes
  // through the shared authorize pipeline so a card revoked or expired
  // mid-session sends the station an explicit Blocked/Expired and lets it
  // abort, rather than a stale Accepted from a hardcoded response.
  if (request.idToken != null) {
    const { idToken, type: tokenType } = request.idToken;
    const input: AuthorizeTokenInput = {
      stationId: ctx.stationId,
      stationDbId: ctx.stationDbId,
      evseId: request.evse?.id ?? null,
      token: { value: idToken, type: tokenType },
      context: request.eventType === 'Started' ? 'tx_start' : 'tx_update',
      ocppVersion: 'ocpp2.1',
      transactionId: request.transactionInfo.transactionId,
    };
    let decision = await authorizeToken(input, ctx.logger);

    // Prepaid token at the transaction start: the limit is the credit the
    // Started projection reserved for this session (its cost ceiling), not the
    // whole balance, which the token's other active or unsettled sessions may
    // hold in part. No credit left answers NoCredit (C17.FR.02 semantics) with
    // no limit.
    let prepaidCreditCents = decision.prepaidBalanceCents;
    if (
      request.eventType === 'Started' &&
      decision.status === 'accepted' &&
      decision.prepaid &&
      decision.matchedTokenId != null
    ) {
      const ceiling = await reservedPrepaidCredit(
        ctx,
        transactionId,
        decision.matchedTokenId,
        startedSessionReady,
      );
      if (ceiling === 0) {
        decision = {
          ...decision,
          status: 'no_credit',
          outcome: 'no_credit',
          reason: 'no_credit',
          echoGroupId: false,
        };
      } else if (ceiling != null) {
        prepaidCreditCents = ceiling;
      }
    }
    logAuthorizeDecision(input, decision, ctx.logger);
    const status = idTokenStatusFor(decision);
    const groupIdToken = groupIdTokenFor(decision, idToken, tokenType);

    // Prepaid token (C17): the remaining credit is the transaction's cost
    // limit (C17.FR.03), sent once: stations send the idToken only in the event
    // after authorization. The cacheExpiryDateTime repeats the Authorize one.
    let prepaidExpiry: string | undefined;
    let transactionLimit: TransactionLimitType | null = null;
    if (decision.status === 'accepted' && decision.prepaid) {
      prepaidExpiry = prepaidCacheExpiry(ctx.stationId, idToken);
      if (request.eventType !== 'Ended' && prepaidCreditCents != null) {
        transactionLimit = { maxCost: prepaidMaxCost(prepaidCreditCents) };
      }
    } else if (decision.status === 'no_credit') {
      prepaidExpiry = new Date().toISOString();
    }

    // Ad hoc payment (C24 payment terminal, C25 QR code): the CSMS started the
    // transaction with the payment's idToken and returns its limit when the
    // transaction starts (C24.FR.02, C25.FR.24).
    if (
      request.eventType === 'Started' &&
      decision.matchedTokenId == null &&
      decision.status === 'accepted'
    ) {
      try {
        transactionLimit = await findAdHocTransactionLimit(ctx.stationId, idToken);
      } catch (err) {
        ctx.logger.error(
          { err, stationId: ctx.stationId, transactionId: request.transactionInfo.transactionId },
          'Ad hoc payment limit lookup failed; responding without transactionLimit',
        );
      }
    }

    if (transactionLimit != null) {
      const sent = await supportedTransactionLimit(ctx, request, transactionLimit);
      if (sent != null) response.transactionLimit = sent;
    }

    response.idTokenInfo = {
      status,
      ...(groupIdToken != null ? { groupIdToken } : {}),
      ...(prepaidExpiry != null
        ? { cacheExpiryDateTime: prepaidExpiry }
        : decision.status === 'accepted' && decision.expiresAt != null
          ? { cacheExpiryDateTime: decision.expiresAt.toISOString() }
          : {}),
    };

    // Attempts log on session start only: stations using LocalAuthList skip
    // the Authorize call and come straight to TransactionEvent[Started], so
    // this is the only record of the authorization decision for those flows.
    if (request.eventType === 'Started') {
      recordAuthorizeDecision(input, decision, ctx.logger);
    }
  }

  return response as unknown as Record<string, unknown>;
}

/**
 * The part of `limit` the station supports (E16.FR.12: the CSMS SHALL NOT
 * send a limit the station does not report in TxCtrlr.SupportedLimits), or
 * null when it supports none of it. A station that has not reported the
 * variable gets the whole limit: the CSMS reads the device model only when it
 * asks for it, so no row means not known, and the prepaid and ad hoc payment
 * flows require the limit (C17.FR.03, C24.FR.02, C25.FR.24). A station that
 * does not support a limit it got may report it (E16.FR.20), and the CSMS
 * stops a transaction past its cost ceiling itself. A failed lookup also
 * sends the whole limit (logged at warn).
 */
async function supportedTransactionLimit(
  ctx: HandlerContext,
  request: TransactionEventRequest,
  limit: TransactionLimitType,
): Promise<TransactionLimitType | null> {
  if (ctx.stationDbId == null) return limit;
  try {
    const supported = await stationSupportedLimits(
      client,
      ctx.stationDbId,
      request.evse?.id ?? null,
    );
    const sent = limitToSupported(limit, supported);
    if (sent == null || Object.keys(sent).length < Object.keys(limit).length) {
      ctx.logger.info(
        {
          stationId: ctx.stationId,
          transactionId: request.transactionInfo.transactionId,
          limit,
          sent,
        },
        'Transaction limit reduced to the limits the station supports (TxCtrlr.SupportedLimits)',
      );
    }
    return sent;
  } catch (err) {
    ctx.logger.warn(
      { err, stationId: ctx.stationId, transactionId: request.transactionInfo.transactionId },
      'TxCtrlr.SupportedLimits lookup failed; sending the transaction limit unchanged',
    );
    return limit;
  }
}

/**
 * The cost ceiling the Started projection reserved for a prepaid session, or
 * null when it is not known: the projection did not finish in time, the
 * session is not linked to the token, or the lookup failed. The caller then
 * sends the balance as before (fail-open, logged at warn): the stored ceiling
 * still caps the cost billed and debited.
 */
async function reservedPrepaidCredit(
  ctx: HandlerContext,
  transactionId: string,
  tokenId: string,
  waitForSession: () => Promise<boolean>,
): Promise<number | null> {
  try {
    const ceiling = (await waitForSession())
      ? await prepaidSessionCeilingCents(ctx.stationId, transactionId, tokenId)
      : null;
    if (ceiling == null) {
      ctx.logger.warn(
        { stationId: ctx.stationId, transactionId },
        'Prepaid session ceiling not known yet; sending the balance as transactionLimit.maxCost',
      );
    }
    return ceiling;
  } catch (err) {
    ctx.logger.warn(
      { err, stationId: ctx.stationId, transactionId },
      'Prepaid session ceiling lookup failed; sending the balance as transactionLimit.maxCost',
    );
    return null;
  }
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
