// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc, sql } from 'drizzle-orm';
import { chargingSessions, chargingStations, drivers } from '@evtivity/database';
import { defineListSort, sortablePersonName } from '../list-sort.js';

/** The station a session row shows (its OCPP id); the lists join `charging_stations`. */
export const sessionStationSort = chargingStations.stationId;

/** How long a session ran; an active session runs until now, as the CSMS shows it. */
export const sessionDurationSort = sql`coalesce(${chargingSessions.endedAt}, now()) - ${chargingSessions.startedAt}`;

/**
 * The cost a session row shows, the SQL twin of `sessionDisplayCostCents`
 * (`@evtivity/lib/session-cost`): the running cost while active, the final cost (0 when
 * none) of a faulted or failed session, else the final cost.
 */
export const sessionCostSort = sql`CASE
  WHEN ${chargingSessions.status} = 'active' THEN ${chargingSessions.currentCostCents}
  WHEN ${chargingSessions.status} IN ('faulted', 'failed') THEN coalesce(${chargingSessions.finalCostCents}, 0)
  ELSE ${chargingSessions.finalCostCents}
END`;

export const sessionSortOptions = {
  tieBreaker: chargingSessions.id,
  defaultOrder: [desc(chargingSessions.createdAt), desc(chargingSessions.id)],
};

/**
 * The sortable columns of the session lists of one station, site, token or driver
 * (`GET /v1/stations/:id/sessions`, `/v1/sites/:id/sessions`, `/v1/tokens/:id/sessions`,
 * `/v1/drivers/:id/sessions`), which join `charging_stations` and `drivers`.
 */
export const sessionListSort = defineListSort(
  {
    sessionId: chargingSessions.id,
    station: sessionStationSort,
    driver: sortablePersonName(drivers.firstName, drivers.lastName),
    status: chargingSessions.status,
    startedAt: chargingSessions.startedAt,
    duration: sessionDurationSort,
    energy: chargingSessions.energyDeliveredWh,
    cost: sessionCostSort,
  },
  sessionSortOptions,
);

/** The sortable columns of `GET /v1/fleets/:id/sessions`, which joins no driver. */
export const fleetSessionListSort = defineListSort(
  {
    sessionId: chargingSessions.id,
    station: sessionStationSort,
    status: chargingSessions.status,
    startedAt: chargingSessions.startedAt,
    duration: sessionDurationSort,
    energy: chargingSessions.energyDeliveredWh,
    cost: sessionCostSort,
  },
  sessionSortOptions,
);
