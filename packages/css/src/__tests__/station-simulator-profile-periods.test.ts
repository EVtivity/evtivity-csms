// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The simulator charges at the charging schedule period active now: a plan of
// several periods changes the power at each period start, and the station-wide
// limit still caps it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StationConfig } from '../station-simulator.js';
import { liveHarness, makeHarness, silenceConsole, type Harness } from './sim-harness.js';

const T0 = Date.parse('2026-11-01T02:00:00.000Z');

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function limitFor(h: Harness, evseId = 1): number | null {
  return (h.p['powerLimitFor'] as (id: number) => number | null).call(h.sim, evseId);
}

function profiles(h: Harness): Map<number, Record<string, unknown>> {
  return h.p['chargingProfilesCache'] as Map<number, Record<string, unknown>>;
}

function powerW(h: Harness, evseId = 1): number {
  return (
    (h.p['meterGens'] as Map<number, { currentPowerW: number }>).get(evseId)?.currentPowerW ?? 0
  );
}

function planProfile(
  transactionId: string,
  periods: Array<{ startPeriod: number; limit: number }>,
  unit: 'W' | 'A' = 'W',
): Record<string, unknown> {
  return {
    id: 3000,
    stackLevel: 1,
    chargingProfilePurpose: 'TxProfile',
    chargingProfileKind: 'Absolute',
    transactionId,
    chargingSchedule: [
      {
        id: 1,
        chargingRateUnit: unit,
        startSchedule: new Date(T0).toISOString(),
        chargingSchedulePeriod: periods,
      },
    ],
  };
}

async function charging(h: Harness): Promise<string> {
  await h.sim.plugIn(1);
  return h.sim.startCharging(1, 'CARD-1');
}

describe('Charging schedule periods over time (2.1)', () => {
  it('changes the power at each period start of a TxProfile', async () => {
    const h = await liveHarness('ocpp2.1');
    const txId = await charging(h);
    const res = await h.invoke('SetChargingProfile', {
      evseId: 1,
      chargingProfile: planProfile(txId, [
        { startPeriod: 0, limit: 11000 },
        { startPeriod: 900, limit: 3000 },
        { startPeriod: 1800, limit: 7000 },
      ]),
    });
    expect(res).toEqual({ status: 'Accepted' });
    expect(limitFor(h)).toBe(11000);

    vi.advanceTimersByTime(900_000);
    expect(limitFor(h)).toBe(3000);
    expect(powerW(h)).toBeLessThanOrEqual(3000);

    vi.advanceTimersByTime(900_000);
    expect(limitFor(h)).toBe(7000);
    expect(powerW(h)).toBeLessThanOrEqual(7000);
    expect(powerW(h)).toBeGreaterThan(3000);
  });

  it('keeps the station-wide limit as a cap over the plan', async () => {
    const h = await liveHarness('ocpp2.1');
    const txId = await charging(h);
    await h.invoke('SetChargingProfile', {
      evseId: 0,
      chargingProfile: {
        id: 1_000_000_000,
        stackLevel: 0,
        chargingProfilePurpose: 'ChargingStationMaxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: [
          {
            id: 1,
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 5000 }],
          },
        ],
      },
    });
    await h.invoke('SetChargingProfile', {
      evseId: 1,
      chargingProfile: planProfile(txId, [
        { startPeriod: 0, limit: 11000 },
        { startPeriod: 600, limit: 2000 },
      ]),
    });
    expect(limitFor(h)).toBe(5000);
    vi.advanceTimersByTime(600_000);
    expect(limitFor(h)).toBe(2000);
  });

  it('converts a plan in amps with the EVSE voltage and phases', async () => {
    const h = await liveHarness('ocpp2.1');
    const txId = await charging(h);
    await h.invoke('SetChargingProfile', {
      evseId: 1,
      chargingProfile: planProfile(txId, [{ startPeriod: 0, limit: 16 }], 'A'),
    });
    // 16 A per phase x 230 V x 3 phases.
    expect(limitFor(h)).toBe(11040);
  });

  it('charges unlimited again once the plan has ended', async () => {
    const h = await liveHarness('ocpp2.1');
    const txId = await charging(h);
    const profile = planProfile(txId, [{ startPeriod: 0, limit: 4000 }]);
    (profile['chargingSchedule'] as Array<Record<string, unknown>>)[0]!['duration'] = 1200;
    await h.invoke('SetChargingProfile', { evseId: 1, chargingProfile: profile });
    expect(limitFor(h)).toBe(4000);
    vi.advanceTimersByTime(1_200_000);
    expect(limitFor(h)).toBeNull();
  });

  it('applies a TxProfile only to its own transaction', async () => {
    const h = await liveHarness('ocpp2.1');
    const txId = await charging(h);
    await h.invoke('SetChargingProfile', {
      evseId: 1,
      chargingProfile: planProfile(txId, [{ startPeriod: 0, limit: 4000 }]),
    });
    expect(limitFor(h)).toBe(4000);
    await h.sim.stopCharging(1, 'Local');
    await h.sim.unplug(1);
    await charging(h);
    expect(limitFor(h)).toBeNull();
  });

  it('draws more than its limit by the code-only follow error', async () => {
    const h = await liveHarness('ocpp2.1');
    (h.p['config'] as StationConfig).profileFollowError = 0.1;
    const txId = await charging(h);
    await h.invoke('SetChargingProfile', {
      evseId: 1,
      chargingProfile: planProfile(txId, [{ startPeriod: 0, limit: 10000 }]),
    });
    expect(limitFor(h)).toBeCloseTo(11000, 6);
  });
});

