// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc, sql, type SQL } from 'drizzle-orm';
import { chargingStations, connectors, evses, sites, vendors } from '@evtivity/database';
import { buildDerivedStatusSubquery } from '@evtivity/services/station-derived-status';
import { defineListSort } from '../list-sort.js';

/**
 * The derived station status the lists show (`buildDerivedStatusSubquery`), built when the
 * query renders rather than when this module loads, so route tests that mock the database
 * tables or Drizzle helpers can still import the routes.
 */
const stationStatus = sql`${{ getSQL: () => buildDerivedStatusSubquery(chargingStations.id) }}`;

/**
 * The connectors of a station, as the station lists count them: a correlated count, so it
 * sorts the same in a list with or without the EVSE and connector joins.
 */
function stationConnectorCount(): SQL<number> {
  return sql<number>`(
    SELECT COUNT(sc.id)::int
    FROM ${evses} se
    JOIN ${connectors} sc ON sc.evse_id = se.id
    WHERE se.station_id = ${chargingStations.id}
  )`;
}

/**
 * The sortable columns of `GET /v1/stations` (`api/routes.md`, "List sorting"): FROM
 * `charging_stations` with `vendors` and `sites` joined.
 */
export const stationListSort = defineListSort(
  {
    stationId: chargingStations.stationId,
    site: sites.name,
    vendor: vendors.name,
    model: chargingStations.model,
    securityProfile: chargingStations.securityProfile,
    ocppProtocol: chargingStations.ocppProtocol,
    status: stationStatus,
    connectors: stationConnectorCount(),
    online: chargingStations.isOnline,
    lastHeartbeat: chargingStations.lastHeartbeat,
    createdAt: chargingStations.createdAt,
  },
  {
    tieBreaker: chargingStations.id,
    defaultOrder: [desc(chargingStations.createdAt), desc(chargingStations.id)],
  },
);

/**
 * The sortable columns of `GET /v1/sites/:id/stations`: the same keys as the stations list
 * (one shared table), over `charging_stations` grouped by station with the EVSE and
 * connector joins and no vendor or site join, so vendor and site read through correlated
 * subqueries. Every row has the same site, so `site` keeps the default tie order.
 */
export const siteStationListSort = defineListSort(
  {
    stationId: chargingStations.stationId,
    site: sql`(SELECT ss.name FROM ${sites} ss WHERE ss.id = ${chargingStations.siteId})`,
    vendor: sql`(SELECT sv.name FROM ${vendors} sv WHERE sv.id = ${chargingStations.vendorId})`,
    model: chargingStations.model,
    securityProfile: chargingStations.securityProfile,
    ocppProtocol: chargingStations.ocppProtocol,
    status: stationStatus,
    connectors: stationConnectorCount(),
    online: chargingStations.isOnline,
    lastHeartbeat: chargingStations.lastHeartbeat,
    createdAt: chargingStations.createdAt,
  },
  {
    tieBreaker: chargingStations.id,
    defaultOrder: [desc(chargingStations.createdAt), desc(chargingStations.id)],
  },
);
