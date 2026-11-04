// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  ENERGY_ASSET_FUTURE_SKEW_MS,
  ENERGY_ASSET_READING_TTL_RANGE,
  energyAssetReadingFreshUntilMs,
  energyAssetSupply,
  type EnergyAssetSupplyInput,
} from '../energy-supply.js';

const NOW = Date.parse('2026-11-03T12:00:00Z');

function battery(overrides: Partial<EnergyAssetSupplyInput> = {}): EnergyAssetSupplyInput {
  return {
    type: 'battery',
    inverterKw: 250,
    peakKwp: null,
    maxDischargeKw: 200,
    maxChargeKw: 150,
    gridCharging: 'possible',
    reservePercent: 10,
    ttlSeconds: 60,
    reading: null,
    ...overrides,
  };
}

function solar(overrides: Partial<EnergyAssetSupplyInput> = {}): EnergyAssetSupplyInput {
  return {
    type: 'solar',
    inverterKw: 100,
    peakKwp: 120,
    maxDischargeKw: null,
    maxChargeKw: null,
    gridCharging: 'never',
    reservePercent: 10,
    ttlSeconds: 60,
    reading: null,
    ...overrides,
  };
}

function reading(
  powerKw: number,
  extra: Partial<NonNullable<EnergyAssetSupplyInput['reading']>> = {},
): NonNullable<EnergyAssetSupplyInput['reading']> {
  return {
    receivedAtMs: NOW - 5_000,
    reportedAtMs: NOW - 5_000,
    powerKw,
    availableKw: null,
    socPercent: null,
    ...extra,
  };
}

