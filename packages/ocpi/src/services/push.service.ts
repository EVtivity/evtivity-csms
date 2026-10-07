// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, sql } from 'drizzle-orm';
import {
  db,
  chargingStations,
  evses,
  ocpiPartners,
  ocpiPartnerEndpoints,
  ocpiLocationPublish,
  ocpiLocationPublishPartners,
  ocpiSyncLog,
  chargingSessions,
  ocpiLocationAudience,
} from '@evtivity/database';
import { createInFlightTracker, createLogger, tryParseJson } from '@evtivity/lib';
import type { PubSubClient, Subscription } from '@evtivity/lib';
import { drainListener, trackListenerWork } from '../lib/listener-drain.js';
import { OcpiClient } from '../lib/ocpi-client.js';
import { OcpiStatusCode } from '../lib/ocpi-response.js';
import { getOutboundToken } from '../lib/outbound-token.js';
import { config } from '../lib/config.js';
import { transformLocation } from '../transformers/location.transformer.js';
import { resolvePartnerVersion } from '../lib/ocpi-version.js';
import { cpoSessionLink, renderCpoSession, syncCpoSessionRow } from './cpo-sessions.js';
import { connectorTariffIds } from './connector-tariffs.js';
import { loadSiteLocation, withTariffIds } from './location-render.js';
import type { SiteLocation } from './location-render.js';
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
  /**
   * location: partners that no longer see the site, under the OCPI location
   * id they know. They get the location with every EVSE REMOVED.
   */
  removed?: { ocpiLocationId: string; partnerIds: string[] };
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
  Array<{
    id: string;
    countryCode: string;
    partyId: string;
    version: string | null;
    allowPrivateNetwork: boolean;
  }>
