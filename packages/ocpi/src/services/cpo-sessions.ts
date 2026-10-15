// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Our sessions as CPO: charging sessions at our stations started with a
// partner's token. The OCPP projection links each one to the partner in
// `ocpi_roaming_sessions` (charging_session_id set) when it starts. The OCPI
// Session object is rendered from the charging session on every GET and push,
// so it always carries the current energy, times, and cost.
//
// Rows without a charging session are partners' sessions we received as eMSP;
// they are never served on the CPO Sessions interface.

import { and, asc, count, desc, eq, gte, isNotNull, lt } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  connectors,
  evses,
  ocpiCommands,
  ocpiExternalTokens,
  ocpiLocationPublish,
  ocpiPartners,
  ocpiRoamingSessions,
  sites,
  inOperatorStation,
} from '@evtivity/database';
import { config } from '../lib/config.js';
import { priceExclTax } from '../lib/ocpi-price.js';
import { ocpiEvseId, ocpiEvseUid } from '../lib/evse-uid.js';
import type { CdrTokenSource } from '../lib/charging-periods.js';
import { transformSession } from '../transformers/session.transformer.js';
import { idleMinutesAt, ocpiSessionCost } from './session-cost-split.js';
import type { OcpiSession, OcpiVersion } from '../types/ocpi.js';

export type ChargingSessionRow = typeof chargingSessions.$inferSelect;

/** Where a session took place, as OCPI identifies it. */
export interface SessionPlace {
  siteId: string | null;
  site: typeof sites.$inferSelect | null;
  /** The published OCPI location id (`ocpi_location_publish`), else the site id. */
  locationId: string;
  evseUid: string;
  evseId: string;
  connectorId: string;
  connectorType: string | null;
}

export async function sessionPlace(session: ChargingSessionRow): Promise<SessionPlace | null> {
  const [station] = await db
    .select({
      id: chargingStations.id,
      stationId: chargingStations.stationId,
      siteId: chargingStations.siteId,
    })
    .from(chargingStations)
    .where(eq(chargingStations.id, session.stationId))
    .limit(1);
  if (station == null) return null;

  // The site the session happened at (charging_sessions.site_id, stamped at
  // insert), so a station moved to another site later keeps its past
  // sessions and CDRs at the old location. Sessions without a stamp fall
  // back to the station's current site.
  const siteId = session.siteId ?? station.siteId;
  const [site] =
    siteId != null ? await db.select().from(sites).where(eq(sites.id, siteId)).limit(1) : [];
  const [publish] =
    siteId != null
      ? await db
          .select({ ocpiLocationId: ocpiLocationPublish.ocpiLocationId })
          .from(ocpiLocationPublish)
          .where(eq(ocpiLocationPublish.siteId, siteId))
          .limit(1)
      : [];

  let evseUid = 'unknown';
  let evseId = 'unknown';
  if (session.evseId != null) {
    const [evse] = await db.select().from(evses).where(eq(evses.id, session.evseId)).limit(1);
    if (evse != null) {
      evseUid = ocpiEvseUid(evse);
      evseId = ocpiEvseId(station.stationId, evse.evseId);
    }
  }

  let connectorId = '1';
  let connectorType: string | null = null;
  if (session.connectorId != null) {
    const [connector] = await db
      .select({ connectorId: connectors.connectorId, connectorType: connectors.connectorType })
      .from(connectors)
      .where(eq(connectors.id, session.connectorId))
      .limit(1);
    if (connector != null) {
      connectorId = String(connector.connectorId);
      connectorType = connector.connectorType;
    }
  }

  return {
    siteId,
    site: site ?? null,
    locationId: publish?.ocpiLocationId ?? siteId ?? station.id,
    evseUid,
    evseId,
    connectorId,
    connectorType,
  };
}

/**
 * The partner's token, with its type and contract id when the partner sent
 * them: the token the partner pushed, else the Token object of its
 * START_SESSION (owner decision: accepted without a push), else the uid under
 * the partner's own country code and party id (a token is the eMSP's).
 */
export async function partnerToken(partnerId: string, uid: string): Promise<CdrTokenSource> {
  const [token] = await db
    .select({
      uid: ocpiExternalTokens.uid,
      countryCode: ocpiExternalTokens.countryCode,
      partyId: ocpiExternalTokens.partyId,
      tokenType: ocpiExternalTokens.tokenType,
      tokenData: ocpiExternalTokens.tokenData,
    })
    .from(ocpiExternalTokens)
    .where(and(eq(ocpiExternalTokens.partnerId, partnerId), eq(ocpiExternalTokens.uid, uid)))
    .orderBy(desc(ocpiExternalTokens.updatedAt))
    .limit(1);
  if (token != null) {
    const contractId = (token.tokenData as { contract_id?: unknown } | null)?.contract_id;
    return {
      uid: token.uid,
      countryCode: token.countryCode,
      partyId: token.partyId,
      tokenType: token.tokenType,
      contractId: typeof contractId === 'string' ? contractId : null,
    };
  }

  const [command] = await db
    .select({ tokenData: ocpiCommands.tokenData })
    .from(ocpiCommands)
    .where(
      and(
        eq(ocpiCommands.partnerId, partnerId),
        eq(ocpiCommands.commandType, 'START_SESSION'),
        eq(ocpiCommands.tokenUid, uid),
        isNotNull(ocpiCommands.tokenData),
      ),
    )
    .orderBy(desc(ocpiCommands.createdAt))
    .limit(1);
  const embedded = command?.tokenData as Record<string, unknown> | null | undefined;
  if (embedded != null) {
    const str = (key: string): string | null =>
      typeof embedded[key] === 'string' ? embedded[key] : null;
    return {
      uid,
      countryCode: str('country_code') ?? '',
      partyId: str('party_id') ?? '',
      tokenType: str('type'),
      contractId: str('contract_id'),
    };
  }

  const [partner] = await db
    .select({ countryCode: ocpiPartners.countryCode, partyId: ocpiPartners.partyId })
    .from(ocpiPartners)
    .where(eq(ocpiPartners.id, partnerId))
    .limit(1);
  return { uid, countryCode: partner?.countryCode ?? '', partyId: partner?.partyId ?? '' };
}

