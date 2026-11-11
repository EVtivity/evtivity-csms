// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { chargingSessions, drivers, vehicles } from '@evtivity/database';
import { defineListSort, sortablePersonName } from '../list-sort.js';
import {
  sessionCostSort,
  sessionDurationSort,
  sessionSortOptions,
  sessionStationSort,
} from './session-list-sort.js';

/** The display name of a session's linked vehicle (year make model, else the plate). */
export const sessionVehicleNameSql = sql<
  string | null
>`NULLIF(coalesce(NULLIF(concat_ws(' ', ${vehicles.year}, ${vehicles.make}, ${vehicles.model}), ''), ${vehicles.licensePlate}), '')`;

/**
 * The sortable columns of `GET /v1/sessions` (`api/routes.md`, "List sorting"), which also
 * joins `vehicles` and returns the CO2 avoided. Its own file: the per-entity session lists
 * join no vehicle, and their route tests mock a database without one.
 */
export const allSessionsListSort = defineListSort(
  {
    station: sessionStationSort,
    driver: sortablePersonName(drivers.firstName, drivers.lastName),
    vehicle: sessionVehicleNameSql,
    status: chargingSessions.status,
    startedAt: chargingSessions.startedAt,
    duration: sessionDurationSort,
    energy: chargingSessions.energyDeliveredWh,
    co2Avoided: chargingSessions.co2AvoidedKg,
    cost: sessionCostSort,
  },
  sessionSortOptions,
);
