// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { liveHarness, priv, silenceConsole, type Harness, type Protocol } from './sim-harness.js';
import type { MeterValueGenerator } from '../meter-value-generator.js';

function txEvents(h: Harness, type?: string): Array<Record<string, unknown>> {
  return h.sent('TransactionEvent').filter((e) => type == null || e['eventType'] === type);
}

function infoOf(e: Record<string, unknown> | undefined): Record<string, unknown> {
  return (e?.['transactionInfo'] as Record<string, unknown> | undefined) ?? {};
}

function statusOf(h: Harness, evseId = 1): string | undefined {
  return (priv(h, 'evseConnectorStatus') as Map<number, string>).get(evseId);
}

function gen(h: Harness, evseId = 1): MeterValueGenerator {
  return (priv(h, 'meterGens') as Map<number, MeterValueGenerator>).get(
    evseId,
  ) as MeterValueGenerator;
}

function lastStatus(h: Harness): Record<string, unknown> | undefined {
  return h.sent('StatusNotification').at(-1);
}

async function charging(protocol: Protocol): Promise<Harness> {
  const h = await liveHarness(protocol);
  await h.sim.plugIn(1);
  await h.sim.startCharging(1, 'TAG-1');
  h.sendCall.mockClear();
  return h;
}

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('suspendCharging and resumeCharging (2.1)', () => {
  it('reports SuspendedEV, keeps the meter loop at power 0 with flat energy, then resumes', async () => {
    const h = await charging('ocpp2.1');
    await h.sim.suspendCharging(1, 'EV');
    const suspended = txEvents(h, 'Updated')[0];
    expect(suspended?.['triggerReason']).toBe('ChargingStateChanged');
    expect(infoOf(suspended)['chargingState']).toBe('SuspendedEV');

    const energy = gen(h).energyWh;
    h.sendCall.mockClear();
    await vi.advanceTimersByTimeAsync(130_000);
    const periodic = txEvents(h, 'Updated').filter(
      (e) => e['triggerReason'] === 'MeterValuePeriodic',
    );
    expect(periodic.length).toBeGreaterThan(0);
    expect(periodic.every((e) => infoOf(e)['chargingState'] === 'SuspendedEV')).toBe(true);
    expect(gen(h).energyWh).toBe(energy);
    expect(gen(h).currentPowerW).toBe(0);

    h.sendCall.mockClear();
    await h.sim.resumeCharging(1);
    expect(infoOf(txEvents(h, 'Updated')[0])['chargingState']).toBe('Charging');
    await vi.advanceTimersByTimeAsync(130_000);
    expect(gen(h).energyWh).toBeGreaterThan(energy);
  });

  it('sends nothing for a repeated suspend or a resume while charging, and switches EV to EVSE', async () => {
    const h = await charging('ocpp2.1');
    await h.sim.resumeCharging(1);
    expect(h.sendCall).not.toHaveBeenCalled();
    await h.sim.suspendCharging(1, 'EV');
    await h.sim.suspendCharging(1, 'EV');
    expect(txEvents(h, 'Updated')).toHaveLength(1);
    await h.sim.suspendCharging(1, 'EVSE');
    expect(infoOf(txEvents(h, 'Updated')[1])['chargingState']).toBe('SuspendedEVSE');
  });

  it('is a no-op without a transaction', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.suspendCharging(1, 'EV');
    await h.sim.resumeCharging(1);
    expect(h.sendCall).not.toHaveBeenCalled();
  });

  it('refuses to resume after a limit was reached or without the cable', async () => {
    const h = await charging('ocpp2.1');
    await h.sim.suspendCharging(1, 'EVSE');
    (priv(h, 'evseLimitReached') as Map<number, boolean>).set(1, true);
    await expect(h.sim.resumeCharging(1)).rejects.toThrow(/limit/);
    (priv(h, 'evseLimitReached') as Map<number, boolean>).set(1, false);
    (priv(h, 'evseContexts') as Map<number, { cablePlugged: boolean }>).get(1)!.cablePlugged =
      false;
    await expect(h.sim.resumeCharging(1)).rejects.toThrow(/cable/);
  });

  it('restarts the meter loop of a transaction resumed as SuspendedEVSE', async () => {
    const h = await charging('ocpp2.1');
    (priv(h, 'evseChargingState') as Map<number, string>).set(1, 'SuspendedEVSE');
    const timers = priv(h, 'meterTimers') as Map<number, NodeJS.Timeout>;
    clearInterval(timers.get(1));
    timers.delete(1);
    await h.sim.resumeCharging(1);
    expect(infoOf(txEvents(h, 'Updated')[0])['chargingState']).toBe('Charging');
    expect(timers.has(1)).toBe(true);
  });
});

describe('suspendCharging and resumeCharging (1.6)', () => {
  it('reports SuspendedEV and SuspendedEVSE as connector status, then Charging', async () => {
    const h = await charging('ocpp1.6');
    await h.sim.suspendCharging(1, 'EV');
    expect(lastStatus(h)).toMatchObject({ status: 'SuspendedEV' });
    await h.sim.suspendCharging(1, 'EVSE');
    expect(lastStatus(h)).toMatchObject({ status: 'SuspendedEVSE' });
    const energy = gen(h).energyWh;
    await vi.advanceTimersByTimeAsync(130_000);
    expect(gen(h).energyWh).toBe(energy);
    await h.sim.resumeCharging(1);
    expect(lastStatus(h)).toMatchObject({ status: 'Charging' });
    expect(h.sent('StopTransaction')).toHaveLength(0);
  });
});

