// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and } from 'drizzle-orm';
import {
  db,
  driverTokens,
  drivers,
  ocpiExternalTokens,
  chargingStations,
  chargingSessions,
  sites,
  guestSessions,
  isRoamingEnabled,
} from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { Authorize } from '../../generated/v1_6/types/messages/Authorize.js';
import { logAuthorizeAttempt, parseOcpiValidThru } from '../authorize-log.js';

export async function handleAuthorize(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as Authorize;
  const idTag = request.idTag;

  ctx.logger.info({ stationId: ctx.stationId, idTag }, 'Authorize received (1.6)');

  await ctx.eventBus.publish({
    eventType: 'ocpp.Authorize',
    aggregateType: 'Driver',
    aggregateId: idTag,
    payload: { stationId: ctx.stationId, idToken: idTag, tokenType: 'ISO14443' },
  });

  // Free-vend: accept any token at free-vend sites.
  try {
    const [fvStation] = await db
      .select({ freeVendEnabled: sites.freeVendEnabled })
      .from(chargingStations)
      .innerJoin(sites, eq(chargingStations.siteId, sites.id))
      .where(eq(chargingStations.stationId, ctx.stationId));
    if (fvStation?.freeVendEnabled === true) {
      ctx.logger.info({ stationId: ctx.stationId, idTag }, 'Free vend site, accepting (1.6)');
      void logAuthorizeAttempt(
        {
          stationId: ctx.stationId,
          idToken: idTag,
          tokenType: null,
          outcome: 'accepted',
          ocppVersion: 'ocpp1.6',
          reason: 'free_vend',
        },
        ctx.logger,
      );
      return { idTagInfo: { status: 'Accepted' as const } };
    }
  } catch {
    // Non-critical: fall through to normal token validation
  }

  let status: 'Accepted' | 'Blocked' | 'Invalid' | 'Expired' | 'ConcurrentTx' = 'Accepted';
  let outcome:
    | 'accepted'
    | 'invalid'
    | 'blocked'
    | 'expired'
    | 'concurrent_tx'
    | 'unknown'
    | 'db_error' = 'accepted';
  let matchedTokenId: string | null = null;
  let matchedDriverId: string | null = null;
  let reason: string | null = null;

  try {
    // Pull every row matching the idToken so we can pick the active, non-revoked,
    // non-expired one. Filtering at SQL level would lose the ability to surface
    // an `Expired` vs `Blocked` distinction back to the station.
    const tokens = await db
      .select({
        id: driverTokens.id,
        driverId: driverTokens.driverId,
        isActive: driverTokens.isActive,
        expiresAt: driverTokens.expiresAt,
        revokedAt: driverTokens.revokedAt,
      })
      .from(driverTokens)
      .where(eq(driverTokens.idToken, idTag));

    if (tokens.length === 0) {
      // Driver-id fallback: portal-authenticated start sends drv_* as idTag.
      if (idTag.startsWith('drv_')) {
        const [driver] = await db
          .select({ id: drivers.id, isActive: drivers.isActive })
          .from(drivers)
          .where(eq(drivers.id, idTag))
          .limit(1);
        if (driver != null) {
          if (driver.isActive) {
            ctx.logger.info(
              { stationId: ctx.stationId, idTag },
              'Driver-id token accepted (1.6 portal remote-start)',
            );
            void logAuthorizeAttempt(
              {
                stationId: ctx.stationId,
                idToken: idTag,
                tokenType: null,
                matchedDriverId: driver.id,
                outcome: 'accepted',
                ocppVersion: 'ocpp1.6',
                reason: 'driver_id',
              },
              ctx.logger,
            );
            return { idTagInfo: { status: 'Accepted' as const } };
          }
          void logAuthorizeAttempt(
            {
              stationId: ctx.stationId,
              idToken: idTag,
              tokenType: null,
              matchedDriverId: driver.id,
              outcome: 'blocked',
              ocppVersion: 'ocpp1.6',
              reason: 'driver_inactive',
            },
            ctx.logger,
          );
          return { idTagInfo: { status: 'Blocked' as const } };
        }
      }

      // Guest sessions. Match on (sessionToken, stationOcppId) so a token
      // generated for one charger can't be replayed at a different station
      // - an attacker who learned the token from a URL/log/screenshot
      // would otherwise get accepted at any station that issues
      // Authorize against it.
      const [guest] = await db
        .select({ status: guestSessions.status })
        .from(guestSessions)
        .where(
          and(
            eq(guestSessions.sessionToken, idTag),
            eq(guestSessions.stationOcppId, ctx.stationId),
          ),
        )
        .limit(1);
      if (guest != null) {
        if (guest.status === 'payment_authorized') {
          void logAuthorizeAttempt(
            {
              stationId: ctx.stationId,
              idToken: idTag,
              tokenType: null,
              outcome: 'accepted',
              ocppVersion: 'ocpp1.6',
              reason: 'guest_session',
            },
            ctx.logger,
          );
          return { idTagInfo: { status: 'Accepted' as const } };
        }
        void logAuthorizeAttempt(
          {
            stationId: ctx.stationId,
            idToken: idTag,
            tokenType: null,
            outcome: 'blocked',
            ocppVersion: 'ocpp1.6',
            reason: `guest_${guest.status}`,
          },
          ctx.logger,
        );
        return { idTagInfo: { status: 'Blocked' as const } };
      }

      // OCPI external tokens. Per OCPI 2.2.1, both `is_valid` and the
      // `whitelist` enum must permit the auth, and any `valid_thru` in the
      // pushed tokenData JSONB must still be in the future. `whitelist=NEVER`
      // means the eMSP requires realtime authorization that we don't perform
      // here, so we treat it as Blocked.
      let externalToken: { isValid: boolean; whitelist: string; tokenData: unknown } | undefined;
      if (await isRoamingEnabled()) {
        try {
          [externalToken] = await db
            .select({
              isValid: ocpiExternalTokens.isValid,
              whitelist: ocpiExternalTokens.whitelist,
              tokenData: ocpiExternalTokens.tokenData,
            })
            .from(ocpiExternalTokens)
            .where(eq(ocpiExternalTokens.uid, idTag))
            .limit(1);
        } catch {
          // OCPI tables may not exist in test/dev environments
        }
      }

      if (externalToken != null) {
        const validThru = parseOcpiValidThru(externalToken.tokenData);
        const expiredByValidThru = validThru != null && validThru.getTime() <= Date.now();
        const allowed =
          externalToken.isValid && externalToken.whitelist !== 'NEVER' && !expiredByValidThru;
        if (expiredByValidThru) {
          status = 'Expired';
          outcome = 'expired';
          reason = 'ocpi_external_valid_thru_expired';
        } else {
          status = allowed ? 'Accepted' : 'Blocked';
          outcome = allowed ? 'accepted' : 'blocked';
          reason = allowed
            ? 'ocpi_external'
            : `ocpi_external_${externalToken.whitelist.toLowerCase()}`;
        }
        ctx.logger.info(
          { stationId: ctx.stationId, idTag, whitelist: externalToken.whitelist, validThru },
          `OCPI external token ${status} (1.6)`,
        );
      } else {
        status = 'Invalid';
        outcome = 'unknown';
        reason = 'token_not_found';
        ctx.logger.info({ stationId: ctx.stationId, idTag }, 'Token not found (1.6)');
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
        status = 'Accepted';
        outcome = 'accepted';
      } else {
        const expiredRow = tokens.find(
          (t) => t.expiresAt != null && t.expiresAt.getTime() <= now.getTime(),
        );
        if (expiredRow != null) {
          matchedTokenId = expiredRow.id;
          matchedDriverId = expiredRow.driverId;
          status = 'Expired';
          outcome = 'expired';
          reason = 'expired_at';
        } else {
          const fallback = tokens[0];
          matchedTokenId = fallback?.id ?? null;
          matchedDriverId = fallback?.driverId ?? null;
          status = 'Blocked';
          outcome = 'blocked';
          reason = 'inactive_or_revoked';
        }
        ctx.logger.info(
          { stationId: ctx.stationId, idTag, status },
          'Token rejected by status (1.6)',
        );
      }
    }
  } catch (err) {
    // Fail-open on DB error but record the security event for alerting.
    ctx.logger.error(
      { stationId: ctx.stationId, idTag, err },
      'Token lookup failed, accepting by default (1.6)',
    );
    status = 'Accepted';
    outcome = 'db_error';
    reason = 'db_unreachable';
  }

  // Concurrent-tx check: a token already mid-transaction must not start a
  // second one. Only check matched driver_tokens rows -- the guest/driver-id/
  // OCPI fallbacks return early above and don't reach this point.
  if (status === 'Accepted' && matchedTokenId != null) {
    try {
      const [activeSession] = await db
        .select({ id: chargingSessions.id })
        .from(chargingSessions)
        .where(
          and(eq(chargingSessions.tokenId, matchedTokenId), eq(chargingSessions.status, 'active')),
        )
        .limit(1);
      if (activeSession != null) {
        status = 'ConcurrentTx';
        outcome = 'concurrent_tx';
        reason = `concurrent_session ${activeSession.id}`;
        ctx.logger.info(
          { stationId: ctx.stationId, idTag, conflictingSessionId: activeSession.id },
          'Token rejected: concurrent transaction (1.6)',
        );
      }
    } catch (err) {
      ctx.logger.warn({ err, idTag }, 'Concurrent-tx lookup failed (1.6)');
    }
  }

  void logAuthorizeAttempt(
    {
      stationId: ctx.stationId,
      idToken: idTag,
      tokenType: 'ISO14443',
      matchedTokenId,
      matchedDriverId,
      outcome,
      ocppVersion: 'ocpp1.6',
      reason,
    },
    ctx.logger,
  );

  return { idTagInfo: { status } };
}
