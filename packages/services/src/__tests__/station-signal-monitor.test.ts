// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { PubSubClient } from '@evtivity/lib';

const { db, storedRows, deleted, updated } = vi.hoisted(() => {
  const storedRows: Array<Record<string, unknown>> = [];
  const deleted: unknown[] = [];
  const updated: Array<Record<string, unknown>> = [];
  const selectChain = {
    from: () => selectChain,
    where: () => Promise.resolve(storedRows),
  };
  return {
    storedRows,
    deleted,
    updated,
    db: {
      select: vi.fn(() => selectChain),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            updated.push(values);
            // The update reaches every stored row (the tests store only the rows it targets).
            const changed = storedRows.map((r) => ({ ...r, ...values }));
            return Object.assign(Promise.resolve(), {
              returning: () => Promise.resolve(changed),
            });
          },
        }),
      })),
      delete: vi.fn(() => ({
        where: (condition: unknown) => {
          deleted.push(condition);
          return Promise.resolve();
        },
      })),
    },
  };
});

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/database')>();
  return { ...actual, db };
});

const {
  LOW_SIGNAL_READ_TTL_MS,
  lowSignalReadExpired,
  lowSignalThreshold,
  lowSignalResultOutcome,
  planLowSignalSync,
  recordLowSignalMonitorFailure,
  reportedLowSignalMonitor,
  scheduleLowSignalSync,
  syncStationLowSignalMonitor,
} = await import('../station-signal-monitor.service.js');

type Row = Parameters<typeof planLowSignalSync>[0][number];