describe('injectFault modes', () => {
  it.each([
    ['GroundFailure', 'GroundFault'],
    ['OverCurrentFailure', 'OvercurrentFault'],
    ['HighTemperature', 'Other'],
  ])('2.1 end: %s ends with %s and AbnormalCondition', async (errorCode, stoppedReason) => {
    const h = await charging('ocpp2.1');
    await h.sim.injectFault(1, errorCode);
    const ended = txEvents(h, 'Ended')[0];
    expect(ended?.['triggerReason']).toBe('AbnormalCondition');
    expect(infoOf(ended)['stoppedReason']).toBe(stoppedReason);
    expect(statusOf(h)).toBe('Faulted');
  });

  it('1.6 end: every fault stops with Other', async () => {
    const h = await charging('ocpp1.6');
    await h.sim.injectFault(1, 'GroundFailure');
    expect(h.sent('StopTransaction')[0]).toMatchObject({ reason: 'Other' });
    expect(lastStatus(h)).toMatchObject({ status: 'Faulted', errorCode: 'GroundFailure' });
  });

  it('2.1 suspend: keeps the transaction, clearFault returns Occupied, resume charges', async () => {
    const h = await charging('ocpp2.1');
    await h.sim.injectFault(1, 'GroundFailure', 'suspend');
    expect(txEvents(h, 'Ended')).toHaveLength(0);
    expect(infoOf(txEvents(h, 'Updated')[0])['chargingState']).toBe('SuspendedEVSE');
    expect(statusOf(h)).toBe('Faulted');
    await expect(h.sim.resumeCharging(1)).rejects.toThrow(/faulted/);
    await expect(h.sim.suspendCharging(1, 'EV')).rejects.toThrow(/faulted/);

    await h.sim.clearFault(1);
    expect(lastStatus(h)).toMatchObject({ connectorStatus: 'Occupied' });
    await h.sim.resumeCharging(1);
    expect(infoOf(txEvents(h, 'Updated').at(-1))['chargingState']).toBe('Charging');
  });

  it('1.6 suspend: no StopTransaction, clearFault returns SuspendedEVSE, resume charges', async () => {
    const h = await charging('ocpp1.6');
    await h.sim.injectFault(1, 'OverCurrentFailure', 'suspend');
    expect(h.sent('StopTransaction')).toHaveLength(0);
    expect(lastStatus(h)).toMatchObject({ status: 'Faulted', errorCode: 'OverCurrentFailure' });
    await h.sim.clearFault(1);
    expect(lastStatus(h)).toMatchObject({ status: 'SuspendedEVSE', errorCode: 'NoError' });
    await h.sim.resumeCharging(1);
    expect(lastStatus(h)).toMatchObject({ status: 'Charging' });
  });

  it('clearFault without a transaction returns Available', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.injectFault(1, 'HighTemperature', 'suspend');
    await h.sim.clearFault(1);
    expect(lastStatus(h)).toMatchObject({ connectorStatus: 'Available' });
  });
});

describe('evFull', () => {
  it('2.1: SuspendedEV, then Ended SOCLimitReached with SoCLimitReached', async () => {
    const h = await charging('ocpp2.1');
    await h.sim.evFull(1);
    expect(infoOf(txEvents(h, 'Updated')[0])['chargingState']).toBe('SuspendedEV');
    const ended = txEvents(h, 'Ended')[0];
    expect(ended?.['triggerReason']).toBe('SoCLimitReached');
    expect(infoOf(ended)['stoppedReason']).toBe('SOCLimitReached');
  });

  it('1.6: SuspendedEV, then the EV unplugs (EVDisconnected)', async () => {
    const h = await charging('ocpp1.6');
    await h.sim.evFull(1);
    expect(h.sent('StatusNotification')[0]).toMatchObject({ status: 'SuspendedEV' });
    expect(h.sent('StopTransaction')[0]).toMatchObject({ reason: 'EVDisconnected' });
    expect(lastStatus(h)).toMatchObject({ status: 'Available' });
  });
});

describe('stopCharging reasons', () => {
  it.each([
    ['EnergyLimitReached', 'EnergyLimitReached'],
    ['TimeLimitReached', 'TimeLimitReached'],
    ['LocalOutOfCredit', 'CostLimitReached'],
    ['SOCLimitReached', 'SoCLimitReached'],
    ['StoppedByEV', 'ChargingStateChanged'],
    ['Local', 'StopAuthorized'],
  ])('2.1: %s ends with triggerReason %s', async (reason, trigger) => {
    const h = await charging('ocpp2.1');
    await h.sim.stopCharging(1, reason);
    expect(txEvents(h, 'Ended')[0]?.['triggerReason']).toBe(trigger);
  });

  it('refuses a reason of the other version', async () => {
    const h16 = await charging('ocpp1.6');
    await expect(h16.sim.stopCharging(1, 'SOCLimitReached')).rejects.toThrow(/1\.6/);
    expect(h16.sent('StopTransaction')).toHaveLength(0);
    const h21 = await charging('ocpp2.1');
    await expect(h21.sim.stopCharging(1, 'HardReset')).rejects.toThrow(/2\.1/);
    expect(txEvents(h21, 'Ended')).toHaveLength(0);
  });
});