describe('Charging schedule periods over time (1.6)', () => {
  it('follows the periods of a TxProfile and drops it with its transaction', async () => {
    let nextTxId = 500;
    const h = await liveHarness('ocpp1.6', (action) =>
      action === 'StartTransaction'
        ? { transactionId: nextTxId++, idTagInfo: { status: 'Accepted' } }
        : undefined,
    );
    await charging(h);
    const res = await h.invoke('SetChargingProfile', {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 30,
        stackLevel: 1,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: {
          chargingRateUnit: 'W',
          startSchedule: new Date(T0).toISOString(),
          chargingSchedulePeriod: [
            { startPeriod: 0, limit: 9000 },
            { startPeriod: 900, limit: 4500 },
          ],
        },
      },
    });
    expect(res).toEqual({ status: 'Accepted' });
    expect(limitFor(h)).toBe(9000);
    vi.advanceTimersByTime(900_000);
    expect(limitFor(h)).toBe(4500);

    await h.sim.stopCharging(1, 'Local');
    expect(profiles(h).has(30)).toBe(false);
    await h.sim.unplug(1);
    await charging(h);
    expect(limitFor(h)).toBeNull();
  });

  it('clears only the profiles matching the ClearChargingProfile criteria', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    const set = (id: number, purpose: string, stackLevel: number, limit: number) =>
      h.invoke('SetChargingProfile', {
        connectorId: id === 3 ? 0 : 1,
        csChargingProfiles: {
          chargingProfileId: id,
          stackLevel,
          chargingProfilePurpose: purpose,
          chargingProfileKind: 'Absolute',
          chargingSchedule: {
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [{ startPeriod: 0, limit }],
          },
        },
      });
    await set(1, 'TxDefaultProfile', 0, 6000);
    await set(2, 'TxDefaultProfile', 1, 5000);
    await set(3, 'ChargePointMaxProfile', 0, 9000);

    expect(await h.invoke('ClearChargingProfile', { id: 99 })).toEqual({ status: 'Unknown' });
    expect(
      await h.invoke('ClearChargingProfile', {
        chargingProfilePurpose: 'TxDefaultProfile',
        stackLevel: 1,
      }),
    ).toEqual({ status: 'Accepted' });
    expect([...profiles(h).keys()].sort()).toEqual([1, 3]);
    expect(limitFor(h)).toBe(6000);
    expect(await h.invoke('ClearChargingProfile', { connectorId: 0 })).toEqual({
      status: 'Accepted',
    });
    expect([...profiles(h).keys()]).toEqual([1]);
    expect(await h.invoke('ClearChargingProfile', {})).toEqual({ status: 'Accepted' });
    expect(profiles(h).size).toBe(0);
    expect(await h.invoke('ClearChargingProfile', {})).toEqual({ status: 'Unknown' });
  });
});

