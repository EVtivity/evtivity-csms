// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { drivers } from '@evtivity/database';
import { defineListSort, sortablePersonName } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/drivers` and `GET /v1/fleets/:id/drivers`
 * (`api/routes.md`, "List sorting"). Both list rows of `drivers`.
 */
export const driverListSort = defineListSort(
  {
    name: sortablePersonName(drivers.firstName, drivers.lastName),
    email: drivers.email,
    phone: drivers.phone,
    status: drivers.isActive,
    createdAt: drivers.createdAt,
  },
  {
    tieBreaker: drivers.id,
    defaultOrder: [desc(drivers.createdAt), desc(drivers.id)],
  },
);
