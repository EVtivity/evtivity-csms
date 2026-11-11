// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { firmwareCampaigns, firmwareUpdates } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/stations/:id/firmware-history` (`api/routes.md`, "List
 * sorting"): FROM `firmware_updates` with the campaign joined for its version. The URL is
 * stored with its password masked, so its order tells nothing about a password.
 */
export const stationFirmwareListSort = defineListSort(
  {
    status: firmwareUpdates.status,
    firmwareUrl: firmwareUpdates.firmwareUrl,
    version: firmwareCampaigns.version,
    initiatedAt: firmwareUpdates.initiatedAt,
    lastStatusAt: firmwareUpdates.lastStatusAt,
  },
  {
    tieBreaker: firmwareUpdates.id,
    defaultOrder: [desc(firmwareUpdates.createdAt), desc(firmwareUpdates.id)],
  },
);
