// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  db,
  chargingSessions,
  evChargingNeeds,
  evses,
  isIso15118Enabled,
} from '@evtivity/database';
import { and, desc, eq } from 'drizzle-orm';

interface SchedulePeriod {
  startPeriod: number;
  limit: number;
}

interface Schedule {
  chargingRateUnit?: string;
  startSchedule?: string;
  chargingSchedulePeriod?: SchedulePeriod[];
}

/** The SetChargingProfile payload the CSMS sent for an EVSE's charging needs. */
export interface ChargingNeedsProfilePayload {
  evseId: number;
  chargingProfile: {
    id: number;
    stackLevel: number;
    chargingProfilePurpose: string;
    chargingProfileKind: string;
    transactionId: string;
    chargingSchedule: Schedule[];
  };
}

/** What `ev_charging_needs.csms_charging_profile` holds. */
export interface StoredChargingNeedsProfile {
  payload: ChargingNeedsProfilePayload;
  /** Renegotiations the CSMS started for this profile after a rejected EV schedule. */
  renegotiations: number;
}

// Rounding slack when comparing limits (W or A).
const LIMIT_EPSILON = 0.001;

function periodsOf(schedule: Schedule | undefined): SchedulePeriod[] {
  const periods = Array.isArray(schedule?.chargingSchedulePeriod)
    ? schedule.chargingSchedulePeriod
    : [];
  return periods
    .filter((p) => typeof p.startPeriod === 'number' && typeof p.limit === 'number')
    .sort((a, b) => a.startPeriod - b.startPeriod);
}

/** The limit of the period active at `t` (ms), or null before the first period. */
function limitAt(periods: SchedulePeriod[], startMs: number, t: number): number | null {
  let limit: number | null = null;
  for (const p of periods) {
    if (startMs + p.startPeriod * 1000 <= t) limit = p.limit;
    else break;
  }
  return limit;
}

/**
 * Whether the EV's charging schedule (NotifyEVChargingSchedule, periods
 * relative to `timeBase`) stays within the CSMS schedule it was given, at
 * every point where either schedule changes (K15.FR.11/12, K16.FR.06/07).
 * Schedules in different rate units cannot be compared without the EV's
 * voltage and phases: the station already checked them (K15.FR.09), so they
 * count as within limits.
 */
export function evScheduleWithinLimits(
  timeBase: string,
  evSchedule: unknown,
  csms: ChargingNeedsProfilePayload,
): boolean {
  const ev = evSchedule as Schedule | undefined;
  const csmsSchedule = csms.chargingProfile.chargingSchedule[0];
  if (csmsSchedule == null) return true;
  if (ev?.chargingRateUnit != null && ev.chargingRateUnit !== csmsSchedule.chargingRateUnit) {
    return true;
  }
  const evStart = new Date(timeBase).getTime();
  const csmsStart = new Date(csmsSchedule.startSchedule ?? timeBase).getTime();
  if (!Number.isFinite(evStart) || !Number.isFinite(csmsStart)) return true;
  const evPeriods = periodsOf(ev);
  const csmsPeriods = periodsOf(csmsSchedule);
  const points = [
    ...evPeriods.map((p) => evStart + p.startPeriod * 1000),
    ...csmsPeriods.map((p) => csmsStart + p.startPeriod * 1000),
  ];
  for (const t of points) {
    const evLimit = limitAt(evPeriods, evStart, t);
    const csmsLimit = limitAt(csmsPeriods, csmsStart, t);
    if (evLimit == null || csmsLimit == null) continue;
    if (evLimit > csmsLimit + LIMIT_EPSILON) return false;
  }
  return true;
}

/** The profile the CSMS sent for an EVSE's current charging needs, or null. */
export async function loadChargingNeedsProfile(
  stationDbId: string,
  evseId: number,
): Promise<StoredChargingNeedsProfile | null> {
  const [row] = await db
    .select({ profile: evChargingNeeds.csmsChargingProfile })
    .from(evChargingNeeds)
    .where(and(eq(evChargingNeeds.stationId, stationDbId), eq(evChargingNeeds.evseId, evseId)))
    .limit(1);
  const profile = row?.profile as StoredChargingNeedsProfile | null | undefined;
  return profile?.payload != null ? profile : null;
}

/**
 * The transactionId of the active session on an EVSE, or null. The TxProfile
 * the CSMS answers charging needs with names it (K15.FR.07, K01.FR.03).
 */
export async function findActiveTransactionId(
  stationDbId: string,
  evseId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ transactionId: chargingSessions.transactionId })
    .from(chargingSessions)
    .innerJoin(evses, eq(evses.id, chargingSessions.evseId))
    .where(
      and(
        eq(chargingSessions.stationId, stationDbId),
        eq(evses.evseId, evseId),
        eq(chargingSessions.status, 'active'),
      ),
    )
    .orderBy(desc(chargingSessions.startedAt))
    .limit(1);
  return row?.transactionId ?? null;
}

/**
 * The transaction the CSMS computes an ISO 15118 schedule for, or null when it
 * will not send one: the `smartCharging.iso15118Enabled` setting is off, the
 * EV asks for dynamic control (the CSMS computes schedules only, K19), or the
 * EVSE has no active transaction to address a TxProfile to.
 */
export async function scheduledChargingTransaction(
  stationDbId: string | null,
  evseId: number,
  chargingNeeds: Record<string, unknown>,
): Promise<string | null> {
  if (stationDbId == null) return null;
  if (chargingNeeds.controlMode === 'DynamicControl') return null;
  if (!(await isIso15118Enabled())) return null;
  return findActiveTransactionId(stationDbId, evseId);
}
