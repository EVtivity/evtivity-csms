// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, evses, chargingStations } from '@evtivity/database';
import type { StationLevelState } from '@evtivity/database';

// Resolves an OCPI EVSE uid (see evse-uid.ts) to the EVSE and its station.
// `stationState` carries the station-level availability inputs for
// `isStationLevelUnavailable`.
export interface EvseByUid {
  evseDbId: string;
  evseNumber: number;
  stationDbId: string;
  stationOcppId: string;
  siteId: string | null;
  updatedAt: Date;
  stationState: StationLevelState;
  /** The station was deleted (soft delete: onboarding status `blocked`). */
  stationRemoved: boolean;
}

export async function findEvseByUid(uid: string): Promise<EvseByUid | null> {
  const [row] = await db
    .select({
      evseDbId: evses.id,
      evseNumber: evses.evseId,
      stationDbId: chargingStations.id,
      stationOcppId: chargingStations.stationId,
      siteId: chargingStations.siteId,
      updatedAt: evses.updatedAt,
      disabledReason: chargingStations.disabledReason,
      firmwareState: chargingStations.firmwareState,
      reportedStatus: chargingStations.reportedStatus,
      onboardingStatus: chargingStations.onboardingStatus,
    })
    .from(evses)
    .innerJoin(chargingStations, eq(chargingStations.id, evses.stationId))
    .where(eq(evses.id, uid))
    .limit(1);
  if (row == null) return null;
  const { disabledReason, firmwareState, reportedStatus, onboardingStatus, ...evse } = row;
  return {
    ...evse,
    stationState: { disabledReason, firmwareState, reportedStatus },
    stationRemoved: onboardingStatus === 'blocked',
  };
}
