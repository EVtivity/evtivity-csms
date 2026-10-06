// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeHarness, priv, call, silenceConsole, type Harness } from './sim-harness.js';

interface Monitor {
  id: number;
  type: string;
  severity: number;
  isHardwired: boolean;
  preconfigured?: boolean;
  component: Record<string, unknown>;
  variable: Record<string, unknown>;
  value?: number;
}

function monitors(h: Harness): Map<number, Monitor> {
  return priv(h, 'variableMonitors') as Map<number, Monitor>;
}

type SetResult = Array<{ status: string; id: number }>;

async function setMonitor(h: Harness, item: Record<string, unknown>): Promise<SetResult[number]> {
  const res = await h.invoke('SetVariableMonitoring', { setMonitoringData: [item] });
  const results = res['setMonitoringResult'] as SetResult;
  return results[0] as SetResult[number];
}

const HEARTBEAT = {
  component: { name: 'OCPPCommCtrlr' },
  variable: { name: 'HeartbeatInterval' },
};

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('SetVariableMonitoring (N04)', () => {
  it('creates a threshold monitor on a numeric device model variable', async () => {
    const h = await makeHarness();
    const r = await setMonitor(h, {
      ...HEARTBEAT,
      type: 'UpperThreshold',
      value: 500,
      severity: 3,
    });
    expect(r.status).toBe('Accepted');
    expect(r.id).toBeGreaterThan(0);
    expect(monitors(h).get(r.id)).toMatchObject({
      type: 'UpperThreshold',
      value: 500,
      severity: 3,
      isHardwired: false,
    });
  });

  it('reports UnknownComponent and UnknownVariable', async () => {
    const h = await makeHarness();
    const unknownComp = await setMonitor(h, {
      component: { name: 'NoSuchCtrlr' },
      variable: { name: 'X' },
      type: 'Delta',
      value: 1,
      severity: 5,
    });
    expect(unknownComp).toMatchObject({ status: 'UnknownComponent', id: 0 });
    const unknownVar = await setMonitor(h, {
      component: { name: 'OCPPCommCtrlr' },
      variable: { name: 'NoSuchVariable' },
      type: 'Delta',
      value: 1,
      severity: 5,
    });
    expect(unknownVar).toMatchObject({ status: 'UnknownVariable', id: 0 });
    const unknownEvse = await setMonitor(h, {
      component: { name: 'EVSE', evse: { id: 9 } },
      variable: { name: 'Power' },
      type: 'Delta',
      value: 1,
      severity: 5,
    });
    expect(unknownEvse.status).toBe('UnknownComponent');
    expect(monitors(h).size).toBe(0);
  });

  it('rejects a negative delta and an out-of-range threshold', async () => {
    const h = await makeHarness();
    expect(
      (await setMonitor(h, { ...HEARTBEAT, type: 'Delta', value: -1, severity: 5 })).status,
    ).toBe('Rejected');
    expect(
      (await setMonitor(h, { ...HEARTBEAT, type: 'LowerThreshold', value: 100001, severity: 5 }))
        .status,
    ).toBe('Rejected');
  });

  it('answers UnsupportedMonitorType for a threshold on a non-numeric variable', async () => {
    const h = await makeHarness();
    const r = await setMonitor(h, {
      component: { name: 'EVSE', evse: { id: 1 } },
      variable: { name: 'AvailabilityState' },
      type: 'UpperThreshold',
      value: 1,
      severity: 5,
    });
    expect(r.status).toBe('UnsupportedMonitorType');
  });

  it('answers Duplicate for a second monitor of the same type and severity', async () => {
    const h = await makeHarness();
    await setMonitor(h, { ...HEARTBEAT, type: 'Delta', value: 10, severity: 4 });
    const dup = await setMonitor(h, { ...HEARTBEAT, type: 'Delta', value: 20, severity: 4 });
    expect(dup.status).toBe('Duplicate');
    const other = await setMonitor(h, { ...HEARTBEAT, type: 'Delta', value: 20, severity: 6 });
    expect(other.status).toBe('Accepted');
  });

  it('replaces a monitor by id only on the same component and variable', async () => {
    const h = await makeHarness();
    const created = await setMonitor(h, { ...HEARTBEAT, type: 'Delta', value: 10, severity: 4 });
    const replaced = await setMonitor(h, {
      ...HEARTBEAT,
      id: created.id,
      type: 'Delta',
      value: 30,
      severity: 4,
    });
    expect(replaced).toMatchObject({ status: 'Accepted', id: created.id });
    expect(monitors(h).get(created.id)?.value).toBe(30);

    const moved = await setMonitor(h, {
      component: { name: 'EVSE', evse: { id: 1 } },
      variable: { name: 'Power' },
      id: created.id,
      type: 'Delta',
      value: 30,
      severity: 4,
    });
    expect(moved).toMatchObject({ status: 'Rejected', id: created.id });
    const unknownId = await setMonitor(h, {
      ...HEARTBEAT,
      id: 4242,
      type: 'Delta',
      value: 1,
      severity: 4,
    });
    expect(unknownId).toMatchObject({ status: 'Rejected', id: 4242 });
  });
});

