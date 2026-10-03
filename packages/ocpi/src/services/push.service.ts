// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, sql, lte, gte } from 'drizzle-orm';
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
  ocpiSyncLog,
  chargingSessions,
  maintenanceEvents,
  isStationLevelUnavailable,
} from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import type { PubSubClient, Subscription } from '@evtivity/lib';
import { OcpiClient } from '../lib/ocpi-client.js';
import { getOutboundToken } from '../lib/outbound-token.js';
import { config } from '../lib/config.js';
import { transformLocation } from '../transformers/location.transformer.js';
import { resolvePartnerVersion } from '../lib/ocpi-version.js';
import { cpoSessionLink, renderCpoSession, syncCpoSessionRow } from './cpo-sessions.js';
import {
  mappingsForPricingChange,
  partnerTariffMappings,
  renderTariffMapping,
} from './published-tariffs.js';

const logger = createLogger('ocpi-push');
const CHANNEL = 'ocpi_push';

/** A published tariff to resync: an OCPI tariff id for one partner, or every partner (null). */
export interface TariffPushTarget {
  partnerId: string | null;
  ocpiTariffId: string;
}

export interface PushNotification {
  type: 'location' | 'session' | 'cdr' | 'tariff';
  siteId?: string;
  sessionId?: string;
  cdrId?: string;
  /**
   * tariff: an internal tariff or pricing group changed. Every mapping
   * generated from it is pushed again. Neither set (a holiday change) pushes
   * every mapping.
   */
  tariffId?: string | null;
  pricingGroupId?: string | null;
  /** tariff: a mapping changed. Each OCPI tariff id is pushed again or deleted. */
  targets?: TariffPushTarget[];
}

function getCountryCode(): string {
  return config.OCPI_COUNTRY_CODE;
}

function getPartyId(): string {
  return config.OCPI_PARTY_ID;
}

async function getConnectedPartners(): Promise<
  Array<{ id: string; countryCode: string; partyId: string; version: string | null }>
