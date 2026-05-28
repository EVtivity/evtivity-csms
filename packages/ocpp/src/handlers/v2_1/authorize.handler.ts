// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, sql } from 'drizzle-orm';
import {
  db,
  driverTokens,
  ocpiExternalTokens,
  chargingSessions,
  isRoamingEnabled,
  isSiteFreeVendEnabledByStation,
} from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { AuthorizeRequest } from '../../generated/v2_1/types/messages/AuthorizeRequest.js';
import type { AuthorizeResponse } from '../../generated/v2_1/types/messages/AuthorizeResponse.js';
import type { Logger } from '@evtivity/lib';
import { logAuthorizeAttempt, parseOcpiValidThru } from '../authorize-log.js';

// Tokens of these types may be generated on the fly (portal remote start) and
// are accepted when not present in driver_tokens. Inactive matches still block.
const ACCEPT_WHEN_NOT_FOUND = new Set(['Central', 'Local', 'NoAuthorization']);

// Token types accepted unconditionally without DB lookup.
// MasterPass: stop-any-transaction admin token (OCPP 2.1 spec).
// eMAID: ISO 15118 contract certificate identifier validated externally.
// DirectPayment: payment terminal handles authorization.
const ACCEPT_WITHOUT_LOOKUP = new Set(['MasterPass', 'eMAID', 'DirectPayment']);

