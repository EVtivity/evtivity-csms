// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { asc, count, desc } from 'drizzle-orm';
import { fleetReservations, reservations } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/fleets/:fleetId/reservations` (`api/routes.md`, "List
 * sorting"). `reservationCount` is the grouped count of the joined reservations, the value
 * the list shows (a site-restricted user's count holds only its sites).
 */
export const fleetReservationListSort = defineListSort(
  {
    name: fleetReservations.name,
    status: fleetReservations.status,
    reservationCount: count(reservations.id),
    startsAt: fleetReservations.startsAt,
    expiresAt: fleetReservations.expiresAt,
    createdAt: fleetReservations.createdAt,
  },
  {
    tieBreaker: fleetReservations.id,
    defaultOrder: [desc(fleetReservations.createdAt), asc(fleetReservations.id)],
  },
);