> {
  return db
    .select({
      id: ocpiPartners.id,
      countryCode: ocpiPartners.countryCode,
      partyId: ocpiPartners.partyId,
      version: ocpiPartners.version,
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

  // OCPI Location.coordinates is required. Skipping the push here keeps
  // unconfigured sites out of partner feeds entirely instead of publishing
  // (0, 0) null-island coordinates that routing systems would treat as real.
  if (site.latitude == null || site.longitude == null) {
    logger.warn({ siteId }, 'Skipping OCPI location push: site has no coordinates configured');
    return;
  }

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

  const stationById = new Map(stationRows.map((s) => [s.id, s]));
  const evsesWithConnectors = evseRows.map((e) => {
    const station = stationById.get(e.stationId);
    return {
      ...e,
      stationOcppId: station?.stationId ?? e.stationId,
      stationLevelUnavailable: station != null && isStationLevelUnavailable(station),
      connectors: (connectorsByEvse.get(e.id) ?? []).map((c) => ({
        id: c.id,
        connectorId: c.connectorId,
        connectorType: c.connectorType,
        maxPowerKw: c.maxPowerKw,
        maxCurrentAmps: c.maxCurrentAmps,
        status: c.status,
        updatedAt: c.updatedAt,
      })),
    };
  });

  const locationId = publishSetting.ocpiLocationId ?? siteId;
  const countryCode = getCountryCode();
  const partyId = getPartyId();

  const now = new Date();
  const activeMaintenance = await db
    .select({ affectedStationIds: maintenanceEvents.affectedStationIds })
    .from(maintenanceEvents)
    .where(
      and(
        eq(maintenanceEvents.siteId, siteId),
        eq(maintenanceEvents.status, 'active'),
        lte(maintenanceEvents.plannedStartAt, now),
        gte(maintenanceEvents.plannedEndAt, now),
      ),
    );

  let coverage: { allAffected: boolean; affectedStationIds: Set<string> } | undefined;
  if (activeMaintenance.length > 0) {
    const allAffected = activeMaintenance.some(
      (m) => m.affectedStationIds == null || m.affectedStationIds.length === 0,
    );
    const stationSet = new Set<string>();
    for (const m of activeMaintenance) {
      if (m.affectedStationIds != null) {
        for (const s of m.affectedStationIds) stationSet.add(s);
      }
    }
    coverage = { allAffected, affectedStationIds: stationSet };
  }

  const locationInput = {
    site,
    evses: evsesWithConnectors,
    ocpiLocationId: locationId,
    countryCode,
    partyId,
    ...(coverage != null ? { maintenance: coverage } : {}),
  };

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

  // Push to every partner in parallel. The inner Promise.all already batches
  // the 3 lookups per partner, but the outer loop was serial: at 10 partners
  // a single location update spent ~3s blocked on sequential HTTP. Each
  // partner is independent (different endpoint, token, identity), and
  // allSettled isolates per-partner failures so one slow or down partner
  // does not hold up the rest.
  await Promise.allSettled(
    partnerIds.map(async (partnerId) => {
      try {
        const [url, token, partnerRows] = await Promise.all([
          getPartnerEndpoint(partnerId, 'locations', 'RECEIVER'),
          getPartnerToken(partnerId),
          db
            .select({
              countryCode: ocpiPartners.countryCode,
              partyId: ocpiPartners.partyId,
              version: ocpiPartners.version,
            })
            .from(ocpiPartners)
            .where(eq(ocpiPartners.id, partnerId))
            .limit(1),
        ]);
        if (url == null) return;
        if (token == null) {
          logger.debug({ partnerId }, 'No outbound token for partner, skipping push');
          return;
        }
        const partner = partnerRows[0];
        if (partner == null) return;

        // Shape the payload to the partner's negotiated version so 2.3.0
        // partners receive the 2.3.0 fields (e.g. open-enum statuses, AFIR
        // metadata) instead of being silently downshifted to 2.2.1.
        const location = transformLocation(locationInput, resolvePartnerVersion(partner.version));
        const client = createOcpiClient(token, partner.countryCode, partner.partyId);
        await client.put(`${url}/${countryCode}/${partyId}/${locationId}`, location);
        await logSync(partnerId, 'locations', 'push_update', 'completed', 1);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Push failed';
        logger.error({ partnerId, err }, 'Failed to push location update');
        await logSync(partnerId, 'locations', 'push_update', 'failed', 0, message);
      }
    }),
  );
}

async function pushSessionUpdate(sessionId: string): Promise<void> {
  logger.info({ sessionId }, 'Pushing session update');

  // sessionId is the internal charging session ID from event-projections. A
  // session started with a partner's token has a CPO session link.
  const link = await cpoSessionLink(sessionId);
  if (link == null) return;

  const partnerId = link.partnerId;
  try {
    const [session] = await db
      .select()
      .from(chargingSessions)
      .where(eq(chargingSessions.id, sessionId))
      .limit(1);
    if (session == null) return;

    const [partner] = await db
      .select({
        countryCode: ocpiPartners.countryCode,
        partyId: ocpiPartners.partyId,
        version: ocpiPartners.version,
      })
      .from(ocpiPartners)
      .where(eq(ocpiPartners.id, partnerId))
      .limit(1);
    if (partner == null) return;

    // The Session is rendered from the charging session, in the partner's
    // version, and the link row keeps its summary for the CSMS.
    const version = resolvePartnerVersion(partner.version);
    const ocpiSession = await renderCpoSession(link, session, version);
    if (ocpiSession == null) return;
    await syncCpoSessionRow(link, ocpiSession, version);

    const [url, token] = await Promise.all([
      getPartnerEndpoint(partnerId, 'sessions', 'RECEIVER'),
      getPartnerToken(partnerId),
    ]);
    if (url == null) return;
    if (token == null) return;

    const countryCode = getCountryCode();
    const partyId = getPartyId();
    const client = createOcpiClient(token, partner.countryCode, partner.partyId);
    // PUT replaces the Session in the eMSP system (9.2.2.2), charging
    // periods included.
    await client.put(`${url}/${countryCode}/${partyId}/${ocpiSession.id}`, ocpiSession);
    await logSync(partnerId, 'sessions', 'push_update', 'completed', 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Push failed';
    logger.error({ partnerId, err }, 'Failed to push session update');
    await logSync(partnerId, 'sessions', 'push_update', 'failed', 0, message);
  }
}

/**
 * Pushes one OCPI tariff id to one partner: the tariff generated from the
 * mapping in effect for the partner (PUT), or a DELETE when no mapping
 * publishes that id to the partner any more (11.2.2.3).
 */
async function syncPartnerTariff(partnerId: string, ocpiTariffId: string): Promise<void> {
  try {
    const [url, token, partnerRows] = await Promise.all([
      getPartnerEndpoint(partnerId, 'tariffs', 'RECEIVER'),
      getPartnerToken(partnerId),
      db
        .select({
          countryCode: ocpiPartners.countryCode,
          partyId: ocpiPartners.partyId,
          version: ocpiPartners.version,
        })
        .from(ocpiPartners)
        .where(eq(ocpiPartners.id, partnerId))
        .limit(1),
    ]);
    if (url == null) return;
    if (token == null) return;
    const partner = partnerRows[0];
    if (partner == null) return;

    const mapping = (await partnerTariffMappings(partnerId)).find(
      (m) => m.ocpiTariffId === ocpiTariffId,
    );
    const tariff =
      mapping != null
        ? await renderTariffMapping(mapping, resolvePartnerVersion(partner.version))
        : null;

    const client = createOcpiClient(token, partner.countryCode, partner.partyId);
    const target = `${url}/${getCountryCode()}/${getPartyId()}/${ocpiTariffId}`;
    if (tariff != null) {
      await client.put(target, tariff);
      await logSync(partnerId, 'tariffs', 'push_update', 'completed', 1);
    } else {
      await client.delete(target);
      await logSync(partnerId, 'tariffs', 'push_delete', 'completed', 1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Push failed';
    logger.error({ partnerId, ocpiTariffId, err }, 'Failed to push tariff update');
    await logSync(partnerId, 'tariffs', 'push_update', 'failed', 0, message);
  }
}

async function pushTariffUpdate(notification: PushNotification): Promise<void> {
  const targets: TariffPushTarget[] =
    notification.targets ??
    (
      await mappingsForPricingChange({
        tariffId: notification.tariffId ?? null,
        pricingGroupId: notification.pricingGroupId ?? null,
      })
    ).map((m) => ({ partnerId: m.partnerId, ocpiTariffId: m.ocpiTariffId }));
  if (targets.length === 0) return;
  logger.info({ targets: targets.length }, 'Pushing tariff update');

  // A global target goes to every connected partner. Each (partner, tariff id)
  // pair is pushed once; per-partner pushes are independent, so one slow or
  // down partner does not block the others.
  const connected = targets.some((t) => t.partnerId == null)
    ? (await getConnectedPartners()).map((p) => p.id)
    : [];
  const pairs = new Map<string, { partnerId: string; ocpiTariffId: string }>();
  for (const target of targets) {
    const partnerIds = target.partnerId != null ? [target.partnerId] : connected;
    for (const partnerId of partnerIds) {
      pairs.set(JSON.stringify([partnerId, target.ocpiTariffId]), {
        partnerId,
        ocpiTariffId: target.ocpiTariffId,
      });
    }
  }
  await Promise.allSettled(
    [...pairs.values()].map((pair) => syncPartnerTariff(pair.partnerId, pair.ocpiTariffId)),
  );
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
      await pushTariffUpdate(notification);
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