function row(overrides: Partial<Row>): Row {
  return {
    id: 1,
    stationId: 'sta_1',
    monitoringId: 41,
    component: 'DataLink',
    componentInstance: 'Modem1',
    variable: 'SignalStrength',
    type: 'LowerThreshold',
    value: '-100',
    severity: 6,
    status: 'active',
    errorInfo: null,
    source: 'low_signal',
    reportRequestId: null,
    reportReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const target = (threshold: number, instance: string | null = 'Modem1') => ({
  instance,
  threshold,
});

describe('planLowSignalSync', () => {
  it('leaves an unchanged active or pending monitor alone outside a boot', () => {
    for (const status of ['active', 'pending'] as const) {
      expect(planLowSignalSync([row({ status })], [target(-100)], false)).toEqual({
        resend: [],
        insert: [],
        remove: [],
      });
    }
  });

  it('sends an unchanged active monitor again without its id after a boot', () => {
    const active = row({});
    expect(planLowSignalSync([active], [target(-100)], true).resend).toEqual([
      { row: active, value: -100, replaceId: null },
    ]);
  });

  it('replaces a changed monitor by its id, outside a boot and after one', () => {
    const active = row({});
    for (const afterBoot of [false, true]) {
      expect(planLowSignalSync([active], [target(-105)], afterBoot).resend).toEqual([
        { row: active, value: -105, replaceId: 41 },
      ]);
    }
  });

  it('waits for a pending send outside a boot, whatever its value', () => {
    const pending = row({ status: 'pending' });
    expect(planLowSignalSync([pending], [target(-105)], false)).toEqual({
      resend: [],
      insert: [],
      remove: [],
    });
    const reading = row({ status: 'pending', monitoringId: null, reportRequestId: 7 });
    expect(planLowSignalSync([reading], [target(-105)], false).resend).toEqual([]);
  });

  it('replaces a monitor marked for clearing by its id when the alert is wanted again', () => {
    const marked = row({ status: 'cleared' });
    expect(planLowSignalSync([marked], [target(-100)], true).resend).toEqual([
      { row: marked, value: -100, replaceId: 41 },
    ]);
  });

  it('replaces a pending monitor after a boot by the id it has', () => {
    const pending = row({ status: 'pending' });
    expect(planLowSignalSync([pending], [target(-100)], true).resend).toEqual([
      { row: pending, value: -100, replaceId: 41 },
    ]);
  });

  it('sends an error monitor again, by its id when it has one', () => {
    const withId = row({ status: 'error' });
    expect(planLowSignalSync([withId], [target(-100)], false).resend).toEqual([
      { row: withId, value: -100, replaceId: 41 },
    ]);
    const withoutId = row({ status: 'error', monitoringId: null });
    expect(planLowSignalSync([withoutId], [target(-100)], false).resend).toEqual([
      { row: withoutId, value: -100, replaceId: null },
    ]);
  });

  it('inserts a monitor for a new modem and removes the one of a modem gone', () => {
    const old = row({ componentInstance: 'Old' });
    expect(planLowSignalSync([old], [target(-100, 'Modem2')], false)).toEqual({
      resend: [],
      insert: [target(-100, 'Modem2')],
      remove: [old],
    });
  });
});

describe('lowSignalThreshold', () => {
  it('uses dBm for dBm, dBmW and an inferred negative value, ASU for an ASU modem', () => {
    expect(lowSignalThreshold(-101, { unit: 'dBm', value: '-80' })).toBe(-101);
    expect(lowSignalThreshold(-101, { unit: 'dBmW', value: '-80' })).toBe(-101);
    expect(lowSignalThreshold(-101, { unit: null, value: '-80' })).toBe(-101);
    expect(lowSignalThreshold(-101, { unit: 'ASU', value: '12' })).toBe(6);
    expect(lowSignalThreshold(-101, { unit: null, value: '12' })).toBe(6);
  });

  it('sets no monitor for a unit it does not know', () => {
    expect(lowSignalThreshold(-101, { unit: 'Percent', value: '-80' })).toBeNull();
    expect(lowSignalThreshold(-101, { unit: 'dB', value: '-80' })).toBeNull();
  });
});

describe('lowSignalResultOutcome', () => {
  it('reads the monitor id back when Duplicate comes for a monitor without a known id', () => {
    expect(lowSignalResultOutcome(null, null, { status: 'Duplicate' })).toEqual({ kind: 'read' });
  });

  it('is active with the id the station returns on Accepted', () => {
    expect(lowSignalResultOutcome(null, null, { status: 'Accepted', id: 52 })).toEqual({
      kind: 'store',
      status: 'active',
      monitoringId: 52,
      errorInfo: null,
    });
  });

  it('sends again without an id when a replace is Rejected (the id is gone)', () => {
    expect(lowSignalResultOutcome(41, 41, { status: 'Rejected' })).toEqual({ kind: 'resend' });
  });

  it('is active on Duplicate only for an unchanged monitor sent again without its id', () => {
    expect(lowSignalResultOutcome(null, 41, { status: 'Duplicate' })).toMatchObject({
      status: 'active',
      monitoringId: 41,
    });
    expect(lowSignalResultOutcome(41, 41, { status: 'Duplicate' })).toMatchObject({
      status: 'error',
      monitoringId: 41,
    });
  });

  it('keeps the known id on any other refusal or a missing result', () => {
    expect(lowSignalResultOutcome(41, 41, { status: 'UnsupportedMonitorType' })).toMatchObject({
      status: 'error',
      monitoringId: 41,
      errorInfo: 'UnsupportedMonitorType',
    });
    expect(lowSignalResultOutcome(null, null, null)).toMatchObject({
      status: 'error',
      monitoringId: null,
    });
  });
});

describe('reportedLowSignalMonitor', () => {
  const entry = (id: number, value = -100) => ({
    component: { name: 'DataLink', instance: 'Modem1' },
    variable: { name: 'SignalStrength' },
    variableMonitoring: [{ id, value, type: 'LowerThreshold', severity: 6 }],
  });

  it('takes the modem monitor the report lists', () => {
    expect(reportedLowSignalMonitor([entry(77)], 'Modem1', new Set())).toEqual({
      kind: 'found',
      id: 77,
      value: -100,
    });
    expect(reportedLowSignalMonitor([entry(77)], 'Modem2', new Set())).toEqual({ kind: 'none' });
  });

  it("never takes over a monitor an operator rule holds, and takes the station's other one", () => {
    expect(reportedLowSignalMonitor([entry(5)], 'Modem1', new Set([5]))).toEqual({
      kind: 'operator',
    });
    expect(reportedLowSignalMonitor([entry(5), entry(77, -95)], 'Modem1', new Set([5]))).toEqual({
      kind: 'found',
      id: 77,
      value: -95,
    });
  });
});

describe('syncStationLowSignalMonitor', () => {
  const published: string[] = [];
  const pubsub = {
    publish: vi.fn(async (_channel: string, message: string) => {
      published.push(message);
    }),
  } as unknown as PubSubClient;
  const deps = { pubsub, log: pino({ level: 'silent' }) };
  const wanted = { stationSignalEnabled: true, signalAlertBelowDbm: -100 };
  const station = { id: 'sta_1', stationId: 'CS-1', ocppProtocol: 'ocpp2.1', isOnline: false };

  beforeEach(() => {
    storedRows.length = 0;
    deleted.length = 0;
    updated.length = 0;
    published.length = 0;
  });

  it('keeps the rows of an offline station and sends nothing', async () => {
    storedRows.push(row({}));
    expect(await syncStationLowSignalMonitor(station, wanted, deps)).toEqual({
      set: 0,
      cleared: 0,
    });
    expect(deleted).toEqual([]);
    expect(published).toEqual([]);
  });

  it('marks the rows of an offline station for clearing at its next boot when switched off', async () => {
    storedRows.push(row({}));
    const off = { stationSignalEnabled: true, signalAlertBelowDbm: null };
    expect(await syncStationLowSignalMonitor(station, off, deps)).toEqual({
      set: 0,
      cleared: 1,
    });
    expect(deleted).toEqual([]);
    expect(updated).toEqual([expect.objectContaining({ status: 'cleared' })]);
    expect(published).toEqual([]);
  });

  it('keeps a pending row of an online station until its answer when switched off', async () => {
    storedRows.push(
      row({ status: 'pending', monitoringId: null }),
      row({ id: 2, componentInstance: 'Modem2' }),
    );
    const off = { stationSignalEnabled: false, signalAlertBelowDbm: -100 };
    expect(await syncStationLowSignalMonitor({ ...station, isOnline: true }, off, deps)).toEqual({
      set: 0,
      cleared: 1,
    });
    expect(deleted).toHaveLength(1);
    expect(published.map((m) => JSON.parse(m) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ action: 'ClearVariableMonitoring', payload: { id: [41] } }),
    ]);
  });

  it('removes a pending row after a boot when switched off, reading back one of unknown id', async () => {
    // Its answer never comes after a boot; without a known id the station may still hold it.
    storedRows.push(
      row({ status: 'pending', monitoringId: 41 }),
      row({ id: 2, componentInstance: 'Modem2', status: 'pending', monitoringId: null }),
    );
    const off = { stationSignalEnabled: false, signalAlertBelowDbm: -100 };
    expect(
      await syncStationLowSignalMonitor({ ...station, isOnline: true }, off, deps, {
        afterBoot: true,
      }),
    ).toEqual({ set: 0, cleared: 2 });
    expect(deleted).toHaveLength(1);
    expect(updated).toEqual([
      expect.objectContaining({ status: 'pending', reportReason: 'remove' }),
    ]);
    expect(published.map((m) => JSON.parse(m) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ action: 'ClearVariableMonitoring', payload: { id: [41] } }),
      expect.objectContaining({ action: 'GetMonitoringReport' }),
    ]);
  });

  it('clears every known id of an online station when switched off', async () => {
    storedRows.push(
      row({}),
      row({ id: 2, componentInstance: 'Modem2', status: 'error', monitoringId: 7 }),
    );
    const off = { stationSignalEnabled: false, signalAlertBelowDbm: -100 };
    await syncStationLowSignalMonitor({ ...station, isOnline: true }, off, deps);
    expect(published.map((m) => JSON.parse(m) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ action: 'ClearVariableMonitoring', payload: { id: [41, 7] } }),
    ]);
  });
});

