// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  createCreditCdr,
  ocpiCdrs,
  ocpiRoamingSessions,
  ocpiPartnerEndpoints,
  ocpiPartners,
  ocpiSyncLog,
} from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import { getOutboundToken } from '../lib/outbound-token.js';
import { OcpiClient } from '../lib/ocpi-client.js';
import { config } from '../lib/config.js';
import { transformCdr } from '../transformers/cdr.transformer.js';
import { resolvePartnerVersion } from '../lib/ocpi-version.js';
import { notifyRoamingCdrChanged } from '../lib/pubsub.js';
import { taxTotals } from '@evtivity/lib/price-display';
import { idleMinutesAt, ocpiCdrCost } from './session-cost-split.js';
import { partnerToken, sessionPlace } from './cpo-sessions.js';
import { renderTariffMapping, sessionTariffMapping } from './published-tariffs.js';
import type { PublishedTariff } from './published-tariffs.js';
import type { OcpiCdr } from '../types/ocpi.js';

const logger = createLogger('ocpi-cdr');

function getCountryCode(): string {
  return config.OCPI_COUNTRY_CODE;
}

function getPartyId(): string {
  return config.OCPI_PARTY_ID;
}

/**
 * Generate an OCPI CDR for a roaming session.
 *
 * Pricing model: roaming sessions ALWAYS use OUR tariff (the tariff resolved
 * at the station as if a local driver had charged there) and OUR currency.
 * The session cost is computed by the standard payment-gate / event-projection
 * pipeline -- the only difference for `is_roaming = true` sessions is that
 * `runPaymentGate()` skips Stripe pre-auth (event-projections.ts:2955) because
 * the eMSP partner pays us via this CDR, then bills their own driver however
 * they want.
 *
 * In practical terms: a partner's driver charging at our station pays whatever
 * our tariff says; we never honour the partner's tariff for sessions hosted on
 * our hardware. If two partners want different rates at the same station, that
 * is modelled via OCPI tariff negotiation outside the CDR (tariff_id reference
 * on the CDR points to the partner's view of our published tariff). The CDR
 * embeds the published tariff that covers the session's tariff for this
 * partner, generated from the internal tariff like GET /cpo/tariffs.
 */
export async function generateCdr(
  chargingSessionId: string,
  partnerId: string,
): Promise<OcpiCdr | null> {
  logger.info({ chargingSessionId, partnerId }, 'Generating CDR');

  const [session] = await db
    .select()
    .from(chargingSessions)
    .where(eq(chargingSessions.id, chargingSessionId))
    .limit(1);

  if (session == null) {
    logger.error({ chargingSessionId }, 'Session not found');
    return null;
  }

  if (session.startedAt == null || session.endedAt == null) {
    logger.error({ chargingSessionId }, 'Session not completed');
    return null;
  }

  const place = await sessionPlace(session);
  if (place == null) return null;
  const site = place.site;

  const currency = session.currency.toUpperCase();

  // The partner's token from the CPO session link written at session start.
  const [roamingSession] = await db
    .select({ tokenUid: ocpiRoamingSessions.tokenUid })
    .from(ocpiRoamingSessions)
    .where(eq(ocpiRoamingSessions.chargingSessionId, chargingSessionId))
    .limit(1);
  const token = await partnerToken(partnerId, roamingSession?.tokenUid ?? 'unknown');

  // The negotiated version shapes the CDR the partner consumes.
  const [partner] = await db
    .select({ version: ocpiPartners.version })
    .from(ocpiPartners)
    .where(eq(ocpiPartners.id, partnerId))
    .limit(1);
  const partnerVersion = resolvePartnerVersion(partner?.version);

  // The tariff the session was billed with, as published to this partner:
  // generated from the mapping that covers the session's tariff (directly or
  // through its pricing group).
  let tariff: PublishedTariff | null = null;
  if (session.tariffId != null) {
    const mapping = await sessionTariffMapping(partnerId, session.tariffId);
    if (mapping != null) tariff = await renderTariffMapping(mapping, partnerVersion);
  }

  const cdrId = crypto.randomUUID();

  // final_cost_cents includes tax: the CDR carries it as the gross and its
  // net and tax split per tax rate (see session-cost-split.ts).
  const cost = ocpiCdrCost(session);

  const cdrInput: Parameters<typeof transformCdr>[0] = {
    session: {
      sessionId: session.id,
      transactionId: session.transactionId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      energyDeliveredWh: session.energyDeliveredWh,
      currency,
      idleMinutes: idleMinutesAt(session, session.endedAt),
    },
    cost,
    location: {
      locationId: place.locationId,
      siteName: site?.name ?? 'Unknown',
      address: site?.address ?? null,
      city: site?.city ?? null,
      postalCode: site?.postalCode ?? null,
      state: site?.state ?? null,
      country: site?.country ?? null,
      latitude: site?.latitude ?? null,
      longitude: site?.longitude ?? null,
      evseUid: place.evseUid,
      evseId: place.evseId,
      connectorId: place.connectorId,
      connectorType: place.connectorType,
    },
    countryCode: getCountryCode(),
    partyId: getPartyId(),
    cdrId,
    token,
  };
  if (tariff != null) {
    cdrInput.tariff = tariff;
  }

  const cdr = transformCdr(cdrInput, partnerVersion);

  // Store the CDR
  await db.insert(ocpiCdrs).values({
    partnerId,
    ocpiCdrId: cdrId,
    chargingSessionId,
    totalEnergy: String(cdr.total_energy),
    // ocpi_cdrs.total_cost holds the amount excluding tax, like the CDRs
    // received from partners (excl_vat in 2.2.1, before_taxes in 2.3.0).
    totalCost: String(taxTotals(cost.total).netCents / 100),
    currency: cdr.currency,
    cdrData: cdr,
    isCredit: false,
    pushStatus: 'pending',
  });

  // Tell the CSMS so the Roaming CDRs page reloads itself.
  notifyRoamingCdrChanged();

  logger.info({ cdrId, chargingSessionId }, 'CDR generated');
  return cdr;
}

