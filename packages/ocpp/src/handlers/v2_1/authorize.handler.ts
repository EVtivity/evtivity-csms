// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and } from 'drizzle-orm';
import {
  db,
  client,
  driverTokens,
  ocpiExternalTokens,
  chargingSessions,
  isRoamingEnabled,
  isSiteFreeVendEnabledByStation,
  getCompanyCurrency,
  getCompanyTaxBasis,
  resolveStationTariff,
} from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { AuthorizeRequest } from '../../generated/v2_1/types/messages/AuthorizeRequest.js';
import type { AuthorizeResponse } from '../../generated/v2_1/types/messages/AuthorizeResponse.js';
import { netUnitPrice, vatPercentFromFraction, type Logger } from '@evtivity/lib';
import { logAuthorizeAttempt, parseOcpiValidThru } from '../authorize-log.js';
import {
  applyContractCertificateVerdict,
  validateContractCertificate,
  type ContractCertificateVerdict,
} from '../../services/pki/contract-certificate-validation.js';
import { prepaidCredit, rememberPrepaidAuthorization } from '../prepaid.js';

// Tokens of these types may be generated on the fly (portal remote start) and
// are accepted when not present in driver_tokens. Inactive matches still block.
const ACCEPT_WHEN_NOT_FOUND = new Set(['Central', 'Local', 'NoAuthorization']);