describe('a read the station accepted and never reported', () => {
  const published: string[] = [];
  const pubsub = {
    publish: vi.fn(async (_channel: string, message: string) => {
      published.push(message);
    }),
  } as unknown as PubSubClient;
  const deps = { pubsub, log: pino({ level: 'silent' }) };
  const now = new Date('2026-10-22T12:00:00Z');
  const stale = new Date(now.getTime() - LOW_SIGNAL_READ_TTL_MS - 1);
  const station = { id: 'sta_1', stationId: 'CS-1', ocppProtocol: 'ocpp2.1', isOnline: true };

  beforeEach(() => {
    storedRows.length = 0;
    deleted.length = 0;
    updated.length = 0;
    published.length = 0;
  });

  it('is settled once it waited longer than the TTL, never a send or a fresh read', () => {
    const reading = row({ status: 'pending', reportRequestId: 9, updatedAt: stale });
    expect(LOW_SIGNAL_READ_TTL_MS).toBe(5 * 60_000);
    expect(lowSignalReadExpired(reading, now)).toBe(true);
    expect(lowSignalReadExpired({ ...reading, updatedAt: now }, now)).toBe(false);
    expect(lowSignalReadExpired({ ...reading, reportRequestId: null }, now)).toBe(false);
    expect(lowSignalReadExpired({ ...reading, status: 'error' }, now)).toBe(false);
  });

  it('ends in error at the next sync while the alert is on', async () => {
    storedRows.push(row({ status: 'pending', reportRequestId: 9, updatedAt: stale }));
    const wanted = { stationSignalEnabled: true, signalAlertBelowDbm: -100 };
    await syncStationLowSignalMonitor({ ...station, isOnline: false }, wanted, deps, { now });
    expect(updated).toEqual([
      expect.objectContaining({
        status: 'error',
        reportRequestId: null,
        reportReason: null,
        errorInfo: 'GetMonitoringReport: no report within 5 minutes',
      }),
    ]);
    expect(published).toEqual([]);
  });

  it('is removed at the next sync while the alert is off, cleared by its known id', async () => {
    storedRows.push(row({ status: 'pending', reportRequestId: 9, updatedAt: stale }));
    const off = { stationSignalEnabled: false, signalAlertBelowDbm: -100 };
    expect(await syncStationLowSignalMonitor(station, off, deps, { now })).toEqual({
      set: 0,
      cleared: 1,
    });
    expect(deleted).toHaveLength(1);
    expect(published.map((m) => JSON.parse(m) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ action: 'ClearVariableMonitoring', payload: { id: [41] } }),
    ]);
  });

  it('keeps a read inside the TTL waiting for its report', async () => {
    storedRows.push(row({ status: 'pending', reportRequestId: 9, updatedAt: now }));
    const off = { stationSignalEnabled: false, signalAlertBelowDbm: -100 };
    expect(await syncStationLowSignalMonitor(station, off, deps, { now })).toEqual({
      set: 0,
      cleared: 0,
    });
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
    expect(published).toEqual([]);
  });
});

