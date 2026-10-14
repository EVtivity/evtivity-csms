// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * OCPP 2.1 K01.FR.80/81: profile ids up to a station's
 * SmartChargingCtrlr.MaxExternalConstraintsId belong to the station's own
 * external constraints profiles; the station rejects a SetChargingProfile
 * with such an id. Operator-entered ids (the station charging profile push,
 * template pushes, the generic SetChargingProfile command) must be above the
 * value the station reported. A station with no recorded value (OCPP 1.6, or
 * no report yet) is not checked.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { AppError } from '@evtivity/lib';
import { db, chargingStations, stationConfigurations } from '@evtivity/database';
import { ERROR_CODES } from './error-codes.generated.js';

const MAX_EXTERNAL_CONSTRAINTS_ID = 'MaxExternalConstraintsId';

function parseMax(value: string | null): number | null {
  if (value == null) return null;
  const max = Number(value);
  return Number.isInteger(max) ? max : null;
}

/** MaxExternalConstraintsId recorded for each station, by station database id. */
export async function maxExternalConstraintsIds(
  stationDbIds: readonly string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (stationDbIds.length === 0) return result;
  const rows = await db
    .select({ stationId: stationConfigurations.stationId, value: stationConfigurations.value })
    .from(stationConfigurations)
    .where(
      and(
        inArray(stationConfigurations.stationId, [...stationDbIds]),
        eq(stationConfigurations.component, 'SmartChargingCtrlr'),
        eq(stationConfigurations.variable, MAX_EXTERNAL_CONSTRAINTS_ID),
        eq(stationConfigurations.attributeType, 'Actual'),
      ),
    );
  for (const row of rows) {
    const max = parseMax(row.value);
    if (max != null) result.set(row.stationId, max);
  }
  return result;
}

/** MaxExternalConstraintsId recorded for a station, by its OCPP identity. */
export async function maxExternalConstraintsIdByIdentity(
  stationIdentity: string,
): Promise<number | null> {
  const [row] = await db
    .select({ value: stationConfigurations.value })
    .from(stationConfigurations)
    .innerJoin(chargingStations, eq(stationConfigurations.stationId, chargingStations.id))
    .where(
      and(
        eq(chargingStations.stationId, stationIdentity),
        eq(stationConfigurations.component, 'SmartChargingCtrlr'),
        eq(stationConfigurations.variable, MAX_EXTERNAL_CONSTRAINTS_ID),
        eq(stationConfigurations.attributeType, 'Actual'),
      ),
    );
  return parseMax(row?.value ?? null);
}

export function reservedProfileIdMessage(profileId: number, maxExternalId: number): string {
  return `Charging profile id ${String(profileId)} must be above the station's MaxExternalConstraintsId ${String(maxExternalId)} (OCPP 2.1 K01.FR.81)`;
}

/** True when the station would reject `profileId` (at or below its recorded value). */
export function isReservedProfileId(
  profileId: number,
  maxExternalId: number | null | undefined,
): boolean {
  return maxExternalId != null && profileId <= maxExternalId;
}

/** Throws 400 CHARGING_PROFILE_ID_RESERVED for an id the station would reject. */
export function assertProfileIdAllowed(
  profileId: number,
  maxExternalId: number | null | undefined,
): void {
  if (maxExternalId != null && isReservedProfileId(profileId, maxExternalId)) {
    throw new AppError(
      reservedProfileIdMessage(profileId, maxExternalId),
      400,
      ERROR_CODES.CHARGING_PROFILE_ID_RESERVED,
    );
  }
}
