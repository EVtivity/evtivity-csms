// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, sql } from 'drizzle-orm';
import {
  db,
  sites,
  chargingStations,
  evses,
  connectors,
  ocpiPartners,
  ocpiPartnerEndpoints,
  ocpiLocationPublish,
  ocpiLocationPublishPartners,
  ocpiRoamingSessions,
  ocpiTariffMappings,
  ocpiSyncLog,
} from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import type { PubSubClient, Subscription } from '@evtivity/lib';
import { OcpiClient } from '../lib/ocpi-client.js';
import { getOutboundToken } from '../lib/outbound-token.js';
import { config } from '../lib/config.js';
import { transformLocation } from '../transformers/location.transformer.js';
import type { OcpiVersion, OcpiSession, OcpiTariff } from '../types/ocpi.js';

const logger = createLogger('ocpi-push');
const CHANNEL = 'ocpi_push';

interface PushNotification {
  type: 'location' | 'session' | 'cdr' | 'tariff';
  siteId?: string;
  sessionId?: string;
  cdrId?: string;
  tariffId?: string;
}

function getCountryCode(): string {
  return config.OCPI_COUNTRY_CODE;
}

function getPartyId(): string {
  return config.OCPI_PARTY_ID;
}

async function getConnectedPartners(): Promise<
  Array<{ id: string; countryCode: string; partyId: string }>
> {
  return db
    .select({
      id: ocpiPartners.id,
      countryCode: ocpiPartners.countryCode,
      partyId: ocpiPartners.partyId,
    })
    .from(ocpiPartners)
    .where(eq(ocpiPartners.status, 'connected'));
}

async function getPartnerEndpoint(
  partnerId: string,
  module: string,
  role: 'SENDER' | 'RECEIVER',
): Promise<string | null> {
  const [endpoint] = await db
    .select({ url: ocpiPartnerEndpoints.url })
    .from(ocpiPartnerEndpoints)
    .where(
      and(
        eq(ocpiPartnerEndpoints.partnerId, partnerId),
        eq(ocpiPartnerEndpoints.module, module),
        eq(ocpiPartnerEndpoints.interfaceRole, role),
      ),
    )
    .limit(1);

  return endpoint?.url ?? null;
}

async function getPartnerToken(partnerId: string): Promise<string | null> {
  return getOutboundToken(partnerId);
}

function createOcpiClient(token: string, toCountryCode: string, toPartyId: string): OcpiClient {
  return new OcpiClient({
    token,
    fromCountryCode: getCountryCode(),
    fromPartyId: getPartyId(),
    toCountryCode,
    toPartyId,
  });
}

async function logSync(
  partnerId: string,
  module: string,
  action: string,
  status: 'started' | 'completed' | 'failed',
  objectsCount: number,
  errorMessage?: string,
): Promise<void> {
  const values: {
    partnerId: string;
    module: string;
    direction: 'push' | 'pull';
    action: string;
    status: 'started' | 'completed' | 'failed';
    objectsCount: string;
    errorMessage?: string;
  } = {
    partnerId,
    module,
    direction: 'push',
    action,
    status,
    objectsCount: String(objectsCount),
  };
  if (errorMessage != null) {
    values.errorMessage = errorMessage;
  }
  await db.insert(ocpiSyncLog).values(values);
}