describe('energyAssetSupply', () => {
  it('gives no credit without a reading and counts a battery that may charge from the grid as load', () => {
    expect(energyAssetSupply(battery(), NOW)).toEqual({ creditKw: 0, loadKw: 150, state: 'none' });
    expect(energyAssetSupply(solar(), NOW)).toEqual({ creditKw: 0, loadKw: 0, state: 'none' });
  });

  it('falls back to the inverter rating, then unknown (never 0), for the charge load of a stale battery', () => {
    expect(energyAssetSupply(battery({ maxChargeKw: null }), NOW).loadKw).toBe(250);
    const unrated = battery({ maxChargeKw: null, inverterKw: null });
    expect(energyAssetSupply(unrated, NOW)).toEqual({ creditKw: 0, loadKw: null, state: 'none' });
    const stale = {
      ...unrated,
      reading: reading(80, { receivedAtMs: NOW - 61_000, reportedAtMs: NOW - 61_000 }),
    };
    expect(energyAssetSupply(stale, NOW).loadKw).toBeNull();
    // A battery that never charges from the grid adds no load without data.
    expect(energyAssetSupply({ ...unrated, gridCharging: 'never' }, NOW).loadKw).toBe(0);
  });

  it('treats a reading older than its time to live as stale', () => {
    const old = battery({
      reading: reading(80, { receivedAtMs: NOW - 61_000, reportedAtMs: NOW - 61_000 }),
    });
    expect(energyAssetSupply(old, NOW)).toEqual({ creditKw: 0, loadKw: 150, state: 'stale' });
    const edge = battery({
      reading: reading(80, { receivedAtMs: NOW - 60_000, reportedAtMs: NOW - 60_000 }),
    });
    expect(energyAssetSupply(edge, NOW).state).toBe('fresh');
  });

  it('counts the age from when the reading was measured, not only when it arrived', () => {
    // Measured 50 s before it arrived 20 s ago: 70 s old, past its 60 s lifetime.
    const late = battery({
      reading: reading(80, { receivedAtMs: NOW - 20_000, reportedAtMs: NOW - 70_000 }),
    });
    expect(energyAssetSupply(late, NOW).state).toBe('stale');
    // A reading dated after its arrival ages from its arrival.
    const ahead = battery({
      reading: reading(80, { receivedAtMs: NOW - 61_000, reportedAtMs: NOW - 31_000 }),
    });
    expect(energyAssetSupply(ahead, NOW).state).toBe('stale');
  });

  it('treats a reading more than 30 s in the future as stale', () => {
    expect(ENERGY_ASSET_FUTURE_SKEW_MS).toBe(30_000);
    const future = solar({
      reading: reading(50, { receivedAtMs: NOW + 31_000, reportedAtMs: NOW + 31_000 }),
    });
    expect(energyAssetSupply(future, NOW)).toEqual({ creditKw: 0, loadKw: 0, state: 'stale' });
    const skew = solar({
      reading: reading(50, { receivedAtMs: NOW + 30_000, reportedAtMs: NOW + 30_000 }),
    });
    expect(energyAssetSupply(skew, NOW)).toEqual({ creditKw: 50, loadKw: 0, state: 'fresh' });
  });

  it('caps solar at its inverter rating, else its peak', () => {
    expect(energyAssetSupply(solar({ reading: reading(120) }), NOW).creditKw).toBe(100);
    expect(
      energyAssetSupply(solar({ inverterKw: null, reading: reading(150) }), NOW).creditKw,
    ).toBe(120);
    expect(
      energyAssetSupply(solar({ inverterKw: null, peakKwp: null, reading: reading(50) }), NOW)
        .creditKw,
    ).toBe(0);
  });

  it('credits the larger of the solar output and what the controller says is available', () => {
    expect(
      energyAssetSupply(solar({ reading: reading(20, { availableKw: 80 }) }), NOW).creditKw,
    ).toBe(80);
    expect(energyAssetSupply(solar({ reading: reading(-5) }), NOW).creditKw).toBe(0);
  });

  it('counts a charging battery as load and gives it no credit', () => {
    expect(energyAssetSupply(battery({ reading: reading(-30) }), NOW)).toEqual({
      creditKw: 0,
      loadKw: 30,
      state: 'fresh',
    });
  });

  it('gives no credit at or below the reserve state of charge', () => {
    expect(
      energyAssetSupply(battery({ reading: reading(50, { socPercent: 10 }) }), NOW).creditKw,
    ).toBe(0);
    expect(
      energyAssetSupply(battery({ reading: reading(50, { socPercent: 11 }) }), NOW).creditKw,
    ).toBe(50);
  });

  it('credits what is available over the output, capped at the discharge and inverter ratings', () => {
    expect(
      energyAssetSupply(battery({ reading: reading(20, { availableKw: 80 }) }), NOW).creditKw,
    ).toBe(80);
    expect(
      energyAssetSupply(battery({ reading: reading(20, { availableKw: 900 }) }), NOW).creditKw,
    ).toBe(200);
    expect(
      energyAssetSupply(
        battery({ maxDischargeKw: null, reading: reading(20, { availableKw: 900 }) }),
        NOW,
      ).creditKw,
    ).toBe(250);
    expect(
      energyAssetSupply(
        battery({ maxDischargeKw: null, inverterKw: null, reading: reading(20) }),
        NOW,
      ).creditKw,
    ).toBe(0);
  });

  it('adds no load for a stale battery that never charges from the grid', () => {
    expect(energyAssetSupply(battery({ gridCharging: 'never' }), NOW)).toEqual({
      creditKw: 0,
      loadKw: 0,
      state: 'none',
    });
  });

  it('keeps the reading time to live range in one place', () => {
    expect(ENERGY_ASSET_READING_TTL_RANGE).toEqual({ min: 15, max: 600, default: 60 });
  });
});

describe('energyAssetReadingFreshUntilMs (security case 334)', () => {
  it('ends a reading its TTL after the earlier of when it was measured and received', () => {
    expect(
      energyAssetReadingFreshUntilMs({ receivedAtMs: NOW, reportedAtMs: NOW - 20_000 }, 60),
    ).toBe(NOW + 40_000);
    // A reading dated ahead of its arrival ends a TTL after it arrived.
    expect(
      energyAssetReadingFreshUntilMs({ receivedAtMs: NOW, reportedAtMs: NOW + 20_000 }, 60),
    ).toBe(NOW + 60_000);
  });
});
