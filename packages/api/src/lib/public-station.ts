// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, not, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { chargingStations, isOperatorStation, sites } from '@evtivity/database';

/**
 * The stations the public portal serves by OCPP id: only stations an operator
 * accepted. A pending or blocked station cannot be started
 * (checkStationOnboarded), so the station and EVSE pages (the QR landing
 * pages), pricing, status checks, starts, the station event stream, favorites
 * and station watches never serve one. They keep an accepted unsited station:
 * QR and guest starts do not require a site (features/site-access-control.md).
 * Conformance (OCTT) stations are never served: a driver cannot find one in a
 * listing, a map, a search or by its OCPP id.
 *
 * A station the operator took out of the portal listings (portal_listed
 * false) is still served here: a driver who has its QR code, a link or a
 * favorite reaches it and can charge. The listings read
 * `publicStationListed()`.
 */
export function publicStationServed(): SQL {
  return and(eq(chargingStations.onboardingStatus, 'accepted'), isOperatorStation()) as SQL;
}

/**
 * The stations the portal listings show: the search, the map and nearby list,
 * and the location pages (with their images and popular times). A served
 * station the operator did not take out of the listings. The listings join
 * sites, so they also leave out unsited stations. Hiding a station is not an
 * access control: its pages by OCPP id stay available
 * (`publicStationServed()`).
 */
export function publicStationListed(): SQL {
  return and(publicStationServed(), eq(chargingStations.portalListed, true)) as SQL;
}

/**
 * The stations the dynamic QR check (`validateQrCodeUrl`) looks up: the
 * stations the portal serves, and accepted conformance (OCTT) stations, so the
 * conformance test of the check (TC_C_131_CSMS) can scan its station. A
 * hidden operator station (pending or blocked) answers like an unknown one, so
 * the check never tells which unserved stations have dynamic QR. A guest start
 * still reads `publicStationServed()`, so a conformance station is never
 * started from the portal.
 */
export function qrCheckableStation(): SQL {
  return or(
    publicStationServed(),
    and(eq(chargingStations.onboardingStatus, 'accepted'), not(isOperatorStation())),
  ) as SQL;
}

/**
 * A site the portal location pages show: one with a station the listings
 * show. A site without one (new, every station pending, refused or deleted, or
 * every station taken out of the listings) answers like an unknown id, so a
 * site id never reveals a site that is not public. Use in the WHERE of a query
 * on `sites`.
 */
export function publicSiteListed(): SQL {
  return sql`EXISTS (SELECT 1 FROM ${chargingStations} WHERE ${chargingStations.siteId} = ${sites.id} AND ${publicStationListed()})`;
}