> {
  return db
    .select({
      id: ocpiPartners.id,
      countryCode: ocpiPartners.countryCode,
      partyId: ocpiPartners.partyId,
      version: ocpiPartners.version,
      allowPrivateNetwork: ocpiPartners.allowPrivateNetwork,
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

function createOcpiClient(
  token: string,
  partner: { countryCode: string; partyId: string; allowPrivateNetwork: boolean },
): OcpiClient {
  return new OcpiClient({
    token,
    fromCountryCode: getCountryCode(),
    fromPartyId: getPartyId(),
    toCountryCode: partner.countryCode,
    toPartyId: partner.partyId,
    allowPrivateNetwork: partner.allowPrivateNetwork,
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

/** A partner's receiver endpoint for a module, its token, and its identity. */
interface PartnerTarget {
  url: string;
  token: string;
  countryCode: string;
  partyId: string;
  version: string | null;
  allowPrivateNetwork: boolean;
}

async function partnerTarget(partnerId: string, module: string): Promise<PartnerTarget | null> {
  const [url, token, partnerRows] = await Promise.all([
    getPartnerEndpoint(partnerId, module, 'RECEIVER'),
    getPartnerToken(partnerId),
    db
      .select({
        countryCode: ocpiPartners.countryCode,
        partyId: ocpiPartners.partyId,
        version: ocpiPartners.version,
        allowPrivateNetwork: ocpiPartners.allowPrivateNetwork,
      })
      .from(ocpiPartners)
      .where(eq(ocpiPartners.id, partnerId))
      .limit(1),
  ]);
  if (url == null) return null;
  if (token == null) {
    logger.debug({ partnerId }, 'No outbound token for partner, skipping push');
    return null;
  }
  const partner = partnerRows[0];
  if (partner == null) return null;
  return { url, token, ...partner };
}

/**
 * PUTs the location to each partner in its version. `removed` renders every
 * EVSE as REMOVED (the partner no longer sees the location, OCPI 8.1).
 * Partners are pushed in parallel and independently, so one slow or down
 * partner does not hold up the rest.
 */
async function putLocation(
  location: SiteLocation,
  partnerIds: readonly string[],
  removed: boolean,
): Promise<void> {
  const { input } = location;
  const action = removed ? 'push_removed' : 'push_update';
  await Promise.allSettled(
    partnerIds.map(async (partnerId) => {
      try {
        const target = await partnerTarget(partnerId, 'locations');
        if (target == null) return;
        // A removed location carries no tariffs: its EVSEs are gone.
        const tariffIds = removed
          ? new Map<string, string[]>()
          : await connectorTariffIds(partnerId, location.stations);
        // Shape the payload to the partner's negotiated version so 2.3.0
        // partners receive the 2.3.0 fields instead of a 2.2.1 downshift.
        const ocpiLocation = transformLocation(
          { ...withTariffIds(input, tariffIds), ...(removed ? { allRemoved: true } : {}) },
          resolvePartnerVersion(target.version),
        );
        const client = createOcpiClient(target.token, target);
        await client.put(
          `${target.url}/${getCountryCode()}/${getPartyId()}/${input.ocpiLocationId}`,
          ocpiLocation,
        );
        await logSync(partnerId, 'locations', action, 'completed', 1);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Push failed';
        logger.error({ partnerId, err }, 'Failed to push location update');
        await logSync(partnerId, 'locations', action, 'failed', 0, message);
      }
    }),
  );
}

async function pushLocationUpdate(
  siteId: string,
  removed?: { ocpiLocationId: string; partnerIds: string[] },
): Promise<void> {
  logger.info({ siteId }, 'Pushing location update');

  const audience = await ocpiLocationAudience(siteId);
  if (audience != null && audience.partnerIds.length > 0) {
    const location = await loadSiteLocation(siteId, audience.ocpiLocationId);
    if (location != null) await putLocation(location, audience.partnerIds, false);
  } else {
    logger.debug({ siteId }, 'Site not published, skipping push');
  }

  // Partners that lost the location (unpublished, dropped from the
  // allow-list, or the OCPI location id changed) get it with every EVSE
  // REMOVED under the id they know.
  if (removed != null && removed.partnerIds.length > 0) {
    const location = await loadSiteLocation(siteId, removed.ocpiLocationId);
    if (location != null) await putLocation(location, removed.partnerIds, true);
  }
}

/** The body of a PATCH that removes an EVSE (OCPI 8.2.2, "delete an EVSE"). */
function evseRemovedPatch(): { status: 'REMOVED'; last_updated: string } {
  return { status: 'REMOVED', last_updated: new Date().toISOString() };
}

/** Throws for an OCPI server error (3xxx), so the caller's job retries. */
function assertNoServerError(
  response: { status_code: OcpiStatusCode; status_message: string },
  what: string,
): void {
  if (response.status_code >= OcpiStatusCode.SERVER_ERROR) {
    throw new Error(
      `Partner answered ${String(response.status_code)} for ${what}: ${response.status_message}`,
    );
  }
}

/**
 * The EVSE uids published before v0.1.32 were `{siteId}-{evseNumber}`. For
 * every site published to the partner: PUTs the current location (new uids),
 * so the location keeps valid EVSEs, then PATCHes REMOVED for each old uid
 * (every EVSE number at the site). A partner that does not know a uid answers
 * with a client error (2xxx), which counts as done. A transport error or a
 * server error (3xxx) throws, so the caller's job retries. Returns the number
 * of PATCHes sent; null when the partner has no locations receiver or token
 * (nothing to do).
 */
export async function pushLegacyEvseRemoval(partnerId: string): Promise<number | null> {
  const target = await partnerTarget(partnerId, 'locations');
  if (target == null) return null;

  const rows = await db
    .selectDistinct({
      siteId: ocpiLocationPublish.siteId,
      ocpiLocationId: ocpiLocationPublish.ocpiLocationId,
      evseNumber: evses.evseId,
    })
    .from(ocpiLocationPublish)
    .innerJoin(chargingStations, eq(chargingStations.siteId, ocpiLocationPublish.siteId))
    .innerJoin(evses, eq(evses.stationId, chargingStations.id))
    .leftJoin(
      ocpiLocationPublishPartners,
      and(
        eq(ocpiLocationPublishPartners.locationPublishId, ocpiLocationPublish.id),
        eq(ocpiLocationPublishPartners.partnerId, partnerId),
      ),
    )
    .where(
      and(
        eq(ocpiLocationPublish.isPublished, true),
        sql`(${ocpiLocationPublish.publishToAll} = true OR ${ocpiLocationPublishPartners.partnerId} IS NOT NULL)`,
      ),
    );

  const client = createOcpiClient(target.token, target);
  const base = `${target.url}/${getCountryCode()}/${getPartyId()}`;
  const version = resolvePartnerVersion(target.version);
  const sites = new Map(rows.map((r) => [r.siteId, r.ocpiLocationId ?? r.siteId]));
  for (const [siteId, locationId] of sites) {
    const location = await loadSiteLocation(siteId, locationId);
    if (location == null) continue;
    const tariffIds = await connectorTariffIds(partnerId, location.stations);
    const response = await client.put(
      `${base}/${locationId}`,
      transformLocation(withTariffIds(location.input, tariffIds), version),
    );
    assertNoServerError(response, `location ${locationId}`);
  }
  for (const row of rows) {
    const locationId = row.ocpiLocationId ?? row.siteId;
    const uid = `${row.siteId}-${String(row.evseNumber)}`;
    const response = await client.patch(`${base}/${locationId}/${uid}`, evseRemovedPatch());
    assertNoServerError(response, `legacy EVSE ${uid}`);
  }
  await logSync(partnerId, 'locations', 'push_removed_legacy', 'completed', rows.length);
  return rows.length;
}

/** Called after a session push when the session is completed (CDR issue). */
export type SessionCompletedHook = (sessionId: string) => Promise<void>;

async function pushSessionUpdate(
  sessionId: string,
  onCompleted: SessionCompletedHook | null,
): Promise<void> {
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
        allowPrivateNetwork: ocpiPartners.allowPrivateNetwork,
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

    // A completed session is billed with a CDR (OCPI 10.1). The hook only
    // schedules it; the job rechecks the status (P5). Faulted and failed
    // sessions are INVALID in OCPI ("will not be billed") and get none.
    if (onCompleted != null && session.status === 'completed' && session.endedAt != null) {
      await onCompleted(sessionId).catch((err: unknown) => {
        logger.warn({ err, sessionId }, 'CDR scheduling failed; the CDR sweep retries');
      });
    }

    const [url, token] = await Promise.all([
      getPartnerEndpoint(partnerId, 'sessions', 'RECEIVER'),
      getPartnerToken(partnerId),
    ]);
    if (url == null) return;
    if (token == null) return;

    const countryCode = getCountryCode();
    const partyId = getPartyId();
    const client = createOcpiClient(token, partner);
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
          allowPrivateNetwork: ocpiPartners.allowPrivateNetwork,
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

    const client = createOcpiClient(token, partner);
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

async function handlePushNotification(
  raw: string,
  onSessionCompleted: SessionCompletedHook | null,
): Promise<void> {
  const parsed = tryParseJson(raw);
  if (parsed === undefined) {
    logger.error({ raw }, 'Invalid push notification payload');
    return;
  }
  const notification = parsed as PushNotification;

  switch (notification.type) {
    case 'location':
      if (notification.siteId != null) {
        await pushLocationUpdate(notification.siteId, notification.removed);
      }
      break;
    case 'session':
      if (notification.sessionId != null) {
        await pushSessionUpdate(notification.sessionId, onSessionCompleted);
      }
      break;
    case 'tariff':
      await pushTariffUpdate(notification);
      break;
    case 'cdr':
      // CDRs are issued and pushed by the ocpi-cdrs queue (cdr-jobs.ts).
      break;
  }
}

export class OcpiPushListener {
  private readonly pubsub: PubSubClient;
  private subscription: Subscription | null = null;
  private readonly inFlight = createInFlightTracker();
  private readonly onSessionCompleted: SessionCompletedHook | null;

  /**
   * `onSessionCompleted` runs after a completed session is pushed; the OCPI
   * server passes the CDR scheduler (`scheduleSessionCdr`).
   */
  constructor(pubsub: PubSubClient, onSessionCompleted: SessionCompletedHook | null = null) {
    this.pubsub = pubsub;
    this.onSessionCompleted = onSessionCompleted;
  }

  async start(): Promise<void> {
    this.subscription = await this.pubsub.subscribe(CHANNEL, (payload: string) => {
      trackListenerWork(this.inFlight, logger, () =>
        handlePushNotification(payload, this.onSessionCompleted),
      );
    });
    logger.info({ channel: CHANNEL }, 'Listening for OCPI push notifications');
  }

  async stop(): Promise<void> {
    if (this.subscription != null) {
      await this.subscription.unsubscribe();
      this.subscription = null;
    }
    await drainListener(this.inFlight, logger);
    logger.info('OCPI push listener stopped');
  }
}