describe('ClearVariableMonitoring and SetMonitoringBase', () => {
  it('clears custom monitors, refuses hardwired ones and reports unknown ids', async () => {
    const h = await makeHarness({ boot: true });
    const created = await setMonitor(h, { ...HEARTBEAT, type: 'Delta', value: 5, severity: 2 });
    const res = await h.invoke('ClearVariableMonitoring', { id: [created.id, 1000, 777] });
    expect(res['clearMonitoringResult']).toEqual([
      { status: 'Accepted', id: created.id },
      { status: 'Rejected', id: 1000 },
      { status: 'NotFound', id: 777 },
    ]);
    expect(monitors(h).has(created.id)).toBe(false);
    expect(monitors(h).has(1000)).toBe(true);
  });

  it('boot seeds the preconfigured and hardwired monitors', async () => {
    const h = await makeHarness({ boot: true });
    const all = Array.from(monitors(h).values());
    expect(all.filter((m) => m.preconfigured === true)).toHaveLength(2);
    expect(monitors(h).get(1000)).toMatchObject({ isHardwired: true });
  });

  it('HardWiredOnly removes custom and preconfigured monitors, FactoryDefault restores defaults', async () => {
    const h = await makeHarness({ boot: true });
    await setMonitor(h, { ...HEARTBEAT, type: 'Delta', value: 5, severity: 2 });
    expect(await h.invoke('SetMonitoringBase', { monitoringBase: 'HardWiredOnly' })).toEqual({
      status: 'Accepted',
    });
    expect(Array.from(monitors(h).keys())).toEqual([1000]);
    await setMonitor(h, { ...HEARTBEAT, type: 'Delta', value: 5, severity: 2 });
    await h.invoke('SetMonitoringBase', { monitoringBase: 'FactoryDefault' });
    const all = Array.from(monitors(h).values());
    expect(all.filter((m) => !m.isHardwired).every((m) => m.preconfigured === true)).toBe(true);
    expect(all).toHaveLength(3);
    expect(await h.invoke('SetMonitoringBase', { monitoringBase: 'Bogus' })).toEqual({
      status: 'NotSupported',
    });
    expect(await h.invoke('SetMonitoringBase', { monitoringBase: 'All' })).toEqual({
      status: 'Accepted',
    });
  });

  it('SetMonitoringLevel accepts 0..9 only', async () => {
    const h = await makeHarness();
    expect(await h.invoke('SetMonitoringLevel', { severity: 10 })).toEqual({ status: 'Rejected' });
    expect(await h.invoke('SetMonitoringLevel', { severity: -1 })).toEqual({ status: 'Rejected' });
    expect(await h.invoke('SetMonitoringLevel', { severity: 3 })).toEqual({ status: 'Accepted' });
    expect(priv(h, 'monitoringLevel') as number).toBe(3);
  });
});

