// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Batteries and solar as supply in load management, fail closed: an asset
// credits power above its connection point only while a fresh reading says
// the power is there, never more than its nameplate, and a battery without a
// fresh reading that may charge from the grid counts as a load at its full
// charge rate (owner decision D9). The CSMS is not a listed energy management
// system (NEC 750.6), so missing data never raises a limit (the 750.30(C)(2)
// principle: cease on malfunction). Browser-safe: the CSMS imports the
// constants.

export const ENERGY_ASSET_TYPES = ['battery', 'solar'] as const;
export type EnergyAssetType = (typeof ENERGY_ASSET_TYPES)[number];

/** `possible`: the battery may charge from the grid, so without data it counts as a load. */
export const ENERGY_ASSET_GRID_CHARGING = ['never', 'possible'] as const;
export type EnergyAssetGridCharging = (typeof ENERGY_ASSET_GRID_CHARGING)[number];

/**
 * Where readings come from: `none` (informational, no supply), `api` (an
 * external EMS, BMS or gateway pushes them), `simulated` (development and
 * demos only, behind ENERGY_ASSETS_ALLOW_SIMULATED).
 */
export const ENERGY_ASSET_TELEMETRY = ['none', 'api', 'simulated'] as const;
export type EnergyAssetTelemetry = (typeof ENERGY_ASSET_TELEMETRY)[number];

export const ENERGY_ASSET_READING_SOURCES = ['api', 'simulated'] as const;
export type EnergyAssetReadingSource = (typeof ENERGY_ASSET_READING_SOURCES)[number];

/** How long a reading counts as fresh, seconds. */
export const ENERGY_ASSET_READING_TTL_RANGE = { min: 15, max: 600, default: 60 } as const;

/** Battery state of charge at or below which it gives no credit, percent. */
export const ENERGY_ASSET_RESERVE_RANGE = { min: 0, max: 100, default: 10 } as const;

/** Capacity (kWh), peak (kWp) and power ratings (kW) an operator may enter. */
export const ENERGY_ASSET_RATING_RANGE = { min: 1, max: 100_000 } as const;

/** A reported power, kW: positive output or discharge, negative charging. */
export const ENERGY_ASSET_READING_POWER_RANGE = { min: -100_000, max: 100_000 } as const;

/** A reading further in the future than this counts as stale (clock skew). */
export const ENERGY_ASSET_FUTURE_SKEW_MS = 30_000;

export interface EnergyAssetSupplyInput {
  type: EnergyAssetType;
  inverterKw: number | null;
  /** Solar DC peak, kWp: the cap when no inverter rating is known. */
  peakKwp: number | null;
  maxDischargeKw: number | null;
  maxChargeKw: number | null;
  gridCharging: EnergyAssetGridCharging;
  reservePercent: number;
  ttlSeconds: number;
  reading: {
    /** When the CSMS received the reading. */
    receivedAtMs: number;
    /** When the asset measured it (the sender's `reportedAt`). */
    reportedAtMs: number;
    powerKw: number;
    availableKw: number | null;
    socPercent: number | null;
  } | null;
}

export interface EnergyAssetSupply {
  /** Firm supply credited above the connection point, kW, >= 0. */
  creditKw: number;
  /**
   * Load the asset may add at its connection point (battery charging), kW,
   * >= 0. Null: unknown, a battery that may charge from the grid with no
   * fresh reading and no `maxChargeKw` or `inverterKw`. It is never 0 (D9):
   * the caller counts the most the connection point carries.
   */
  loadKw: number | null;
  state: 'fresh' | 'stale' | 'none';
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

/** The smallest of the known ratings, or null when none is known. */
function lowestRating(...ratings: Array<number | null>): number | null {
  const known = ratings.filter((r): r is number => r != null);
  return known.length === 0 ? null : Math.min(...known);
}

/**
 * Whether a reading is fresh at `nowMs`. Its age counts from the earlier of
 * when it was measured and when it was received, so a reading sent near the
 * end of its lifetime does not count for another full lifetime (security
 * review, case 333).
 */
export function isEnergyAssetReadingFresh(
  reading: { receivedAtMs: number; reportedAtMs: number },
  ttlSeconds: number,
  nowMs: number,
): boolean {
  const measuredAtMs = Math.min(reading.receivedAtMs, reading.reportedAtMs);
  return (
    nowMs - measuredAtMs <= ttlSeconds * 1000 && measuredAtMs - nowMs <= ENERGY_ASSET_FUTURE_SKEW_MS
  );
}

/**
 * The time a reading stops being fresh, ms: its measurement time (the earlier
 * of when it was measured and when it was received, as
 * `isEnergyAssetReadingFresh`) plus the asset's TTL. Load management sends
 * limits that rest on the reading only until then (security case 334).
 */
export function energyAssetReadingFreshUntilMs(
  reading: { receivedAtMs: number; reportedAtMs: number },
  ttlSeconds: number,
): number {
  return Math.min(reading.receivedAtMs, reading.reportedAtMs) + ttlSeconds * 1000;
}

/**
 * The supply an asset gives load management at `nowMs`. Every bound is the
 * nameplate, so an inflated reading never credits more than the rating; an
 * asset without a rating credits nothing. Where the credit counts (the strict
 * ancestors of the connection point, D8) is the caller's job.
 */
export function energyAssetSupply(input: EnergyAssetSupplyInput, nowMs: number): EnergyAssetSupply {
  const { reading } = input;
  if (reading == null || !isEnergyAssetReadingFresh(reading, input.ttlSeconds, nowMs)) {
    // An unrated battery that may charge from the grid: unknown, not 0 (the
    // writer refuses to connect one, a row stored before still counts).
    const loadKw =
      input.type === 'battery' && input.gridCharging === 'possible'
        ? (input.maxChargeKw ?? input.inverterKw ?? null)
        : 0;
    return { creditKw: 0, loadKw, state: reading == null ? 'none' : 'stale' };
  }

  if (input.type === 'solar') {
    const cap = input.inverterKw ?? input.peakKwp;
    const output = Math.max(reading.powerKw, reading.availableKw ?? 0);
    return { creditKw: cap == null ? 0 : clamp(output, cap), loadKw: 0, state: 'fresh' };
  }

  if (reading.powerKw < 0) return { creditKw: 0, loadKw: -reading.powerKw, state: 'fresh' };
  if (reading.socPercent != null && reading.socPercent <= input.reservePercent) {
    return { creditKw: 0, loadKw: 0, state: 'fresh' };
  }
  const cap = lowestRating(input.maxDischargeKw, input.inverterKw);
  const offered = reading.availableKw ?? reading.powerKw;
  return { creditKw: cap == null ? 0 : clamp(offered, cap), loadKw: 0, state: 'fresh' };
}
