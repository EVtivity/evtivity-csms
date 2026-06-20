// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import {
  db,
  ocpiPartners,
  ocpiPartnerEndpoints,
  ocpiExternalLocations,
  ocpiExternalTariffs,
  ocpiCdrs,
  ocpiSyncLog,
} from '@evtivity/database';
import { createLogger, withLock } from '@evtivity/lib';
import type { PubSubClient, Subscription } from '@evtivity/lib';
import { OcpiClient } from '../lib/ocpi-client.js';
import { getOutboundToken } from '../lib/outbound-token.js';
import { config } from '../lib/config.js';
import type { OcpiLocation, OcpiTariff, OcpiCdr } from '../types/ocpi.js';

const logger = createLogger('ocpi-pull');
const CHANNEL = 'ocpi_sync';

// Flush upserts in batches instead of one round-trip per row, so a large
// partner catalog lands in O(rows / CHUNK) statements rather than O(rows).
const UPSERT_CHUNK = 500;

interface SyncNotification {
  partnerId: string;
  module: string;
}

interface SyncResult {
  module: string;
  objectsCount: number;
  status: 'completed' | 'failed';
  errorMessage?: string;
}

function getCountryCode(): string {
  return config.OCPI_COUNTRY_CODE;
}

function getPartyId(): string {
  return config.OCPI_PARTY_ID;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function getPartnerInfo(
  partnerId: string,
): Promise<{ countryCode: string; partyId: string } | null> {
  const [partner] = await db
    .select({ countryCode: ocpiPartners.countryCode, partyId: ocpiPartners.partyId })
    .from(ocpiPartners)
    .where(eq(ocpiPartners.id, partnerId))
    .limit(1);
  return partner ?? null;
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
    direction: 'pull',
    action,
    status,
    objectsCount: String(objectsCount),
  };
  if (errorMessage != null) {
    values.errorMessage = errorMessage;
  }
  await db.insert(ocpiSyncLog).values(values);
}

// Per-partner+module distributed lock so overlapping triggers (a manual sync
// racing the twice-daily cron, or a duplicate publish reaching more than one
// OCPI replica) run the pull once instead of concurrently upserting the same
// rows. Try-once: a second trigger while a pull is in flight is skipped, not
// queued. Without a Redis client (e.g. unit tests) the inner pull runs directly.
async function runLocked(
  lockRedis: Redis | undefined,
  partnerId: string,
  module: string,
  inner: () => Promise<SyncResult>,
): Promise<SyncResult> {
  if (lockRedis == null) {
    return inner();
  }
  const { acquired, result } = await withLock(lockRedis, `opl:${partnerId}:${module}`, inner, {
    acquireTimeoutMs: 0,
    ttlMs: 10 * 60_000,
    renewMs: 60_000,
  });
  if (!acquired || result == null) {
    logger.info({ partnerId, module }, 'OCPI pull already in progress; skipping duplicate');
    return { module, objectsCount: 0, status: 'completed' };
  }
  return result;
}

interface LocationValues {
  partnerId: string;
  countryCode: string;
  partyId: string;
  locationId: string;
  name: string | null;
  latitude: string;
  longitude: string;
  evseCount: string;
  locationData: OcpiLocation;
}

async function upsertLocationBatch(rows: LocationValues[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(ocpiExternalLocations)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        ocpiExternalLocations.partnerId,
        ocpiExternalLocations.countryCode,
        ocpiExternalLocations.partyId,
        ocpiExternalLocations.locationId,
      ],
      set: {
        name: sql`excluded.name`,
        latitude: sql`excluded.latitude`,
        longitude: sql`excluded.longitude`,
        evseCount: sql`excluded.evse_count`,
        locationData: sql`excluded.location_data`,
        updatedAt: sql`now()`,
      },
    });
}

