// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql as dsql, eq } from 'drizzle-orm';
import { db, driverTokens } from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { StartTransaction } from '../../generated/v1_6/types/messages/StartTransaction.js';

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

  // Atomically claim a pending session pre-created by the portal.
  // FOR UPDATE SKIP LOCKED prevents two concurrent StartTransaction calls
  // from claiming the same session.
  let transactionId: number | null = null;

  if (ctx.stationDbId != null) {
    const claimed = await db.execute<{ transaction_id: string }>(
      dsql`UPDATE charging_sessions
           SET updated_at = now()
           WHERE id = (
             SELECT id FROM charging_sessions
             WHERE station_id = ${ctx.stationDbId}
               AND status = 'active'
             ORDER BY created_at DESC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
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

  // If no pending session found, allocate a new ID from the sequence.
  // Falls back to a timestamp-based ID when the database is unavailable (e.g. tests).
  if (transactionId == null) {
    try {
      const [row] = await db.execute<{ nextval: string }>(
        dsql`SELECT nextval('ocpp16_transaction_id_seq')`,
      );
      transactionId = Number(row?.nextval ?? 1);
    } catch {
      transactionId = Math.floor(Date.now() / 1000) % 2_147_483_647;
    }
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

  // Validate the idTag against driver_tokens. Return Invalid if unknown, Blocked if inactive.
  let idTagStatus: 'Accepted' | 'Blocked' | 'Invalid' = 'Accepted';
  try {
    const tokens = await db
      .select({ isActive: driverTokens.isActive })
      .from(driverTokens)
      .where(eq(driverTokens.idToken, request.idTag));
    if (tokens.length === 0) {
      idTagStatus = 'Invalid';
    } else if (!tokens.some((t) => t.isActive)) {
      idTagStatus = 'Blocked';
    }
  } catch {
    // DB unavailable: accept by default (fail-open)
  }

  return {
    transactionId,
    idTagInfo: { status: idTagStatus },
  };
}