describe('recordLowSignalMonitorFailure', () => {
  const published: string[] = [];
  const pubsub = {
    publish: vi.fn(async (_channel: string, message: string) => {
      published.push(message);
    }),
  } as unknown as PubSubClient;
  const deps = { pubsub, log: pino({ level: 'silent' }) };
  const item = (instance: string) => ({
    component: { name: 'DataLink', instance },
    variable: { name: 'SignalStrength' },
    type: 'LowerThreshold',
    value: -100,
    severity: 6,
  });

  beforeEach(() => {
    storedRows.length = 0;
    updated.length = 0;
    published.length = 0;
  });

  it('reads a first send back as a timeout and the one send after a read as resent', async () => {
    storedRows.push(
      row({ status: 'pending', monitoringId: null, reportReason: null }),
      row({
        id: 2,
        componentInstance: 'Modem2',
        status: 'pending',
        monitoringId: null,
        reportReason: 'resent',
      }),
    );
    await recordLowSignalMonitorFailure(
      { id: 'sta_1', stationId: 'CS-1' },
      { setMonitoringData: [item('Modem1'), item('Modem2')] },
      'No response from station',
      deps,
      { timedOut: true },
    );
    expect(updated.map((u) => u['reportReason'])).toEqual(['timeout', 'resent']);
    expect(published.map((m) => (JSON.parse(m) as { action: string }).action)).toEqual([
      'GetMonitoringReport',
      'GetMonitoringReport',
    ]);
  });
});

describe('scheduleLowSignalSync', () => {
  const deps = { pubsub: {} as PubSubClient, log: pino({ level: 'silent' }) };

  it('runs one sync at a time and once more for a save during a run', async () => {
    let release: () => void = () => undefined;
    const thresholds: Array<number | null> = [];
    const sync = vi.fn(async (settings: { signalAlertBelowDbm: number | null }) => {
      thresholds.push(settings.signalAlertBelowDbm);
      if (thresholds.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { set: 0, cleared: 0 };
    });
    let current = -100;
    const read = async () => ({ stationSignalEnabled: true, signalAlertBelowDbm: current });

    const first = scheduleLowSignalSync(read, deps, sync);
    await vi.waitFor(() => {
      expect(sync).toHaveBeenCalledTimes(1);
    });
    current = -105;
    const second = scheduleLowSignalSync(read, deps, sync);
    current = -110;
    const third = scheduleLowSignalSync(read, deps, sync);
    release();
    await Promise.all([first, second, third]);
    expect(thresholds).toEqual([-100, -110]);
  });

  it('logs a failed run and lets the next save run', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('db down'));
    await scheduleLowSignalSync(
      async () => ({ stationSignalEnabled: true, signalAlertBelowDbm: -100 }),
      deps,
      failing,
    );
    const ok = vi.fn().mockResolvedValue({ set: 1, cleared: 0 });
    await scheduleLowSignalSync(
      async () => ({ stationSignalEnabled: true, signalAlertBelowDbm: -100 }),
      deps,
      ok,
    );
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