async function pullLocationsInner(partnerId: string): Promise<SyncResult> {
  logger.info({ partnerId }, 'Pulling locations from partner');
  await logSync(partnerId, 'locations', 'pull_full', 'started', 0);

  try {
    // Endpoint URL, outbound token, and partner identity are independent
    // lookups - fetch in parallel to collapse three sequential RTTs into one
    // before the long-running paginated pull starts.
    const [url, token, partner] = await Promise.all([
      getPartnerEndpoint(partnerId, 'locations', 'SENDER'),
      getPartnerToken(partnerId),
      getPartnerInfo(partnerId),
    ]);
    if (url == null) {
      throw new Error('Partner has no locations SENDER endpoint');
    }
    if (token == null) {
      throw new Error('No outbound token for partner');
    }
    if (partner == null) {
      throw new Error('Partner not found');
    }

    const client = createOcpiClient(token, partner.countryCode, partner.partyId);

    // Stream page-by-page and flush each page as batched upserts so memory is
    // bounded by one page, not the whole catalog.
    let count = 0;
    let skipped = 0;
    await client.getPaginatedEach(url, async (page) => {
      const valid: LocationValues[] = [];
      for (const item of page) {
        // Defensive validation: a malformed partner payload missing required
        // fields would otherwise crash the whole pull. Skip and log each bad
        // row so the rest of the page still lands.
        if (item == null || typeof item !== 'object') {
          skipped++;
          continue;
        }
        const candidate = item as Record<string, unknown>;
        const coords = candidate['coordinates'] as
          | { latitude?: unknown; longitude?: unknown }
          | undefined;
        if (
          typeof candidate['id'] !== 'string' ||
          typeof candidate['country_code'] !== 'string' ||
          typeof candidate['party_id'] !== 'string' ||
          coords == null ||
          typeof coords !== 'object' ||
          coords.latitude == null ||
          coords.longitude == null
        ) {
          logger.warn(
            { partnerId, locationId: candidate['id'] },
            'Skipping malformed Location from partner pull',
          );
          skipped++;
          continue;
        }
        const location = candidate as unknown as OcpiLocation;
        valid.push({
          partnerId,
          countryCode: location.country_code,
          partyId: location.party_id,
          locationId: location.id,
          name: location.name ?? null,
          latitude: location.coordinates.latitude,
          longitude: location.coordinates.longitude,
          evseCount: String(Array.isArray(location.evses) ? location.evses.length : 0),
          locationData: location,
        });
      }
      for (const batch of chunk(valid, UPSERT_CHUNK)) {
        await upsertLocationBatch(batch);
        count += batch.length;
      }
    });

    if (skipped > 0) {
      logger.warn({ partnerId, skipped }, 'Some locations were skipped due to malformed data');
    }
    await logSync(partnerId, 'locations', 'pull_full', 'completed', count);
    return { module: 'locations', objectsCount: count, status: 'completed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pull failed';
    logger.error({ partnerId, err }, 'Failed to pull locations');
    await logSync(partnerId, 'locations', 'pull_full', 'failed', 0, message);
    return { module: 'locations', objectsCount: 0, status: 'failed', errorMessage: message };
  }
}

export async function pullLocations(partnerId: string, lockRedis?: Redis): Promise<SyncResult> {
  return runLocked(lockRedis, partnerId, 'locations', () => pullLocationsInner(partnerId));
}

interface TariffValues {
  partnerId: string;
  countryCode: string;
  partyId: string;
  tariffId: string;
  currency: string;
  tariffData: OcpiTariff;
}

async function upsertTariffBatch(rows: TariffValues[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(ocpiExternalTariffs)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        ocpiExternalTariffs.partnerId,
        ocpiExternalTariffs.countryCode,
        ocpiExternalTariffs.partyId,
        ocpiExternalTariffs.tariffId,
      ],
      set: {
        currency: sql`excluded.currency`,
        tariffData: sql`excluded.tariff_data`,
        updatedAt: sql`now()`,
      },
    });
}

