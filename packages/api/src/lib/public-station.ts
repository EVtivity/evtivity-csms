// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { chargingStations, sites } from '@evtivity/database';

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

/**
 * A site the portal location pages show: one with a station the page lists.
 * A site without one (new, or every station pending, refused or deleted)
 * answers like an unknown id, so a site id never reveals a site that is not
 * public yet. Use in the WHERE of a query on `sites`.
 */
export function publicSiteListed(): SQL {
  return sql`EXISTS (SELECT 1 FROM ${chargingStations} WHERE ${chargingStations.siteId} = ${sites.id} AND ${publicStationListed()})`;
}
