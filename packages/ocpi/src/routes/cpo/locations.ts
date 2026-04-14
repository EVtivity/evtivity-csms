// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import {
  db,
  sites,
  chargingStations,
  evses,
  connectors,
  ocpiLocationPublish,
  ocpiLocationPublishPartners,
} from '@evtivity/database';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { parsePaginationParams, setPaginationHeaders } from '../../lib/ocpi-pagination.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import {
  transformLocation,
  transformEvseStandalone,
  transformConnectorStandalone,
} from '../../transformers/location.transformer.js';
import { config } from '../../lib/config.js';
import type { OcpiVersion } from '../../types/ocpi.js';

function getCountryCode(): string {
  return config.OCPI_COUNTRY_CODE;
}

function getPartyId(): string {
  return config.OCPI_PARTY_ID;
}

interface EvseRow {
  id: string;
  evseId: number;
  updatedAt: Date;
}

interface ConnectorRow {
  id: string;
  connectorId: number;
  connectorType: string | null;
  maxPowerKw: string | null;
  maxCurrentAmps: number | null;
  status: string;
  updatedAt: Date;
}

async function getPublishedLocations(
  partnerId: string,
  offset: number,
  limit: number,
  dateFrom?: Date,
  dateTo?: Date,
): Promise<{ locations: (typeof sites.$inferSelect)[]; total: number }> {
  // Get published location IDs visible to this partner
  const conditions = [eq(ocpiLocationPublish.isPublished, true)];

  if (dateFrom != null) {
    conditions.push(gte(ocpiLocationPublish.updatedAt, dateFrom));
  }
  if (dateTo != null) {
    conditions.push(lte(ocpiLocationPublish.updatedAt, dateTo));
  }

  // Query published sites - either publishToAll=true or partner is in the allow list
  const publishedSiteIds = await db
    .select({
      siteId: ocpiLocationPublish.siteId,
      ocpiLocationId: ocpiLocationPublish.ocpiLocationId,
    })
    .from(ocpiLocationPublish)
    .leftJoin(
      ocpiLocationPublishPartners,
      eq(ocpiLocationPublish.id, ocpiLocationPublishPartners.locationPublishId),
    )
    .where(
      and(
        ...conditions,
        sql`(${ocpiLocationPublish.publishToAll} = true OR ${ocpiLocationPublishPartners.partnerId} = ${partnerId})`,
      ),
    );

  const siteIdSet = new Map<string, string | null>();
  for (const row of publishedSiteIds) {
    siteIdSet.set(row.siteId, row.ocpiLocationId);
  }

  const uniqueSiteIds = [...siteIdSet.keys()];

  if (uniqueSiteIds.length === 0) {
    return { locations: [], total: 0 };
  }

  const total = uniqueSiteIds.length;

  // Paginate the site IDs
  const pagedSiteIds = uniqueSiteIds.slice(offset, offset + limit);
  if (pagedSiteIds.length === 0) {
    return { locations: [], total };
  }

  const siteRows = await db
    .select()
    .from(sites)
    .where(sql`${sites.id} IN ${pagedSiteIds}`);

  return { locations: siteRows, total };
}

async function getEvsesWithConnectors(
  stationIds: string[],
): Promise<Map<string, Array<EvseRow & { connectors: ConnectorRow[] }>>> {
  if (stationIds.length === 0) return new Map();

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

  const connectorsByEvse = new Map<string, ConnectorRow[]>();
  for (const c of connectorRows) {
    const list = connectorsByEvse.get(c.evseId) ?? [];
    list.push({
      id: c.id,
      connectorId: c.connectorId,
      connectorType: c.connectorType,
      maxPowerKw: c.maxPowerKw,
      maxCurrentAmps: c.maxCurrentAmps,
      status: c.status,
      updatedAt: c.updatedAt,
    });
    connectorsByEvse.set(c.evseId, list);
  }

  const result = new Map<string, Array<EvseRow & { connectors: ConnectorRow[] }>>();
  for (const e of evseRows) {
    const stId = e.stationId;
    const list = result.get(stId) ?? [];
    list.push({
      id: e.id,
      evseId: e.evseId,
      updatedAt: e.updatedAt,
      connectors: connectorsByEvse.get(e.id) ?? [],
    });
    result.set(stId, list);
  }

  return result;
}

