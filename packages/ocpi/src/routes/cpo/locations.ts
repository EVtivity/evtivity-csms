// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { eq, and, gte, lte, sql, isNotNull, desc } from 'drizzle-orm';
import {
  db,
  sites,
  chargingStations,
  evses,
  connectors,
  ocpiLocationPublish,
  ocpiLocationPublishPartners,
  maintenanceEvents,
  isStationLevelUnavailable,
  removedOcpiEvses,
} from '@evtivity/database';
import { inArray } from 'drizzle-orm';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { parsePaginationParams, setPaginationHeaders } from '../../lib/ocpi-pagination.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import {
  transformLocation,
  transformEvseStandalone,
  transformConnectorStandalone,
} from '../../transformers/location.transformer.js';
import { config } from '../../lib/config.js';
import { isLocationVisibleToPartner } from '../../lib/location-visibility.js';
import { findEvseByUid } from '../../lib/evse-lookup.js';
import { connectorTariffIds } from '../../services/connector-tariffs.js';
import { removedEvseRow } from '../../services/location-render.js';
import type { OcpiVersion } from '../../types/ocpi.js';
import type { EvseRow as TransformEvseRow } from '../../transformers/location.transformer.js';

function getCountryCode(): string {
  return config.OCPI_COUNTRY_CODE;
}

function getPartyId(): string {
  return config.OCPI_PARTY_ID;
}

interface EvseRow {
  id: string;
  stationId: string;
  stationOcppId: string;
  evseId: number;
  updatedAt: Date;
  stationLevelUnavailable: boolean;
  removed: boolean;
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

  // Query published sites - either publishToAll=true or partner is in the allow list.
  // Inner-join sites and require non-null coordinates so the OCPI list reflects
  // only locations we can actually represent (coordinates is a required field
  // in the OCPI Location object); count and pagination both reflect that filter.
  // OCPI 2.2.1 §3.1.3: list responses MUST be sorted by `last_updated`.
  // Without an explicit ORDER BY, Postgres returns rows in storage order,
  // which means client pagination can skip or repeat rows as the index
  // mutates. Sort by site.updated_at DESC to match the Location.last_updated
  // each row will carry.
  const publishedSiteIds = await db
    .select({
      siteId: ocpiLocationPublish.siteId,
      ocpiLocationId: ocpiLocationPublish.ocpiLocationId,
    })
    .from(ocpiLocationPublish)
    .innerJoin(sites, eq(sites.id, ocpiLocationPublish.siteId))
    .leftJoin(
      ocpiLocationPublishPartners,
      eq(ocpiLocationPublish.id, ocpiLocationPublishPartners.locationPublishId),
    )
    .where(
      and(
        ...conditions,
        isNotNull(sites.latitude),
        isNotNull(sites.longitude),
        sql`(${ocpiLocationPublish.publishToAll} = true OR ${ocpiLocationPublishPartners.partnerId} = ${partnerId})`,
      ),
    )
    .orderBy(desc(sites.updatedAt), desc(ocpiLocationPublish.siteId));

  // Dedupe while preserving sort order. A site with multiple allow-list rows
  // appears once per row from the LEFT JOIN; the first hit wins.
  const siteIdSet = new Map<string, string | null>();
  for (const row of publishedSiteIds) {
    if (!siteIdSet.has(row.siteId)) {
      siteIdSet.set(row.siteId, row.ocpiLocationId);
    }
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

  // Sites returned by the IN-list filter come back unordered. Re-sort to
  // match the canonical pagination order so the response array matches the
  // header offsets.
  const orderIndex = new Map(pagedSiteIds.map((id, idx) => [id, idx]));
  const siteRows = await db
    .select()
    .from(sites)
    .where(sql`${sites.id} IN ${pagedSiteIds}`);
  siteRows.sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0));

  return { locations: siteRows, total };
}

function withEvseTariffIds<T extends EvseRow>(
  evse: T,
  tariffIds: string[] | undefined,
): T & { tariffIds?: string[] } {
  return tariffIds != null ? { ...evse, tariffIds } : evse;
}

async function getEvsesWithConnectors(
  stationIds: string[],
): Promise<Map<string, Array<EvseRow & { connectors: ConnectorRow[] }>>> {
  if (stationIds.length === 0) return new Map();

  const evseRows = await db
    .select({
      id: evses.id,
      stationId: evses.stationId,
      stationOcppId: chargingStations.stationId,
      evseId: evses.evseId,
      updatedAt: evses.updatedAt,
      disabledReason: chargingStations.disabledReason,
      firmwareState: chargingStations.firmwareState,
      reportedStatus: chargingStations.reportedStatus,
      onboardingStatus: chargingStations.onboardingStatus,
    })
    .from(evses)
    .innerJoin(chargingStations, eq(chargingStations.id, evses.stationId))
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
      stationId: stId,
      stationOcppId: e.stationOcppId,
      evseId: e.evseId,
      updatedAt: e.updatedAt,
      stationLevelUnavailable: isStationLevelUnavailable(e),
      // A deleted station is kept with onboarding status `blocked`.
      removed: e.onboardingStatus === 'blocked',
      connectors: connectorsByEvse.get(e.id) ?? [],
    });
    result.set(stId, list);
  }

  return result;
}

