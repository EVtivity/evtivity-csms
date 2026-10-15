// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Loads a site as the input of `transformLocation` for the location push:
// stations, EVSEs, connectors, maintenance coverage. Tariff ids are per
// partner and added by the caller (`withTariffIds`).

import { and, eq, gte, inArray, lte, ne } from 'drizzle-orm';
import {
  db,
  sites,
  chargingStations,
  evses,
  connectors,
  maintenanceEvents,
  isStationLevelUnavailable,
  removedOcpiEvses,
  ocpiLocationPublish,
  isOperatorStation,
} from '@evtivity/database';
import type { RemovedOcpiEvse } from '@evtivity/database';
import { config } from '../lib/config.js';
import type { EvseRow, LocationTransformInput } from '../transformers/location.transformer.js';
import type { TariffStation } from './connector-tariffs.js';

export interface SiteLocation {
  input: LocationTransformInput;
  /** The site's stations, for `connectorTariffIds`. */
  stations: TariffStation[];
}

/**
 * A removed EVSE (`ocpi_removed_evses`) as an EVSE row the transformer
 * reports as REMOVED, with the connectors it had.
 */
export function removedEvseRow(r: RemovedOcpiEvse): EvseRow {
  return {
    id: r.evseUid,
    stationId: '',
    stationOcppId: r.stationOcppId,
    evseId: r.evseNumber,
    updatedAt: r.removedAt,
    stationLevelUnavailable: false,
    removed: true,
    connectors: r.connectors.map((c) => ({
      ...c,
      status: 'unavailable',
      updatedAt: r.removedAt,
    })),
  };
}

/**
 * The site rendered under an OCPI location id, or null when the site is gone,
 * has no coordinates (OCPI requires them, so it was never published), or has
 * neither stations nor removed EVSEs. EVSEs that left the site are included
 * as REMOVED.
 */
export async function loadSiteLocation(
  siteId: string,
  ocpiLocationId: string,
): Promise<SiteLocation | null> {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (site == null) return null;
  // OCPI Location.coordinates is required. Skipping keeps unconfigured sites
  // out of partner feeds instead of publishing (0, 0) null-island coordinates.
  if (site.latitude == null || site.longitude == null) return null;

  // A pending station is not onboarded yet: never published. A blocked one
  // (deleted) stays, as REMOVED. A conformance test station is never published.
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
  const removed = await removedOcpiEvses([siteId]);
  if (stationRows.length === 0 && removed.length === 0) return null;

  const evseRows =
    stationRows.length > 0
      ? await db
          .select()
          .from(evses)
          .where(
            inArray(
              evses.stationId,
              stationRows.map((s) => s.id),
            ),
          )
      : [];
  const connectorRows =
    evseRows.length > 0
      ? await db
          .select()
          .from(connectors)
          .where(
            inArray(
              connectors.evseId,
              evseRows.map((e) => e.id),
            ),
          )
      : [];

  const connectorsByEvse = new Map<string, typeof connectorRows>();
  for (const c of connectorRows) {
    const list = connectorsByEvse.get(c.evseId) ?? [];
    list.push(c);
    connectorsByEvse.set(c.evseId, list);
  }

  const stationById = new Map(stationRows.map((s) => [s.id, s]));
  const evsesWithConnectors = evseRows.map((e) => {
    const station = stationById.get(e.stationId);
    return {
      id: e.id,
      stationId: e.stationId,
      stationOcppId: station?.stationId ?? e.stationId,
      evseId: e.evseId,
      updatedAt: e.updatedAt,
      stationLevelUnavailable: station != null && isStationLevelUnavailable(station),
      stationOnline: station?.isOnline ?? false,
      ...(station != null ? { stationUpdatedAt: station.updatedAt } : {}),
      // A deleted station is kept with onboarding status `blocked`; a retired
      // EVSE is out of service. Both are REMOVED (OCPI 8.1).
      removed: station?.onboardingStatus === 'blocked' || e.retiredAt != null,
      ...retiredConnectorsUpdatedAt(connectorsByEvse.get(e.id) ?? []),
      // A retired connector is out of service: left out of the location.
      connectors: (connectorsByEvse.get(e.id) ?? [])
        .filter((c) => c.retiredAt == null)
        .map((c) => ({
          id: c.id,
          connectorId: c.connectorId,
          connectorType: c.connectorType,
          maxPowerKw: c.maxPowerKw,
          maxCurrentAmps: c.maxCurrentAmps,
          status: c.status,
          updatedAt: c.updatedAt,
        })),
    };
  });

  const now = new Date();
  const activeMaintenance = await db
    .select({ affectedStationIds: maintenanceEvents.affectedStationIds })
    .from(maintenanceEvents)
    .where(
      and(
        eq(maintenanceEvents.siteId, siteId),
        eq(maintenanceEvents.status, 'active'),
        lte(maintenanceEvents.plannedStartAt, now),
        gte(maintenanceEvents.plannedEndAt, now),
      ),
    );

  let coverage: { allAffected: boolean; affectedStationIds: Set<string> } | undefined;
  if (activeMaintenance.length > 0) {
    const allAffected = activeMaintenance.some(
      (m) => m.affectedStationIds == null || m.affectedStationIds.length === 0,
    );
    const stationSet = new Set<string>();
    for (const m of activeMaintenance) {
      if (m.affectedStationIds != null) {
        for (const s of m.affectedStationIds) stationSet.add(s);
      }
    }
    coverage = { allAffected, affectedStationIds: stationSet };
  }

  const [publish] = await db
    .select({ updatedAt: ocpiLocationPublish.updatedAt })
    .from(ocpiLocationPublish)
    .where(eq(ocpiLocationPublish.siteId, siteId))
    .limit(1);

  return {
    input: {
      site,
      evses: [...evsesWithConnectors, ...removed.map(removedEvseRow)],
      ocpiLocationId,
      ...(publish != null ? { publishUpdatedAt: publish.updatedAt } : {}),
      countryCode: config.OCPI_COUNTRY_CODE,
      partyId: config.OCPI_PARTY_ID,
      ...(coverage != null ? { maintenance: coverage } : {}),
    },
    stations: stationRows.map((s) => ({ id: s.id, freeVend: site.freeVendEnabled })),
  };
}