export async function pushCdr(cdrId: string): Promise<boolean> {
  const [cdr] = await db.select().from(ocpiCdrs).where(eq(ocpiCdrs.ocpiCdrId, cdrId)).limit(1);

  if (cdr == null) return false;

  const partnerId = cdr.partnerId;

  try {
    const [endpoint] = await db
      .select({ url: ocpiPartnerEndpoints.url })
      .from(ocpiPartnerEndpoints)
      .where(
        and(
          eq(ocpiPartnerEndpoints.partnerId, partnerId),
          eq(ocpiPartnerEndpoints.module, 'cdrs'),
          eq(ocpiPartnerEndpoints.interfaceRole, 'RECEIVER'),
        ),
      )
      .limit(1);

    if (endpoint == null) {
      logger.debug({ partnerId }, 'No CDR receiver endpoint for partner');
      return false;
    }

    const token = await getOutboundToken(partnerId);
    if (token == null) {
      logger.warn({ partnerId, cdrId }, 'No outbound token for partner, cannot push CDR');
      return false;
    }

    const [partner] = await db
      .select({ countryCode: ocpiPartners.countryCode, partyId: ocpiPartners.partyId })
      .from(ocpiPartners)
      .where(eq(ocpiPartners.id, partnerId))
      .limit(1);

    if (partner == null) return false;

    const client = new OcpiClient({
      token,
      fromCountryCode: getCountryCode(),
      fromPartyId: getPartyId(),
      toCountryCode: partner.countryCode,
      toPartyId: partner.partyId,
    });

    const cdrData = cdr.cdrData as OcpiCdr;
    await client.post(endpoint.url, cdrData);

    await db
      .update(ocpiCdrs)
      .set({ pushStatus: 'sent', updatedAt: new Date() })
      .where(eq(ocpiCdrs.id, cdr.id));

    // Tell the CSMS so the Roaming CDRs page reloads itself.
    notifyRoamingCdrChanged();

    await db.insert(ocpiSyncLog).values({
      partnerId,
      module: 'cdrs',
      direction: 'push',
      action: 'push_cdr',
      status: 'completed',
      objectsCount: '1',
    });

    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'CDR push failed';
    logger.error({ cdrId, partnerId, err }, 'Failed to push CDR');

    await db
      .update(ocpiCdrs)
      .set({ pushStatus: 'failed', updatedAt: new Date() })
      .where(eq(ocpiCdrs.id, cdr.id));

    await db.insert(ocpiSyncLog).values({
      partnerId,
      module: 'cdrs',
      direction: 'push',
      action: 'push_cdr',
      status: 'failed',
      objectsCount: '0',
      errorMessage: message,
    });

    return false;
  }
}

/**
 * A credit CDR for one of our CDRs (OCPI 10.1.1): only total_cost is negated.
 * Stored pending push through the shared `createCreditCdr`, which the API's
 * operator credit uses too. An existing credit of the CDR is returned as is.
 */
export async function generateCreditCdr(
  originalCdrId: string,
  reason: string,
): Promise<OcpiCdr | null> {
  const result = await createCreditCdr(originalCdrId, reason);
  if (result.status !== 'created' && result.status !== 'existing') {
    logger.warn({ originalCdrId, status: result.status }, 'Credit CDR not generated');
    return null;
  }
  if (result.status === 'created') {
    // Tell the CSMS so the Roaming CDRs page reloads itself.
    notifyRoamingCdrChanged();
    logger.info({ creditCdrId: result.cdrId, originalCdrId, reason }, 'Credit CDR generated');
  }
  return result.cdrData as unknown as OcpiCdr;
}
