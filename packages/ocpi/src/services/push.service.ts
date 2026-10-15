// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import type { JobsOptions } from 'bullmq';
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
  clearIdlingSettingCache,
  clearSystemSettingsCache,
  isOperatorStation,
} from '@evtivity/database';
import { createInFlightTracker, createLogger, tryParseJson } from '@evtivity/lib';
import type { PubSubClient, Subscription } from '@evtivity/lib';
import { drainListener, trackListenerWork } from '../lib/listener-drain.js';
import { OcpiClient } from '../lib/ocpi-client.js';
import { OcpiStatusCode } from '../lib/ocpi-response.js';
import { getOutboundToken } from '../lib/outbound-token.js';
import { config } from '../lib/config.js';
import { transformLocation } from '../transformers/location.transformer.js';
import { ocpiTokenTypeOf, transformToken } from '../transformers/token.transformer.js';
import { loadEmspTokens, loadEmspTombstones } from './emsp-tokens.js';
import { resolvePartnerVersion } from '../lib/ocpi-version.js';
import { cpoSessionLink, renderCpoSession, syncCpoSessionRow } from './cpo-sessions.js';
import { connectorTariffIds } from './connector-tariffs.js';
import { deletedSiteLocation, loadSiteLocation, withTariffIds } from './location-render.js';
import type { DeletedSiteSnapshot } from './location-render.js';
import {
  mappingsForPricingChange,
  partnerTariffMappings,
  renderTariffMapping,
} from './published-tariffs.js';

// Pushes run as BullMQ jobs on the OCPI server's queue (cdr-jobs.ts), not in
// the pub/sub handler: every OCPI replica receives each `ocpi_push` message,
// so a push done in the handler went to the partner once per replica, and a
// failed push was never retried. The handler only adds jobs; each job carries
// a deduplication id per object (and per partner), so the replicas' adds
// become one job. With `keepLastIfActive`, a change that arrives while the
// object's job runs adds one more job after it, and every job renders the
// object as it is when it runs: the latest state wins, and one object is
// never pushed twice at once. A failed push retries with backoff; a partner
// client error (2xxx) is not retried.

const logger = createLogger('ocpi-push');
const CHANNEL = 'ocpi_push';

/** A published tariff to resync: an OCPI tariff id for one partner, or every partner (null). */
export interface TariffPushTarget {
  partnerId: string | null;
  ocpiTariffId: string;
}

export interface PushNotification {
  type: 'location' | 'session' | 'cdr' | 'tariff' | 'token';
  siteId?: string;
  /**
   * location: partners that no longer see the site, under the OCPI location
   * id they know. They get the location with every EVSE REMOVED.
   */
  removed?: { ocpiLocationId: string; partnerIds: string[] };
  /**
   * location: the site was deleted. Its location as it was, so the partners
   * in `removed` get it with every EVSE REMOVED although the site is gone.
   */
  deletedSite?: DeletedSiteSnapshot;
  sessionId?: string;
  /**
   * cdr with sessionId: an operator reissued the session's CDR; generation
   * counts its superseded CDRs (the jobId of the new CDR job).
   */
  generation?: number;
  /** cdr with cdrId: an operator retries the push of a stored CDR; retry stamps the attempt. */
  cdrId?: string;
  retry?: string;
  /**
   * tariff: an internal tariff or pricing group changed. Every mapping
   * generated from it is pushed again. Neither set (a holiday change) pushes
   * every mapping.
   */
  tariffId?: string | null;
  pricingGroupId?: string | null;
  /**
   * tariff: a setting every tariff is rendered with changed (currency, tax
   * basis, idle grace). The cached readers of this process are cleared first,
   * so the push carries the new value, then every mapping is pushed.
   */
  settingsChanged?: boolean;
  /** tariff: a mapping changed. Each OCPI tariff id is pushed again or deleted. */
  targets?: TariffPushTarget[];
  /** token: driver tokens that changed; each is pushed as it is now. */
  tokenIds?: string[];
  /** token: token values that no longer exist; each is pushed as valid = false. */
  tombstones?: Array<{ idToken: string; tokenType: string }>;
}

/** The push jobs. `push-fanout` resolves a notification into per-partner jobs. */
export const PUSH_JOB_NAMES = [
  'push-fanout',
  'push-location',
  'push-session',
  'push-tariff',
  'push-token',
] as const;
export type PushJobName = (typeof PUSH_JOB_NAMES)[number];