export interface CpoSessionLink {
  id: number;
  partnerId: string;
  /** The OCPI Session id shared with the partner. */
  ocpiSessionId: string;
  chargingSessionId: string;
  tokenUid: string;
  /** OCPI AuthMethod stored at session start (null on links written before). */
  authMethod: string | null;
  authorizationReference: string | null;
}

/** A linked charging session as the OCPI Session of a version. */
export async function renderCpoSession(
  link: CpoSessionLink,
  session: ChargingSessionRow,
  version: OcpiVersion,
  now: Date = new Date(),
): Promise<OcpiSession | null> {
  const place = await sessionPlace(session);
  if (place == null) return null;
  return transformSession(
    {
      session,
      ocpiSessionId: link.ocpiSessionId,
      cost: ocpiSessionCost(session),
      idleMinutes: idleMinutesAt(session, session.endedAt ?? now),
      now,
      countryCode: config.OCPI_COUNTRY_CODE,
      partyId: config.OCPI_PARTY_ID,
      locationId: place.locationId,
      evseUid: place.evseUid,
      connectorId: place.connectorId,
      token: await partnerToken(link.partnerId, link.tokenUid),
      authMethod: link.authMethod,
      authorizationReference: link.authorizationReference,
    },
    version,
  );
}

/**
 * Keeps the link row's summary columns (shown on the CSMS Roaming Sessions
 * page) in step with the rendered Session. total_cost holds the amount
 * excluding tax, as for the sessions received from partners.
 */
export async function syncCpoSessionRow(
  link: CpoSessionLink,
  ocpi: OcpiSession,
  version: OcpiVersion,
): Promise<void> {
  const net = priceExclTax(ocpi.total_cost, version);
  await db
    .update(ocpiRoamingSessions)
    .set({
      status: ocpi.status,
      kwh: String(ocpi.kwh),
      totalCost: net != null ? String(net) : null,
      currency: ocpi.currency,
      sessionData: ocpi,
      updatedAt: new Date(),
    })
    .where(eq(ocpiRoamingSessions.id, link.id));
}

const linkColumns = {
  id: ocpiRoamingSessions.id,
  partnerId: ocpiRoamingSessions.partnerId,
  ocpiSessionId: ocpiRoamingSessions.ocpiSessionId,
  chargingSessionId: ocpiRoamingSessions.chargingSessionId,
  tokenUid: ocpiRoamingSessions.tokenUid,
  authMethod: ocpiRoamingSessions.authMethod,
  authorizationReference: ocpiRoamingSessions.authorizationReference,
};

/**
 * The CPO session link of a charging session, if a partner's token started
 * it. A session at a conformance test station has none: it is never pushed to
 * a partner and never gets a CDR.
 */
export async function cpoSessionLink(chargingSessionId: string): Promise<CpoSessionLink | null> {
  const [row] = await db
    .select(linkColumns)
    .from(ocpiRoamingSessions)
    .innerJoin(chargingSessions, eq(chargingSessions.id, ocpiRoamingSessions.chargingSessionId))
    .where(
      and(
        eq(ocpiRoamingSessions.chargingSessionId, chargingSessionId),
        inOperatorStation(chargingSessions.stationId),
      ),
    )
    .limit(1);
  if (row?.chargingSessionId == null) return null;
  return { ...row, chargingSessionId: row.chargingSessionId };
}

/**
 * A page of a partner's CPO sessions in a stable order (link created_at, id:
 * a session that changes while a partner pages does not move to another
 * page), filtered on the
 * session's last_updated (`charging_sessions.updated_at`): date_from
 * inclusive, date_to exclusive (§9.2.1.1).
 */
export async function listPartnerCpoSessions(
  partnerId: string,
  version: OcpiVersion,
  page: { offset: number; limit: number; dateFrom?: Date; dateTo?: Date },
): Promise<{ total: number; sessions: OcpiSession[] }> {
  const conditions = [
    eq(ocpiRoamingSessions.partnerId, partnerId),
    isNotNull(ocpiRoamingSessions.chargingSessionId),
    inOperatorStation(chargingSessions.stationId),
  ];
  if (page.dateFrom != null) conditions.push(gte(chargingSessions.updatedAt, page.dateFrom));
  if (page.dateTo != null) conditions.push(lt(chargingSessions.updatedAt, page.dateTo));
  const where = and(...conditions);

  const [rows, countRows] = await Promise.all([
    db
      .select({ link: linkColumns, session: chargingSessions })
      .from(ocpiRoamingSessions)
      .innerJoin(chargingSessions, eq(chargingSessions.id, ocpiRoamingSessions.chargingSessionId))
      .where(where)
      .orderBy(asc(ocpiRoamingSessions.createdAt), asc(ocpiRoamingSessions.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ count: count() })
      .from(ocpiRoamingSessions)
      .innerJoin(chargingSessions, eq(chargingSessions.id, ocpiRoamingSessions.chargingSessionId))
      .where(where),
  ]);

  const now = new Date();
  const rendered = await Promise.all(
    rows.map(({ link, session }) =>
      renderCpoSession({ ...link, chargingSessionId: session.id }, session, version, now),
    ),
  );
  return {
    total: countRows[0]?.count ?? 0,
    sessions: rendered.filter((s): s is OcpiSession => s != null),
  };
}
