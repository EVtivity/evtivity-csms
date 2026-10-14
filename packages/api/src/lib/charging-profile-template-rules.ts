// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// OCPP 1.6 knows only the station maximum (ChargePointMaxProfile, sent as the
// 2.1 name and mapped by the command translation) and TxDefaultProfile.
const TEMPLATE_PROFILE_PURPOSES_16: ReadonlySet<string> = new Set([
  'ChargingStationMaxProfile',
  'TxDefaultProfile',
]);

/** The fields of a template that must agree with each other. */
export interface TemplateState {
  ocppVersion: string;
  profilePurpose: string;
  profileKind: string;
  recurrencyKind?: string | null | undefined;
  schedulePeriods: unknown;
  startSchedule?: Date | string | null | undefined;
  validFrom?: Date | string | null | undefined;
  validTo?: Date | string | null | undefined;
}

function toTime(value: Date | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * The first rule a template breaks, or null. Checked on create, on the merged
 * result of a PATCH and before a push, so no request can store or send a
 * profile the station must reject.
 */
export function templateStateError(state: TemplateState): string | null {
  if (state.ocppVersion === '1.6' && !TEMPLATE_PROFILE_PURPOSES_16.has(state.profilePurpose)) {
    return `profilePurpose ${state.profilePurpose} is not available in OCPP 1.6`;
  }
  if (
    state.profileKind === 'Recurring' &&
    (state.recurrencyKind == null || state.recurrencyKind === '')
  ) {
    return 'recurrencyKind is required when profileKind is Recurring';
  }
  // K01.FR.40: an Absolute or Recurring profile carries startSchedule.
  if (toTime(state.startSchedule) == null) {
    return `startSchedule is required when profileKind is ${state.profileKind}`;
  }
  const periods = Array.isArray(state.schedulePeriods)
    ? (state.schedulePeriods as Array<{ startPeriod?: unknown }>)
    : [];
  if (periods.length === 0) return 'At least one schedule period is required';
  // K01.FR.31: the first period starts at 0. Later periods strictly ascend.
  if (periods[0]?.startPeriod !== 0) return 'The first schedule period must start at 0';
  for (let i = 1; i < periods.length; i++) {
    if (Number(periods[i]?.startPeriod) <= Number(periods[i - 1]?.startPeriod)) {
      return 'schedulePeriods must be ordered by strictly increasing startPeriod';
    }
  }
  const from = toTime(state.validFrom);
  const to = toTime(state.validTo);
  if (from != null && to != null && from >= to) return 'validFrom must be strictly before validTo';
  return null;
}
