// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { drivers, vehicles } from '@evtivity/database';
import { defineListSort, sortablePersonName } from '../list-sort.js';

/** The sortable columns of `GET /v1/fleets/:id/vehicles` (`api/routes.md`, "List sorting"). */
export const vehicleListSort = defineListSort(
  {
    make: vehicles.make,
    model: vehicles.model,
    driver: sortablePersonName(drivers.firstName, drivers.lastName),
    year: vehicles.year,
    vin: vehicles.vin,
    licensePlate: vehicles.licensePlate,
  },
  {
    tieBreaker: vehicles.id,
    defaultOrder: [desc(vehicles.createdAt), desc(vehicles.id)],
  },
);
