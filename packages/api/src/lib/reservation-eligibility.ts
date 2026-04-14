// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, getReservationSettings, sites } from '@evtivity/database';
import { AppError } from '@evtivity/lib';

interface StationEligibilityInfo {
  reservationsEnabled: boolean;
  siteId: string | null | undefined;
}

export async function assertReservationsAllowed(station: StationEligibilityInfo): Promise<void> {
  const config = await getReservationSettings();
  if (!config.enabled) {
    throw new AppError('Reservations are disabled system-wide', 403, 'RESERVATIONS_DISABLED');
  }

  if (station.siteId != null) {
    const [site] = await db
      .select({ reservationsEnabled: sites.reservationsEnabled })
      .from(sites)
      .where(eq(sites.id, station.siteId));

    if (site != null && !site.reservationsEnabled) {
      throw new AppError('Reservations are disabled for this site', 403, 'RESERVATIONS_DISABLED');
    }
  }

  if (!station.reservationsEnabled) {
    throw new AppError('Reservations are disabled for this station', 403, 'RESERVATIONS_DISABLED');
  }
}