describe('TxProfile lifetime and station-wide limits', () => {
  const remoteStartProfile = {
    id: 40,
    stackLevel: 0,
    chargingProfilePurpose: 'TxProfile',
    chargingProfileKind: 'Relative',
    chargingSchedule: [
      { id: 1, chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: 5000 }] },
    ],
  };

  it('ties the TxProfile of a remote start to its transaction and drops it at the end', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    const res = await h.invoke('RequestStartTransaction', {
      idToken: { idToken: 'CARD-1', type: 'ISO14443' },
      remoteStartId: 7,
      evseId: 1,
      chargingProfile: remoteStartProfile,
    });
    expect(res['status']).toBe('Accepted');
    await vi.waitFor(() => expect(limitFor(h)).toBe(5000));

    // GetCompositeSchedule reads the same profiles as the meter loop.
    const gcs = await h.invoke('GetCompositeSchedule', {
      evseId: 1,
      duration: 60,
      chargingRateUnit: 'W',
    });
    const schedule = gcs['schedule'] as { chargingSchedulePeriod: Array<{ limit: number }> };
    expect(schedule.chargingSchedulePeriod[0]?.limit).toBe(5000);

    await h.sim.stopCharging(1, 'Local');
    expect(profiles(h).has(40)).toBe(false);
    await h.sim.unplug(1);
    await charging(h);
    expect(limitFor(h)).toBeNull();
  });

  it('shares external constraints on EVSE 0 across the charging EVSEs', async () => {
    const evse = { connectorType: 'ac_type2' as const, maxPowerW: 22000, phases: 3, voltage: 230 };
    const h = await makeHarness({
      config: {
        evses: [
          { ...evse, evseId: 1, connectorId: 1 },
          { ...evse, evseId: 2, connectorId: 1 },
        ],
      },
    });
    await h.invoke('SetChargingProfile', {
      evseId: 0,
      chargingProfile: {
        id: 50,
        stackLevel: 0,
        chargingProfilePurpose: 'ChargingStationExternalConstraints',
        chargingProfileKind: 'Absolute',
        chargingSchedule: [
          {
            id: 1,
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 10000 }],
          },
        ],
      },
    });
    const active = h.p['activeTransactionIds'] as Map<number, string>;
    active.set(1, 'tx-1');
    active.set(2, 'tx-2');
    expect(limitFor(h, 1)).toBe(5000);
    expect(limitFor(h, 2)).toBe(5000);
  });

  it('draws nothing for a negative (discharge) limit', async () => {
    const h = await liveHarness('ocpp2.1');
    const txId = await charging(h);
    // The schema allows a negative limit for V2X; set it directly, as a station could hold one.
    profiles(h).set(60, {
      ...planProfile(txId, [{ startPeriod: 0, limit: -3000 }]),
      _evseId: 1,
      _setAt: new Date(T0).toISOString(),
    });
    expect(limitFor(h)).toBe(0);
  });
});

describe('Full battery', () => {
  it('reports SuspendedEV once the battery is full', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugInEv(1, { socPercent: 100 });
    await h.sim.startCharging(1, 'CARD-1');
    await vi.advanceTimersByTimeAsync(120_000);
    const states = h
      .sent('TransactionEvent')
      .filter((e) => e['triggerReason'] === 'ChargingStateChanged')
      .map((e) => (e['transactionInfo'] as { chargingState?: string }).chargingState);
    const suspended = states.at(-1) === 'SuspendedEV';
    expect(suspended).toBe(true);
    expect(powerW(h)).toBe(0);
  });
});
