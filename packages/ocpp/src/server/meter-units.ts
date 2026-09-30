// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Measurand of a SampledValue that omits it. OCPP 1.6 (Part 1, SampledValue)
 * and OCPP 2.1 (Part 2, SampledValueType) both define this default.
 */
export const DEFAULT_MEASURAND = 'Energy.Active.Import.Register';

/**
 * Applies the OCPP 2.1 `unitOfMeasure.multiplier`, the power of ten the value
 * is scaled by (multiplier 3 means value * 10^3). The unit stays the same.
 * Negative exponents divide, which keeps decimal results exact
 * (1234 with multiplier -3 is 1.234, not 1.2340000000000002).
 */
export function applyMultiplier(value: number, multiplier: number): number {
  if (multiplier >= 0) return value * 10 ** multiplier;
  return value / 10 ** -multiplier;
}

/**
 * Converts an energy register reading to Wh. A missing unit means Wh (the
 * spec default for Energy measurands). Returns null for any other unit, so
 * a misconfigured station cannot write a non-energy value into session energy.
 */
export function energyToWh(value: number, unit: string | null): number | null {
  if (!Number.isFinite(value)) return null;
  if (unit == null || unit === 'Wh') return value;
  if (unit === 'kWh') return Math.round(value * 1000 * 1000) / 1000;
  return null;
}

// Phases that name a single line. L1-N is measured on L1 against neutral, so it
// is the same line as L1. Line-to-line values (L1-L2) and N are not per-line
// quantities and are never summed.
const LINE_OF_PHASE: Record<string, string> = {
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  'L1-N': 'L1',
  'L2-N': 'L2',
  'L3-N': 'L3',
};

export interface PhaseSample {
  value: number;
  phase: string | null;
}

/**
 * The overall value of one measurand in one MeterValue. A sample without a
 * phase is the overall value (OCPP 1.6 and 2.1 SampledValue.phase: "When phase
 * is absent, the measured value is interpreted as an overall value"). Without
 * one, a station reporting only per-phase values gets the sum of its lines.
 * Returns null when there is nothing to use or a line appears twice.
 */
export function overallValue(samples: PhaseSample[]): number | null {
  const overall = samples.find((sample) => sample.phase == null);
  if (overall != null) return overall.value;

  const byLine = new Map<string, number>();
  for (const sample of samples) {
    const line = sample.phase != null ? LINE_OF_PHASE[sample.phase] : undefined;
    if (line == null) continue;
    if (byLine.has(line)) return null;
    byLine.set(line, sample.value);
  }
  if (byLine.size === 0) return null;
  let sum = 0;
  for (const value of byLine.values()) sum += value;
  return Math.round(sum * 1000) / 1000;
}

/** Location of a SampledValue without one (OCPP 1.6 and 2.1 default). */
export const DEFAULT_LOCATION = 'Outlet';
