// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq } from 'drizzle-orm';
import { AppError } from '@evtivity/lib';
import { db, chargingStations, cssStations, stationAuditLog, writeAudit } from '@evtivity/database';
import { disableCssPair } from '../lib/css-pairing.js';
import type { AuditActorInfo } from '../lib/audit-actor.js';

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface ConfirmRealStationContext {
  actor: AuditActorInfo;
  log: Logger;
}

export interface ConfirmRealStationResult {
  /** False when the station was no longer flagged as a simulator. */
  changed: boolean;
}

/**
 * The operator confirms that a real station uses this identity (the guard for
 * a simulator-flagged station that a connection without the simulator marker
 * reached, see `simulator-identity.ts` in the OCPP package). Clears the flag
 * and the recorded conflict and disables the paired simulator, so it stops
 * connecting as this station. Idempotent.
 */
export async function confirmRealStation(
  stationDbId: string,
  ctx: ConfirmRealStationContext,
): Promise<ConfirmRealStationResult> {
  const outcome = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        stationId: chargingStations.stationId,
        isSimulator: chargingStations.isSimulator,
        simulatorConflictAt: chargingStations.simulatorConflictAt,
      })
      .from(chargingStations)
      .where(eq(chargingStations.id, stationDbId));
    if (before == null) throw new AppError('Station not found', 404, 'STATION_NOT_FOUND');

    const cleared = await tx
      .update(chargingStations)
      .set({ isSimulator: false, simulatorConflictAt: null, updatedAt: new Date() })
      .where(and(eq(chargingStations.id, stationDbId), eq(chargingStations.isSimulator, true)))
      .returning({ id: chargingStations.id });
    if (cleared.length === 0) return null;

    const [pairing] = await tx
      .select({ enabled: cssStations.enabled })
      .from(cssStations)
      .where(eq(cssStations.stationId, before.stationId));
    await disableCssPair(before.stationId, tx);
    return { before, simulatorWasEnabled: pairing?.enabled === true };
  });

  if (outcome == null) return { changed: false };

  await writeAudit(
    { table: stationAuditLog, idColumn: 'station_id' },
    {
      entityId: stationDbId,
      entityIdSnapshot: stationDbId,
      action: 'simulator_toggled',
      ...ctx.actor,
      before: {
        isSimulator: true,
        simulatorEnabled: outcome.simulatorWasEnabled,
        simulatorConflictAt: outcome.before.simulatorConflictAt,
      },
      after: { isSimulator: false, simulatorEnabled: false, simulatorConflictAt: null },
      notes: 'Operator confirmed a real station',
    },
    db,
    ctx.log,
  );
  return { changed: true };
}
