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
