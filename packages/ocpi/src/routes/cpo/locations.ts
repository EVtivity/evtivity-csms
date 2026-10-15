// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { eq, and, gte, lte, sql, isNotNull, isNull, desc, ne } from 'drizzle-orm';
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
  isOperatorStation,
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
import { findPublishedSiteId } from '../../lib/published-location.js';
import { findEvseByUid } from '../../lib/evse-lookup.js';
import { connectorTariffIds } from '../../services/connector-tariffs.js';
import { removedEvseRow, retiredConnectorsUpdatedAt } from '../../services/location-render.js';
import { locationLastUpdatedSql } from '../../lib/location-last-updated.js';
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
  stationOnline: boolean;
  stationUpdatedAt: Date;
  retiredConnectorsUpdatedAt?: Date;
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

interface PublishedLocationRow {
  site: typeof sites.$inferSelect;
  ocpiLocationId: string;
  publishUpdatedAt: Date;
}

async function getPublishedLocations(
  partnerId: string,
  offset: number,
  limit: number,
  dateFrom?: Date,
  dateTo?: Date,
): Promise<{ locations: PublishedLocationRow[]; total: number }> {
  // The location's last_updated: the site, its publish row, its EVSEs and
  // connectors, and its removed EVSEs (OCPI 8.3.1). The date filters and the
  // sort use it, so a partner pulling with date_from sees an EVSE change.
  const lastUpdated = locationLastUpdatedSql();
  const conditions = [eq(ocpiLocationPublish.isPublished, true)];
  if (dateFrom != null) conditions.push(sql`${lastUpdated} >= ${dateFrom}`);
  if (dateTo != null) conditions.push(sql`${lastUpdated} <= ${dateTo}`);

  // Published sites - either publishToAll=true or partner is in the allow list.
  // Inner-join sites and require non-null coordinates so the OCPI list reflects
  // only locations we can actually represent (coordinates is a required field
  // in the OCPI Location object); count and pagination both reflect that filter.
  // OCPI 2.2.1 §3.1.3: list responses MUST be sorted by `last_updated`; the
  // site id breaks ties so pages never skip or repeat a row. EXISTS on the
  // allow-list keeps one row per site.
  const visible = sql`(${ocpiLocationPublish.publishToAll} = true OR EXISTS (
    SELECT 1 FROM ${ocpiLocationPublishPartners}
     WHERE ${ocpiLocationPublishPartners.locationPublishId} = ${ocpiLocationPublish.id}
       AND ${ocpiLocationPublishPartners.partnerId} = ${partnerId}))`;
  const where = and(...conditions, isNotNull(sites.latitude), isNotNull(sites.longitude), visible);

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(ocpiLocationPublish)
    .innerJoin(sites, eq(sites.id, ocpiLocationPublish.siteId))
    .where(where);
  const total = countRow?.total ?? 0;
  if (total === 0 || offset >= total) return { locations: [], total };

  const rows = await db
    .select({
      site: sites,
      ocpiLocationId: ocpiLocationPublish.ocpiLocationId,
      publishUpdatedAt: ocpiLocationPublish.updatedAt,
    })
    .from(ocpiLocationPublish)
    .innerJoin(sites, eq(sites.id, ocpiLocationPublish.siteId))
    .where(where)
    .orderBy(desc(lastUpdated), desc(ocpiLocationPublish.siteId))
    .limit(limit)
    .offset(offset);

  return {
    locations: rows.map((r) => ({
      site: r.site,
      ocpiLocationId: r.ocpiLocationId ?? r.site.id,
      publishUpdatedAt: r.publishUpdatedAt,
    })),
    total,
  };
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
      retiredAt: evses.retiredAt,
      disabledReason: chargingStations.disabledReason,
      firmwareState: chargingStations.firmwareState,
      reportedStatus: chargingStations.reportedStatus,
      onboardingStatus: chargingStations.onboardingStatus,
      isOnline: chargingStations.isOnline,
      stationUpdatedAt: chargingStations.updatedAt,
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
  const retiredByEvse = new Map<string, Array<{ retiredAt: Date | null; updatedAt: Date }>>();
  for (const c of connectorRows) {
    // A retired connector is out of service: left out of the location, but
    // its change still moves the EVSE's last_updated.
    if (c.retiredAt != null) {
      const retired = retiredByEvse.get(c.evseId) ?? [];
      retired.push(c);
      retiredByEvse.set(c.evseId, retired);
      continue;
    }
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
      stationOnline: e.isOnline,
      stationUpdatedAt: e.stationUpdatedAt,
      ...retiredConnectorsUpdatedAt(retiredByEvse.get(e.id) ?? []),
      // A deleted station is kept with onboarding status `blocked`; a retired
      // EVSE is out of service. Both are REMOVED (OCPI 8.1).
      removed: e.onboardingStatus === 'blocked' || e.retiredAt != null,
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

    // Get stations for these sites. A pending station is not onboarded:
    // never published (a blocked one, deleted, stays as REMOVED). A
    // conformance test station is never published.
    const siteIds = siteRows.map((r) => r.site.id);
    const stationRows = await db
      .select()
      .from(chargingStations)
      .where(
        and(
          sql`${chargingStations.siteId} IN ${siteIds}`,
          ne(chargingStations.onboardingStatus, 'pending'),
          isOperatorStation(),
        ),
      );

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

    const countryCode = getCountryCode();
    const partyId = getPartyId();

    const allSiteIds = siteIds;
    const maintenanceCoverage = await findSiteMaintenanceCoverage(allSiteIds);
    const freeVendBySite = new Map(siteRows.map((r) => [r.site.id, r.site.freeVendEnabled]));
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
    const ocpiLocations = siteRows.map(({ site, ocpiLocationId, publishUpdatedAt }) => {
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
          ocpiLocationId,
          publishUpdatedAt,
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
    const siteId = await findPublishedSiteId(location_id);
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
      .where(
        and(
          eq(chargingStations.siteId, siteId),
          ne(chargingStations.onboardingStatus, 'pending'),
          isOperatorStation(),
        ),
      );
    const [publish] = await db
      .select({ updatedAt: ocpiLocationPublish.updatedAt })
      .from(ocpiLocationPublish)
      .where(eq(ocpiLocationPublish.siteId, siteId))
      .limit(1);

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
        ...(publish != null ? { publishUpdatedAt: publish.updatedAt } : {}),
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
      const siteId = await findPublishedSiteId(location_id);
      const found = siteId != null ? await findEvseByUid(evse_uid) : null;
      if (siteId == null || !(await isLocationVisibleToPartner(partner.partnerId, siteId))) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'EVSE not found'));
        return;
      }
      // A pending station is not onboarded: its EVSEs are not published.
      if (found?.siteId !== siteId || found.stationPending) {
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
        stationOnline: found.stationOnline,
        stationUpdatedAt: found.stationUpdatedAt,
        removed: found.stationRemoved || found.evseRetired,
      };
      const evseTariffIds = await stationTariffIds(partner.partnerId, found.stationDbId, siteId);

      const allConnectorRows = await db
        .select()
        .from(connectors)
        .where(eq(connectors.evseId, evseRow.id));
      // A retired connector is left out; its change still moves last_updated.
      const connectorRows = allConnectorRows.filter((c) => c.retiredAt == null);

      const evseWithConnectors = {
        ...evseRow,
        ...retiredConnectorsUpdatedAt(allConnectorRows),
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
      const siteId = await findPublishedSiteId(location_id);
      const found = siteId != null ? await findEvseByUid(evse_uid) : null;
      if (siteId == null || !(await isLocationVisibleToPartner(partner.partnerId, siteId))) {
        await reply
          .status(404)
          .send(ocpiError(OcpiStatusCode.CLIENT_UNKNOWN_LOCATION, 'Connector not found'));
        return;
      }
      if (found?.siteId !== siteId || found.stationPending) {
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

      // The EVSE of a deleted station, or a retired EVSE, is REMOVED (the
      // EVSE GET and the location carry the status; a Connector has none,
      // OCPI 8.3.3): its connectors are served as they were, like those of
      // a removed EVSE. A retired connector of a live EVSE is left out.
      const evseRemoved = found.stationRemoved || found.evseRetired;
      const [connector] = await db
        .select()
        .from(connectors)
        .where(
          and(
            eq(connectors.evseId, found.evseDbId),
            eq(connectors.connectorId, connectorIdNum),
            ...(evseRemoved ? [] : [isNull(connectors.retiredAt)]),
          ),
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