export function isPushJobName(name: string): name is PushJobName {
  return (PUSH_JOB_NAMES as readonly string[]).includes(name);
}

/** Adds a push job (the OCPI queue in production, an in-process runner in tests). */
export interface PushJobSink {
  add: (name: PushJobName, data: unknown, deduplicationId: string) => Promise<void>;
  /** Schedules the CDR job of a session (a reissue passes its generation). */
  scheduleCdr: (sessionId: string, generation: number) => Promise<void>;
  /** Schedules the POST of a stored CDR (an operator retry passes its stamp). */
  pushStoredCdr: (ocpiCdrId: string, retry?: string) => Promise<void>;
}

/** Attempts of a push job: about 5 minutes of exponential backoff from 10 s. */
export const PUSH_JOB_ATTEMPTS = 6;

/** The BullMQ options of a push job with its deduplication id. */
export function pushJobOptions(deduplicationId: string): JobsOptions {
  return {
    deduplication: { id: deduplicationId, keepLastIfActive: true },
    attempts: PUSH_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: true,
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  };
}

/** A short stable hash for deduplication ids built from free-form values. */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function getCountryCode(): string {
  return config.OCPI_COUNTRY_CODE;
}

function getPartyId(): string {
  return config.OCPI_PARTY_ID;
}

