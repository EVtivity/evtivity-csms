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
import { OcpiStatusCode } from '../lib/ocpi-response.js';
import { config } from '../lib/config.js';
import { transformCdr } from '../transformers/cdr.transformer.js';
import { resolvePartnerVersion } from '../lib/ocpi-version.js';
import { notifyRoamingCdrChanged } from '../lib/pubsub.js';
import { taxTotals } from '@evtivity/lib/price-display';
import { idleMinutesAt, ocpiCdrCost } from './session-cost-split.js';
import { cpoSessionLink, partnerToken, sessionPlace } from './cpo-sessions.js';
import type { CpoSessionLink } from './cpo-sessions.js';
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

type ChargingSessionRow = typeof chargingSessions.$inferSelect;

/** A CDR built for a session, and the `ocpi_cdrs` row that stores it. */
export interface BuiltCdr {
  cdr: OcpiCdr;
  row: typeof ocpiCdrs.$inferInsert;
}

/**
 * Builds the OCPI CDR of a completed session for the partner whose token
 * started it. Null when the session has no start or end, or its place (site,
 * EVSE) is gone.
 *
 * Pricing model: roaming sessions ALWAYS use OUR tariff (the tariff resolved
 * at the station as if a local driver had charged there) and OUR currency.
 * The session cost is computed by the standard payment-gate / event-projection
 * pipeline; the only difference for `is_roaming = true` sessions is that the
 * payment gate skips the pre-auth, because the eMSP partner pays us via this
 * CDR and then bills its own driver however it wants. The CDR embeds the
 * published tariff that covers the session's tariff for this partner,
 * generated from the internal tariff like GET /cpo/tariffs.
 */
export async function buildSessionCdr(
  session: ChargingSessionRow,
  link: CpoSessionLink,
): Promise<BuiltCdr | null> {
  if (session.startedAt == null || session.endedAt == null) return null;
  const { partnerId } = link;

  const place = await sessionPlace(session);
  if (place == null) return null;
  const site = place.site;

  const currency = session.currency.toUpperCase();
  // The partner's token from the CPO session link written at session start.
  const token = await partnerToken(link.partnerId, link.tokenUid);

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
      // The Session id the partner knows, stored on the link.
      ocpiSessionId: link.ocpiSessionId,
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
  return {
    cdr,
    row: {
      partnerId,
      ocpiCdrId: cdrId,
      chargingSessionId: session.id,
      totalEnergy: String(cdr.total_energy),
      // ocpi_cdrs.total_cost holds the amount excluding tax, like the CDRs
      // received from partners (excl_vat in 2.2.1, before_taxes in 2.3.0).
      totalCost: String(taxTotals(cost.total).netCents / 100),
      currency: cdr.currency,
      cdrData: cdr,
      isCredit: false,
      pushStatus: 'pending',
    },
  };
}

export type IssueCdrResult =
  | { status: 'created' | 'existing'; cdrId: string }
  | { status: 'not_found' | 'not_billable' | 'not_roaming' | 'not_renderable' };

async function existingSessionCdrId(
  executor: Pick<typeof db, 'select'>,
  chargingSessionId: string,
): Promise<string | null> {
  const [row] = await executor
    .select({ ocpiCdrId: ocpiCdrs.ocpiCdrId })
    .from(ocpiCdrs)
    .where(and(eq(ocpiCdrs.chargingSessionId, chargingSessionId), eq(ocpiCdrs.isCredit, false)))
    .limit(1);
  return row?.ocpiCdrId ?? null;
}

/**
 * Issues the CDR of one of our CPO sessions: the only writer of our session
 * CDRs. One CDR per session (OCPI 10.1: a sent CDR is never replaced, only
 * credited): a second call returns the CDR already stored. The session's
 * `ocpi_roaming_sessions` row is locked while the CDR is stored, so two runs
 * (a retried job, two replicas) cannot both insert.
 *
 * Only `completed` sessions are billed. `faulted`, `failed`, and `invalid`
 * sessions are OCPI INVALID ("declared invalid and will not be billed") and
 * get no CDR; the status is read here, not trusted from the trigger.
 */