/**
 * The latest change of the retired connectors (left out of the location),
 * for the EVSE's `last_updated`. Empty when none is retired.
 */
export function retiredConnectorsUpdatedAt(
  rows: ReadonlyArray<{ retiredAt: Date | null; updatedAt: Date }>,
): { retiredConnectorsUpdatedAt?: Date } {
  let max: Date | undefined;
  for (const c of rows) {
    if (c.retiredAt != null && (max == null || c.updatedAt > max)) max = c.updatedAt;
  }
  return max != null ? { retiredConnectorsUpdatedAt: max } : {};
}

/**
 * A deleted site's location, as the API captured it before the delete
 * cascaded its publish row and removed EVSEs (`ocpi_push` `deletedSite`).
 * Dates arrive as JSON strings.
 */
export interface DeletedSiteSnapshot {
  site: Omit<LocationTransformInput['site'], 'updatedAt'> & { updatedAt: string | Date };
  removedEvses: Array<Omit<RemovedOcpiEvse, 'removedAt'> & { removedAt: string | Date }>;
}

/**
 * The deleted site's location for a REMOVED push: its removed EVSEs (the
 * site has no stations, the API refuses to delete one that has). Null when
 * it has none (no partner ever had a live EVSE there).
 */
export function deletedSiteLocation(
  snapshot: DeletedSiteSnapshot,
  ocpiLocationId: string,
): SiteLocation | null {
  if (snapshot.removedEvses.length === 0) return null;
  const site = snapshot.site;
  if (site.latitude == null || site.longitude == null) return null;
  return {
    input: {
      site: { ...site, updatedAt: new Date(site.updatedAt) },
      evses: snapshot.removedEvses.map((r) =>
        removedEvseRow({ ...r, removedAt: new Date(r.removedAt) }),
      ),
      ocpiLocationId,
      countryCode: config.OCPI_COUNTRY_CODE,
      partyId: config.OCPI_PARTY_ID,
    },
    stations: [],
  };
}

/** The location input with each EVSE's connector tariff ids (by station). */
export function withTariffIds(
  input: LocationTransformInput,
  tariffIds: ReadonlyMap<string, string[]>,
): LocationTransformInput {
  return {
    ...input,
    evses: input.evses.map((e) => {
      const ids = tariffIds.get(e.stationId);
      return ids != null ? { ...e, tariffIds: ids } : e;
    }),
  };
}