export async function handleAuthorize(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as AuthorizeRequest;
  const { idToken, type: tokenType } = request.idToken;

  ctx.logger.info({ stationId: ctx.stationId, idToken, tokenType }, 'Authorize received');

  await ctx.eventBus.publish({
    eventType: 'ocpp.Authorize',
    aggregateType: 'Driver',
    aggregateId: idToken,
    payload: { idToken, tokenType, stationId: ctx.stationId },
  });

  // Free-vend short-circuit. Cached at 60s so the per-station hot path
  // does not pay a JOIN on every authorize.
  if (await isSiteFreeVendEnabledByStation(ctx.stationId)) {
    ctx.logger.info({ stationId: ctx.stationId, idToken, tokenType }, 'Free vend site, accepting');
    void logAuthorizeAttempt(
      {
        stationId: ctx.stationId,
        idToken,
        tokenType,
        outcome: 'accepted',
        ocppVersion: 'ocpp2.1',
        reason: 'free_vend',
      },
      ctx.logger,
    );
    const fvResponse: AuthorizeResponse = { idTokenInfo: { status: 'Accepted' } };
    return fvResponse as unknown as Record<string, unknown>;
  }

  let status: AuthorizeResponse['idTokenInfo']['status'] = 'Accepted';
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
  let logReason: string | null = null;

  let groupIdToken: AuthorizeResponse['idTokenInfo']['groupIdToken'] | undefined;
  let certificateStatus: AuthorizeResponse['certificateStatus'] | undefined;

  if (ACCEPT_WITHOUT_LOOKUP.has(tokenType)) {
    ctx.logger.info(
      { stationId: ctx.stationId, idToken, tokenType },
      `Token type ${tokenType} accepted without lookup`,
    );
    groupIdToken = { idToken, type: tokenType };
    logReason = 'no_lookup_type';
  } else if (tokenType !== 'NoAuthorization') {
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

      if (token == null && !ACCEPT_WHEN_NOT_FOUND.has(tokenType)) {
        // OCPI 2.2.1+: gate on `is_valid` AND `whitelist != NEVER` AND any
        // `valid_thru` in tokenData JSONB still being in the future. Any of
        // those failing produces Blocked / Expired.
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
              .where(eq(ocpiExternalTokens.uid, idToken))
              .limit(1);
          } catch {
            // OCPI tables may not exist
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
            logReason = 'ocpi_external_valid_thru_expired';
          } else {
            status = allowed ? 'Accepted' : 'Blocked';
            outcome = allowed ? 'accepted' : 'blocked';
            logReason = allowed
              ? 'ocpi_external'
              : `ocpi_external_${externalToken.whitelist.toLowerCase()}`;
          }
          ctx.logger.info(
            {
              stationId: ctx.stationId,
              idToken,
              tokenType,
              whitelist: externalToken.whitelist,
              validThru,
            },
            `OCPI external token ${status}`,
          );
        } else {
          status = 'Invalid';
          outcome = 'unknown';
          logReason = 'token_not_found';
          ctx.logger.info({ stationId: ctx.stationId, idToken, tokenType }, 'Token not found');
        }
      } else if (token != null) {
        const now = new Date();
        if (!token.isActive || token.revokedAt != null) {
          status = 'Blocked';
          outcome = 'blocked';
          matchedTokenId = token.id;
          matchedDriverId = token.driverId;
          logReason = 'inactive_or_revoked';
          ctx.logger.info(
            { stationId: ctx.stationId, idToken, tokenType },
            'Token blocked (inactive/revoked)',
          );
        } else if (token.expiresAt != null && token.expiresAt.getTime() <= now.getTime()) {
          status = 'Expired';
          outcome = 'expired';
          matchedTokenId = token.id;
          matchedDriverId = token.driverId;
          logReason = 'expired_at';
          ctx.logger.info({ stationId: ctx.stationId, idToken, tokenType }, 'Token expired');
        } else {
          matchedTokenId = token.id;
          matchedDriverId = token.driverId;
          groupIdToken = { idToken, type: tokenType };
          logReason = 'active';
        }
      } else {
        // ACCEPT_WHEN_NOT_FOUND, no row -> accept
        groupIdToken = { idToken, type: tokenType };
        logReason = 'accept_when_not_found';
      }
    } catch (err) {
      ctx.logger.error(
        { stationId: ctx.stationId, idToken, tokenType, err },
        'Token lookup failed, accepting by default',
      );
      status = 'Accepted';
      outcome = 'db_error';
      logReason = 'db_unreachable';
    }
  } else {
    logReason = 'no_authorization';
  }

  // Concurrent-tx check: a token already mid-transaction must not start a
  // second one. Only check matched driver_tokens rows -- OCPI/guest/no-lookup
  // paths don't write `charging_sessions.token_id` so the join would be moot.
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
        logReason = `concurrent_session ${activeSession.id}`;
        groupIdToken = undefined;
        ctx.logger.info(
          { stationId: ctx.stationId, idToken, tokenType, conflictingSessionId: activeSession.id },
          'Token rejected: concurrent transaction',
        );
      }
    } catch (err) {
      ctx.logger.warn({ err, idToken }, 'Concurrent-tx lookup failed');
    }
  }

  if (tokenType === 'eMAID') {
    const hasHashData =
      request.iso15118CertificateHashData != null && request.iso15118CertificateHashData.length > 0;
    const hasCertificate = request.certificate != null;
    if (hasHashData || hasCertificate) {
      certificateStatus = 'Accepted';
    }
  }

  let tariff: Record<string, unknown> | undefined;
  if (status === 'Accepted' && tokenType !== 'NoAuthorization') {
    try {
      tariff = await resolveDriverTariff(idToken, tokenType, ctx.stationId, ctx.logger);
    } catch {
      // Non-critical
    }
  }

  void logAuthorizeAttempt(
    {
      stationId: ctx.stationId,
      idToken,
      tokenType,
      matchedTokenId,
      matchedDriverId,
      outcome,
      ocppVersion: 'ocpp2.1',
      reason: logReason,
    },
    ctx.logger,
  );

  const response: AuthorizeResponse = {
    idTokenInfo: {
      status,
      ...(groupIdToken != null ? { groupIdToken } : {}),
    },
    ...(certificateStatus != null ? { certificateStatus } : {}),
  };

  const result = response as unknown as Record<string, unknown>;
  if (tariff != null) {
    result['tariff'] = tariff;
  }
  return result;
}