describe('GetMonitoringReport (N02)', () => {
  it('rejects unknown criteria and answers EmptyResultSet without matches', async () => {
    const h = await makeHarness();
    expect(
      await h.invoke('GetMonitoringReport', { requestId: 1, monitoringCriteria: ['X'] }),
    ).toEqual({ status: 'NotSupported' });
    expect(await h.invoke('GetMonitoringReport', { requestId: 1 })).toEqual({
      status: 'EmptyResultSet',
    });
  });

  it('reports matching monitors by criteria and component variable', async () => {
    const h = await makeHarness({ boot: true });
    const threshold = await setMonitor(h, {
      ...HEARTBEAT,
      type: 'UpperThreshold',
      value: 900,
      severity: 1,
    });
    const res = await h.invoke('GetMonitoringReport', {
      requestId: 42,
      monitoringCriteria: ['ThresholdMonitoring'],
      componentVariable: [HEARTBEAT],
    });
    expect(res).toEqual({ status: 'Accepted' });
    await vi.advanceTimersByTimeAsync(200);
    const report = h.sent('NotifyMonitoringReport').at(-1);
    expect(report).toMatchObject({ requestId: 42, seqNo: 0, tbc: false });
    expect(report?.['monitor']).toEqual([
      {
        component: HEARTBEAT.component,
        variable: HEARTBEAT.variable,
        variableMonitoring: [
          {
            id: threshold.id,
            transaction: false,
            value: 900,
            type: 'UpperThreshold',
            severity: 1,
            eventNotificationType: 'CustomMonitor',
          },
        ],
      },
    ]);
  });

  it('reports hardwired and preconfigured monitor notification types', async () => {
    const h = await makeHarness({ boot: true });
    await h.invoke('GetMonitoringReport', {
      requestId: 7,
      monitoringCriteria: ['DeltaMonitoring', 'PeriodicMonitoring'],
    });
    await vi.advanceTimersByTimeAsync(200);
    const report = h.sent('NotifyMonitoringReport').at(-1);
    const types = (report?.['monitor'] as Array<Record<string, unknown>>).map(
      (m) =>
        (m['variableMonitoring'] as Array<Record<string, unknown>>)[0]?.['eventNotificationType'],
    );
    expect(types).toContain('HardWiredMonitor');
    expect(types).toContain('PreconfiguredMonitor');
  });

  it('1.6 accepts without reporting', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    expect(await h.invoke('GetMonitoringReport', { requestId: 1 })).toEqual({
      status: 'Accepted',
    });
  });
});

