// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  evses,
  connectors,
  sites,
  ocpiCdrs,
  ocpiRoamingSessions,
  ocpiTariffMappings,
  ocpiPartnerEndpoints,
  ocpiPartners,
  ocpiSyncLog,
} from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import { getOutboundToken } from '../lib/outbound-token.js';
import { OcpiClient } from '../lib/ocpi-client.js';
import { config } from '../lib/config.js';
import { transformCdr } from '../transformers/cdr.transformer.js';
import type { OcpiVersion, OcpiCdr, OcpiTariff } from '../types/ocpi.js';

const logger = createLogger('ocpi-cdr');

function getCountryCode(): string {
  return config.OCPI_COUNTRY_CODE;
}

function getPartyId(): string {
  return config.OCPI_PARTY_ID;
}

export async function generateCdr(
  chargingSessionId: string,
  partnerId: string,
): Promise<OcpiCdr | null> {
  logger.info({ chargingSessionId, partnerId }, 'Generating CDR');

  // Load the charging session
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

  // Load station and site
  const [station] = await db
    .select()
    .from(chargingStations)
    .where(eq(chargingStations.id, session.stationId))
    .limit(1);

  if (station == null) return null;

  const siteId = station.siteId;
  const [site] =
    siteId != null ? await db.select().from(sites).where(eq(sites.id, siteId)).limit(1) : [null];

  // Load EVSE and connector
  let evseUid = 'unknown';
  let evseIdStr = 'unknown';
  let connectorIdStr = '1';
  let connectorType: string | null = null;

  if (session.evseId != null) {
    const [evse] = await db.select().from(evses).where(eq(evses.id, session.evseId)).limit(1);
    if (evse != null) {
      evseUid = `${siteId ?? station.id}-${String(evse.evseId)}`;
      evseIdStr = `${siteId ?? station.id}-EVSE-${String(evse.evseId)}`;
    }
  }

  if (session.connectorId != null) {
    const [connector] = await db
      .select()
      .from(connectors)
      .where(eq(connectors.id, session.connectorId))
      .limit(1);
    if (connector != null) {
      connectorIdStr = String(connector.connectorId);
      connectorType = connector.connectorType;
    }
  }

  // Load tariff mapping if available
  let ocpiTariff: OcpiTariff | undefined;
  if (session.tariffId != null) {
    const [mapping] = await db
      .select()
      .from(ocpiTariffMappings)
      .where(eq(ocpiTariffMappings.tariffId, session.tariffId))
      .limit(1);
    if (mapping != null) {
      ocpiTariff = mapping.ocpiTariffData as OcpiTariff;
    }
  }

  // Get token info from roaming session
  const [roamingSession] = await db
    .select()
    .from(ocpiRoamingSessions)
    .where(eq(ocpiRoamingSessions.chargingSessionId, chargingSessionId))
    .limit(1);

  const tokenUid = roamingSession?.tokenUid ?? 'unknown';

  // Get partner info for token country/party
  const [partner] = await db
    .select({ countryCode: ocpiPartners.countryCode, partyId: ocpiPartners.partyId })
    .from(ocpiPartners)
    .where(eq(ocpiPartners.id, partnerId))
    .limit(1);

  const cdrId = crypto.randomUUID();

  const cdrInput: Parameters<typeof transformCdr>[0] = {
    session: {
      sessionId: session.id,
      transactionId: session.transactionId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      energyDeliveredWh: session.energyDeliveredWh,
      finalCostCents: session.finalCostCents,
      currency: session.currency,
    },
    location: {
      siteId: siteId ?? station.id,
      siteName: site?.name ?? 'Unknown',
      address: site?.address ?? null,
      city: site?.city ?? null,
      postalCode: site?.postalCode ?? null,
      state: site?.state ?? null,
      country: site?.country ?? null,
      latitude: site?.latitude ?? null,
      longitude: site?.longitude ?? null,
      evseUid,
      evseId: evseIdStr,
      connectorId: connectorIdStr,
      connectorType,
    },
    countryCode: getCountryCode(),
    partyId: getPartyId(),
    cdrId,
    tokenUid,
    tokenCountryCode: partner?.countryCode ?? '',
    tokenPartyId: partner?.partyId ?? '',
  };
  if (ocpiTariff != null) {
    cdrInput.tariff = ocpiTariff;
  }

  const cdr = transformCdr(cdrInput, '2.2.1' as OcpiVersion);

  // Store the CDR
  await db.insert(ocpiCdrs).values({
    partnerId,
    ocpiCdrId: cdrId,
    chargingSessionId,
    totalEnergy: String(cdr.total_energy),
    totalCost: String(cdr.total_cost.excl_vat),
    currency: cdr.currency,
    cdrData: cdr,
    isCredit: false,
    pushStatus: 'pending',
  });

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

export async function generateCreditCdr(
  originalCdrId: string,
  reason: string,
): Promise<OcpiCdr | null> {
  const [originalCdr] = await db
    .select()
    .from(ocpiCdrs)
    .where(eq(ocpiCdrs.ocpiCdrId, originalCdrId))
    .limit(1);

  if (originalCdr == null) return null;

  const originalData = originalCdr.cdrData as OcpiCdr;
  const creditCdrId = crypto.randomUUID();

  const creditCdr: OcpiCdr = {
    ...originalData,
    id: creditCdrId,
    credit: true,
    credit_reference_id: originalCdrId,
    remark: reason,
    total_cost: { excl_vat: -originalData.total_cost.excl_vat },
    last_updated: new Date().toISOString(),
  };

  await db.insert(ocpiCdrs).values({
    partnerId: originalCdr.partnerId,
    ocpiCdrId: creditCdrId,
    chargingSessionId: originalCdr.chargingSessionId,
    totalEnergy: originalCdr.totalEnergy,
    totalCost: String(-parseFloat(originalCdr.totalCost)),
    currency: originalCdr.currency,
    cdrData: creditCdr,
    isCredit: true,
    pushStatus: 'pending',
  });

  logger.info({ creditCdrId, originalCdrId, reason }, 'Credit CDR generated');
  return creditCdr;
}
