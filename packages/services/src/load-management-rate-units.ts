// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ChargingRateUnit, StationPowerInfo } from './load-management-model.js';

// Configuration variables naming the units a station takes in a charging
// schedule: 2.1 SmartChargingCtrlr.RateUnit ("A,W"), 1.6
// ChargingScheduleAllowedChargingRateUnit ("Current,Power").
export const RATE_UNIT_VARIABLES = ['RateUnit', 'ChargingScheduleAllowedChargingRateUnit'] as const;

// 2.1 SmartChargingCtrlr.MaxExternalConstraintsId: profile ids up to it are
// the station's own (external constraints); the CSMS chooses ids above it
// (K01.FR.80) and the station rejects the others (K01.FR.81).
export const MAX_EXTERNAL_CONSTRAINTS_ID_VARIABLE = 'MaxExternalConstraintsId';

// The highest stack level a station takes: 2.1 SmartChargingCtrlr.ProfileStackLevel,
// 1.6 ChargeProfileMaxStackLevel (OCPP 1.6 section 9.4.1).
export const PROFILE_STACK_LEVEL_VARIABLES = [
  'ProfileStackLevel',
  'ChargeProfileMaxStackLevel',
] as const;

/** The units a station reports it takes in a charging schedule (empty: none reported). */
export function supportedRateUnits(reported: readonly string[]): ChargingRateUnit[] {
  const units = new Set<ChargingRateUnit>();
  for (const value of reported) {
    for (const part of value.split(',')) {
      const unit = part.trim();
      if (unit === 'W' || unit === 'Power') units.add('W');
      if (unit === 'A' || unit === 'Current') units.add('A');
    }
  }
  return (['A', 'W'] as const).filter((u) => units.has(u));
}

/**
 * The unit load management sends a station its limit in (K01.FR.26: a station
 * rejects a unit it does not support): A whenever it supports A, on any
 * circuit, since an A limit bounds the current of every phase and a W limit
 * only the total; else W, also when it reports nothing.
 */
export function chargingRateUnitFor(reported: readonly string[]): ChargingRateUnit {
  return supportedRateUnits(reported).includes('A') ? 'A' : 'W';
}

/**
 * The unit a station is sent its limit in: its preferred unit (`rateUnit`)
 * unless it rejected it, else the other unit when the station may take it (it
 * reports it, or reports no unit). A station that rejected every unit it may
 * take is sent the preferred one again; it stays a fixed load meanwhile.
 */
export function sendRateUnit(
  station: Pick<StationPowerInfo, 'rateUnit' | 'supportedRateUnits'>,
  rejected: readonly ChargingRateUnit[],
): ChargingRateUnit {
  const other: ChargingRateUnit = station.rateUnit === 'W' ? 'A' : 'W';
  const supported = station.supportedRateUnits ?? [];
  const candidates: ChargingRateUnit[] = [station.rateUnit];
  if (supported.length === 0 || supported.includes(other)) candidates.push(other);
  return candidates.find((u) => !rejected.includes(u)) ?? station.rateUnit;
}
