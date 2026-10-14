// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { AppError, publishStationDisconnect } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { db, chargingStations, stationAuditLog, writeAudit } from '@evtivity/database';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import { publishStationStatusChanged } from '../lib/station-status-events.js';

export type OnboardingStatus = 'pending' | 'accepted' | 'blocked';

/** The operator moves of a station's onboarding status. */
export const ONBOARDING_TRANSITIONS = {
  approve: { from: 'pending', to: 'accepted', notes: 'Station approved' },
  reject: { from: 'pending', to: 'blocked', notes: 'Station rejected' },
  unblock: { from: 'blocked', to: 'pending', notes: 'Station unblocked' },
} as const satisfies Record<
  string,
  { from: OnboardingStatus; to: OnboardingStatus; notes: string }
>;

export type OnboardingTransition = keyof typeof ONBOARDING_TRANSITIONS;

export interface OnboardingContext {
  actor: AuditActorInfo;
  log: FastifyBaseLogger;
}

export interface OnboardedStation {
  stationId: string;
  isSimulator: boolean;
  isOnline: boolean;
  siteId: string | null;
}

/**
 * Applies an operator approve, reject or unblock. The UPDATE is a
 * compare-and-set on the expected status, so two operators acting at once
 * (approve and reject) cannot both win: the second gets 409 (NOT_PENDING or
 * NOT_BLOCKED). Audited as onboarding_status_changed, then the dashboards and
 * roaming partners are told (fail-open): a station that is not accepted
 * publishes its EVSEs to OCPI as REMOVED. A rejected station's live connection
 * is closed (fail-open; the connection authentication refuses it from now on).
 *
 * Open registration accepts a pending station on its BootNotification in the
 * OCPP server (`handlers/boot-status.ts`); the station DELETE route blocks a
 * station from any status. Those are the other writers of the status.
 */
export async function changeStationOnboarding(
  stationDbId: string,
  transition: OnboardingTransition,
  ctx: OnboardingContext,
): Promise<OnboardedStation> {
  const { from, to, notes } = ONBOARDING_TRANSITIONS[transition];
  const [updated] = await db
    .update(chargingStations)
    .set({ onboardingStatus: to, updatedAt: new Date() })
    .where(and(eq(chargingStations.id, stationDbId), eq(chargingStations.onboardingStatus, from)))
    .returning({
      stationId: chargingStations.stationId,
      isSimulator: chargingStations.isSimulator,
      isOnline: chargingStations.isOnline,
      siteId: chargingStations.siteId,
    });
  if (updated == null) {
    const [exists] = await db
      .select({ id: chargingStations.id })
      .from(chargingStations)
      .where(eq(chargingStations.id, stationDbId));
    if (exists == null) throw new AppError('Station not found', 404, 'STATION_NOT_FOUND');
    throw from === 'pending'
      ? new AppError('Station is not pending approval', 409, 'NOT_PENDING')
      : new AppError('Station is not blocked', 409, 'NOT_BLOCKED');
  }

  await writeAudit(
    { table: stationAuditLog, idColumn: 'station_id' },
    {
      entityId: stationDbId,
      entityIdSnapshot: stationDbId,
      action: 'onboarding_status_changed',
      ...ctx.actor,
      before: { onboardingStatus: from },
      after: { onboardingStatus: to },
      notes,
    },
    db,
    ctx.log,
  );
  await publishStationStatusChanged({ id: stationDbId, siteId: updated.siteId }, ctx.log);
  // A blocked station is refused at its next connection; end the one it holds.
  if (to === 'blocked') await publishStationDisconnect(getPubSub(), updated.stationId, ctx.log);
  return updated;
}
