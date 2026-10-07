// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  client,
  getCompanyCurrency,
  getCompanyTaxBasis,
  resolveStationTariff,
} from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { AuthorizeRequest } from '../../generated/v2_1/types/messages/AuthorizeRequest.js';
import type { AuthorizeResponse } from '../../generated/v2_1/types/messages/AuthorizeResponse.js';
import { netUnitPrice, vatPercentFromFraction, type Logger } from '@evtivity/lib';
import {
  applyContractCertificateVerdict,
  validateContractCertificate,
  type ContractCertificateVerdict,
} from '../../services/pki/contract-certificate-validation.js';
import { rememberPrepaidAuthorization } from '../../authorization/prepaid.js';
import type { AuthorizeTokenInput } from '../../authorization/authorize-context.js';
import {
  authorizeToken,
  logAuthorizeDecision,
  recordAuthorizeDecision,
} from '../../authorization/authorize-token.js';
import { groupIdTokenFor, idTokenStatusFor } from './id-token-info.js';

/**
 * OCPP 2.1 Authorize: an adapter over the shared authorize pipeline. Around
 * the decision it runs the C07 contract certificate check, remembers a prepaid
 * authorization for the TransactionEventResponse (C17), and resolves the
 * tariff the station shows.
 */
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

  const input: AuthorizeTokenInput = {
    stationId: ctx.stationId,
    stationDbId: ctx.stationDbId,
    evseId: null,
    token: { value: idToken, type: tokenType },
    context: 'authorize',
    ocppVersion: 'ocpp2.1',
  };
  let decision = await authorizeToken(input, ctx.logger);

  // Free vend accepts any token as is: no certificate check, tariff or cache expiry.
  if (decision.source === 'free_vend') {
    logAuthorizeDecision(input, decision, ctx.logger);
    recordAuthorizeDecision(input, decision, ctx.logger);
    const fvResponse: AuthorizeResponse = { idTokenInfo: { status: 'Accepted' } };
    return fvResponse as unknown as Record<string, unknown>;
  }

  let status = idTokenStatusFor(decision);
  let groupIdToken = groupIdTokenFor(decision, idToken, tokenType);
  let certificateStatus: AuthorizeResponse['certificateStatus'] | undefined;

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
        // The station names the OCSP responders, so their failures carry it.
        ctx.logger.child({ stationId: ctx.stationId }),
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
      const rejected = status === 'Expired' ? 'expired' : 'invalid';
      decision = {
        ...decision,
        status: rejected,
        outcome: rejected,
        reason: `contract_certificate_${verdict}`,
        echoGroupId: false,
      };
      groupIdToken = undefined;
    }
    ctx.logger.info(
      { stationId: ctx.stationId, idToken, tokenType, verdict, status },
      'Contract certificate validated',
    );
  }

  // Prepaid token (C17.FR.01/02): cacheExpiryDateTime = now so the station
  // does not cache it, remembered for the TransactionEventResponse. After C07:
  // a token the contract certificate check rejected is not remembered.
  const prepaidExpiry =
    decision.prepaid && (status === 'Accepted' || status === 'NoCredit')
      ? rememberPrepaidAuthorization(ctx.stationId, idToken)
      : undefined;

  // Logged after C07 so the line names the final status.
  logAuthorizeDecision(input, decision, ctx.logger);

  let tariff: Record<string, unknown> | undefined;
  if (status === 'Accepted' && tokenType !== 'NoAuthorization') {
    try {
      tariff = await resolveDriverTariff(
        decision.matchedDriverId,
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

  recordAuthorizeDecision(input, decision, ctx.logger);

  const response: AuthorizeResponse = {
    idTokenInfo: {
      status,
      ...(groupIdToken != null ? { groupIdToken } : {}),
      ...(prepaidExpiry != null
        ? { cacheExpiryDateTime: prepaidExpiry }
        : status === 'Accepted' && decision.expiresAt != null
          ? { cacheExpiryDateTime: decision.expiresAt.toISOString() }
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