async function pushLocationUpdate(siteId: string): Promise<void> {
  logger.info({ siteId }, 'Pushing location update');

  // Check if published
  const [publishSetting] = await db
    .select()
    .from(ocpiLocationPublish)
    .where(and(eq(ocpiLocationPublish.siteId, siteId), eq(ocpiLocationPublish.isPublished, true)))
    .limit(1);

  if (publishSetting == null) {
    logger.debug({ siteId }, 'Site not published, skipping push');
    return;
  }

  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (site == null) return;

  // Get stations and EVSEs
  const stationRows = await db
    .select()
    .from(chargingStations)
    .where(eq(chargingStations.siteId, siteId));

  const stationIds = stationRows.map((s) => s.id);
  if (stationIds.length === 0) return;

  const evseRows = await db
    .select()
    .from(evses)
    .where(sql`${evses.stationId} IN ${stationIds}`);

  const evseIds = evseRows.map((e) => e.id);
  const connectorRows =
    evseIds.length > 0
      ? await db
          .select()
          .from(connectors)
          .where(sql`${connectors.evseId} IN ${evseIds}`)
      : [];

  const connectorsByEvse = new Map<string, typeof connectorRows>();
  for (const c of connectorRows) {
    const list = connectorsByEvse.get(c.evseId) ?? [];
    list.push(c);
    connectorsByEvse.set(c.evseId, list);
  }

  const evsesWithConnectors = evseRows.map((e) => ({
    ...e,
    connectors: (connectorsByEvse.get(e.id) ?? []).map((c) => ({
      id: c.id,
      connectorId: c.connectorId,
      connectorType: c.connectorType,
      maxPowerKw: c.maxPowerKw,
      maxCurrentAmps: c.maxCurrentAmps,
      status: c.status,
      updatedAt: c.updatedAt,
    })),
  }));

  const locationId = publishSetting.ocpiLocationId ?? siteId;
  const countryCode = getCountryCode();
  const partyId = getPartyId();

  const location = transformLocation(
    { site, evses: evsesWithConnectors, ocpiLocationId: locationId, countryCode, partyId },
    '2.2.1' as OcpiVersion,
  );

  // Determine which partners to push to
  let partnerIds: string[];

  if (publishSetting.publishToAll) {
    const partners = await getConnectedPartners();
    partnerIds = partners.map((p) => p.id);
  } else {
    const rows = await db
      .select({ partnerId: ocpiLocationPublishPartners.partnerId })
      .from(ocpiLocationPublishPartners)
      .where(eq(ocpiLocationPublishPartners.locationPublishId, publishSetting.id));
    partnerIds = rows.map((r) => r.partnerId);
  }

  for (const partnerId of partnerIds) {
    try {
      const url = await getPartnerEndpoint(partnerId, 'locations', 'RECEIVER');
      if (url == null) continue;

      const token = await getPartnerToken(partnerId);
      if (token == null) {
        logger.debug({ partnerId }, 'No outbound token for partner, skipping push');
        continue;
      }

      const partner = await db
        .select({ countryCode: ocpiPartners.countryCode, partyId: ocpiPartners.partyId })
        .from(ocpiPartners)
        .where(eq(ocpiPartners.id, partnerId))
        .limit(1);

      if (partner[0] == null) continue;

      const client = createOcpiClient(token, partner[0].countryCode, partner[0].partyId);
      await client.put(`${url}/${countryCode}/${partyId}/${locationId}`, location);
      await logSync(partnerId, 'locations', 'push_update', 'completed', 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Push failed';
      logger.error({ partnerId, err }, 'Failed to push location update');
      await logSync(partnerId, 'locations', 'push_update', 'failed', 0, message);
    }
  }
}

async function pushSessionUpdate(sessionId: string): Promise<void> {
  logger.info({ sessionId }, 'Pushing session update');

  // sessionId is the internal charging session ID from event-projections
  const [roamingSession] = await db
    .select()
    .from(ocpiRoamingSessions)
    .where(eq(ocpiRoamingSessions.chargingSessionId, sessionId))
    .limit(1);

  if (roamingSession == null) return;

  const sessionData = roamingSession.sessionData as OcpiSession;
  const partnerId = roamingSession.partnerId;

  try {
    const url = await getPartnerEndpoint(partnerId, 'sessions', 'RECEIVER');
    if (url == null) return;

    const token = await getPartnerToken(partnerId);
    if (token == null) return;

    const partner = await db
      .select({ countryCode: ocpiPartners.countryCode, partyId: ocpiPartners.partyId })
      .from(ocpiPartners)
      .where(eq(ocpiPartners.id, partnerId))
      .limit(1);

    if (partner[0] == null) return;

    const countryCode = getCountryCode();
    const partyId = getPartyId();
    const client = createOcpiClient(token, partner[0].countryCode, partner[0].partyId);
    await client.put(
      `${url}/${countryCode}/${partyId}/${roamingSession.ocpiSessionId}`,
      sessionData,
    );
    await logSync(partnerId, 'sessions', 'push_update', 'completed', 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Push failed';
    logger.error({ partnerId, err }, 'Failed to push session update');
    await logSync(partnerId, 'sessions', 'push_update', 'failed', 0, message);
  }
}

async function pushTariffUpdate(tariffId: string): Promise<void> {
  logger.info({ tariffId }, 'Pushing tariff update');

  const mappings = await db
    .select()
    .from(ocpiTariffMappings)
    .where(eq(ocpiTariffMappings.tariffId, tariffId));

  if (mappings.length === 0) return;

  const countryCode = getCountryCode();
  const partyId = getPartyId();

  for (const mapping of mappings) {
    const tariffData = mapping.ocpiTariffData as OcpiTariff;
    const targetPartnerId = mapping.partnerId;

    // If partnerId is null, push to all connected partners
    const partners =
      targetPartnerId != null ? [{ id: targetPartnerId }] : await getConnectedPartners();

    for (const partner of partners) {
      try {
        const url = await getPartnerEndpoint(partner.id, 'tariffs', 'RECEIVER');
        if (url == null) continue;

        const token = await getPartnerToken(partner.id);
        if (token == null) continue;

        const partnerInfo = await db
          .select({ countryCode: ocpiPartners.countryCode, partyId: ocpiPartners.partyId })
          .from(ocpiPartners)
          .where(eq(ocpiPartners.id, partner.id))
          .limit(1);

        if (partnerInfo[0] == null) continue;

        const client = createOcpiClient(token, partnerInfo[0].countryCode, partnerInfo[0].partyId);
        await client.put(`${url}/${countryCode}/${partyId}/${mapping.ocpiTariffId}`, tariffData);
        await logSync(partner.id, 'tariffs', 'push_update', 'completed', 1);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Push failed';
        logger.error({ partnerId: partner.id, err }, 'Failed to push tariff update');
        await logSync(partner.id, 'tariffs', 'push_update', 'failed', 0, message);
      }
    }
  }
}

async function handlePushNotification(raw: string): Promise<void> {
  let notification: PushNotification;
  try {
    notification = JSON.parse(raw) as PushNotification;
  } catch {
    logger.error({ raw }, 'Invalid push notification payload');
    return;
  }

  switch (notification.type) {
    case 'location':
      if (notification.siteId != null) {
        await pushLocationUpdate(notification.siteId);
      }
      break;
    case 'session':
      if (notification.sessionId != null) {
        await pushSessionUpdate(notification.sessionId);
      }
      break;
    case 'tariff':
      if (notification.tariffId != null) {
        await pushTariffUpdate(notification.tariffId);
      }
      break;
    case 'cdr':
      // CDRs are pushed by the CDR service directly after generation
      break;
  }
}

export class OcpiPushListener {
  private readonly pubsub: PubSubClient;
  private subscription: Subscription | null = null;

  constructor(pubsub: PubSubClient) {
    this.pubsub = pubsub;
  }

  async start(): Promise<void> {
    this.subscription = await this.pubsub.subscribe(CHANNEL, (payload: string) => {
      void handlePushNotification(payload);
    });
    logger.info({ channel: CHANNEL }, 'Listening for OCPI push notifications');
  }

  async stop(): Promise<void> {
    if (this.subscription != null) {
      await this.subscription.unsubscribe();
      this.subscription = null;
    }
    logger.info('OCPI push listener stopped');
  }
}