describe('monitor evaluation (N07)', () => {
  it('a threshold monitor fires Alerting once when exceeded, and cleared when back', async () => {
    const h = await makeHarness();
    const m = await setMonitor(h, {
      ...HEARTBEAT,
      type: 'UpperThreshold',
      value: 500,
      severity: 2,
    });
    const evaluate = (v: number): Array<{ event: Record<string, unknown> }> =>
      call(h, 'evaluateMonitors', HEARTBEAT.component, 'HeartbeatInterval', v, null) as Array<{
        event: Record<string, unknown>;
      }>;
    expect(evaluate(400)).toEqual([]);
    const over = evaluate(600);
    expect(over).toHaveLength(1);
    expect(over[0]?.event).toMatchObject({
      trigger: 'Alerting',
      actualValue: '600',
      variableMonitoringId: m.id,
    });
    expect(evaluate(700)).toEqual([]);
    const back = evaluate(100);
    expect(back[0]?.event).toMatchObject({ trigger: 'Alerting', cleared: true });
  });

  it('a delta monitor fires when the change reaches its value, filtered by MonitoringLevel', async () => {
    const h = await makeHarness();
    await setMonitor(h, { ...HEARTBEAT, type: 'Delta', value: 50, severity: 5 });
    const evaluate = (v: number): unknown[] =>
      call(h, 'evaluateMonitors', HEARTBEAT.component, 'HeartbeatInterval', v, 'tx-1') as unknown[];
    // Baseline is the current value (300 from the default device model).
    expect(evaluate(320)).toEqual([]);
    const fired = evaluate(400) as Array<{ event: Record<string, unknown> }>;
    expect(fired[0]?.event).toMatchObject({ trigger: 'Delta', transactionId: 'tx-1' });
    await h.invoke('SetMonitoringLevel', { severity: 2 });
    expect(evaluate(900)).toEqual([]);
  });

  it('does nothing when monitoring is disabled or on 1.6', async () => {
    const h = await makeHarness();
    await setMonitor(h, { ...HEARTBEAT, type: 'UpperThreshold', value: 1, severity: 0 });
    h.sim.setConfigValue('MonitoringCtrlr.Enabled', 'false');
    expect(call(h, 'evaluateMonitors', HEARTBEAT.component, 'HeartbeatInterval', 9, null)).toEqual(
      [],
    );
    const h16 = await makeHarness({ protocol: 'ocpp1.6' });
    expect(
      call(h16, 'evaluateMonitors', HEARTBEAT.component, 'HeartbeatInterval', 9, null),
    ).toEqual([]);
  });

  it('a connector status change notifies the EVSE AvailabilityState monitor through NotifyEvent', async () => {
    const h = await makeHarness({ boot: true });
    h.sendCall.mockClear();
    // First change sets the baseline of the preconfigured delta monitors.
    await h.sim.sendStatusNotification(1, 1, 'Occupied');
    await h.sim.sendStatusNotification(1, 1, 'Available');
    await vi.advanceTimersByTimeAsync(0);
    const events = h
      .sent('NotifyEvent')
      .flatMap((p) => p['eventData'] as Array<Record<string, unknown>>);
    const delta = events.filter((e) => e['eventNotificationType'] === 'PreconfiguredMonitor');
    expect(delta.length).toBeGreaterThan(0);
    expect(delta[0]).toMatchObject({
      actualValue: 'Available',
      variable: { name: 'AvailabilityState' },
      eventNotificationType: 'PreconfiguredMonitor',
    });
  });

  it('offline: queues events at or below OfflineQueuingSeverity and drops the rest', async () => {
    const h = await makeHarness({ connected: false });
    h.sim.setConfigValue('MonitoringCtrlr.OfflineQueuingSeverity', '3');
    const queue = priv(h, 'offlineMessageQueue') as Array<{ action: string }>;
    call(h, 'dispatchMonitorEvents', [
      { severity: 2, event: { eventId: 1 } },
      { severity: 8, event: { eventId: 2 } },
    ]);
    expect(queue.filter((m) => m.action === 'NotifyEvent')).toHaveLength(1);
    expect(h.sent('NotifyEvent')).toHaveLength(0);
  });
});

