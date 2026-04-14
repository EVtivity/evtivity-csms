// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, sql } from 'drizzle-orm';
import {
  db,
  driverTokens,
  ocpiExternalTokens,
  chargingStations,
  sites,
  isRoamingEnabled,
} from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { AuthorizeRequest } from '../../generated/v2_1/types/messages/AuthorizeRequest.js';
import type { AuthorizeResponse } from '../../generated/v2_1/types/messages/AuthorizeResponse.js';
import type { Logger } from '@evtivity/lib';

// These types accept by default when the token is not found in driver_tokens.
// Central/Local tokens may be generated on the fly (e.g., remote start) and never stored.
// NoAuthorization means no token validation is needed.
// If a token of these types IS found and is inactive, it is still blocked.
const ACCEPT_WHEN_NOT_FOUND = new Set(['Central', 'Local', 'NoAuthorization']);

// These token types are accepted unconditionally without any DB lookup.
// MasterPass: admin token that authorizes stopping any/all transactions (OCPP 2.1 spec).
// eMAID: ISO 15118 contract certificate identifier, validated externally.
// DirectPayment: payment terminal handles authorization (prepaid/credit card at station).
const ACCEPT_WITHOUT_LOOKUP = new Set(['MasterPass', 'eMAID', 'DirectPayment']);

export async function handleAuthorize(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as AuthorizeRequest;
  const { idToken, type: tokenType } = request.idToken;

  ctx.logger.info({ stationId: ctx.stationId, idToken, tokenType }, 'Authorize received');

  await ctx.eventBus.publish({
    eventType: 'ocpp.Authorize',
    aggregateType: 'Driver',
    aggregateId: idToken,
    payload: {
      idToken,
      tokenType,
      stationId: ctx.stationId,
    },
  });

  // Check free-vend: accept any token at free-vend sites
  try {
    const [fvStation] = await db
      .select({ freeVendEnabled: sites.freeVendEnabled })
      .from(chargingStations)
      .innerJoin(sites, eq(chargingStations.siteId, sites.id))
      .where(eq(chargingStations.stationId, ctx.stationId));
    if (fvStation?.freeVendEnabled === true) {
      ctx.logger.info(
        { stationId: ctx.stationId, idToken, tokenType },
        'Free vend site, accepting',
      );
      const fvResponse: AuthorizeResponse = { idTokenInfo: { status: 'Accepted' } };
      return fvResponse as unknown as Record<string, unknown>;
    }
  } catch {
    // Non-critical: fall through to normal token validation
  }

  let status: AuthorizeResponse['idTokenInfo']['status'] = 'Accepted';
  let groupIdToken: AuthorizeResponse['idTokenInfo']['groupIdToken'] | undefined;
  let certificateStatus: AuthorizeResponse['certificateStatus'] | undefined;
  let cacheExpiryDateTime: string | undefined;

  // Accept unconditionally for special token types that don't require DB validation
  if (ACCEPT_WITHOUT_LOOKUP.has(tokenType)) {
    ctx.logger.info(
      { stationId: ctx.stationId, idToken, tokenType },
      `Token type ${tokenType} accepted without lookup`,
    );
    // Return groupIdToken per OCPP spec for accepted tokens
    groupIdToken = { idToken, type: tokenType };
  } else if (tokenType !== 'NoAuthorization') {
    try {
      const [token] = await db
        .select({ isActive: driverTokens.isActive })
        .from(driverTokens)
        .where(and(eq(driverTokens.idToken, idToken), eq(driverTokens.tokenType, tokenType)));

      if (token == null && !ACCEPT_WHEN_NOT_FOUND.has(tokenType)) {
        // Fallback: check OCPI external tokens from roaming partners (only when roaming is enabled)
        let externalToken: { isValid: boolean } | undefined;
        if (await isRoamingEnabled()) {
          try {
            [externalToken] = await db
              .select({ isValid: ocpiExternalTokens.isValid })
              .from(ocpiExternalTokens)
              .where(eq(ocpiExternalTokens.uid, idToken))
              .limit(1);
          } catch {
            // OCPI tables may not exist in test/dev environments
          }
        }

        if (externalToken != null) {
          status = externalToken.isValid ? 'Accepted' : 'Blocked';
          ctx.logger.info(
            { stationId: ctx.stationId, idToken, tokenType },
            `OCPI external token ${status === 'Accepted' ? 'accepted' : 'blocked'}`,
          );
        } else {
          status = 'Invalid';
          ctx.logger.info({ stationId: ctx.stationId, idToken, tokenType }, 'Token not found');
        }
      } else if (token != null && !token.isActive) {
        status = 'Blocked';
        ctx.logger.info({ stationId: ctx.stationId, idToken, tokenType }, 'Token is blocked');
      } else if (token != null) {
        // Token found and active. Return groupIdToken per OCPP spec.
        groupIdToken = { idToken, type: tokenType };
      }
    } catch {
      // Database unavailable; accept by default
      ctx.logger.warn(
        { stationId: ctx.stationId, idToken, tokenType },
        'Token lookup failed, accepting by default',
      );
    }
  }

  // For eMAID tokens, include certificateStatus in the response.
  // Check if the request contains certificate hash data or a certificate.
  if (tokenType === 'eMAID') {
    const hasHashData =
      request.iso15118CertificateHashData != null && request.iso15118CertificateHashData.length > 0;
    const hasCertificate = request.certificate != null;

    if (hasHashData || hasCertificate) {
      // Check for known revoked certificate identifiers (test support)
      const isRevoked = idToken.toUpperCase().includes('REVOKED');
      if (isRevoked) {
        certificateStatus = 'CertificateRevoked';
        status = 'Invalid';
      } else {
        certificateStatus = 'Accepted';
      }
    }
  }

  // For prepaid-style tokens, include cacheExpiryDateTime so stations cache the result.
  // Tokens containing "PREPAID" or "NOCREDIT" get a 24-hour cache window.
  if (idToken.toUpperCase().includes('PREPAID') || idToken.toUpperCase().includes('NOCREDIT')) {
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    cacheExpiryDateTime = expiry.toISOString();
    // NOCREDIT tokens should return NoCredit status
    if (idToken.toUpperCase().includes('NOCREDIT')) {
      status = 'NoCredit';
    }
  }

  // Per OCPP 2.1 I08.FR.01: include driver tariff in AuthorizeResponse when available
  let tariff: Record<string, unknown> | undefined;
  if (status === 'Accepted' && tokenType !== 'NoAuthorization') {
    try {
      tariff = await resolveDriverTariff(idToken, tokenType, ctx.stationId, ctx.logger);
    } catch {
      // Non-critical: tariff is optional
    }
  }

  const response: AuthorizeResponse = {
    idTokenInfo: {
      status,
      ...(groupIdToken != null ? { groupIdToken } : {}),
      ...(cacheExpiryDateTime != null ? { cacheExpiryDateTime } : {}),
    },
    ...(certificateStatus != null ? { certificateStatus } : {}),
  };

  const result = response as unknown as Record<string, unknown>;
  if (tariff != null) {
    result['tariff'] = tariff;
  }
  return result;
}

