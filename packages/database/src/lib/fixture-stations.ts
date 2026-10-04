// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../config.js';
import { chargingStations } from '../schema/index.js';

/**
 * The simulator fixtures migration 0001 inserts in every install: CS-0001
 * (OCPP 1.6) and CS-0002 (OCPP 2.1). They start `pending`, so a simulator
 * that connects as one of them is never accepted until an operator accepts
 * the station.
 */
export const FIXTURE_STATION_IDS = ['CS-0001', 'CS-0002'] as const;

/**
 * Accepts the fixture stations that are still pending, so their simulators
 * boot into service on a demo or dev install. A station an operator blocked
 * stays blocked. Idempotent. Only the demo seed and the dev fixture seed call
 * it: a production install keeps them pending.
 */
export async function acceptPendingFixtureStations(): Promise<string[]> {
  const accepted = await db
    .update(chargingStations)
    .set({ onboardingStatus: 'accepted', updatedAt: new Date() })
    .where(
      and(
        inArray(chargingStations.stationId, [...FIXTURE_STATION_IDS]),
        eq(chargingStations.onboardingStatus, 'pending'),
      ),
    )
    .returning({ stationId: chargingStations.stationId });
  return accepted.map((row) => row.stationId);
}