function registerCpoLocationRoutes(app: FastifyInstance, version: OcpiVersion): void {
  const prefix = `/ocpi/${version}/cpo/locations`;

  // GET /ocpi/{version}/cpo/locations - paginated list of published locations
  app.get(prefix, { onRequest: [ocpiAuthenticate] }, async (request, reply) => {
    const partner = request.ocpiPartner;
    if (partner?.partnerId == null) {
      await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
      return;
    }

    const { offset, limit, dateFrom, dateTo } = parsePaginationParams(request);
    const { locations: siteRows, total } = await getPublishedLocations(
      partner.partnerId,
      offset,
      limit,
      dateFrom,
      dateTo,
    );

    if (siteRows.length === 0) {
      setPaginationHeaders(reply, request, total, limit, offset);
      return ocpiSuccess([]);
    }

    // Get stations for these sites
    const siteIds = siteRows.map((s) => s.id);
    const stationRows = await db
      .select()
      .from(chargingStations)
      .where(sql`${chargingStations.siteId} IN ${siteIds}`);

    const stationIds = stationRows.map((s) => s.id);
    const evseMap = await getEvsesWithConnectors(stationIds);

    // Group stations by site
    const stationsBySite = new Map<string, string[]>();
    for (const station of stationRows) {
      if (station.siteId == null) continue;
      const list = stationsBySite.get(station.siteId) ?? [];
      list.push(station.id);
      stationsBySite.set(station.siteId, list);
    }

    // Get OCPI location IDs from publish settings
    const publishSettings = await db
      .select({
        siteId: ocpiLocationPublish.siteId,
        ocpiLocationId: ocpiLocationPublish.ocpiLocationId,
      })
      .from(ocpiLocationPublish)
      .where(sql`${ocpiLocationPublish.siteId} IN ${siteIds}`);

    const locationIdMap = new Map<string, string>();
    for (const ps of publishSettings) {
      locationIdMap.set(ps.siteId, ps.ocpiLocationId ?? ps.siteId);
    }

    const countryCode = getCountryCode();
    const partyId = getPartyId();

    const ocpiLocations = siteRows.map((site) => {
      const siteStationIds = stationsBySite.get(site.id) ?? [];
      const allEvses = siteStationIds.flatMap((stId) => evseMap.get(stId) ?? []);

      return transformLocation(
        {
          site,
          evses: allEvses,
          ocpiLocationId: locationIdMap.get(site.id) ?? site.id,
          countryCode,
          partyId,
        },
        version,
      );
    });

    setPaginationHeaders(reply, request, total, limit, offset);
    return ocpiSuccess(ocpiLocations);
  });

  // GET /ocpi/{version}/cpo/locations/:location_id
  app.get(`${prefix}/:location_id`, { onRequest: [ocpiAuthenticate] }, async (request, reply) => {
    const { location_id } = request.params as { location_id: string };

    // Find site by OCPI location ID or direct site ID
    const publishRow = await db
      .select({ siteId: ocpiLocationPublish.siteId })
      .from(ocpiLocationPublish)
      .where(
        and(
          eq(ocpiLocationPublish.isPublished, true),
          sql`(${ocpiLocationPublish.ocpiLocationId} = ${location_id} OR ${ocpiLocationPublish.siteId} = ${location_id})`,
        ),
      )
      .limit(1);

    const siteId = publishRow[0]?.siteId;
    if (siteId == null) {
      await reply
        .status(404)
        .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Location not found'));
      return;
    }

    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    if (site == null) {
      await reply
        .status(404)
        .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Location not found'));
      return;
    }

    const stationRows = await db
      .select()
      .from(chargingStations)
      .where(eq(chargingStations.siteId, siteId));

    const stationIds = stationRows.map((s) => s.id);
    const evseMap = await getEvsesWithConnectors(stationIds);
    const allEvses = stationIds.flatMap((stId) => evseMap.get(stId) ?? []);

    const location = transformLocation(
      {
        site,
        evses: allEvses,
        ocpiLocationId: location_id,
        countryCode: getCountryCode(),
        partyId: getPartyId(),
      },
      version,
    );

    return ocpiSuccess(location);
  });

  // GET /ocpi/{version}/cpo/locations/:location_id/:evse_uid
  app.get(
    `${prefix}/:location_id/:evse_uid`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const { evse_uid } = request.params as { location_id: string; evse_uid: string };

      // Parse evse_uid format: {siteId}-{evseId}
      const dashIdx = evse_uid.lastIndexOf('-');
      if (dashIdx === -1) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'EVSE not found'));
        return;
      }

      const siteIdPart = evse_uid.slice(0, dashIdx);
      const evseIdNum = parseInt(evse_uid.slice(dashIdx + 1), 10);

      // Find station at this site
      const stationRows = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.siteId, siteIdPart));

      if (stationRows.length === 0) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'EVSE not found'));
        return;
      }

      const stationIds = stationRows.map((s) => s.id);

      const evseRows = await db
        .select()
        .from(evses)
        .where(and(sql`${evses.stationId} IN ${stationIds}`, eq(evses.evseId, evseIdNum)))
        .limit(1);

      const evseRow = evseRows[0];
      if (evseRow == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'EVSE not found'));
        return;
      }

      const connectorRows = await db
        .select()
        .from(connectors)
        .where(eq(connectors.evseId, evseRow.id));

      const evseWithConnectors = {
        ...evseRow,
        connectors: connectorRows.map((c) => ({
          id: c.id,
          connectorId: c.connectorId,
          connectorType: c.connectorType,
          maxPowerKw: c.maxPowerKw,
          maxCurrentAmps: c.maxCurrentAmps,
          status: c.status,
          updatedAt: c.updatedAt,
        })),
      };

      const ocpiEvse = transformEvseStandalone(evseWithConnectors, siteIdPart, version);
      return ocpiSuccess(ocpiEvse);
    },
  );

  // GET /ocpi/{version}/cpo/locations/:location_id/:evse_uid/:connector_id
  app.get(
    `${prefix}/:location_id/:evse_uid/:connector_id`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const { evse_uid, connector_id } = request.params as {
        location_id: string;
        evse_uid: string;
        connector_id: string;
      };

      const dashIdx = evse_uid.lastIndexOf('-');
      if (dashIdx === -1) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Connector not found'));
        return;
      }

      const siteIdPart = evse_uid.slice(0, dashIdx);
      const evseIdNum = parseInt(evse_uid.slice(dashIdx + 1), 10);
      const connectorIdNum = parseInt(connector_id, 10);

      const stationRows = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.siteId, siteIdPart));

      if (stationRows.length === 0) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Connector not found'));
        return;
      }

      const stationIds = stationRows.map((s) => s.id);

      const evseRows = await db
        .select({ id: evses.id })
        .from(evses)
        .where(and(sql`${evses.stationId} IN ${stationIds}`, eq(evses.evseId, evseIdNum)))
        .limit(1);

      if (evseRows[0] == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Connector not found'));
        return;
      }

      const [connector] = await db
        .select()
        .from(connectors)
        .where(
          and(eq(connectors.evseId, evseRows[0].id), eq(connectors.connectorId, connectorIdNum)),
        )
        .limit(1);

      if (connector == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Connector not found'));
        return;
      }

      const ocpiConnector = transformConnectorStandalone(
        {
          id: connector.id,
          connectorId: connector.connectorId,
          connectorType: connector.connectorType,
          maxPowerKw: connector.maxPowerKw,
          maxCurrentAmps: connector.maxCurrentAmps,
          status: connector.status,
          updatedAt: connector.updatedAt,
        },
        version,
      );

      return ocpiSuccess(ocpiConnector);
    },
  );
}

export function cpoLocationRoutes(app: FastifyInstance): void {
  registerCpoLocationRoutes(app, '2.2.1');
  registerCpoLocationRoutes(app, '2.3.0');
}