export async function issueSessionCdr(chargingSessionId: string): Promise<IssueCdrResult> {
  const [session] = await db
    .select()
    .from(chargingSessions)
    .where(eq(chargingSessions.id, chargingSessionId))
    .limit(1);
  if (session == null) return { status: 'not_found' };
  if (session.status !== 'completed' || session.startedAt == null || session.endedAt == null) {
    return { status: 'not_billable' };
  }

  const link = await cpoSessionLink(chargingSessionId);
  if (link == null) return { status: 'not_roaming' };

  const existing = await existingSessionCdrId(db, chargingSessionId);
  if (existing != null) return { status: 'existing', cdrId: existing };

  const built = await buildSessionCdr(session, link);
  if (built == null) {
    logger.warn({ chargingSessionId }, 'CDR not generated: session place not found');
    return { status: 'not_renderable' };
  }

  const result = await db.transaction(async (tx): Promise<IssueCdrResult> => {
    await tx
      .select({ id: ocpiRoamingSessions.id })
      .from(ocpiRoamingSessions)
      .where(eq(ocpiRoamingSessions.id, link.id))
      .for('update');
    const stored = await existingSessionCdrId(tx, chargingSessionId);
    if (stored != null) return { status: 'existing', cdrId: stored };
    await tx.insert(ocpiCdrs).values(built.row);
    return { status: 'created', cdrId: built.cdr.id };
  });

  if (result.status === 'created') {
    // Tell the CSMS so the Roaming CDRs page reloads itself.
    notifyRoamingCdrChanged();
    logger.info({ cdrId: result.cdrId, chargingSessionId }, 'CDR generated');
  }
  return result;
}

/**
 * sent: POSTed now; already_sent: sent before, not repeated; no_receiver: the
 * partner has no CDRs receiver or no token, so it stays pending for the
 * partner's pull; failed: the POST failed (retry); not_found.
 */
export type PushCdrResult = 'sent' | 'already_sent' | 'no_receiver' | 'failed' | 'not_found';

export async function pushCdr(cdrId: string): Promise<PushCdrResult> {
  const [cdr] = await db.select().from(ocpiCdrs).where(eq(ocpiCdrs.ocpiCdrId, cdrId)).limit(1);

  if (cdr == null) return 'not_found';
  if (cdr.pushStatus === 'sent') return 'already_sent';

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
      return 'no_receiver';
    }

    const token = await getOutboundToken(partnerId);
    if (token == null) {
      logger.warn({ partnerId, cdrId }, 'No outbound token for partner, cannot push CDR');
      return 'no_receiver';
    }

    const [partner] = await db
      .select({
        countryCode: ocpiPartners.countryCode,
        partyId: ocpiPartners.partyId,
        allowPrivateNetwork: ocpiPartners.allowPrivateNetwork,
      })
      .from(ocpiPartners)
      .where(eq(ocpiPartners.id, partnerId))
      .limit(1);

    if (partner == null) return 'not_found';

    const client = new OcpiClient({
      token,
      fromCountryCode: getCountryCode(),
      fromPartyId: getPartyId(),
      toCountryCode: partner.countryCode,
      toPartyId: partner.partyId,
      allowPrivateNetwork: partner.allowPrivateNetwork,
    });

    // The same stored CDR (same id) on every attempt, so a retry after a
    // lost response cannot create a second CDR at the partner.
    const cdrData = cdr.cdrData as OcpiCdr;
    const response = await client.post(endpoint.url, cdrData);
    if (response.status_code !== OcpiStatusCode.SUCCESS) {
      throw new Error(
        `Partner rejected CDR: ${String(response.status_code)} ${response.status_message}`,
      );
    }
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

    return 'sent';
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

    return 'failed';
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
