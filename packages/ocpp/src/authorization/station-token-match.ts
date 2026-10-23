// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { stationTokenLookup, VEHICLE_ID_TYPES } from '@evtivity/lib/vehicle-id';
import { db, driverTokens } from '@evtivity/database';

/**
 * The one rule for which driver tokens a value a station sent matches, used by
 * Authorize and by the session's token link at TransactionEvent Started, so
 * the two never decide differently:
 *
 * - every card matches the value as sent;
 * - a card of a vehicle id type (VIN, EVCCID, MacAddress: only operators
 *   create them) also matches the canonical form of a vehicle-shaped value
 *   (`stationTokenLookup`), the form the token and vehicle services compare
 *   cards with vehicle ids in. Any other card matches its exact spelling only,
 *   so a card a driver registered never takes a `VID:` idTag;
 * - with `type`, only cards of that type match, so a card never matches a
 *   vehicle id a charger sends typed as VIN, EVCCID or MacAddress.
 *
 * Which type a caller passes is its own decision: Authorize passes the type a
 * 2.x station sent; the Started link passes it only for a vehicle id type,
 * because a 1.6 transaction event names ISO14443 for any idTag.
 */
export function stationTokenCondition(value: string, type?: string | null): SQL {
  const { exact, canonical } = stationTokenLookup(value);
  const byExact = eq(driverTokens.idToken, exact);
  const byValue =
    canonical == null
      ? byExact
      : (or(
          byExact,
          and(
            eq(driverTokens.idToken, canonical),
            inArray(driverTokens.tokenType, [...VEHICLE_ID_TYPES]),
          ),
        ) ?? byExact);
  return type == null ? byValue : (and(byValue, eq(driverTokens.tokenType, type)) ?? byValue);
}

export interface LinkableStationToken {
  id: string;
  driverId: string | null;
  prepaidBalanceCents: number | null;
}

/**
 * The active driver tokens a started session may link to, by the station
 * token rule (`stationTokenCondition`): the exact spelling first, then by id.
 * Only active cards link; Authorize already refused an inactive one.
 */
export async function findLinkableStationTokens(
  value: string,
  type?: string | null,
): Promise<LinkableStationToken[]> {
  return db
    .select({
      id: driverTokens.id,
      driverId: driverTokens.driverId,
      prepaidBalanceCents: driverTokens.prepaidBalanceCents,
    })
    .from(driverTokens)
    .where(and(stationTokenCondition(value, type), eq(driverTokens.isActive, true)))
    .orderBy(desc(sql`${driverTokens.idToken} = ${value}`), asc(driverTokens.id));
}
