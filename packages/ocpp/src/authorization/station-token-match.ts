// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, asc, desc, eq, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { stationTokenLookup, VEHICLE_ID_TYPES } from '@evtivity/lib/vehicle-id';
import { db, driverTokens } from '@evtivity/database';

/**
 * The one rule for which driver tokens a value a station sent matches, used by
 * Authorize and by the session's token link at TransactionEvent Started, so
 * the two never decide differently:
 *
 * - every card matches the value as sent;
 * - a card of any other type also matches the value in another letter case:
 *   OCPP idTokens are case-insensitive (2.x IdToken, 1.6 IdToken). The exact
 *   spelling wins over a case variant (`pickStationTokenRows`);
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
  const byCase =
    and(
      sql`lower(${driverTokens.idToken}) = lower(${exact})`,
      notInArray(driverTokens.tokenType, [...VEHICLE_ID_TYPES]),
    ) ?? byExact;
  const byCanonical =
    canonical == null
      ? null
      : and(
          eq(driverTokens.idToken, canonical),
          inArray(driverTokens.tokenType, [...VEHICLE_ID_TYPES]),
        );
  const byValue = or(byExact, byCase, byCanonical ?? undefined) ?? byExact;
  return type == null ? byValue : (and(byValue, eq(driverTokens.tokenType, type)) ?? byValue);
}

function isVehicleIdTypeValue(type: string): boolean {
  return (VEHICLE_ID_TYPES as readonly string[]).includes(type);
}

/**
 * Which of the cards `stationTokenCondition` matched count, in the order a
 * station value resolves: the cards spelled exactly as sent (and the vehicle id
 * cards of the canonical form) win; without one, the cards that differ only in
 * letter case count when they share one spelling. Two spellings that both
 * differ from the sent value only in case are ambiguous: no card counts and the
 * caller refuses the value (fail closed), never picks one of them.
 */
export function pickStationTokenRows<T extends { idToken: string; tokenType: string }>(
  rows: readonly T[],
  value: string,
): { rows: T[]; ambiguous: boolean } {
  const caseOnly = (r: T): boolean => r.idToken !== value && !isVehicleIdTypeValue(r.tokenType);
  const primary = rows.filter((r) => !caseOnly(r));
  if (primary.length > 0) return { rows: primary, ambiguous: false };
  const variants = rows.filter(caseOnly);
  const spellings = new Set(variants.map((r) => r.idToken));
  if (spellings.size > 1) return { rows: [], ambiguous: true };
  return { rows: variants, ambiguous: false };
}

export interface LinkableStationToken {
  id: string;
  idToken: string;
  tokenType: string;
  driverId: string | null;
  /** The fleet that owns the card, null for a driver's own card. */
  fleetId: string | null;
  prepaidBalanceCents: number | null;
}

/**
 * The active driver tokens a started session may link to, by the station
 * token rule (`stationTokenCondition`, `pickStationTokenRows`): the exact
 * spelling first, then by id. Only active cards link; Authorize already
 * refused an inactive one. A value that matches two case variants and no exact
 * spelling links nothing (`ambiguous`).
 */
export async function findLinkableStationTokenMatch(
  value: string,
  type?: string | null,
): Promise<{ tokens: LinkableStationToken[]; ambiguous: boolean }> {
  const rows = await db
    .select({
      id: driverTokens.id,
      idToken: driverTokens.idToken,
      tokenType: driverTokens.tokenType,
      isActive: driverTokens.isActive,
      driverId: driverTokens.driverId,
      fleetId: driverTokens.fleetId,
      prepaidBalanceCents: driverTokens.prepaidBalanceCents,
    })
    .from(driverTokens)
    .where(stationTokenCondition(value, type))
    .orderBy(desc(sql`${driverTokens.idToken} = ${value}`), asc(driverTokens.id));
  const picked = pickStationTokenRows(rows, value);
  const tokens = picked.rows
    .filter((r) => r.isActive)
    .map((r) => ({
      id: r.id,
      idToken: r.idToken,
      tokenType: r.tokenType,
      driverId: r.driverId,
      fleetId: r.fleetId,
      prepaidBalanceCents: r.prepaidBalanceCents,
    }));
  return { tokens, ambiguous: picked.ambiguous };
}

export async function findLinkableStationTokens(
  value: string,
  type?: string | null,
): Promise<LinkableStationToken[]> {
  return (await findLinkableStationTokenMatch(value, type)).tokens;
}
