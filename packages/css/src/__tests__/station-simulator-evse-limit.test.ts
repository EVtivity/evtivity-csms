// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// An AC EVSE cannot charge below 6 A per phase (IEC 61851-1): under a lower limit it
// draws nothing and reports SuspendedEVSE once, and charges again at 6 A or more.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StationConfig } from '../station-simulator.js';
import { liveHarness, priv, silenceConsole, type Harness } from './sim-harness.js';

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

function powerW(h: Harness, evseId = 1): number {
  return (
    (priv(h, 'meterGens') as Map<number, { currentPowerW: number }>).get(evseId)?.currentPowerW ?? 0
  );
}

function chargingStates(h: Harness): unknown[] {
  return h
    .sent('TransactionEvent')
    .filter((e) => e['triggerReason'] === 'ChargingStateChanged')
    .map((e) => (e['transactionInfo'] as Record<string, unknown>)['chargingState']);
}

function statuses(h: Harness): unknown[] {
  return h.sent('StatusNotification').map((s) => s['status']);
}

function txProfile21(txId: string, limitA: number): Record<string, unknown> {
  return {
    evseId: 1,
    chargingProfile: {
      id: 3000,
      stackLevel: 1,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Absolute',
      transactionId: txId,
      chargingSchedule: [
        {
          id: 1,
          chargingRateUnit: 'A',
          startSchedule: new Date(T0).toISOString(),
          chargingSchedulePeriod: [{ startPeriod: 0, limit: limitA }],
        },
      ],
    },
  };
}

function txProfile16(limitA: number): Record<string, unknown> {
  return {
    connectorId: 1,
    csChargingProfiles: {
      chargingProfileId: 30,
      stackLevel: 1,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: {
        chargingRateUnit: 'A',
        startSchedule: new Date(T0).toISOString(),
        chargingSchedulePeriod: [{ startPeriod: 0, limit: limitA }],
      },
    },
  };
}

async function charging(h: Harness): Promise<string> {
  await h.sim.plugIn(1);
  const txId = await h.sim.startCharging(1, 'CARD-1');
  await vi.advanceTimersByTimeAsync(10_000);
  return txId;
}

describe('AC EVSE below 6 A (2.1)', () => {
  it('draws 0 and reports SuspendedEVSE once, then resumes at 6 A', async () => {
    const h = await liveHarness('ocpp2.1');
    const txId = await charging(h);
    expect(powerW(h)).toBeGreaterThan(0);
    h.sendCall.mockClear();

    await h.invoke('SetChargingProfile', txProfile21(txId, 5));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(powerW(h)).toBe(0);
    expect(chargingStates(h)).toEqual(['SuspendedEVSE']);
    const periodic = h
      .sent('TransactionEvent')
      .filter((e) => e['triggerReason'] === 'MeterValuePeriodic')
      .at(-1);
    expect((periodic?.['transactionInfo'] as Record<string, unknown>)['chargingState']).toBe(
      'SuspendedEVSE',
    );

    h.sendCall.mockClear();
    await h.invoke('SetChargingProfile', txProfile21(txId, 6));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chargingStates(h)).toEqual(['Charging']);
    expect(powerW(h)).toBeGreaterThan(0);
    // 6 A x 230 V x 3 phases.
    expect(powerW(h)).toBeLessThanOrEqual(4140);
  });

  it('pauses at a 0 A limit', async () => {
    const h = await liveHarness('ocpp2.1');
    const txId = await charging(h);
    h.sendCall.mockClear();
    await h.invoke('SetChargingProfile', txProfile21(txId, 0));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(powerW(h)).toBe(0);
    expect(chargingStates(h)).toEqual(['SuspendedEVSE']);
  });

  it('keeps a manual EVSE suspension when the limit rises again', async () => {
    const h = await liveHarness('ocpp2.1');
    const txId = await charging(h);
    await h.invoke('SetChargingProfile', txProfile21(txId, 5));
    await vi.advanceTimersByTimeAsync(10_000);
    await h.sim.suspendCharging(1, 'EVSE');
    h.sendCall.mockClear();
    await h.invoke('SetChargingProfile', txProfile21(txId, 16));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chargingStates(h)).toEqual([]);
    expect(powerW(h)).toBe(0);
  });

  it('never pauses a DC EVSE on a low limit', async () => {
    const h = await liveHarness('ocpp2.1');
    (h.p['config'] as StationConfig).evses = [
      {
        evseId: 1,
        connectorId: 1,
        connectorType: 'dc_ccs2',
        maxPowerW: 150000,
        phases: 3,
        voltage: 400,
      },
    ];
    const txId = await charging(h);
    h.sendCall.mockClear();
    await h.invoke('SetChargingProfile', txProfile21(txId, 5));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chargingStates(h)).toEqual([]);
  });
});

