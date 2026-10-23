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
 * The shortest time the energy register must stay flat before the meter
 * fallback opens an idle period. A station sends clock-aligned and
 * transaction-end samples a moment after a periodic one, and those show almost
 * no new energy even while the EV charges (finding J3). 30 s is below the
 * usual sample interval (60 s), so a true flat interval still counts.
 */
export const FLAT_ENERGY_MIN_GAP_MS = 30_000;

/**
 * Whether an energy reading shows that no power flowed: it rose less than
 * 1 Wh above the previous reading and the register has not risen for at least
 * FLAT_ENERGY_MIN_GAP_MS (`lastRiseAt`: the reading that last raised it, or
 * the session start).
 */
export function isFlatEnergyReading(args: {
  previousEnergyWh: number;
  energyWh: number;
  lastRiseAt: Date;
  readingAt: Date;
}): boolean {
  if (Math.abs(args.energyWh - args.previousEnergyWh) >= 1) return false;
  const gapMs = args.readingAt.getTime() - args.lastRiseAt.getTime();
  return Number.isFinite(gapMs) && gapMs >= FLAT_ENERGY_MIN_GAP_MS;
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

/**
 * The energy register reading in Wh of an OCPP 2.1 MeterValue list (the
 * meterValue of a TransactionEvent), from the samples that update session
 * energy: Energy.Active.Import.Register (the default measurand) at location
 * Outlet (the default location), multiplier applied, Wh or kWh, one overall
 * value per MeterValue. The register is cumulative, so the highest reading is
 * returned. Null when there is no usable reading.
 */
export function energyRegisterWh(meterValues: unknown): number | null {
  if (!Array.isArray(meterValues)) return null;
  let highest: number | null = null;
  for (const meterValue of meterValues as Array<Record<string, unknown>>) {
    const sampledValues = meterValue.sampledValue;
    if (!Array.isArray(sampledValues)) continue;
    const samples: PhaseSample[] = [];
    for (const sv of sampledValues as Array<Record<string, unknown>>) {
      const measurand = typeof sv.measurand === 'string' ? sv.measurand : DEFAULT_MEASURAND;
      const location = typeof sv.location === 'string' ? sv.location : DEFAULT_LOCATION;
      if (measurand !== DEFAULT_MEASURAND || location !== DEFAULT_LOCATION) continue;
      const unitOfMeasure = sv.unitOfMeasure as Record<string, unknown> | undefined;
      const unit = typeof unitOfMeasure?.unit === 'string' ? unitOfMeasure.unit : null;
      const multiplier =
        typeof unitOfMeasure?.multiplier === 'number' ? unitOfMeasure.multiplier : 0;
      const wh = energyToWh(applyMultiplier(Number(sv.value), multiplier), unit);
      if (wh == null) continue;
      samples.push({ value: wh, phase: typeof sv.phase === 'string' ? sv.phase : null });
    }
    const value = overallValue(samples);
    if (value != null && (highest == null || value > highest)) highest = value;
  }
  return highest;
}

/**
 * Converts a Power.Active.Import reading to W. A missing unit means W (the
 * spec default for Power measurands). Returns null for any other unit.
 */
export function powerToW(value: number, unit: string | null): number | null {
  if (!Number.isFinite(value)) return null;
  if (unit == null || unit === 'W') return value;
  if (unit === 'kW') return Math.round(value * 1000 * 1000) / 1000;
  return null;
}

/**
 * A state of charge reading in percent: unit Percent or none, 0 to 100.
 * Null for anything else.
 */
export function socPercent(value: number, unit: string | null): number | null {
  if (!Number.isFinite(value)) return null;
  if (unit != null && unit !== 'Percent') return null;
  if (value < 0 || value > 100) return null;
  return value;
}

/**
 * The session summary values of one MeterValue's samples (OCPP 1.6 `unit`,
 * OCPP 2.1 `unitOfMeasure` with its multiplier): the overall Outlet
 * Power.Active.Import in W (overallValue: the sample without phase, else the
 * sum of the lines), and the state of charge at any location (an EV reports
 * it at location EV). Every context counts. Stored on the session as
 * peak_power_w and last_soc_percent, which outlive the meter_values retention.
 */
export function readingSummary(sampledValues: unknown): {
  powerW: number | null;
  socPercent: number | null;
} {
  if (!Array.isArray(sampledValues)) return { powerW: null, socPercent: null };
  const power: PhaseSample[] = [];
  let soc: number | null = null;
  for (const sv of sampledValues as Array<Record<string, unknown>>) {
    const measurand = typeof sv.measurand === 'string' ? sv.measurand : DEFAULT_MEASURAND;
    if (measurand !== 'Power.Active.Import' && measurand !== 'SoC') continue;
    const unitOfMeasure = sv.unitOfMeasure as Record<string, unknown> | undefined;
    const unit =
      unitOfMeasure != null
        ? typeof unitOfMeasure.unit === 'string'
          ? unitOfMeasure.unit
          : null
        : typeof sv.unit === 'string'
          ? sv.unit
          : null;
    const multiplier = typeof unitOfMeasure?.multiplier === 'number' ? unitOfMeasure.multiplier : 0;
    const value = applyMultiplier(Number(sv.value), multiplier);
    if (measurand === 'SoC') {
      soc ??= socPercent(value, unit);
      continue;
    }
    const location = typeof sv.location === 'string' ? sv.location : DEFAULT_LOCATION;
    if (location !== DEFAULT_LOCATION) continue;
    const w = powerToW(value, unit);
    if (w == null) continue;
    power.push({ value: w, phase: typeof sv.phase === 'string' ? sv.phase : null });
  }
  return { powerW: overallValue(power), socPercent: soc };
}
