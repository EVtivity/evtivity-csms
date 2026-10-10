// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, chargingStations } from '@evtivity/database';
import { getUserSiteIds } from './site-access.js';
import { siteInScope } from './site-scope.js';

export interface CommandStation {
  /** Internal (nanoid) station id. */
  id: string;
  /** `ocpp1.6`, `ocpp2.1`, or null before the station first connected. */
  ocppProtocol: string | null;
}

/**
 * The station an OCPP command addresses, by its OCPP identity, as the user
 * may see it. Null when the station does not exist or is outside the user's
 * sites: callers answer both with 404 `STATION_NOT_FOUND`, so the answer does
 * not tell whether the station exists. The OCPP command routes and the AI
 * assistant's version check use the same lookup.
 */
export async function findCommandStation(
  userId: string,
  ocppStationId: string,
): Promise<CommandStation | null> {
  const [station] = await db
    .select({
      id: chargingStations.id,
      siteId: chargingStations.siteId,
      ocppProtocol: chargingStations.ocppProtocol,
    })
    .from(chargingStations)
    .where(eq(chargingStations.stationId, ocppStationId));
  if (station == null) return null;
  const siteAccessIds = await getUserSiteIds(userId);
  if (!siteInScope(siteAccessIds, station.siteId)) return null;
  return { id: station.id, ocppProtocol: station.ocppProtocol };
}
