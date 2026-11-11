// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { evChargingSchedules } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/stations/:id/ev-charging-schedules` (`api/routes.md`,
 * "List sorting"). The keys differ from the monitoring rules list, which shares its tab
 * and the URL sort.
 */
export const evChargingScheduleListSort = defineListSort(
  {
    evseId: evChargingSchedules.evseId,
    timeBase: evChargingSchedules.timeBase,
    withinLimits: evChargingSchedules.withinLimits,
    receivedAt: evChargingSchedules.createdAt,
  },
  {
    tieBreaker: evChargingSchedules.id,
    defaultOrder: [desc(evChargingSchedules.createdAt), desc(evChargingSchedules.id)],
  },
);
