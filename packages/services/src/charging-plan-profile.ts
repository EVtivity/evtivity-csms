// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The OCPP transaction profile of a planned session (route-aware charging):
// one 2.1 SetChargingProfile payload the OCPP server translates for 1.6 and
// 2.0.1 stations. The id is the transaction's TxProfile id, the one the
// ISO 15118 computer uses, so a plan replaces that profile (K01.FR.05)
// instead of adding a second TxProfile for the transaction (K01.FR.39).

import { chargingNeedsProfileId } from '@evtivity/lib/charging-profile-ids';
import type { PlanSlot } from '@evtivity/lib/charging-plan';
import { limitInUnit, type StationRate } from './load-management.service.js';

export { planProfileHash } from './charging-plan-profile-hash.js';

/** Stack level of the plan's TxProfile, as the ISO 15118 computer sends it. */
export const PLAN_PROFILE_STACK_LEVEL = 1;
/** Periods per schedule when the station reported no bound. */
export const DEFAULT_PLAN_MAX_PERIODS = 24;

export interface PlanProfileInput {
  stationOcppId: string;
  evseId: number;
  transactionId: string;
  /** The plan slots from the current one on. */
  slots: readonly PlanSlot[];
  /** Planned kW per slot, aligned with `slots`. */
  powerKw: readonly number[];
  /** The station's unit and circuit; without one the limit is in W. */
  rate: StationRate | undefined;
  /** The station's period bound (PeriodsPerSchedule, 1.6 ChargingScheduleMaxPeriods). */
  maxPeriods: number;
  now: Date;
  /** Phases the EV charges on, set on each period when fewer than the circuit's (A limits). */
  numberPhases?: number;
  /**
   * Slots in which the EV should precondition its battery (a depot system's
   * preconditioning window), aligned with `slots`. Sent as the OCPP 2.1
   * `preconditioningRequest` of each period; the OCPP server drops the field
   * for 2.0.1 and 1.6 stations, so pass it for 2.1 stations only.
   */
  preconditioning?: readonly boolean[];
}

export interface PlanSchedulePeriod {
  startPeriod: number;
  limit: number;
  numberPhases?: number;
  preconditioningRequest?: boolean;
}

export interface PlanProfilePayload {
  evseId: number;
  chargingProfile: {
    id: number;
    stackLevel: number;
    chargingProfilePurpose: 'TxProfile';
    chargingProfileKind: 'Absolute';
    transactionId: string;
    chargingSchedule: Array<{
      id: number;
      startSchedule: string;
      chargingRateUnit: 'A' | 'W';
      chargingSchedulePeriod: PlanSchedulePeriod[];
    }>;
  };
}

function slotLimit(kw: number, rate: StationRate | undefined): number {
  const watts = Math.max(0, Number.isFinite(kw) ? kw : 0) * 1000;
  const limit = limitInUnit(watts, rate);
  // W to whole watts; limitInUnit already rounds A down to 0.1 A.
  return rate?.rateUnit === 'A' ? limit : Math.floor(limit);
}

/**
 * The plan of one session as an Absolute TxProfile. The schedule starts a
 * minute before the first slot (K01.FR.40: a station clock a little behind
 * applies it at once), equal consecutive limits merge into one period, and
 * periods past the station's bound are dropped: the plan is sent again at
 * every slot boundary, so the station always holds the next hours.
 */
export function buildChargingPlanProfile(input: PlanProfileInput): PlanProfilePayload {
  const firstMs = input.slots[0]?.startMs ?? input.now.getTime();
  const startMs = Math.floor(Math.min(firstMs, input.now.getTime()) / 1000) * 1000 - 60_000;
  const periods: PlanSchedulePeriod[] = [];
  const withFlags = input.preconditioning?.some((flag) => flag) === true;
  input.slots.forEach((slot, i) => {
    const limit = slotLimit(input.powerKw[i] ?? 0, input.rate);
    const precondition = withFlags ? input.preconditioning?.[i] === true : undefined;
    const last = periods[periods.length - 1];
    if (last != null && last.limit === limit && last.preconditioningRequest === precondition) {
      return;
    }
    periods.push({
      startPeriod: i === 0 ? 0 : Math.round((slot.startMs - startMs) / 1000),
      limit,
      ...(input.numberPhases != null ? { numberPhases: input.numberPhases } : {}),
      ...(precondition != null ? { preconditioningRequest: precondition } : {}),
    });
  });
  if (periods.length === 0) {
    periods.push({
      startPeriod: 0,
      limit: 0,
      ...(input.numberPhases != null ? { numberPhases: input.numberPhases } : {}),
    });
  }
  const maxPeriods = Math.max(1, Math.floor(input.maxPeriods));
  const id = chargingNeedsProfileId(input.stationOcppId, input.transactionId);
  return {
    evseId: input.evseId,
    chargingProfile: {
      id,
      stackLevel: PLAN_PROFILE_STACK_LEVEL,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Absolute',
      transactionId: input.transactionId,
      chargingSchedule: [
        {
          id,
          startSchedule: new Date(startMs).toISOString(),
          chargingRateUnit: input.rate?.rateUnit ?? 'W',
          chargingSchedulePeriod: periods.slice(0, maxPeriods),
        },
      ],
    },
  };
}
