// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, inArray } from 'drizzle-orm';
import {
  db,
  ocpiPartners,
  ocpiPartnerEndpoints,
  ocpiExternalLocations,
  ocpiExternalTariffs,
  ocpiCdrs,
  ocpiSyncLog,
} from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import type { PubSubClient, Subscription } from '@evtivity/lib';
import { OcpiClient } from '../lib/ocpi-client.js';
import { getOutboundToken } from '../lib/outbound-token.js';
import { config } from '../lib/config.js';
import type { OcpiLocation, OcpiTariff, OcpiCdr } from '../types/ocpi.js';

const logger = createLogger('ocpi-pull');
const CHANNEL = 'ocpi_sync';

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

export async function pullLocations(partnerId: string): Promise<SyncResult> {
  logger.info({ partnerId }, 'Pulling locations from partner');
  await logSync(partnerId, 'locations', 'pull_full', 'started', 0);

  try {
    // Endpoint URL, outbound token, and partner identity are independent
    // lookups - fetch in parallel to collapse three sequential RTTs into
    // one before the long-running paginated pull starts.
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
    const locations = await client.getPaginated<OcpiLocation>(url);

    // Upsert each location in a single round-trip using the
    // (partner_id, country_code, party_id, location_id) unique constraint
    // instead of doing a separate SELECT+INSERT/UPDATE per row. A 1000-row
    // pull dropped from ~2000 DB round-trips to ~1000.
    let count = 0;
    for (const location of locations) {
      const evseCount = String(Array.isArray(location.evses) ? location.evses.length : 0);
      await db
        .insert(ocpiExternalLocations)
        .values({
          partnerId,
          countryCode: location.country_code,
          partyId: location.party_id,
          locationId: location.id,
          name: location.name,
          latitude: location.coordinates.latitude,
          longitude: location.coordinates.longitude,
          evseCount,
          locationData: location,
        })
        .onConflictDoUpdate({
          target: [
            ocpiExternalLocations.partnerId,
            ocpiExternalLocations.countryCode,
            ocpiExternalLocations.partyId,
            ocpiExternalLocations.locationId,
          ],
          set: {
            name: location.name ?? null,
            latitude: location.coordinates.latitude,
            longitude: location.coordinates.longitude,
            evseCount,
            locationData: location,
            updatedAt: new Date(),
          },
        });
      count++;
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

export async function pullTariffs(partnerId: string): Promise<SyncResult> {
  logger.info({ partnerId }, 'Pulling tariffs from partner');
  await logSync(partnerId, 'tariffs', 'pull_full', 'started', 0);

  try {
    // Parallel lookups: same rationale as pullLocations.
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
    const tariffs = await client.getPaginated<OcpiTariff>(url);

    // Upsert via unique constraint - halves DB round-trips per tariff vs
    // the prior SELECT+INSERT/UPDATE pattern.
    let count = 0;
    for (const tariff of tariffs) {
      await db
        .insert(ocpiExternalTariffs)
        .values({
          partnerId,
          countryCode: tariff.country_code,
          partyId: tariff.party_id,
          tariffId: tariff.id,
          currency: tariff.currency,
          tariffData: tariff,
        })
        .onConflictDoUpdate({
          target: [
            ocpiExternalTariffs.partnerId,
            ocpiExternalTariffs.countryCode,
            ocpiExternalTariffs.partyId,
            ocpiExternalTariffs.tariffId,
          ],
          set: {
            currency: tariff.currency,
            tariffData: tariff,
            updatedAt: new Date(),
          },
        });
      count++;
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

export async function pullCdrs(partnerId: string): Promise<SyncResult> {
  logger.info({ partnerId }, 'Pulling CDRs from partner');
  await logSync(partnerId, 'cdrs', 'pull_full', 'started', 0);

  try {
    // Parallel lookups: same rationale as pullLocations.
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
    const cdrs = await client.getPaginated<OcpiCdr>(url);

    // Batch the existence check: one IN query instead of one per-CDR SELECT.
    // CDRs are immutable, so skipping already-present rows in memory is
    // exact. At 1000 pulled CDRs this trades 1000 round-trips for 1.
    const cdrIds = cdrs.map((c) => c.id);
    const existingIds = new Set<string>();
    if (cdrIds.length > 0) {
      const existingRows = await db
        .select({ ocpiCdrId: ocpiCdrs.ocpiCdrId })
        .from(ocpiCdrs)
        .where(and(eq(ocpiCdrs.partnerId, partnerId), inArray(ocpiCdrs.ocpiCdrId, cdrIds)));
      for (const r of existingRows) {
        existingIds.add(r.ocpiCdrId);
      }
    }

    let count = 0;
    for (const cdr of cdrs) {
      if (existingIds.has(cdr.id)) {
        // CDRs are immutable, skip if already exists
        continue;
      }

      const totalCost = typeof cdr.total_cost === 'object' ? String(cdr.total_cost.excl_vat) : '0';

      await db.insert(ocpiCdrs).values({
        partnerId,
        ocpiCdrId: cdr.id,
        totalEnergy: String(cdr.total_energy),
        totalCost,
        currency: cdr.currency,
        cdrData: cdr,
        isCredit: cdr.credit === true,
        pushStatus: 'confirmed',
      });
      count++;
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

async function handleSyncNotification(raw: string): Promise<void> {
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
      await pullLocations(partnerId);
      break;
    case 'tariffs':
      await pullTariffs(partnerId);
      break;
    case 'cdrs':
      await pullCdrs(partnerId);
      break;
    default:
      logger.warn({ module }, 'Unknown sync module');
  }
}

export class OcpiPullListener {
  private readonly pubsub: PubSubClient;
  private subscription: Subscription | null = null;

  constructor(pubsub: PubSubClient) {
    this.pubsub = pubsub;
  }

  async start(): Promise<void> {
    this.subscription = await this.pubsub.subscribe(CHANNEL, (payload: string) => {
      void handleSyncNotification(payload);
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
