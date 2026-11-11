// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { chargingStations, neviExcludedDowntime } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/** The sortable columns of `GET /v1/nevi/excluded-downtime` (`api/routes.md`, "List sorting"). */
export const neviDowntimeListSort = defineListSort(
  {
    station: chargingStations.stationId,
    evseId: neviExcludedDowntime.evseId,
    reason: neviExcludedDowntime.reason,
    startedAt: neviExcludedDowntime.startedAt,
    endedAt: neviExcludedDowntime.endedAt,
  },
  {
    tieBreaker: neviExcludedDowntime.id,
    defaultOrder: [desc(neviExcludedDowntime.startedAt)],
  },
);
