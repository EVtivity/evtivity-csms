// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { chargingStations, drivers, reservations } from '@evtivity/database';
import { defineListSort, sortablePersonName } from '../list-sort.js';

const reservationSortOptions = {
  tieBreaker: reservations.id,
  defaultOrder: [desc(reservations.createdAt), desc(reservations.id)],
};

/**
 * The sortable columns of `GET /v1/reservations` (`api/routes.md`, "List sorting"),
 * which joins `charging_stations` and `drivers`.
 */
export const reservationListSort = defineListSort(
  {
    reservationId: reservations.reservationId,
    station: chargingStations.stationId,
    driver: sortablePersonName(drivers.firstName, drivers.lastName),
    status: reservations.status,
    startsAt: reservations.startsAt,
    expiresAt: reservations.expiresAt,
    createdAt: reservations.createdAt,
  },
  reservationSortOptions,
);

/** The sortable columns of `GET /v1/drivers/:id/reservations`, which joins no driver. */
export const driverReservationListSort = defineListSort(
  {
    reservationId: reservations.reservationId,
    station: chargingStations.stationId,
    status: reservations.status,
    startsAt: reservations.startsAt,
    expiresAt: reservations.expiresAt,
    cancellationFee: reservations.cancellationFeeCents,
  },
  reservationSortOptions,
);
