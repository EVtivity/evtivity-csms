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

export type SignalBars = 0 | 1 | 2 | 3 | 4;

/**
 * RSSI bands for the 0 to 4 signal bars, in dBm (lower bound of each bar).
 * Digi, "Signal strength for 3G and 2G cellular connections" (Digi IX/TX
 * device OS user guide, 90002399): Excellent > -70 dBm, Good -70 to -85 dBm,
 * Fair -86 to -100 dBm, Poor below -100 to -109 dBm, No service -110 dBm,
 * https://docs.digi.com/resources/documentation/digidocs/90002399/os/cell-signal-strength-3g2g-r.htm
 * The -70 and -85 dBm edges match ChargePoint's CPF32 site design guide,
 * Connectivity (greater than -70 dBm Excellent, -70 to -85 dBm Acceptable).
 * Like `gradeSignal`, these are RSSI bands: an LTE modem that reports RSRP
 * reads lower than its link.
 */
export const SIGNAL_BAR_MIN_DBM = Object.freeze({
  four: -69,
  three: -85,
  two: -100,
  one: -109,
});

/** Bars 0 to 4 for a dBm value; null when the value is unknown or misread (positive). */
export function signalBars(dbm: number | null | undefined): SignalBars | null {
  if (dbm == null || !Number.isFinite(dbm) || dbm > 0) return null;
  // Integer dBm: "> -70" is -69 and above; bands are inclusive at their lower edge.
  const value = Math.round(dbm);
  if (value >= SIGNAL_BAR_MIN_DBM.four) return 4;
  if (value >= SIGNAL_BAR_MIN_DBM.three) return 3;
  if (value >= SIGNAL_BAR_MIN_DBM.two) return 2;
  if (value >= SIGNAL_BAR_MIN_DBM.one) return 1;
  return 0;
}
