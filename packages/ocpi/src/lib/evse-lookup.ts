// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq } from 'drizzle-orm';
import { db, evses, chargingStations, isOperatorStation } from '@evtivity/database';
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
  /** The EVSE was retired: out of service, reported REMOVED, never started. */
  evseRetired: boolean;
  /** The station holds an OCPP connection now (`charging_stations.is_online`). */
  stationOnline: boolean;
  /** The station was accepted at onboarding (not pending, rejected or removed). */
  stationAccepted: boolean;
  /** The station is not onboarded yet (onboarding status `pending`). */
  stationPending: boolean;
  /** Last change of the station row. */
  stationUpdatedAt: Date;
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
      retiredAt: evses.retiredAt,
      disabledReason: chargingStations.disabledReason,
      firmwareState: chargingStations.firmwareState,
      reportedStatus: chargingStations.reportedStatus,
      onboardingStatus: chargingStations.onboardingStatus,
      isOnline: chargingStations.isOnline,
      stationUpdatedAt: chargingStations.updatedAt,
    })
    .from(evses)
    .innerJoin(chargingStations, eq(chargingStations.id, evses.stationId))
    // A conformance test station is never published: partners cannot find
    // or command its EVSEs.
    .where(and(eq(evses.id, uid), isOperatorStation()))
    .limit(1);
  if (row == null) return null;
  const {
    disabledReason,
    firmwareState,
    reportedStatus,
    onboardingStatus,
    retiredAt,
    isOnline,
    ...evse
  } = row;
  return {
    ...evse,
    stationState: { disabledReason, firmwareState, reportedStatus },
    stationRemoved: onboardingStatus === 'blocked',
    stationPending: onboardingStatus === 'pending',
    evseRetired: retiredAt != null,
    stationOnline: isOnline,
    stationAccepted: onboardingStatus === 'accepted',
  };
}
