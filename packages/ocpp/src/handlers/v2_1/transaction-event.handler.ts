// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { TransactionEventRequest } from '../../generated/v2_1/types/messages/TransactionEventRequest.js';
import type { TransactionEventResponse } from '../../generated/v2_1/types/messages/TransactionEventResponse.js';
import { prepaidCacheExpiry, prepaidMaxCost } from '../../authorization/prepaid.js';
import type { AuthorizeTokenInput } from '../../authorization/authorize-context.js';
import {
  ACCOUNT_CREDIT_LIMIT_REASON,
  authorizeToken,
  logAuthorizeDecision,
  recordAuthorizeDecision,
} from '../../authorization/authorize-token.js';
import { groupIdTokenFor, idTokenStatusFor } from './id-token-info.js';
import { findAdHocTransactionLimit } from '../ad-hoc-payment-limit.js';
import {
  accountSessionCeilingCents,
  markAccountCeilingSent,
  prepaidSessionCeilingCents,
  raiseAccountCeilingAtCostLimit,
  takeGrownAccountCeiling,
} from '../prepaid-session-limit.js';
import { limitToSupported, stationSupportedLimits } from '../supported-limits.js';
import type { TransactionLimitType } from '../../generated/v2_1/types/common/TransactionLimitType.js';
import { energyRegisterWh } from '../../server/meter-units.js';
import {
  projectionQueueFor,
  sessionGatedKey,
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

  // Charge on account with a fleet credit limit (plan S8): a station that
  // suspended at its cost limit (Updated, CostLimitReached, E16.FR.05)
  // resumes when the limit is raised (E16 scenario 2, step 4a). The ceiling
  // grows now, before the projection runs, so this response sends it (the
  // grown ceiling below) and the projection does not claim the session at
  // the ceiling while the fleet has credit. An Ended transaction (E16.FR.06)
  // is over: it is claimed as before.
  const accountCeilingRaised =
    request.eventType === 'Updated' && request.triggerReason === 'CostLimitReached'
      ? await raiseCeilingAtCostLimit(ctx, transactionId)
      : false;

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
      // F01.FR.25, F02.FR.01: the first event after a RequestStartTransaction
      // carries its remoteStartId (a cable-first transaction the driver
      // started from the portal links to its remote start by it).
      ...(request.transactionInfo.remoteStartId != null
        ? { remoteStartId: request.transactionInfo.remoteStartId }
        : {}),
      ...(meterStopWh != null ? { meterStop: meterStopWh } : {}),
      ...(request.eventType === 'Ended' && cost?.calculated === true
        ? { finalCostCents: cost.totalCostCents }
        : {}),
      ...(accountCeilingRaised ? { accountCeilingRaised: true } : {}),
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
        // The charging state the station reported with these readings: when
        // present it decides idle, not the meter fallbacks (finding JB-1).
        ...(request.transactionInfo.chargingState != null
          ? { chargingState: request.transactionInfo.chargingState }
          : {}),
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
  // Updated: an idToken first presented here (cable plugged in first, E02) is
  // linked by this event's projection, which reserves a prepaid token's credit
  // and runs the payment gate. The limit below waits for it.
  const updatedProjected = (): Promise<boolean> =>
    queue.settled([transactionLane], PROJECTION_SETTLE_TIMEOUT_MS);

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

    // Prepaid token at the transaction start, or first presented in an
    // Updated: the limit is the credit the projection reserved for this
    // session (its cost ceiling), not the whole balance, which the token's
    // other active or unsettled sessions may hold in part. No credit left
    // answers NoCredit (C17.FR.02 semantics) with no limit.
    let prepaidCreditCents = decision.prepaidBalanceCents;
    if (
      request.eventType !== 'Ended' &&
      decision.status === 'accepted' &&
      decision.prepaid &&
      decision.matchedTokenId != null
    ) {
      const ceiling = await reservedPrepaidCredit(
        ctx,
        transactionId,
        decision.matchedTokenId,
        request.eventType === 'Started' ? startedSessionReady : updatedProjected,
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

    // Charge on account with a fleet credit limit (plan S8): the limit is the
    // fleet credit the payment gate reserved for this session (its cost
    // ceiling). No credit left answers NoCredit with no limit; the gate stops
    // the session. Not known (gate timeout, lookup failure): no limit, the
    // stored ceiling still caps billing and the MeterValues cost loop stops
    // the transaction at it.
    let accountCeilingCents: number | null = null;
    if (
      request.eventType !== 'Ended' &&
      decision.status === 'accepted' &&
      !decision.prepaid &&
      decision.accountFleetId != null
    ) {
      const ceiling = await reservedAccountCredit(ctx, transactionId, () =>
        request.eventType === 'Started'
          ? Promise.race([
              queue.waitForSignal(
                sessionGatedKey(ctx.stationId, transactionId),
                PROJECTION_SETTLE_TIMEOUT_MS,
              ),
              queue.settled([transactionLane], PROJECTION_SETTLE_TIMEOUT_MS),
            ])
          : updatedProjected(),
      );
      if (ceiling === 0) {
        decision = {
          ...decision,
          status: 'no_credit',
          outcome: 'no_credit',
          reason: ACCOUNT_CREDIT_LIMIT_REASON,
          echoGroupId: false,
        };
      } else {
        accountCeilingCents = ceiling;
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

    let accountLimitCents: number | null = null;
    if (transactionLimit == null && decision.status === 'accepted' && accountCeilingCents != null) {
      transactionLimit = { maxCost: prepaidMaxCost(accountCeilingCents) };
      accountLimitCents = accountCeilingCents;
    }

    if (transactionLimit != null) {
      const sent = await supportedTransactionLimit(ctx, request, transactionLimit);
      if (sent != null) response.transactionLimit = sent;
      // The station got the account ceiling: a grown ceiling follows on a
      // later response (plan S8).
      if (accountLimitCents != null && sent?.maxCost != null) {
        await recordAccountCeilingSent(ctx, transactionId, accountLimitCents);
      }
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

  // Charge on account with a fleet credit limit (plan S8): the session's cost
  // ceiling grows while the fleet has credit. A station that got the first
  // ceiling as transactionLimit.maxCost gets the grown one once, on the next
  // response (E16.FR.02), so it does not suspend at the old limit, or resumes
  // when it reported CostLimitReached (raised above).
  if (request.eventType === 'Updated' && response.transactionLimit == null) {
    const grown = await grownAccountCeiling(ctx, transactionId);
    if (grown != null) {
      const sent = await supportedTransactionLimit(ctx, request, {
        maxCost: prepaidMaxCost(grown),
      });
      if (sent != null) response.transactionLimit = sent;
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

/**
 * The cost ceiling the payment gate reserved for an account session from its
 * fleet's credit limit (plan S8), or null when it is not known: the gate did
 * not finish in time, the session is not billed on account, or the lookup
 * failed (logged at warn). The response then carries no limit: the stored
 * ceiling still caps billing and the MeterValues cost loop stops at it.
 */
async function reservedAccountCredit(
  ctx: HandlerContext,
  transactionId: string,
  waitForGate: () => Promise<boolean>,
): Promise<number | null> {
  try {
    const ceiling = (await waitForGate())
      ? await accountSessionCeilingCents(ctx.stationId, transactionId)
      : null;
    if (ceiling == null) {
      ctx.logger.warn(
        { stationId: ctx.stationId, transactionId },
        'Account session ceiling not known; responding without transactionLimit',
      );
    }
    return ceiling;
  } catch (err) {
    ctx.logger.warn(
      { err, stationId: ctx.stationId, transactionId },
      'Account session ceiling lookup failed; responding without transactionLimit',
    );
    return null;
  }
}

/**
 * markAccountCeilingSent, fail-open (P9): without the record the station only
 * misses a grown limit; the CSMS still stops the transaction at the ceiling
 * when the fleet has no credit left.
 */
async function recordAccountCeilingSent(
  ctx: HandlerContext,
  transactionId: string,
  ceilingCents: number,
): Promise<void> {
  try {
    await markAccountCeilingSent(ctx.stationId, transactionId, ceilingCents);
  } catch (err) {
    ctx.logger.warn(
      { err, stationId: ctx.stationId, transactionId },
      'Recording the account ceiling sent to the station failed; grown limits will not be sent',
    );
  }
}

/**
 * raiseAccountCeilingAtCostLimit. A failure is logged at warn and answers
 * false: the projection then claims the session at its ceiling as for a fleet
 * without credit (the station stays suspended at the limit it reached), so a
 * database failure never lets a session past the fleet limit.
 */
async function raiseCeilingAtCostLimit(
  ctx: HandlerContext,
  transactionId: string,
): Promise<boolean> {
  try {
    const raised = await raiseAccountCeilingAtCostLimit(ctx.stationId, transactionId);
    if (raised) {
      ctx.logger.info(
        { stationId: ctx.stationId, transactionId },
        'Account session cost ceiling raised at CostLimitReached; sending the new limit',
      );
    }
    return raised;
  } catch (err) {
    ctx.logger.warn(
      { err, stationId: ctx.stationId, transactionId },
      'Raising the account ceiling at CostLimitReached failed; the session stays at its limit',
    );
    return false;
  }
}

/**
 * takeGrownAccountCeiling, fail-open (P9): a failed lookup sends no new
 * limit on this response; the next one tries again.
 */
async function grownAccountCeiling(
  ctx: HandlerContext,
  transactionId: string,
): Promise<number | null> {
  try {
    return await takeGrownAccountCeiling(ctx.stationId, transactionId);
  } catch (err) {
    ctx.logger.warn(
      { err, stationId: ctx.stationId, transactionId },
      'Grown account ceiling lookup failed; responding without a new transactionLimit',
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