interface SiteMaintenanceCoverage {
  allAffected: boolean;
  affectedStationIds: Set<string>;
}

async function findSiteMaintenanceCoverage(
  siteIds: string[],
): Promise<Map<string, SiteMaintenanceCoverage>> {
  const result = new Map<string, SiteMaintenanceCoverage>();
  if (siteIds.length === 0) return result;
  const now = new Date();
  const rows = await db
    .select({
      siteId: maintenanceEvents.siteId,
      affectedStationIds: maintenanceEvents.affectedStationIds,
    })
    .from(maintenanceEvents)
    .where(
      and(
        inArray(maintenanceEvents.siteId, siteIds),
        eq(maintenanceEvents.status, 'active'),
        lte(maintenanceEvents.plannedStartAt, now),
        gte(maintenanceEvents.plannedEndAt, now),
      ),
    );
  for (const r of rows) {
    const existing = result.get(r.siteId) ?? {
      allAffected: false,
      affectedStationIds: new Set<string>(),
    };
    const filter = r.affectedStationIds;
    if (filter == null || filter.length === 0) {
      existing.allAffected = true;
    } else {
      for (const s of filter) existing.affectedStationIds.add(s);
    }
    result.set(r.siteId, existing);
  }
  return result;
}

// Resolve a partner-supplied location_id (custom OCPI location id or site id)
// to a published site id. Null when nothing published matches.
async function resolvePublishedSiteId(locationId: string): Promise<string | null> {
  const [publishRow] = await db
    .select({ siteId: ocpiLocationPublish.siteId })
    .from(ocpiLocationPublish)
    .where(
      and(
        eq(ocpiLocationPublish.isPublished, true),
        sql`(${ocpiLocationPublish.ocpiLocationId} = ${locationId} OR ${ocpiLocationPublish.siteId} = ${locationId})`,
      ),
    )
    .limit(1);
  return publishRow?.siteId ?? null;
}

// An EVSE that left the site (`ocpi_removed_evses`), as a REMOVED EVSE row.
async function findRemovedEvse(siteId: string, uid: string): Promise<TransformEvseRow | null> {
  const removed = (await removedOcpiEvses([siteId])).find((r) => r.evseUid === uid);
  return removed != null ? removedEvseRow(removed) : null;
}