describe('periodic monitors (N11-N15)', () => {
  it('without stream params sends periodic NotifyEvents every value seconds', async () => {
    const h = await makeHarness();
    const m = await setMonitor(h, { ...HEARTBEAT, type: 'Periodic', value: 10, severity: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25_000);
    const periodic = h
      .sent('NotifyEvent')
      .flatMap((p) => p['eventData'] as Array<Record<string, unknown>>)
      .filter((e) => e['trigger'] === 'Periodic');
    expect(periodic).toHaveLength(2);
    expect(periodic[0]).toMatchObject({ variableMonitoringId: m.id, actualValue: '300' });
    // Clearing the monitor stops the reports.
    await h.invoke('ClearVariableMonitoring', { id: [m.id] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      h
        .sent('NotifyEvent')
        .flatMap((p) => p['eventData'] as Array<Record<string, unknown>>)
        .filter((e) => e['trigger'] === 'Periodic'),
    ).toHaveLength(2);
  });

  it('opens a periodic event stream, streams samples, adjusts and closes it', async () => {
    const h = await makeHarness();
    const sendSend = vi.fn(() => true);
    Object.defineProperty(h.sim.client, 'sendSend', { value: sendSend, writable: true });
    const m = await setMonitor(h, {
      ...HEARTBEAT,
      type: 'Periodic',
      value: 1,
      severity: 1,
      periodicEventStream: { interval: 5, values: 0 },
    });
    await vi.advanceTimersByTimeAsync(0);
    const open = h.sent('OpenPeriodicEventStream')[0];
    expect(open).toEqual({
      constantStreamData: { id: 1, variableMonitoringId: m.id, params: { interval: 5, values: 0 } },
    });
    expect(await h.invoke('GetPeriodicEventStream', {})).toEqual({
      constantStreamData: [
        { id: 1, variableMonitoringId: m.id, params: { interval: 5, values: 0 } },
      ],
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendSend).toHaveBeenCalledWith(
      'NotifyPeriodicEventStream',
      expect.objectContaining({ id: 1, pending: 0 }),
    );
    const firstData = (sendSend.mock.calls[0] as unknown as [string, { data: unknown[] }])[1].data;
    expect(firstData.length).toBeGreaterThanOrEqual(4);

    expect(await h.invoke('AdjustPeriodicEventStream', { id: 99, params: {} })).toEqual({
      status: 'Rejected',
      statusInfo: { reasonCode: 'UnknownStream' },
    });
    expect(
      await h.invoke('AdjustPeriodicEventStream', { id: 1, params: { interval: 20, values: 3 } }),
    ).toEqual({ status: 'Accepted' });
    sendSend.mockClear();
    // values=3 flushes after three samples, before the 20 s interval.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sendSend).toHaveBeenCalledTimes(1);

    await h.invoke('ClearVariableMonitoring', { id: [m.id] });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent('ClosePeriodicEventStream')).toEqual([{ id: 1 }]);
    expect(await h.invoke('GetPeriodicEventStream', {})).toEqual({});
  });

  it('falls back to NotifyEvent when the CSMS rejects the stream', async () => {
    const h = await makeHarness({
      respond: (action) =>
        action === 'OpenPeriodicEventStream' ? { status: 'Rejected' } : undefined,
    });
    await setMonitor(h, {
      ...HEARTBEAT,
      type: 'Periodic',
      value: 2,
      severity: 1,
      periodicEventStream: { interval: 10 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.invoke('GetPeriodicEventStream', {})).toEqual({});
    await vi.advanceTimersByTimeAsync(4_000);
    const periodic = h
      .sent('NotifyEvent')
      .flatMap((p) => p['eventData'] as Array<Record<string, unknown>>)
      .filter((e) => e['trigger'] === 'Periodic');
    expect(periodic).toHaveLength(2);
  });

  it('keeps stream data while disconnected and sends it on the next flush', async () => {
    const h = await makeHarness();
    let connected = false;
    const sendSend = vi.fn(() => connected);
    Object.defineProperty(h.sim.client, 'sendSend', { value: sendSend, writable: true });
    await setMonitor(h, {
      ...HEARTBEAT,
      type: 'Periodic',
      value: 1,
      severity: 1,
      periodicEventStream: { interval: 2 },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendSend).toHaveBeenCalled();
    const kept = (sendSend.mock.calls[0] as unknown as [string, { data: Array<{ t: number }> }])[1]
      .data;
    expect(kept.length).toBeGreaterThan(0);
    connected = true;
    await vi.advanceTimersByTimeAsync(2_000);
    const last = sendSend.mock.calls.at(-1) as unknown as [string, { data: Array<{ t: number }> }];
    // The unsent samples lead the next flush, followed by the new ones.
    expect(last[1].data.slice(0, kept.length)).toEqual(kept);
    expect(last[1].data.length).toBeGreaterThan(kept.length);
  });
});