// Token types accepted unconditionally without DB lookup.
// MasterPass: stop-any-transaction admin token (OCPP 2.1 spec).
// DirectPayment: payment terminal handles authorization.
// An eMAID is looked up like any other token: C07 checks both the contract
// certificate (below) and the eMAID itself (C07.FR.13).
const ACCEPT_WITHOUT_LOOKUP = new Set(['MasterPass', 'DirectPayment']);

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
    // Best-effort match against driver_tokens so the forensic log still
    // links a free-vend swipe to a registered driver when the operator
    // taps a known card. Failure here doesn't block the accept.
    let freeVendMatchedTokenId: string | null = null;
    let freeVendMatchedDriverId: string | null = null;
    try {
      const [row] = await db
        .select({ id: driverTokens.id, driverId: driverTokens.driverId })
        .from(driverTokens)
        .where(and(eq(driverTokens.idToken, idToken), eq(driverTokens.tokenType, tokenType)));
      if (row != null) {
        freeVendMatchedTokenId = row.id;
        freeVendMatchedDriverId = row.driverId ?? null;
      }
    } catch (err) {
      ctx.logger.warn(
        { err, stationId: ctx.stationId, idToken },
        'Free-vend matched-token lookup failed; accepting without match',
      );
    }
    void logAuthorizeAttempt(
      {
        stationId: ctx.stationId,
        idToken,
        tokenType,
        matchedTokenId: freeVendMatchedTokenId,
        matchedDriverId: freeVendMatchedDriverId,
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
    | 'no_credit'
    | 'concurrent_tx'
    | 'unknown'
    | 'db_error' = 'accepted';
  let matchedTokenId: string | null = null;
  let matchedDriverId: string | null = null;
  let logReason: string | null = null;

  let groupIdToken: AuthorizeResponse['idTokenInfo']['groupIdToken'] | undefined;
  let certificateStatus: AuthorizeResponse['certificateStatus'] | undefined;
  let matchedExpiresAt: Date | null = null;
  let matchedPrepaidBalanceCents: number | null = null;

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
          prepaidBalanceCents: driverTokens.prepaidBalanceCents,
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
          } catch (err) {
            ctx.logger.debug(
              { err, idToken },
              'OCPI external-token lookup failed; OCPI tables may not exist',
            );
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
          matchedExpiresAt = token.expiresAt;
          matchedPrepaidBalanceCents = token.prepaidBalanceCents ?? null;
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

  // Prepaid token (C17.FR.01/02): NoCredit when the balance is not positive,
  // and cacheExpiryDateTime = now either way so the station does not cache it.
  let prepaidExpiry: string | undefined;
  const credit = status === 'Accepted' ? prepaidCredit(matchedPrepaidBalanceCents) : 'not_prepaid';
  if (credit !== 'not_prepaid') {
    prepaidExpiry = rememberPrepaidAuthorization(ctx.stationId, idToken);
    if (credit === 'no_credit') {
      status = 'NoCredit';
      outcome = 'no_credit';
      logReason = 'no_credit';
      groupIdToken = undefined;
    }
  }

  // C07: a contract certificate chain (hash data or PEM chain) is checked via
  // OCSP whatever the token type, and a bad chain overrides the token status
  // (C07.FR.05, FR.13 to FR.17). An unverifiable chain fails closed.
  const hasHashData =
    request.iso15118CertificateHashData != null && request.iso15118CertificateHashData.length > 0;
  if (hasHashData || request.certificate != null) {
    let verdict: ContractCertificateVerdict;
    try {
      verdict = await validateContractCertificate(
        {
          ...(request.iso15118CertificateHashData != null
            ? { iso15118CertificateHashData: request.iso15118CertificateHashData }
            : {}),
          ...(request.certificate != null ? { certificate: request.certificate } : {}),
        },
        ctx.logger,
      );
    } catch (err) {
      ctx.logger.error(
        { err, stationId: ctx.stationId, idToken },
        'Contract certificate validation failed',
      );
      verdict = 'CertChainError';
    }
    const applied = applyContractCertificateVerdict(status, verdict);
    certificateStatus = applied.certificateStatus;
    if (applied.status !== status) {
      status = applied.status;
      outcome = status === 'Expired' ? 'expired' : 'invalid';
      logReason = `contract_certificate_${verdict}`;
      groupIdToken = undefined;
    }
    ctx.logger.info(
      { stationId: ctx.stationId, idToken, tokenType, verdict, status },
      'Contract certificate validated',
    );
  }

  let tariff: Record<string, unknown> | undefined;
  if (status === 'Accepted' && tokenType !== 'NoAuthorization') {
    try {
      tariff = await resolveDriverTariff(
        matchedDriverId,
        ctx.stationId,
        ctx.stationDbId,
        ctx.logger,
      );
    } catch (err) {
      ctx.logger.warn(
        { err, stationId: ctx.stationId, idToken },
        'Tariff resolution failed; authorize response omits tariff',
      );
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
      ...(prepaidExpiry != null
        ? { cacheExpiryDateTime: prepaidExpiry }
        : status === 'Accepted' && matchedExpiresAt != null
          ? { cacheExpiryDateTime: matchedExpiresAt.toISOString() }
          : {}),
    },
    ...(certificateStatus != null ? { certificateStatus } : {}),
  };

  const result = response as unknown as Record<string, unknown>;
  if (tariff != null) {
    result['tariff'] = tariff;
  }
  return result;
}

// The tariff the session would be priced with now (the same resolution as
// session pricing: pricing group, then the tariff whose restrictions match in
// the site's timezone), so the station shows the price the driver is billed.
async function resolveDriverTariff(
  driverId: string | null,
  stationId: string,
  stationDbId: string | null,
  logger: Logger,
): Promise<Record<string, unknown> | undefined> {
  let stationUuid = stationDbId;
  if (stationUuid == null) {
    const [station] = await client`
      SELECT id FROM charging_stations WHERE station_id = ${stationId} LIMIT 1
    `;
    stationUuid = (station?.id as string | undefined) ?? null;
  }
  if (stationUuid == null) return undefined;

  const resolved = await resolveStationTariff({ stationUuid, driverUuid: driverId }, client);
  if (resolved == null) {
    logger.debug({ stationId, driverId }, 'No tariff found for driver');
    return undefined;
  }
  const rawRow: Record<string, unknown> = {
    id: resolved.id,
    price_per_kwh: resolved.pricePerKwh,
    price_per_minute: resolved.pricePerMinute,
    price_per_session: resolved.pricePerSession,
    idle_fee_price_per_minute: resolved.idleFeePricePerMinute,
    tax_rate: resolved.taxRate,
  };

  const toNum = (v: unknown): number | null => (v != null ? Number(v) : null);
  const taxRate = toNum(rawRow['tax_rate']);
  // TariffType prices are excluding tax: prices entered on the gross tax
  // basis are sent with the tax rate taken out, in 4 decimals.
  const taxBasis = await getCompanyTaxBasis();
  const netPrice = (v: unknown): number | null => {
    const price = toNum(v);
    if (price == null || taxBasis === 'net') return price;
    return Math.round(netUnitPrice(price, taxRate ?? 0, taxBasis) * 10_000) / 10_000;
  };
  const pricePerKwh = netPrice(rawRow['price_per_kwh']);
  const pricePerMinute = netPrice(rawRow['price_per_minute']);
  const pricePerSession = netPrice(rawRow['price_per_session']);
  const idleFeePerMinute = netPrice(rawRow['idle_fee_price_per_minute']);

  const tariff: Record<string, unknown> = {
    tariffId: rawRow['id'],
    currency: await getCompanyCurrency(),
  };

  // TaxRateType.tax is a percentage (19 for a stored rate of 0.19).
  const taxRates =
    taxRate != null && taxRate > 0
      ? [{ type: 'VAT', tax: vatPercentFromFraction(taxRate) }]
      : undefined;

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
