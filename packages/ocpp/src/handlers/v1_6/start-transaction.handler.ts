// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql as dsql } from 'drizzle-orm';
import { db } from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { StartTransaction } from '../../generated/v1_6/types/messages/StartTransaction.js';
import type { StartTransactionResponse } from '../../generated/v1_6/types/messages/StartTransactionResponse.js';
import type { AuthorizeTokenInput } from '../../authorization/authorize-context.js';
import {
  authorizeToken,
  logAuthorizeDecision,
  recordAuthorizeDecision,
} from '../../authorization/authorize-token.js';
import { idTagInfoFor } from './id-tag-info.js';

async function nextOcpp16TransactionId(ctx: HandlerContext): Promise<number> {
  try {
    const [row] = await db.execute<{ nextval: string }>(
      dsql`SELECT nextval('ocpp16_transaction_id_seq')`,
    );
    const id = Number(row?.nextval);
    if (!Number.isSafeInteger(id)) {
      throw new Error('ocpp16_transaction_id_seq returned no value');
    }
    return id;
  } catch (err) {
    ctx.logger.error(
      { stationId: ctx.stationId, err },
      'StartTransaction (1.6): could not allocate a transaction id',
    );
    throw err;
  }
}

export async function handleStartTransaction(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as StartTransaction;

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      connectorId: request.connectorId,
      idTag: request.idTag,
    },
    'StartTransaction received (1.6)',
  );

  let transactionId: number | null = null;

  if (ctx.stationDbId != null) {
    // A resend (the station retries a StartTransaction whose response it did
    // not get, OCPP 1.6 3.7.1) carries the same connectorId, idTag,
    // meterStart and timestamp. It gets the transaction id it already has,
    // found by the Started event the projection recorded for it.
    const resent = await db.execute<{ transaction_id: string }>(
      dsql`SELECT cs.transaction_id
           FROM transaction_events te
           JOIN charging_sessions cs ON cs.id = te.session_id
           WHERE cs.station_id = ${ctx.stationDbId}
             AND te.event_type = 'started'
             AND te.timestamp = ${request.timestamp}
             AND te.payload->>'connectorId' = ${String(request.connectorId)}
             AND te.payload->>'idToken' = ${request.idTag}
             AND te.payload->>'meterStart' = ${String(request.meterStart)}
           ORDER BY te.id DESC
           LIMIT 1`,
    );
    const resentRow = resent[0];
    const resentId = resentRow != null ? Number(resentRow.transaction_id) : NaN;
    if (resentRow != null && Number.isSafeInteger(resentId)) {
      transactionId = resentId;
    }
  }

  if (ctx.stationDbId != null && transactionId == null) {
    // Claim a remote start the portal created on the EVSE of this connector
    // and that is still waiting for its transaction (no transaction_events
    // row), the newest first, like the 2.1 remote-start link. A running
    // session or one on another connector is never claimed. FOR UPDATE SKIP
    // LOCKED keeps two concurrent StartTransactions from claiming the same
    // session.
    const claimed = await db.execute<{ transaction_id: string }>(
      dsql`UPDATE charging_sessions
           SET updated_at = now()
           WHERE id = (
             SELECT pending.id FROM charging_sessions pending
             JOIN evses e ON e.id = pending.evse_id
             WHERE pending.station_id = ${ctx.stationDbId}
               AND e.evse_id = ${request.connectorId}
               AND pending.remote_start_id IS NOT NULL
               AND pending.status = 'active'
               AND NOT EXISTS (
                 SELECT 1 FROM transaction_events te WHERE te.session_id = pending.id
               )
             ORDER BY pending.started_at DESC
             LIMIT 1
             FOR UPDATE OF pending SKIP LOCKED
           )
           RETURNING transaction_id`,
    );

    const row = claimed[0];
    if (row != null) {
      const parsed = Number(row.transaction_id);
      if (!Number.isNaN(parsed) && Number.isInteger(parsed)) {
        transactionId = parsed;
      }
    }
  }

  // If no pending session found, allocate a new ID from the sequence. The
  // sequence is the only source of 1.6 transaction ids: an id made up here
  // could collide with another session, so a failed read fails the message and
  // the station answers it with a CALLERROR InternalError and retries it.
  if (transactionId == null) {
    transactionId = await nextOcpp16TransactionId(ctx);
  }

  await ctx.eventBus.publish({
    eventType: 'ocpp.TransactionEvent',
    aggregateType: 'Transaction',
    aggregateId: String(transactionId),
    payload: {
      stationId: ctx.stationId,
      eventType: 'Started',
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionId: String(transactionId),
      timestamp: request.timestamp,
      idToken: request.idTag,
      tokenType: 'ISO14443',
      evseId: request.connectorId,
      connectorId: request.connectorId,
      meterStart: request.meterStart,
      reservationId: request.reservationId,
    },
  });

  // A station that skips Authorize (LocalAuthList, LocalPreAuthorize) comes
  // straight here, so the idTag goes through the whole authorize pipeline:
  // revocation, expiry, ConcurrentTx (OCPP 1.6 5.13, not counting this
  // transaction's own session: a resent message's, or the one the projection
  // may already have linked) and prepaid credit. The attempts log is the only
  // record of the decision for those flows.
  const input: AuthorizeTokenInput = {
    stationId: ctx.stationId,
    stationDbId: ctx.stationDbId,
    evseId: request.connectorId,
    token: { value: request.idTag, type: null },
    context: 'tx_start',
    ocppVersion: 'ocpp1.6',
    transactionId: String(transactionId),
  };
  const decision = await authorizeToken(input, ctx.logger);
  logAuthorizeDecision(input, decision, ctx.logger);
  recordAuthorizeDecision(input, decision, ctx.logger);

  const response: StartTransactionResponse = { transactionId, idTagInfo: idTagInfoFor(decision) };
  return response as unknown as Record<string, unknown>;
}
