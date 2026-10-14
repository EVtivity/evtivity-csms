// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq } from 'drizzle-orm';
import {
  db,
  chargingStations,
  getRegistrationPolicy,
  stationAuditLog,
  writeAudit,
} from '@evtivity/database';
import type { HandlerContext } from '../server/middleware/pipeline.js';

/** RegistrationStatusEnumType, the same three values in OCPP 1.6 and 2.1. */
export type BootRegistrationStatus = 'Accepted' | 'Pending' | 'Rejected';

/**
 * The registration status a BootNotification answers, from the station's
 * onboarding status (OCPP 2.1 B01-B03, 1.6 section 4.2):
 *
 * - blocked: Rejected.
 * - pending, registration policy approval-required: Pending until an operator
 *   approves the station.
 * - pending, registration policy open: the station is accepted on this boot,
 *   and its onboarding status becomes accepted, so drivers can charge there
 *   and the boot projection treats it as an accepted station.
 * - accepted, or no station row (test mode): Accepted.
 *
 * A failed lookup or update answers Pending (fail closed): the station retries
 * after the interval, and a blocked station never slips through an outage.
 * Runs before the BootNotification event is published, so the projection
 * reads the onboarding status this boot settled.
 */
export async function resolveBootStatus(
  ctx: HandlerContext,
  versionLabel: string,
): Promise<BootRegistrationStatus> {
  if (ctx.stationDbId == null) return 'Accepted';
  try {
    const [station] = await db
      .select({ onboardingStatus: chargingStations.onboardingStatus })
      .from(chargingStations)
      .where(eq(chargingStations.id, ctx.stationDbId));

    if (station?.onboardingStatus === 'blocked') {
      ctx.logger.info(
        { stationId: ctx.stationId },
        `BootNotification rejected: station is blocked (${versionLabel})`,
      );
      return 'Rejected';
    }

    if (station?.onboardingStatus === 'pending') {
      const policy = await getRegistrationPolicy();
      if (policy === 'approval-required') {
        ctx.logger.info(
          { stationId: ctx.stationId },
          `BootNotification pending: station awaiting approval (${versionLabel})`,
        );
        return 'Pending';
      }
      await acceptPendingStation(ctx.stationDbId, ctx);
    }
  } catch (err: unknown) {
    ctx.logger.warn(
      { stationId: ctx.stationId, err: err instanceof Error ? err.message : String(err) },
      `BootNotification: onboarding lookup failed, returning Pending to force station retry (${versionLabel})`,
    );
    return 'Pending';
  }
  return 'Accepted';
}

// Open registration: the first accepted boot accepts the station. A
// compare-and-set on pending, so an operator who rejected the station in the
// meantime wins, and only one of two concurrent boots writes the audit row.
async function acceptPendingStation(stationDbId: string, ctx: HandlerContext): Promise<void> {
  const accepted = await db
    .update(chargingStations)
    .set({ onboardingStatus: 'accepted', updatedAt: new Date() })
    .where(
      and(eq(chargingStations.id, stationDbId), eq(chargingStations.onboardingStatus, 'pending')),
    )
    .returning({ id: chargingStations.id });
  if (accepted.length === 0) {
    throw new Error('The station left pending while it booted');
  }
  ctx.logger.info(
    { stationId: ctx.stationId },
    'BootNotification accepted: registration policy is open, station accepted',
  );
  await writeAudit(
    { table: stationAuditLog, idColumn: 'station_id' },
    {
      entityId: stationDbId,
      entityIdSnapshot: stationDbId,
      action: 'onboarding_status_changed',
      actor: 'ocpp',
      actorLabel: 'BootNotification',
      before: { onboardingStatus: 'pending' },
      after: { onboardingStatus: 'accepted' },
      notes: 'Accepted on its BootNotification: new stations do not require approval',
    },
    undefined,
    ctx.logger,
  );
}