async function getConnectedPartnerIds(): Promise<string[]> {
  const rows = await db
    .select({ id: ocpiPartners.id })
    .from(ocpiPartners)
    .where(eq(ocpiPartners.status, 'connected'));
  return rows.map((r) => r.id);
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

function createOcpiClient(
  token: string,
  partner: {
    countryCode: string;
    partyId: string;
    allowPrivateNetwork: boolean;
    allowRawToken: boolean;
  },
): OcpiClient {
  return new OcpiClient({
    token,
    fromCountryCode: getCountryCode(),
    fromPartyId: getPartyId(),
    toCountryCode: partner.countryCode,
    toPartyId: partner.partyId,
    allowPrivateNetwork: partner.allowPrivateNetwork,
    rawToken: partner.allowRawToken,
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
  allowRawToken: boolean;
}

async function partnerTarget(partnerId: string, module: string): Promise<PartnerTarget | null> {
  const [url, token, partnerRows] = await Promise.all([
    getPartnerEndpoint(partnerId, module, 'RECEIVER'),
    getOutboundToken(partnerId),
    db
      .select({
        countryCode: ocpiPartners.countryCode,
        partyId: ocpiPartners.partyId,
        version: ocpiPartners.version,
        allowPrivateNetwork: ocpiPartners.allowPrivateNetwork,
        allowRawToken: ocpiPartners.allowRawToken,
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
 * The partner accepted the request (OCPI 1000). A client error (2xxx) is not
 * retried (the same request gets the same answer); any other code throws for
 * a retry with backoff. HTTP errors without an OCPI error code and transport
 * errors throw in the client.
 */
function assertAccepted(
  response: { status_code: OcpiStatusCode; status_message?: string },
  what: string,
): void {
  if (response.status_code === OcpiStatusCode.SUCCESS) return;
  const message = `Partner answered ${String(response.status_code)} for ${what}: ${response.status_message ?? ''}`;
  if (
    response.status_code >= OcpiStatusCode.CLIENT_ERROR &&
    response.status_code < OcpiStatusCode.SERVER_ERROR
  ) {
    throw new UnrecoverableError(message);
  }
  throw new Error(message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Push failed';
}

/** The data of one location push job: one partner, one OCPI location id. */
export interface LocationPushJob {
  siteId: string;
  partnerId: string;
  ocpiLocationId: string;
  /** true: the partner lost the location; it gets every EVSE REMOVED. */
  removed: boolean;
  /** removed, site deleted: the location as it was, since the site row is gone. */
  deletedSite?: DeletedSiteSnapshot;
}

/**
 * PUTs the location to one partner in its version, as it is when the job
 * runs. The audience is read again first: a partner that lost the location
 * since the job was added gets no update (its REMOVED job sends that), and a
 * REMOVED job for a partner that sees the location again under the same id
 * is skipped.
 */
async function pushLocationToPartner(job: LocationPushJob): Promise<void> {
  const { siteId, partnerId, ocpiLocationId, removed } = job;
  const action = removed ? 'push_removed' : 'push_update';
  const audience = await ocpiLocationAudience(siteId);
  const sees =
    audience != null &&
    audience.ocpiLocationId === ocpiLocationId &&
    audience.partnerIds.includes(partnerId);
  if (sees === removed) {
    logger.debug({ siteId, partnerId, removed }, 'Location audience changed, push skipped');
    return;
  }
  const location =
    (await loadSiteLocation(siteId, ocpiLocationId)) ??
    (removed && job.deletedSite != null
      ? deletedSiteLocation(job.deletedSite, ocpiLocationId)
      : null);
  if (location == null) return;
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
      { ...withTariffIds(location.input, tariffIds), ...(removed ? { allRemoved: true } : {}) },
      resolvePartnerVersion(target.version),
    );
    const client = createOcpiClient(target.token, target);
    const locationId = location.input.ocpiLocationId;
    const response = await client.put(
      `${target.url}/${getCountryCode()}/${getPartyId()}/${encodeURIComponent(locationId)}`,
      ocpiLocation,
    );
    assertAccepted(response, `location ${locationId}`);
    await logSync(partnerId, 'locations', action, 'completed', 1);
  } catch (err) {
    logger.error({ partnerId, err }, 'Failed to push location update');
    await logSync(partnerId, 'locations', action, 'failed', 0, errorMessage(err));
    throw err;
  }
}

/** One push job per partner that sees the site, and one per partner that lost it. */
async function fanOutLocation(
  sink: PushJobSink,
  siteId: string,
  removed: { ocpiLocationId: string; partnerIds: string[] } | undefined,
  deletedSite?: DeletedSiteSnapshot,
): Promise<void> {
  const audience = await ocpiLocationAudience(siteId);
  const jobs: LocationPushJob[] = [];
  if (audience != null) {
    for (const partnerId of audience.partnerIds) {
      jobs.push({ siteId, partnerId, ocpiLocationId: audience.ocpiLocationId, removed: false });
    }
  } else {
    logger.debug({ siteId }, 'Site not published, no location update');
  }
  // Partners that lost the location (unpublished, dropped from the
  // allow-list, or the OCPI location id changed) get it with every EVSE
  // REMOVED under the id they know.
  if (removed != null) {
    for (const partnerId of removed.partnerIds) {
      jobs.push({
        siteId,
        partnerId,
        ocpiLocationId: removed.ocpiLocationId,
        removed: true,
        ...(deletedSite != null ? { deletedSite } : {}),
      });
    }
  }
  for (const job of jobs) {
    const kind = job.removed ? 'r' : 'u';
    await sink.add(
      'push-location',
      job,
      `pl-${siteId}-${job.partnerId}-${shortHash(job.ocpiLocationId)}-${kind}`,
    );
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
        isOperatorStation(),
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
      `${base}/${encodeURIComponent(locationId)}`,
      transformLocation(withTariffIds(location.input, tariffIds), version),
    );
    assertNoServerError(response, `location ${locationId}`);
  }
  for (const row of rows) {
    const locationId = row.ocpiLocationId ?? row.siteId;
    const uid = `${row.siteId}-${String(row.evseNumber)}`;
    const response = await client.patch(
      `${base}/${encodeURIComponent(locationId)}/${encodeURIComponent(uid)}`,
      evseRemovedPatch(),
    );
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
        allowRawToken: ocpiPartners.allowRawToken,
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
      getOutboundToken(partnerId),
    ]);
    if (url == null) return;
    if (token == null) return;

    const countryCode = getCountryCode();
    const partyId = getPartyId();
    const client = createOcpiClient(token, partner);
    // PUT replaces the Session in the eMSP system (9.2.2.2), charging
    // periods included.
    const response = await client.put(
      `${url}/${countryCode}/${partyId}/${encodeURIComponent(ocpiSession.id)}`,
      ocpiSession,
    );
    assertAccepted(response, `session ${ocpiSession.id}`);
    await logSync(partnerId, 'sessions', 'push_update', 'completed', 1);
  } catch (err) {
    logger.error({ partnerId, err }, 'Failed to push session update');
    await logSync(partnerId, 'sessions', 'push_update', 'failed', 0, errorMessage(err));
    throw err;
  }
}

/** The data of one tariff push job. */
export interface TariffPushJob {
  partnerId: string;
  ocpiTariffId: string;
}

/**
 * Pushes one OCPI tariff id to one partner: the tariff generated from the
 * mapping in effect for the partner (PUT), or a DELETE when no mapping
 * publishes that id to the partner any more (11.2.2.3). A partner that does
 * not know a deleted tariff (2003) counts as done.
 */
async function syncPartnerTariff(job: TariffPushJob): Promise<void> {
  const { partnerId, ocpiTariffId } = job;
  try {
    const target = await partnerTarget(partnerId, 'tariffs');
    if (target == null) return;

    const mapping = (await partnerTariffMappings(partnerId)).find(
      (m) => m.ocpiTariffId === ocpiTariffId,
    );
    const tariff =
      mapping != null
        ? await renderTariffMapping(mapping, resolvePartnerVersion(target.version))
        : null;

    const client = createOcpiClient(target.token, target);
    const url = `${target.url}/${getCountryCode()}/${getPartyId()}/${encodeURIComponent(ocpiTariffId)}`;
    if (tariff != null) {
      assertAccepted(await client.put(url, tariff), `tariff ${ocpiTariffId}`);
      await logSync(partnerId, 'tariffs', 'push_update', 'completed', 1);
    } else {
      const response = await client.delete(url);
      if (response.status_code !== OcpiStatusCode.CLIENT_UNKNOWN_LOCATION) {
        assertAccepted(response, `tariff ${ocpiTariffId} delete`);
      }
      await logSync(partnerId, 'tariffs', 'push_delete', 'completed', 1);
    }
  } catch (err) {
    logger.error({ partnerId, ocpiTariffId, err }, 'Failed to push tariff update');
    await logSync(partnerId, 'tariffs', 'push_update', 'failed', 0, errorMessage(err));
    throw err;
  }
}

/** One push job per (partner, OCPI tariff id) the change touches. */
async function fanOutTariff(sink: PushJobSink, notification: PushNotification): Promise<void> {
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
  // pair is pushed once.
  const connected = targets.some((t) => t.partnerId == null) ? await getConnectedPartnerIds() : [];
  const pairs = new Map<string, TariffPushJob>();
  for (const target of targets) {
    const partnerIds = target.partnerId != null ? [target.partnerId] : connected;
    for (const partnerId of partnerIds) {
      pairs.set(JSON.stringify([partnerId, target.ocpiTariffId]), {
        partnerId,
        ocpiTariffId: target.ocpiTariffId,
      });
    }
  }
  for (const pair of pairs.values()) {
    await sink.add('push-tariff', pair, `pt-${pair.partnerId}-${shortHash(pair.ocpiTariffId)}`);
  }
}

/** The data of one token push job: the changed tokens, for one partner. */
export interface TokenPushJob {
  partnerId: string;
  tokenIds: string[];
  tombstones: Array<{ idToken: string; tokenType: string }>;
}

/**
 * OCPI 12.1.1 push model: the eMSP PUTs each changed Token to every partner
 * that receives Tokens (a CPO with a Tokens RECEIVER endpoint), in the
 * partner's version; a token value that no longer exists goes as valid =
 * false (Tokens cannot be deleted), before the live tokens. Each token is
 * read when the job runs. A failed token makes the job retry; the partner
 * also sees every change on its next pull (last_updated moved).
 */
async function pushTokensToPartner(job: TokenPushJob): Promise<void> {
  const [live, dead] = await Promise.all([
    loadEmspTokens(job.tokenIds),
    loadEmspTombstones(job.tombstones),
  ]);
  // Tombstones first: a value that moved to a new OCPI type reaches the
  // partner invalid under the old type before it is valid under the new one.
  const tokens = [...dead, ...live];
  if (tokens.length === 0) return;
  const partnerId = job.partnerId;
  const target = await partnerTarget(partnerId, 'tokens');
  if (target == null) return;
  const version = resolvePartnerVersion(target.version);
  const client = createOcpiClient(target.token, target);
  let sent = 0;
  let failure: Error | null = null;
  for (const token of tokens) {
    try {
      const body = transformToken(
        { token, countryCode: getCountryCode(), partyId: getPartyId() },
        version,
      );
      const type = encodeURIComponent(ocpiTokenTypeOf(token.tokenType));
      const response = await client.put(
        `${target.url}/${getCountryCode()}/${getPartyId()}/${encodeURIComponent(token.idToken)}?type=${type}`,
        body,
      );
      assertAccepted(response, 'token');
      sent++;
    } catch (err) {
      failure ??= err instanceof Error ? err : new Error(String(err));
    }
  }
  if (failure == null) {
    await logSync(partnerId, 'tokens', 'push_update', 'completed', sent);
    return;
  }
  logger.error({ partnerId, err: failure, sent }, 'Failed to push token update');
  await logSync(partnerId, 'tokens', 'push_update', 'failed', sent, failure.message);
  throw failure;
}

/** One push job per connected partner for a token change. */
async function fanOutToken(sink: PushJobSink, notification: PushNotification): Promise<void> {
  const tokenIds = notification.tokenIds ?? [];
  const tombstones = notification.tombstones ?? [];
  if (tokenIds.length === 0 && tombstones.length === 0) return;
  const payloadHash = shortHash(JSON.stringify([tokenIds, tombstones]));
  for (const partnerId of await getConnectedPartnerIds()) {
    const job: TokenPushJob = { partnerId, tokenIds, tombstones };
    await sink.add('push-token', job, `pk-${partnerId}-${payloadHash}`);
  }
}

export interface PushJobContext {
  sink: PushJobSink;
  /** Runs after a completed session is pushed (schedules its CDR). */
  onSessionCompleted: SessionCompletedHook | null;
}

/** Runs one push job. Throws for a retry; a client error is an UnrecoverableError. */
export async function processPushJob(
  name: PushJobName,
  data: unknown,
  ctx: PushJobContext,
): Promise<void> {
  switch (name) {
    case 'push-fanout': {
      const notification = (data as { notification: PushNotification }).notification;
      if (notification.type === 'location' && notification.siteId != null) {
        await fanOutLocation(
          ctx.sink,
          notification.siteId,
          notification.removed,
          notification.deletedSite,
        );
      } else if (notification.type === 'tariff') {
        await fanOutTariff(ctx.sink, notification);
      } else if (notification.type === 'token') {
        await fanOutToken(ctx.sink, notification);
      }
      return;
    }
    case 'push-location':
      await pushLocationToPartner(data as LocationPushJob);
      return;
    case 'push-session':
      await pushSessionUpdate((data as { sessionId: string }).sessionId, ctx.onSessionCompleted);
      return;
    case 'push-tariff':
      await syncPartnerTariff(data as TariffPushJob);
      return;
    case 'push-token':
      await pushTokensToPartner(data as TokenPushJob);
      return;
  }
}

/** Turns one `ocpi_push` message into its job (every replica adds the same deduplicated job). */
export async function enqueuePushNotification(
  sink: PushJobSink,
  notification: PushNotification,
): Promise<void> {
  switch (notification.type) {
    case 'session':
      if (notification.sessionId != null) {
        await sink.add(
          'push-session',
          { sessionId: notification.sessionId },
          `ps-${notification.sessionId}`,
        );
      }
      return;
    case 'location':
      if (notification.siteId == null) return;
      break;
    case 'tariff':
    case 'token':
      break;
    case 'cdr':
      // CDRs are issued and pushed by the ocpi-cdrs queue (cdr-jobs.ts). The
      // API asks for a reissue or a push retry here; the database already
      // holds the request, so the sweep catches a lost message.
      if (notification.sessionId != null && (notification.generation ?? 0) > 0) {
        await sink.scheduleCdr(notification.sessionId, notification.generation ?? 0);
      } else if (notification.cdrId != null) {
        await sink.pushStoredCdr(notification.cdrId, notification.retry);
      }
      return;
    default:
      return;
  }
  await sink.add(
    'push-fanout',
    { notification },
    `pf-${notification.type}-${shortHash(JSON.stringify(notification))}`,
  );
}

async function handlePushNotification(raw: string, sink: PushJobSink): Promise<void> {
  const parsed = tryParseJson(raw);
  if (parsed == null || typeof parsed !== 'object') {
    logger.error({ raw }, 'Invalid push notification payload');
    return;
  }
  const notification = parsed as PushNotification;
  // Every replica gets the message: each clears its own setting caches, so
  // whichever replica runs a tariff job renders the new currency, tax basis
  // or idle grace.
  if (notification.type === 'tariff' && notification.settingsChanged === true) {
    clearSystemSettingsCache();
    clearIdlingSettingCache();
  }
  await enqueuePushNotification(sink, notification);
}

export class OcpiPushListener {
  private readonly pubsub: PubSubClient;
  private subscription: Subscription | null = null;
  private readonly inFlight = createInFlightTracker();
  private readonly sink: PushJobSink;

  /** `sink` adds the push jobs (the OCPI server passes its queue, `cdr-jobs.ts`). */
  constructor(pubsub: PubSubClient, sink: PushJobSink) {
    this.pubsub = pubsub;
    this.sink = sink;
  }

  async start(): Promise<void> {
    this.subscription = await this.pubsub.subscribe(CHANNEL, (payload: string) => {
      trackListenerWork(this.inFlight, logger, () => handlePushNotification(payload, this.sink));
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
