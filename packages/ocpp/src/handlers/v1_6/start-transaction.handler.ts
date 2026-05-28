// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql as dsql, eq, and } from 'drizzle-orm';
import {
  db,
  driverTokens,
  drivers,
  guestSessions,
  isSiteFreeVendEnabledByStation,
} from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { StartTransaction } from '../../generated/v1_6/types/messages/StartTransaction.js';
import { logAuthorizeAttempt } from '../authorize-log.js';

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

  // Validate the idTag against driver_tokens, then guest_sessions.
  // Mirrors the Authorize handler: pick the active+non-revoked+non-expired
  // row when multiple rows match (same idToken with different tokenType is
  // allowed by uniqueness). A station that skips Authorize and goes straight
  // to StartTransaction must not be able to bypass revocation/expiry.
  let idTagStatus: 'Accepted' | 'Blocked' | 'Invalid' | 'Expired' = 'Accepted';
  let outcome: 'accepted' | 'invalid' | 'blocked' | 'expired' | 'unknown' | 'db_error' = 'accepted';
  let matchedTokenId: string | null = null;
  let matchedDriverId: string | null = null;
  let reason: string | null = null;

  // Free-vend short-circuit. 1.6 stations frequently skip Authorize when the
  // operator pushes LocalPreAuthorize/AllowOfflineTxForUnknownId/etc., so the
  // free-vend gate must also be honored here or unknown idTags at free-vend
  // sites would be rejected with Invalid despite the Authorize handler and
  // the TransactionEvent.Started projection both accepting them.
  if (await isSiteFreeVendEnabledByStation(ctx.stationId)) {
    ctx.logger.info(
      { stationId: ctx.stationId, idTag: request.idTag },
      'Free vend site, accepting StartTransaction (1.6)',
    );
    void logAuthorizeAttempt(
      {
        stationId: ctx.stationId,
        idToken: request.idTag,
        tokenType: 'ISO14443',
        matchedTokenId: null,
        matchedDriverId: null,
        outcome: 'accepted',
        ocppVersion: 'ocpp1.6',
        reason: 'free_vend',
      },
      ctx.logger,
    );
    return {
      transactionId,
      idTagInfo: { status: 'Accepted' as const },
    };
  }

  try {
    const tokens = await db
      .select({
        id: driverTokens.id,
        driverId: driverTokens.driverId,
        isActive: driverTokens.isActive,
        expiresAt: driverTokens.expiresAt,
        revokedAt: driverTokens.revokedAt,
      })
      .from(driverTokens)
      .where(eq(driverTokens.idToken, request.idTag));
    if (tokens.length === 0) {
      // Driver-id fallback: portal authenticated start sends the driver's
      // UUID (drv_*) as the idToken (1.6 has no `Central` token type). Match
      // the 1.6 authorize handler's fallback chain so StartTransaction does
      // not flip Authorize's Accepted to Invalid.
      let resolved = false;
      if (request.idTag.startsWith('drv_')) {
        const [driver] = await db
          .select({ id: drivers.id, isActive: drivers.isActive })
          .from(drivers)
          .where(eq(drivers.id, request.idTag))
          .limit(1);
        if (driver != null) {
          if (driver.isActive) {
            idTagStatus = 'Accepted';
            outcome = 'accepted';
          } else {
            idTagStatus = 'Blocked';
            outcome = 'blocked';
            reason = 'driver_inactive';
          }
          matchedDriverId = driver.id;
          resolved = true;
        }
      }
      if (!resolved) {
        // Fall back to guest_sessions: idTag may be a CSMS-issued
        // sessionToken. Scope the match to this station so a token
        // generated for charger A can't be replayed at charger B via a
        // station that skips Authorize and goes straight to StartTransaction.
        const [guest] = await db
          .select({ status: guestSessions.status })
          .from(guestSessions)
          .where(
            and(
              eq(guestSessions.sessionToken, request.idTag),
              eq(guestSessions.stationOcppId, ctx.stationId),
            ),
          )
          .limit(1);
        if (guest == null) {
          idTagStatus = 'Invalid';
          outcome = 'unknown';
          reason = 'token_not_found';
        } else if (guest.status !== 'payment_authorized' && guest.status !== 'charging') {
          idTagStatus = 'Blocked';
          outcome = 'blocked';
          reason = `guest_${guest.status}`;
        } else {
          reason = 'guest_session';
        }
      }
    } else {
      const now = new Date();
      const usable = tokens.find(
        (t) =>
          t.isActive &&
          t.revokedAt == null &&
          (t.expiresAt == null || t.expiresAt.getTime() > now.getTime()),
      );
      if (usable != null) {
        matchedTokenId = usable.id;
        matchedDriverId = usable.driverId;
      } else {
        const expiredRow = tokens.find(
          (t) => t.expiresAt != null && t.expiresAt.getTime() <= now.getTime(),
        );
        if (expiredRow != null) {
          matchedTokenId = expiredRow.id;
          matchedDriverId = expiredRow.driverId;
          idTagStatus = 'Expired';
          outcome = 'expired';
          reason = 'expired_at';
        } else {
          const fallback = tokens[0];
          matchedTokenId = fallback?.id ?? null;
          matchedDriverId = fallback?.driverId ?? null;
          idTagStatus = 'Blocked';
          outcome = 'blocked';
          reason = 'inactive_or_revoked';
        }
      }
    }
  } catch {
    // DB unavailable: accept by default (fail-open)
    outcome = 'db_error';
    reason = 'db_unreachable';
  }

  // Forensic log: stations using LocalAuthList skip Authorize and come
  // straight to StartTransaction, so this is the only record of the
  // authorization decision for those flows.
  void logAuthorizeAttempt(
    {
      stationId: ctx.stationId,
      idToken: request.idTag,
      tokenType: 'ISO14443',
      matchedTokenId,
      matchedDriverId,
      outcome,
      ocppVersion: 'ocpp1.6',
      reason,
    },
    ctx.logger,
  );

  // OCPP 1.6 StartTransaction's idTagInfo.status enum only includes
  // Accepted/Blocked/Expired/Invalid/ConcurrentTx (no NoCredit). Our 'Expired'
  // maps directly.

  return {
    transactionId,
    idTagInfo: { status: idTagStatus },
  };
}
