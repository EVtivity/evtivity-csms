// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { maintenanceEventStations, maintenanceEvents } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/** The sortable columns of `GET /v1/sites/:siteId/maintenance/events` (`api/routes.md`, "List sorting"). */
export const maintenanceEventListSort = defineListSort(
  {
    plannedStartAt: maintenanceEvents.plannedStartAt,
    plannedEndAt: maintenanceEvents.plannedEndAt,
    status: maintenanceEvents.status,
    eventType: maintenanceEvents.eventType,
    reason: maintenanceEvents.reason,
    sessionsStopped: maintenanceEvents.sessionsStoppedCount,
    reservationsCancelled: maintenanceEvents.reservationsCancelledCount,
  },
  {
    tieBreaker: maintenanceEvents.id,
    defaultOrder: [desc(maintenanceEvents.plannedStartAt)],
  },
);

/** The sortable columns of `GET /v1/sites/:siteId/maintenance/events/:id/stations`. */
export const maintenanceEventStationListSort = defineListSort(
  {
    station: maintenanceEventStations.stationOcppId,
    phase: maintenanceEventStations.phase,
    command: maintenanceEventStations.command,
    commandStatus: maintenanceEventStations.commandStatus,
    createdAt: maintenanceEventStations.createdAt,
  },
  {
    tieBreaker: maintenanceEventStations.id,
    defaultOrder: [desc(maintenanceEventStations.createdAt), desc(maintenanceEventStations.id)],
  },
);
