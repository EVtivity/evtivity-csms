// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The hash of a depot plan TxProfile, kept apart from the profile builder so
// the OCPP server can match station replies without loading load management.

import { createHash } from 'node:crypto';

/** The fields of a SetChargingProfile request the hash reads. */
export interface PlanProfileHashInput {
  evseId: number;
  chargingProfile: {
    id: number;
    stackLevel: number;
    transactionId?: string;
    chargingSchedule?: Array<{
      chargingRateUnit?: string;
      chargingSchedulePeriod?: unknown[];
    }>;
  };
}

/**
 * A hash of what the station would do with the profile: everything but the
 * schedule start, which moves with each send. Within one slot the same plan
 * gives the same hash, so an unchanged plan is never sent again.
 */
export function planProfileHash(payload: PlanProfileHashInput): string {
  const profile = payload.chargingProfile;
  const schedule = profile.chargingSchedule?.[0];
  const content = JSON.stringify([
    payload.evseId,
    profile.id,
    profile.stackLevel,
    profile.transactionId,
    schedule?.chargingRateUnit ?? null,
    schedule?.chargingSchedulePeriod ?? [],
  ]);
  return createHash('sha256').update(content).digest('hex');
}
