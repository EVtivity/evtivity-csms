// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { asc } from 'drizzle-orm';
import { chargingStations, sites, vendors } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/**
 * The sortable columns of the matching stations previews (`api/routes.md`, "List sorting"):
 * `GET /v1/firmware-campaigns/:id/matching-stations`, `GET /v1/config-templates/:id/matching-stations`
 * and `GET /v1/smart-charging/templates/:id/matching-stations`. Each selects the stations with
 * their site and vendor joined.
 */
export const matchingStationListSort = defineListSort(
  {
    station: chargingStations.stationId,
    site: sites.name,
    vendor: vendors.name,
    model: chargingStations.model,
    firmwareVersion: chargingStations.firmwareVersion,
    status: chargingStations.isOnline,
  },
  {
    tieBreaker: chargingStations.id,
    defaultOrder: [asc(chargingStations.stationId)],
  },
);
