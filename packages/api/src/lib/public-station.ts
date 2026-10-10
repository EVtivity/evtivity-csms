// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { chargingStations } from '@evtivity/database';

/**
 * The stations the public portal serves: only stations an operator accepted.
 * A pending or blocked station cannot be started (checkStationOnboarded), so
 * the listings, the station and EVSE pages (the QR landing pages), pricing,
 * status checks, the station event stream, favorites and station watches never
 * serve one. The listings join sites, so they also leave out unsited stations.
 * The pages reached by OCPP id keep an accepted unsited station: QR and guest
 * starts do not require a site (features/site-access-control.md).
 */
export function publicStationListed(): SQL {
  return eq(chargingStations.onboardingStatus, 'accepted');
}
