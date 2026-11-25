// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { LoadAllocationEntryInput } from '@evtivity/database';
import type { LoadAllocationReason } from '@evtivity/lib/load-allocation-reasons';
import { effectiveBalancingMode } from './evse-limits.js';
import type { AllocationSend, PreparedLimitCommand } from './load-management-send.js';
import type { ChargingRateUnit, StationPowerInfo } from './load-management-model.js';

interface ProfileFields {
  profileId: number;
  stackLevel: number;
  purpose: string;
  rateUnit: ChargingRateUnit;
  limit: number | null;
  numberPhases: number | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function profileFields(payload: Record<string, unknown>): ProfileFields {
  const profile = (payload['chargingProfile'] ?? {}) as Record<string, unknown>;
  const schedules = profile['chargingSchedule'];
  const schedule = (Array.isArray(schedules) ? schedules[0] : undefined) as
    | Record<string, unknown>
    | undefined;
  const periods = schedule?.['chargingSchedulePeriod'];
  const period = (Array.isArray(periods) ? periods[0] : undefined) as
    | Record<string, unknown>
    | undefined;
  return {
    profileId: numberOrNull(profile['id']) ?? 0,
    stackLevel: numberOrNull(profile['stackLevel']) ?? 0,
    purpose:
      typeof profile['chargingProfilePurpose'] === 'string'
        ? profile['chargingProfilePurpose']
        : '',
    rateUnit: schedule?.['chargingRateUnit'] === 'A' ? 'A' : 'W',
    limit: numberOrNull(period?.['limit']),
    numberPhases: numberOrNull(period?.['numberPhases']),
  };
}

export interface AllocationEntryContext {
  stations: ReadonlyMap<string, StationPowerInfo>;
  /** Stations sent their reservation as the limit (an unconfirmed limit retried). */
  reservedRetries: ReadonlySet<string>;
  /** The send is the periodic resend of unchanged limits, or a credit profile resend. */
  refresh: boolean;
}

function stationEntry(
  command: PreparedLimitCommand & { source: { scope: 'station' } },
  ctx: AllocationEntryContext,
): LoadAllocationEntryInput {
  const fields = profileFields(command.payload);
  const station = ctx.stations.get(command.stationDbId);
  const reason: LoadAllocationReason = ctx.reservedRetries.has(command.stationDbId)
    ? 'reserved'
    : (command.source.command.allocation.limitedBy ?? 'circuit_limit');
  return {
    stationId: command.stationDbId,
    stationOcppId: command.stationId,
    unitId: null,
    evseNumber: null,
    scope: 'station',
    mode: station != null ? effectiveBalancingMode(station) : 'station',
    limitKw: command.kw,
    limitA: fields.rateUnit === 'A' ? fields.limit : null,
    phases: fields.rateUnit === 'A' ? (command.source.rate?.phases ?? null) : null,
    rateUnit: fields.rateUnit,
    reason,
    sessionId: null,
    tariffId: null,
    tariffMaxCurrentA: null,
    profileId: fields.profileId,
    stackLevel: fields.stackLevel,
    purpose: fields.purpose,
    commandId: command.commandId,
    refresh: ctx.refresh,
  };
}

function evseEntry(
  command: PreparedLimitCommand & { source: { scope: 'evse' } },
  ctx: AllocationEntryContext,
): LoadAllocationEntryInput {
  const fields = profileFields(command.payload);
  const limit = command.source.command.limit;
  const session = ctx.stations
    .get(command.stationDbId)
    ?.sessions?.find((s) => s.sessionId === limit.sessionId);
  return {
    stationId: command.stationDbId,
    stationOcppId: command.stationId,
    unitId: limit.unitId,
    evseNumber: limit.evseNumber,
    scope: 'evse',
    mode: 'evse',
    limitKw: limit.limitKw,
    limitA: fields.rateUnit === 'A' ? fields.limit : limit.limitA,
    phases: limit.phases,
    rateUnit: fields.rateUnit,
    reason: limit.reason,
    sessionId: limit.sessionId,
    tariffId: session?.tariffId ?? null,
    tariffMaxCurrentA: session?.kind === 'ac' ? (session.tariffMaxCurrentA ?? null) : null,
    profileId: fields.profileId,
    stackLevel: fields.stackLevel,
    purpose: fields.purpose,
    commandId: command.commandId,
    refresh: ctx.refresh,
  };
}

/** The TxDefaultProfile of one unit box EVSE: no session, the box budget set it. */
function evseDefaultEntry(
  command: PreparedLimitCommand & { source: { scope: 'evseDefault' } },
  ctx: AllocationEntryContext,
): LoadAllocationEntryInput {
  const fields = profileFields(command.payload);
  const value = command.source.command.value;
  return {
    stationId: command.stationDbId,
    stationOcppId: command.stationId,
    unitId: value.unitId,
    evseNumber: value.evseNumber,
    scope: 'evse',
    mode: 'evse',
    limitKw: value.limitKw,
    limitA: fields.rateUnit === 'A' ? fields.limit : value.limitA,
    phases: null,
    rateUnit: fields.rateUnit,
    reason: 'unit_budget',
    sessionId: null,
    tariffId: null,
    tariffMaxCurrentA: null,
    profileId: fields.profileId,
    stackLevel: fields.stackLevel,
    purpose: fields.purpose,
    commandId: command.commandId,
    refresh: ctx.refresh,
  };
}

/** One allocation log entry per SetChargingProfile of a send, in send order. */
export function allocationSendEntries(
  send: AllocationSend,
  ctx: AllocationEntryContext,
): LoadAllocationEntryInput[] {
  return [...send.stationCuts, ...send.evseCuts, ...send.evseRaises, ...send.stationRaises].map(
    (command) =>
      command.source.scope === 'station'
        ? stationEntry(command as PreparedLimitCommand & { source: { scope: 'station' } }, ctx)
        : command.source.scope === 'evse'
          ? evseEntry(command as PreparedLimitCommand & { source: { scope: 'evse' } }, ctx)
          : evseDefaultEntry(
              command as PreparedLimitCommand & { source: { scope: 'evseDefault' } },
              ctx,
            ),
  );
}
