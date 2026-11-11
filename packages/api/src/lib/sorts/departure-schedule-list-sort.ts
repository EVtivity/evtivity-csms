// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { sites, vehicleDepartureSchedules } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/fleets/:id/departure-schedules` (`api/routes.md`, "List
 * sorting"). The list joins `sites` (the depot).
 */
export const departureScheduleListSort = defineListSort(
  {
    departureTime: vehicleDepartureSchedules.departureTime,
    priority: vehicleDepartureSchedules.priority,
    depot: sites.name,
  },
  {
    tieBreaker: vehicleDepartureSchedules.id,
    defaultOrder: [desc(vehicleDepartureSchedules.createdAt), desc(vehicleDepartureSchedules.id)],
  },
);