describe('AC EVSE below 6 A (1.6)', () => {
  it('reports SuspendedEVSE as connector status, then Charging at 6 A', async () => {
    const h = await liveHarness('ocpp1.6');
    await charging(h);
    h.sendCall.mockClear();

    await h.invoke('SetChargingProfile', txProfile16(5.9));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(powerW(h)).toBe(0);
    expect(statuses(h)).toEqual(['SuspendedEVSE']);

    h.sendCall.mockClear();
    await h.invoke('SetChargingProfile', txProfile16(6));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statuses(h)).toEqual(['Charging']);
    expect(powerW(h)).toBeGreaterThan(0);
  });
});

function limitFor(h: Harness, evseId = 1): number | null {
  return (h.p['powerLimitFor'] as (id: number) => number | null).call(h.sim, evseId);
}

function periodicCurrents(h: Harness): Array<Record<string, unknown>> {
  const event = h
    .sent('TransactionEvent')
    .filter((e) => e['triggerReason'] === 'MeterValuePeriodic')
    .at(-1);
  const meterValue = (event?.['meterValue'] as Array<Record<string, unknown>> | undefined) ?? [];
  const sampled =
    (meterValue[0]?.['sampledValue'] as Array<Record<string, unknown>> | undefined) ?? [];
  return sampled.filter((sv) => sv['measurand'] === 'Current.Import');
}

async function chargingEv(h: Harness, evPhases?: 1 | 3): Promise<string> {
  await h.sim.plugIn(1, evPhases != null ? { evPhases } : {});
  const txId = await h.sim.startCharging(1, 'CARD-1');
  await vi.advanceTimersByTimeAsync(10_000);
  return txId;
}

describe('Single-phase EVs and numberPhases (2.1)', () => {
  it('draws on L1 only and reports one phase used', async () => {
    const h = await liveHarness('ocpp2.1');
    await chargingEv(h, 1);
    // 22 kW three-phase EVSE: one phase gives at most a third.
    expect(powerW(h)).toBeGreaterThan(0);
    expect(powerW(h)).toBeLessThanOrEqual(22000 / 3);
    const currents = periodicCurrents(h);
    expect(currents).toHaveLength(1);
    expect(currents[0]?.['phase']).toBe('L1');
    const updated = h.sent('TransactionEvent').filter((e) => e['eventType'] === 'Updated');
    expect(updated.at(-1)?.['numberOfPhasesUsed']).toBe(1);
  });

  it('reports three phases for a three-phase EV and no phase on Current.Import', async () => {
    const h = await liveHarness('ocpp2.1');
    await chargingEv(h);
    const started = h.sent('TransactionEvent').find((e) => e['eventType'] === 'Started');
    expect(started?.['numberOfPhasesUsed']).toBe(3);
    expect(periodicCurrents(h)[0]?.['phase']).toBeUndefined();
  });

  it('limits a single-phase EV to the amps of one phase', async () => {
    const h = await liveHarness('ocpp2.1');
    const txId = await chargingEv(h, 1);
    await h.invoke('SetChargingProfile', txProfile21(txId, 16));
    // 16 A x 230 V on one phase.
    expect(limitFor(h)).toBe(3680);
  });

  it('pauses a single-phase EV only below 6 A on its phase', async () => {
    const h = await liveHarness('ocpp2.1');
    const txId = await chargingEv(h, 1);
    h.sendCall.mockClear();
    await h.invoke('SetChargingProfile', txProfile21(txId, 6));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(chargingStates(h)).toEqual([]);
    expect(powerW(h)).toBeGreaterThan(0);
  });

  it('follows the schedule numberPhases of a three-phase EV', async () => {
    const h = await liveHarness('ocpp2.1');
    const txId = await chargingEv(h);
    const profile = txProfile21(txId, 10);
    const schedule = (
      (profile['chargingProfile'] as Record<string, unknown>)['chargingSchedule'] as Array<
        Record<string, unknown>
      >
    )[0]!;
    schedule['chargingSchedulePeriod'] = [{ startPeriod: 0, limit: 10, numberPhases: 1 }];
    await h.invoke('SetChargingProfile', profile);
    expect(limitFor(h)).toBe(2300);
    await vi.advanceTimersByTimeAsync(10_000);
    const updated = h.sent('TransactionEvent').filter((e) => e['eventType'] === 'Updated');
    expect(updated.at(-1)?.['numberOfPhasesUsed']).toBe(1);
  });
});

describe('Single-phase EVs (1.6)', () => {
  it('reports Current.Import on L1 only', async () => {
    const h = await liveHarness('ocpp1.6', (action) =>
      action === 'ChangeConfiguration' ? { status: 'Accepted' } : undefined,
    );
    await h.invoke('ChangeConfiguration', {
      key: 'MeterValuesSampledData',
      value: 'Energy.Active.Import.Register,Current.Import',
    });
    await chargingEv(h, 1);
    const mv = h.sent('MeterValues').at(-1);
    const sampled = (
      (mv?.['meterValue'] as Array<Record<string, unknown>>)[0]?.['sampledValue'] as Array<
        Record<string, unknown>
      >
    ).filter((sv) => sv['measurand'] === 'Current.Import');
    expect(sampled).toHaveLength(1);
    expect(sampled[0]?.['phase']).toBe('L1');
  });
});