async function resolveDriverTariff(
  idToken: string,
  tokenType: string,
  stationId: string,
  logger: Logger,
): Promise<Record<string, unknown> | undefined> {
  const [tokenRow] = await db
    .select({ driverId: driverTokens.driverId })
    .from(driverTokens)
    .where(and(eq(driverTokens.idToken, idToken), eq(driverTokens.tokenType, tokenType)));

  const driverId = tokenRow?.driverId;

  const rows = await db.execute<{
    id: string;
    currency: string;
    price_per_kwh: string | null;
    price_per_minute: string | null;
    price_per_session: string | null;
    idle_fee_price_per_minute: string | null;
    tax_rate: string | null;
    pricing_group_id: string;
  }>(sql`
    WITH resolved_group AS (
      ${
        driverId != null
          ? sql`
      SELECT pg.id AS group_id, 1 AS group_priority FROM pricing_groups pg
      JOIN pricing_group_drivers pgd ON pgd.pricing_group_id = pg.id
      WHERE pgd.driver_id = ${driverId}
      UNION ALL
      `
          : sql``
      }
      SELECT pg.id AS group_id, 2 AS group_priority FROM pricing_groups pg
      JOIN pricing_group_stations pgs ON pgs.pricing_group_id = pg.id
      JOIN charging_stations cs ON cs.id = pgs.station_id
      WHERE cs.station_id = ${stationId}
      UNION ALL
      SELECT pg.id AS group_id, 3 AS group_priority FROM pricing_groups pg
      JOIN pricing_group_sites pgsi ON pgsi.pricing_group_id = pg.id
      JOIN charging_stations cs ON cs.site_id = pgsi.site_id
      WHERE cs.station_id = ${stationId}
      UNION ALL
      SELECT pg.id AS group_id, 4 AS group_priority FROM pricing_groups pg
      WHERE pg.is_default = true
    )
    SELECT t.id, t.currency, t.price_per_kwh, t.price_per_minute, t.price_per_session,
           t.idle_fee_price_per_minute, t.tax_rate, t.pricing_group_id
    FROM tariffs t
    JOIN resolved_group rg ON rg.group_id = t.pricing_group_id
    WHERE t.is_active = true
    ORDER BY rg.group_priority ASC, t.priority DESC, t.is_default DESC
    LIMIT 1
  `);

  const rawRow = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (rawRow == null) {
    logger.debug({ stationId, idToken }, 'No tariff found for driver');
    return undefined;
  }

  const toNum = (v: unknown): number | null => (v != null ? Number(v) : null);
  const pricePerKwh = toNum(rawRow['price_per_kwh']);
  const pricePerMinute = toNum(rawRow['price_per_minute']);
  const pricePerSession = toNum(rawRow['price_per_session']);
  const idleFeePerMinute = toNum(rawRow['idle_fee_price_per_minute']);
  const taxRate = toNum(rawRow['tax_rate']);

  const tariff: Record<string, unknown> = {
    tariffId: rawRow['id'],
    currency: rawRow['currency'],
  };

  const taxRates = taxRate != null && taxRate > 0 ? [{ type: 'VAT', tax: taxRate }] : undefined;

  if (pricePerKwh != null && pricePerKwh > 0) {
    tariff['energy'] = {
      prices: [{ priceKwh: pricePerKwh }],
      ...(taxRates != null ? { taxRates } : {}),
    };
  }
  if (pricePerMinute != null && pricePerMinute > 0) {
    tariff['chargingTime'] = {
      prices: [{ priceMinute: pricePerMinute }],
      ...(taxRates != null ? { taxRates } : {}),
    };
  }
  if (idleFeePerMinute != null && idleFeePerMinute > 0) {
    tariff['idleTime'] = {
      prices: [{ priceMinute: idleFeePerMinute }],
      ...(taxRates != null ? { taxRates } : {}),
    };
  }
  if (pricePerSession != null && pricePerSession > 0) {
    tariff['fixedFee'] = {
      prices: [{ priceFixed: pricePerSession }],
      ...(taxRates != null ? { taxRates } : {}),
    };
  }

  return tariff;
}