// Connector tariff ids of one station for a partner (empty when none is published).
async function stationTariffIds(
  partnerId: string,
  stationDbId: string,
  siteId: string,
): Promise<string[] | undefined> {
  const [site] = await db
    .select({ freeVendEnabled: sites.freeVendEnabled })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1);
  const ids = await connectorTariffIds(partnerId, [
    { id: stationDbId, freeVend: site?.freeVendEnabled === true },
  ]);
  return ids.get(stationDbId);
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

    const allSiteIds = siteRows.map((s) => s.id);
    const maintenanceCoverage = await findSiteMaintenanceCoverage(allSiteIds);
    const freeVendBySite = new Map(siteRows.map((s) => [s.id, s.freeVendEnabled]));
    // EVSEs that left these sites (deleted, station moved) are served as
    // REMOVED for the retention period (OCPI 8.1).
    const removedBySite = new Map<string, TransformEvseRow[]>();
    for (const r of await removedOcpiEvses(allSiteIds)) {
      const list = removedBySite.get(r.siteId) ?? [];
      list.push(removedEvseRow(r));
      removedBySite.set(r.siteId, list);
    }
    const tariffIds = await connectorTariffIds(
      partner.partnerId,
      stationRows.map((s) => ({
        id: s.id,
        freeVend: s.siteId != null && freeVendBySite.get(s.siteId) === true,
      })),
    );

    // OCPI Location.coordinates is required; getPublishedLocations() filters
    // out coordinateless sites at the source so total + pagination stay aligned.
    const ocpiLocations = siteRows.map((site) => {
      const siteStationIds = stationsBySite.get(site.id) ?? [];
      const allEvses = [
        ...siteStationIds.flatMap((stId) =>
          (evseMap.get(stId) ?? []).map((e) => withEvseTariffIds(e, tariffIds.get(stId))),
        ),
        ...(removedBySite.get(site.id) ?? []),
      ];
      const coverage = maintenanceCoverage.get(site.id);

      return transformLocation(
        {
          site,
          evses: allEvses,
          ocpiLocationId: locationIdMap.get(site.id) ?? site.id,
          countryCode,
          partyId,
          ...(coverage != null ? { maintenance: coverage } : {}),
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

    const partner = request.ocpiPartner;
    if (partner?.partnerId == null) {
      await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
      return;
    }

    // Find site by OCPI location ID or direct site ID
    const siteId = await resolvePublishedSiteId(location_id);
    if (siteId == null) {
      await reply
        .status(404)
        .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Location not found'));
      return;
    }

    if (!(await isLocationVisibleToPartner(partner.partnerId, siteId))) {
      await reply
        .status(404)
        .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Location not found'));
      return;
    }

    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    if (site == null || site.latitude == null || site.longitude == null) {
      // Missing coordinates leave the location unrepresentable in OCPI; treat
      // it as not-found from the partner's perspective rather than emit (0, 0).
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
    const tariffIds = await connectorTariffIds(
      partner.partnerId,
      stationIds.map((id) => ({ id, freeVend: site.freeVendEnabled })),
    );
    const allEvses = [
      ...stationIds.flatMap((stId) =>
        (evseMap.get(stId) ?? []).map((e) => withEvseTariffIds(e, tariffIds.get(stId))),
      ),
      ...(await removedOcpiEvses([siteId])).map(removedEvseRow),
    ];

    const maintenanceCoverage = await findSiteMaintenanceCoverage([siteId]);
    const coverage = maintenanceCoverage.get(siteId);
    const location = transformLocation(
      {
        site,
        evses: allEvses,
        ocpiLocationId: location_id,
        countryCode: getCountryCode(),
        partyId: getPartyId(),
        ...(coverage != null ? { maintenance: coverage } : {}),
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
      const { location_id, evse_uid } = request.params as {
        location_id: string;
        evse_uid: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      // The EVSE must belong to the requested location, or have left it
      // (served as REMOVED, OCPI 8.1).
      const siteId = await resolvePublishedSiteId(location_id);
      const found = siteId != null ? await findEvseByUid(evse_uid) : null;
      if (siteId == null || !(await isLocationVisibleToPartner(partner.partnerId, siteId))) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'EVSE not found'));
        return;
      }
      if (found?.siteId !== siteId) {
        const removed = await findRemovedEvse(siteId, evse_uid);
        if (removed == null) {
          await reply
            .status(404)
            .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'EVSE not found'));
          return;
        }
        return ocpiSuccess(transformEvseStandalone(removed, version));
      }
      const evseRow = {
        id: found.evseDbId,
        stationId: found.stationDbId,
        stationOcppId: found.stationOcppId,
        evseId: found.evseNumber,
        updatedAt: found.updatedAt,
        stationLevelUnavailable: isStationLevelUnavailable(found.stationState),
        removed: found.stationRemoved,
      };
      const evseTariffIds = await stationTariffIds(partner.partnerId, found.stationDbId, siteId);

      const connectorRows = await db
        .select()
        .from(connectors)
        .where(eq(connectors.evseId, evseRow.id));

      const evseWithConnectors = {
        ...evseRow,
        ...(evseTariffIds != null ? { tariffIds: evseTariffIds } : {}),
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

      const coverage = (await findSiteMaintenanceCoverage([siteId])).get(siteId);
      const underMaintenance =
        coverage != null &&
        (coverage.allAffected || coverage.affectedStationIds.has(found.stationDbId));
      const ocpiEvse = transformEvseStandalone(evseWithConnectors, version, underMaintenance);
      return ocpiSuccess(ocpiEvse);
    },
  );

  // GET /ocpi/{version}/cpo/locations/:location_id/:evse_uid/:connector_id
  app.get(
    `${prefix}/:location_id/:evse_uid/:connector_id`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const { location_id, evse_uid, connector_id } = request.params as {
        location_id: string;
        evse_uid: string;
        connector_id: string;
      };

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      const connectorIdNum = parseInt(connector_id, 10);
      // The EVSE must belong to the requested location, or have left it (its
      // connectors are served as they were).
      const siteId = await resolvePublishedSiteId(location_id);
      const found = siteId != null ? await findEvseByUid(evse_uid) : null;
      if (siteId == null || !(await isLocationVisibleToPartner(partner.partnerId, siteId))) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Connector not found'));
        return;
      }
      if (found?.siteId !== siteId) {
        const removed = (await findRemovedEvse(siteId, evse_uid))?.connectors.find(
          (c) => c.connectorId === connectorIdNum,
        );
        if (removed == null) {
          await reply
            .status(404)
            .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Connector not found'));
          return;
        }
        return ocpiSuccess(transformConnectorStandalone(removed, version));
      }

      const [connector] = await db
        .select()
        .from(connectors)
        .where(
          and(eq(connectors.evseId, found.evseDbId), eq(connectors.connectorId, connectorIdNum)),
        )
        .limit(1);

      if (connector == null) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Connector not found'));
        return;
      }

      const connectorTariffs = await stationTariffIds(partner.partnerId, found.stationDbId, siteId);
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
        connectorTariffs,
      );

      return ocpiSuccess(ocpiConnector);
    },
  );
}

export function cpoLocationRoutes(app: FastifyInstance): void {
  registerCpoLocationRoutes(app, '2.2.1');
  registerCpoLocationRoutes(app, '2.3.0');
}