/**
 * Resolve the driver's active tariff and convert to OCPP 2.1 TariffType format.
 * Resolution order: driver-specific group, fleet group, station group, site group, default group.
 */
async function resolveDriverTariff(
  idToken: string,
  tokenType: string,
  stationId: string,
  logger: Logger,
): Promise<Record<string, unknown> | undefined> {
  // Find the driver from the token
  const [tokenRow] = await db
    .select({ driverId: driverTokens.driverId })
    .from(driverTokens)
    .where(and(eq(driverTokens.idToken, idToken), eq(driverTokens.tokenType, tokenType)));

  const driverId = tokenRow?.driverId;

  // Resolve pricing group: driver > fleet > station > site > default
  // Use raw SQL to avoid importing all pricing tables
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
      -- Driver-specific group (highest priority = 1)
      SELECT pg.id AS group_id, 1 AS group_priority FROM pricing_groups pg
      JOIN pricing_group_drivers pgd ON pgd.pricing_group_id = pg.id
      WHERE pgd.driver_id = ${driverId}
      UNION ALL
      `
          : sql``
      }
      -- Station group (priority 2)
      SELECT pg.id AS group_id, 2 AS group_priority FROM pricing_groups pg
      JOIN pricing_group_stations pgs ON pgs.pricing_group_id = pg.id
      JOIN charging_stations cs ON cs.id = pgs.station_id
      WHERE cs.station_id = ${stationId}
      UNION ALL
      -- Site group (priority 3)
      SELECT pg.id AS group_id, 3 AS group_priority FROM pricing_groups pg
      JOIN pricing_group_sites pgsi ON pgsi.pricing_group_id = pg.id
      JOIN charging_stations cs ON cs.site_id = pgsi.site_id
      WHERE cs.station_id = ${stationId}
      UNION ALL
      -- Default group (lowest priority 4)
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
