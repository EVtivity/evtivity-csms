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

import { and, count, desc, eq, gte, isNotNull, lt } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  connectors,
  evses,
  ocpiExternalTokens,
  ocpiLocationPublish,
  ocpiRoamingSessions,
  sites,
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

  const [site] =
    station.siteId != null
      ? await db.select().from(sites).where(eq(sites.id, station.siteId)).limit(1)
      : [];
  const [publish] =
    station.siteId != null
      ? await db
          .select({ ocpiLocationId: ocpiLocationPublish.ocpiLocationId })
          .from(ocpiLocationPublish)
          .where(eq(ocpiLocationPublish.siteId, station.siteId))
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
    siteId: station.siteId,
    site: site ?? null,
    locationId: publish?.ocpiLocationId ?? station.siteId ?? station.id,
    evseUid,
    evseId,
    connectorId,
    connectorType,
  };
}

/** The partner's token, with its type and contract id when the partner sent them. */
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
  if (token == null) return { uid, countryCode: '', partyId: '' };
  const contractId = (token.tokenData as { contract_id?: unknown } | null)?.contract_id;
  return {
    uid: token.uid,
    countryCode: token.countryCode,
    partyId: token.partyId,
    tokenType: token.tokenType,
    contractId: typeof contractId === 'string' ? contractId : null,
  };
}

export interface CpoSessionLink {
  id: number;
  partnerId: string;
  chargingSessionId: string;
  tokenUid: string;
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
      cost: ocpiSessionCost(session),
      idleMinutes: idleMinutesAt(session, session.endedAt ?? now),
      now,
      countryCode: config.OCPI_COUNTRY_CODE,
      partyId: config.OCPI_PARTY_ID,
      locationId: place.locationId,
      evseUid: place.evseUid,
      connectorId: place.connectorId,
      token: await partnerToken(link.partnerId, link.tokenUid),
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
  chargingSessionId: ocpiRoamingSessions.chargingSessionId,
  tokenUid: ocpiRoamingSessions.tokenUid,
};

/** The CPO session link of a charging session, if a partner's token started it. */
export async function cpoSessionLink(chargingSessionId: string): Promise<CpoSessionLink | null> {
  const [row] = await db
    .select(linkColumns)
    .from(ocpiRoamingSessions)
    .where(eq(ocpiRoamingSessions.chargingSessionId, chargingSessionId))
    .limit(1);
  if (row?.chargingSessionId == null) return null;
  return { ...row, chargingSessionId: row.chargingSessionId };
}

/**
 * A page of a partner's CPO sessions, newest change first, filtered on the
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
      .orderBy(desc(chargingSessions.updatedAt), desc(ocpiRoamingSessions.id))
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
