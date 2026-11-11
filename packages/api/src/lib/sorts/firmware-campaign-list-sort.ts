// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { asc, desc } from 'drizzle-orm';
import { chargingStations, firmwareCampaignStations, firmwareCampaigns } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/** The sortable columns of `GET /v1/firmware-campaigns` (`api/routes.md`, "List sorting"). */
export const firmwareCampaignListSort = defineListSort(
  {
    name: firmwareCampaigns.name,
    version: firmwareCampaigns.version,
    status: firmwareCampaigns.status,
    createdAt: firmwareCampaigns.createdAt,
  },
  {
    tieBreaker: firmwareCampaigns.id,
    defaultOrder: [desc(firmwareCampaigns.createdAt), desc(firmwareCampaigns.id)],
  },
);

/** The sortable columns of the station progress of `GET /v1/firmware-campaigns/:id`. */
export const firmwareCampaignStationListSort = defineListSort(
  {
    station: chargingStations.stationId,
    status: firmwareCampaignStations.status,
    updatedAt: firmwareCampaignStations.updatedAt,
  },
  {
    tieBreaker: firmwareCampaignStations.id,
    defaultOrder: [asc(chargingStations.stationId), asc(firmwareCampaignStations.id)],
  },
);
