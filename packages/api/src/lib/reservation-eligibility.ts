// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, getReservationSettings, isStationLevelUnavailable, sites } from '@evtivity/database';
import { AppError } from '@evtivity/lib';

interface StationEligibilityInfo {
  reservationsEnabled: boolean;
  siteId: string | null | undefined;
  disabledReason: string | null;
  firmwareState: string | null;
  reportedStatus: string | null;
}

// Every reservation create path (operator, fleet, portal, reassign) calls this.
// A station that is disabled, installing or failed firmware, or reports itself
// unavailable or faulted cannot take a reservation, the same rule the start
// gate applies.

export async function assertReservationsAllowed(station: StationEligibilityInfo): Promise<void> {
  const config = await getReservationSettings();
  if (!config.enabled) {
    throw new AppError('Reservations are disabled system-wide', 403, 'RESERVATION_DISABLED');
  }

  if (station.siteId != null) {
    const [site] = await db
      .select({ reservationsEnabled: sites.reservationsEnabled })
      .from(sites)
      .where(eq(sites.id, station.siteId));

    if (site != null && !site.reservationsEnabled) {
      throw new AppError('Reservations are disabled for this site', 403, 'RESERVATION_DISABLED');
    }
  }

  if (!station.reservationsEnabled) {
    throw new AppError('Reservations are disabled for this station', 403, 'RESERVATION_DISABLED');
  }

  if (isStationLevelUnavailable(station)) {
    throw new AppError('Station is unavailable', 409, 'STATION_UNAVAILABLE');
  }
}