async function pullTariffsInner(partnerId: string): Promise<SyncResult> {
  logger.info({ partnerId }, 'Pulling tariffs from partner');
  await logSync(partnerId, 'tariffs', 'pull_full', 'started', 0);

  try {
    const [url, token, partner] = await Promise.all([
      getPartnerEndpoint(partnerId, 'tariffs', 'SENDER'),
      getPartnerToken(partnerId),
      getPartnerInfo(partnerId),
    ]);
    if (url == null) {
      throw new Error('Partner has no tariffs SENDER endpoint');
    }
    if (token == null) {
      throw new Error('No outbound token for partner');
    }
    if (partner == null) {
      throw new Error('Partner not found');
    }

    const client = createOcpiClient(token, partner.countryCode, partner.partyId);

    let count = 0;
    let skipped = 0;
    await client.getPaginatedEach(url, async (page) => {
      const valid: TariffValues[] = [];
      for (const item of page) {
        if (item == null || typeof item !== 'object') {
          skipped++;
          continue;
        }
        const candidate = item as Record<string, unknown>;
        if (
          typeof candidate['id'] !== 'string' ||
          typeof candidate['country_code'] !== 'string' ||
          typeof candidate['party_id'] !== 'string' ||
          typeof candidate['currency'] !== 'string'
        ) {
          logger.warn(
            { partnerId, tariffId: candidate['id'] },
            'Skipping malformed Tariff from partner pull',
          );
          skipped++;
          continue;
        }
        const tariff = candidate as unknown as OcpiTariff;
        valid.push({
          partnerId,
          countryCode: tariff.country_code,
          partyId: tariff.party_id,
          tariffId: tariff.id,
          currency: tariff.currency,
          tariffData: tariff,
        });
      }
      for (const batch of chunk(valid, UPSERT_CHUNK)) {
        await upsertTariffBatch(batch);
        count += batch.length;
      }
    });

    if (skipped > 0) {
      logger.warn({ partnerId, skipped }, 'Some tariffs were skipped due to malformed data');
    }
    await logSync(partnerId, 'tariffs', 'pull_full', 'completed', count);
    return { module: 'tariffs', objectsCount: count, status: 'completed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pull failed';
    logger.error({ partnerId, err }, 'Failed to pull tariffs');
    await logSync(partnerId, 'tariffs', 'pull_full', 'failed', 0, message);
    return { module: 'tariffs', objectsCount: 0, status: 'failed', errorMessage: message };
  }
}

export async function pullTariffs(partnerId: string, lockRedis?: Redis): Promise<SyncResult> {
  return runLocked(lockRedis, partnerId, 'tariffs', () => pullTariffsInner(partnerId));
}

interface CdrValues {
  partnerId: string;
  ocpiCdrId: string;
  totalEnergy: string;
  totalCost: string;
  currency: string;
  cdrData: OcpiCdr;
  isCredit: boolean;
  pushStatus: 'confirmed';
}

async function pullCdrsInner(partnerId: string): Promise<SyncResult> {
  logger.info({ partnerId }, 'Pulling CDRs from partner');
  await logSync(partnerId, 'cdrs', 'pull_full', 'started', 0);

  try {
    const [url, token, partner] = await Promise.all([
      getPartnerEndpoint(partnerId, 'cdrs', 'SENDER'),
      getPartnerToken(partnerId),
      getPartnerInfo(partnerId),
    ]);
    if (url == null) {
      throw new Error('Partner has no cdrs SENDER endpoint');
    }
    if (token == null) {
      throw new Error('No outbound token for partner');
    }
    if (partner == null) {
      throw new Error('Partner not found');
    }

    const client = createOcpiClient(token, partner.countryCode, partner.partyId);

    let count = 0;
    let skipped = 0;
    await client.getPaginatedEach(url, async (page) => {
      const valid: CdrValues[] = [];
      const pageIds: string[] = [];
      for (const item of page) {
        if (item == null || typeof item !== 'object') {
          skipped++;
          continue;
        }
        const candidate = item as Record<string, unknown>;
        if (
          typeof candidate['id'] !== 'string' ||
          typeof candidate['total_energy'] !== 'number' ||
          typeof candidate['currency'] !== 'string'
        ) {
          logger.warn(
            { partnerId, cdrId: candidate['id'] },
            'Skipping malformed CDR from partner pull',
          );
          skipped++;
          continue;
        }
        const cdr = candidate as unknown as OcpiCdr;
        const totalCost =
          typeof cdr.total_cost === 'object' ? String(cdr.total_cost.excl_vat) : '0';
        pageIds.push(cdr.id);
        valid.push({
          partnerId,
          ocpiCdrId: cdr.id,
          totalEnergy: String(cdr.total_energy),
          totalCost,
          currency: cdr.currency,
          cdrData: cdr,
          isCredit: cdr.credit === true,
          pushStatus: 'confirmed',
        });
      }

      // CDRs are immutable: skip ids already stored. Scope the existence check
      // to this page's ids so memory stays bounded on a large history pull.
      const existing = new Set<string>();
      if (pageIds.length > 0) {
        const rows = await db
          .select({ ocpiCdrId: ocpiCdrs.ocpiCdrId })
          .from(ocpiCdrs)
          .where(and(eq(ocpiCdrs.partnerId, partnerId), inArray(ocpiCdrs.ocpiCdrId, pageIds)));
        for (const r of rows) existing.add(r.ocpiCdrId);
      }
      const fresh = valid.filter((c) => !existing.has(c.ocpiCdrId));
      for (const batch of chunk(fresh, UPSERT_CHUNK)) {
        await db.insert(ocpiCdrs).values(batch);
        count += batch.length;
      }
    });

    if (skipped > 0) {
      logger.warn({ partnerId, skipped }, 'Some CDRs were skipped due to malformed data');
    }
    await logSync(partnerId, 'cdrs', 'pull_full', 'completed', count);
    return { module: 'cdrs', objectsCount: count, status: 'completed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pull failed';
    logger.error({ partnerId, err }, 'Failed to pull CDRs');
    await logSync(partnerId, 'cdrs', 'pull_full', 'failed', 0, message);
    return { module: 'cdrs', objectsCount: 0, status: 'failed', errorMessage: message };
  }
}

export async function pullCdrs(partnerId: string, lockRedis?: Redis): Promise<SyncResult> {
  return runLocked(lockRedis, partnerId, 'cdrs', () => pullCdrsInner(partnerId));
}

async function handleSyncNotification(raw: string, lockRedis: Redis | undefined): Promise<void> {
  let notification: SyncNotification;
  try {
    notification = JSON.parse(raw) as SyncNotification;
  } catch {
    logger.error({ raw }, 'Invalid sync notification payload');
    return;
  }

  const { partnerId, module } = notification;
  logger.info({ partnerId, module }, 'Processing sync request');

  switch (module) {
    case 'locations':
      await pullLocations(partnerId, lockRedis);
      break;
    case 'tariffs':
      await pullTariffs(partnerId, lockRedis);
      break;
    case 'cdrs':
      await pullCdrs(partnerId, lockRedis);
      break;
    default:
      logger.warn({ module }, 'Unknown sync module');
  }
}

export class OcpiPullListener {
  private readonly pubsub: PubSubClient;
  private readonly lockRedis: Redis | undefined;
  private subscription: Subscription | null = null;

  constructor(pubsub: PubSubClient, lockRedis?: Redis) {
    this.pubsub = pubsub;
    this.lockRedis = lockRedis;
  }

  async start(): Promise<void> {
    this.subscription = await this.pubsub.subscribe(CHANNEL, (payload: string) => {
      void handleSyncNotification(payload, this.lockRedis);
    });
    logger.info({ channel: CHANNEL }, 'Listening for OCPI sync notifications');
  }

  async stop(): Promise<void> {
    if (this.subscription != null) {
      await this.subscription.unsubscribe();
      this.subscription = null;
    }
    logger.info('OCPI pull listener stopped');
  }
}
