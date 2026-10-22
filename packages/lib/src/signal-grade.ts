// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Cellular signal values a station reports (OCPP DataLink.SignalStrength) and
 * their grade. Browser-safe: the CSMS imports `@evtivity/lib/signal-grade`.
 *
 * The grade applies RSSI thresholds (default -65 dBm good, -85 dBm fair, after
 * ChargePoint's cellular signal reading guide). OCPP does not say which radio
 * measure a modem reports, so an LTE modem that reports RSRP grades lower than
 * its link quality.
 */

import { SIM_SIGNAL_DEFAULTS } from './sim-settings.js';

export type SignalGrade = 'good' | 'fair' | 'poor' | 'unknown';

export type SignalUnit = 'dBm' | 'ASU';

/** The ASU value modems report when the signal is not known. */
export const SIGNAL_ASU_UNKNOWN = 99;

const ASU_MAX = 31;

export interface SignalThresholds {
  goodDbm: number;
  fairDbm: number;
}

export interface SignalReading {
  /** The value as the station reported it. */
  value: number;
  unit: SignalUnit;
  /** True when the unit was not reported and came from the value's range. */
  inferred: boolean;
  /** The value in dBm, null when the station reports it as unknown (ASU 99). */
  dbm: number | null;
}

/** GSM ASU to dBm (3GPP TS 27.007: 0 is -113 dBm or less, 31 is -51 dBm or more). */
export function asuToDbm(asu: number): number | null {
  if (!Number.isFinite(asu) || asu === SIGNAL_ASU_UNKNOWN || asu < 0 || asu > ASU_MAX) return null;
  return 2 * Math.round(asu) - 113;
}

function unitOf(unit: string | null | undefined): SignalUnit | null {
  const name = unit?.trim().toLowerCase();
  if (name === 'dbm' || name === 'dbmw') return 'dBm';
  if (name === 'asu') return 'ASU';
  return null;
}

/**
 * A reported signal value with its unit: the unit the station reported, else
 * one inferred from the range (99 unknown, 0 to 31 ASU, negative dBm). Null
 * when the value is not a number or fits no unit.
 */
export function readSignalStrength(
  value: string | number | null | undefined,
  unit?: string | null,
): SignalReading | null {
  if (value == null) return null;
  const number = typeof value === 'number' ? value : Number(value.trim());
  if (typeof value === 'string' && value.trim() === '') return null;
  if (!Number.isFinite(number)) return null;
  const reported = unitOf(unit);
  if (reported === 'dBm') return { value: number, unit: 'dBm', inferred: false, dbm: number };
  if (reported === 'ASU') {
    return { value: number, unit: 'ASU', inferred: false, dbm: asuToDbm(number) };
  }
  if (number === SIGNAL_ASU_UNKNOWN || (number >= 0 && number <= ASU_MAX)) {
    return { value: number, unit: 'ASU', inferred: true, dbm: asuToDbm(number) };
  }
  if (number < 0) return { value: number, unit: 'dBm', inferred: true, dbm: number };
  return null;
}

/**
 * Good at or above `goodDbm`, fair at or above `fairDbm`, else poor. An ASU
 * value is converted first; an unknown or missing value is `unknown`.
 */
export function gradeSignal(
  input: { dbm: number | null } | { asu: number | null },
  thresholds: SignalThresholds = SIM_SIGNAL_DEFAULTS,
): SignalGrade {
  const dbm = 'asu' in input ? (input.asu == null ? null : asuToDbm(input.asu)) : input.dbm;
  // A received cellular signal is always below 0 dBm; a positive value is a misread unit.
  if (dbm == null || !Number.isFinite(dbm) || dbm > 0) return 'unknown';
  if (dbm >= thresholds.goodDbm) return 'good';
  if (dbm >= thresholds.fairDbm) return 'fair';
  return 'poor';
}
