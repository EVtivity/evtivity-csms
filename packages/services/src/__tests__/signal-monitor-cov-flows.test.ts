// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The low signal monitor flows (`station-signal-monitor.service.ts`): the sync
// of an online 2.x station, the settings-save sync in batches, and the station
// answers (SetVariableMonitoring results and failures, GetMonitoringReport
// results and NotifyMonitoringReport) with the rows they write and the
// commands they publish.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PubSubClient, ServiceLogger } from '@evtivity/lib';
import type { FakeDb } from './helpers/fake-db.js';
import { opArgs } from './helpers/fake-db.js';

const h = vi.hoisted(() => ({
  fake: undefined as unknown as FakeDb,
  settings: defaultSignalSettings(),
}));

function defaultSignalSettings(): {
  stationSignalEnabled: boolean;
  signalAlertBelowDbm: number | null;
} {
  return { stationSignalEnabled: true, signalAlertBelowDbm: -100 };
}

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  const { sql } = await import('drizzle-orm');
  h.fake = createFakeDb();
  return fakeDatabaseModule(h.fake, {
    getSimGeneralSettings: () => Promise.resolve(h.settings),
    inOperatorStation: () => sql`true`,
    isOperatorStation: () => sql`true`,
  });
});

const svc = await import('../station-signal-monitor.service.js');

type Row = Parameters<typeof svc.planLowSignalSync>[0][number];

function row(over: Partial<Row>): Row {
  return {
    id: 1,
    stationId: 'sta_u',
    monitoringId: null,
    component: 'DataLink',
    componentInstance: 'M1',
    variable: 'SignalStrength',
    type: 'LowerThreshold',
    value: '-100',
    severity: 6,
    status: 'pending',
    errorInfo: null,
    source: 'low_signal',
    reportRequestId: null,
    reportReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

const station2x = { id: 'sta_u', stationId: 'CP1', ocppProtocol: 'ocpp2.1', isOnline: true };

function makeDeps(failPublish = false) {
  const published: { action: string; payload: Record<string, unknown> }[] = [];
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const pubsub = {
    publish: vi.fn((_channel: string, message: string) => {
      if (failPublish) return Promise.reject(new Error('redis down'));
      const parsed = JSON.parse(message) as {
        action: string;
        payload: Record<string, unknown>;
        noQueue?: boolean;
      };
      expect(parsed.noQueue).toBe(true);
      published.push({ action: parsed.action, payload: parsed.payload });
      return Promise.resolve();
    }),
    subscribe: vi.fn(),
  };
  return {
    published,
    log,
    deps: { pubsub: pubsub as unknown as PubSubClient, log: log as unknown as ServiceLogger },
  };
}

const item = (instance: string, value: number, id?: number) => ({
  ...(id != null ? { id } : {}),
  component: { name: 'DataLink', instance },
  variable: { name: 'SignalStrength' },
  type: 'LowerThreshold',
  value,
  severity: 6,
});

beforeEach(() => {
  h.fake.reset();
  h.settings = { stationSignalEnabled: true, signalAlertBelowDbm: -100 };
});

describe('syncStationLowSignalMonitor on an online 2.x station', () => {
  it('replaces a changed monitor by its id, inserts a new modem and clears a modem gone', async () => {
    const { deps, published } = makeDeps();
    h.fake.queue('select:variable_monitoring_rules', [
      row({ id: 1, componentInstance: 'M1', status: 'active', monitoringId: 41, value: '-90' }),
      row({ id: 9, componentInstance: 'M9', status: 'active', monitoringId: 77 }),
    ]);
    h.fake.queue('select:station_configurations', [
      { instance: 'M1', unit: 'dBm', value: '-80' },
      { instance: 'M2', unit: null, value: '-70' },
      { instance: 'M3', unit: 'percent', value: '50' },
    ]);
    h.fake.queue('update:variable_monitoring_rules', [
      row({ id: 1, componentInstance: 'M1', value: '-100', monitoringId: 41 }),
    ]);
    h.fake.queue('execute:INSERT INTO variable_monitoring_rules', [{ id: 5 }]);

    const result = await svc.syncStationLowSignalMonitor(station2x, h.settings, deps);

    expect(result).toEqual({ set: 2, cleared: 1 });
    const [upd] = h.fake.find('update', 'variable_monitoring_rules');
    expect(upd!.set).toMatchObject({ value: '-100', status: 'pending', reportRequestId: null });
    expect(h.fake.find('delete', 'variable_monitoring_rules')).toHaveLength(1);
    expect(published).toEqual([
      { action: 'ClearVariableMonitoring', payload: { id: [77] } },
      {
        action: 'SetVariableMonitoring',
        payload: { setMonitoringData: [item('M1', -100, 41), item('M2', -100)] },
      },
    ]);
  });

  it('sends nothing when a concurrent sync stored the new modem first', async () => {
    const { deps, published } = makeDeps();
    h.fake.queue('select:station_configurations', [{ instance: 'M5', unit: 'ASU', value: '10' }]);
    const result = await svc.syncStationLowSignalMonitor(station2x, h.settings, deps);
    expect(result).toEqual({ set: 0, cleared: 0 });
    expect(h.fake.find('execute')).toHaveLength(1);
    expect(published).toHaveLength(0);
  });

  it('drops a resend whose row is gone and keeps other rows', async () => {
    const { deps, published } = makeDeps();
    h.fake.queue('select:variable_monitoring_rules', [
      row({ status: 'error', monitoringId: null, value: '-90' }),
    ]);
    h.fake.queue('select:station_configurations', [{ instance: 'M1', unit: 'dBm', value: '-80' }]);
    const result = await svc.syncStationLowSignalMonitor(station2x, h.settings, deps);
    expect(result).toEqual({ set: 0, cleared: 0 });
    expect(published).toHaveLength(0);
  });

  it('removes the monitors of a 1.6 station without a read of unknown ids', async () => {
    const { deps, published } = makeDeps();
    h.fake.queue('select:variable_monitoring_rules', [
      row({ id: 3, status: 'active', monitoringId: null }),
    ]);
    const result = await svc.syncStationLowSignalMonitor(
      { ...station2x, ocppProtocol: 'ocpp1.6' },
      h.settings,
      deps,
    );
    expect(result).toEqual({ set: 0, cleared: 1 });
    expect(h.fake.find('delete', 'variable_monitoring_rules')).toHaveLength(1);
    expect(published).toHaveLength(0);
  });

  it('logs a command it cannot publish and still reports the sync', async () => {
    const { deps, log } = makeDeps(true);
    h.fake.queue('select:variable_monitoring_rules', [row({ status: 'active', monitoringId: 5 })]);
    h.settings = { stationSignalEnabled: false, signalAlertBelowDbm: -100 };
    const result = await svc.syncStationLowSignalMonitor(station2x, h.settings, deps);
    expect(result).toEqual({ set: 0, cleared: 1 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ClearVariableMonitoring', stationId: 'CP1' }),
      expect.stringContaining('not published'),
    );
  });
});

describe('syncLowSignalMonitors', () => {
  it('reads stations in batches, sums the results and goes on after a failed station', async () => {
    const { deps, published, log } = makeDeps();
    h.settings = { stationSignalEnabled: false, signalAlertBelowDbm: null };
    h.fake.queue('select:charging_stations', [
      { ...station2x, id: 's1', stationId: 'CP1' },
      { ...station2x, id: 's2', stationId: 'CP2' },
    ]);
    h.fake.queue('select:charging_stations', [{ ...station2x, id: 's3', stationId: 'CP3' }]);
    h.fake.fail('select:variable_monitoring_rules', new Error('db down'));
    h.fake.queue('select:variable_monitoring_rules', [
      row({ id: 4, stationId: 's2', status: 'active', monitoringId: 9 }),
    ]);

    const total = await svc.syncLowSignalMonitors(h.settings, deps, { batchSize: 2 });

    expect(total).toEqual({ set: 0, cleared: 1 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'CP1' }),
      expect.stringContaining('the others go on'),
    );
    expect(published).toEqual([{ action: 'ClearVariableMonitoring', payload: { id: [9] } }]);
    const batches = h.fake.find('select', 'charging_stations');
    expect(batches).toHaveLength(2);
    expect(opArgs(batches[0], 'limit')).toEqual([2]);
  });

  it('stops after a short first batch while the alert is wanted', async () => {
    const { deps } = makeDeps();
    const total = await svc.syncLowSignalMonitors(h.settings, deps);
    expect(total).toEqual({ set: 0, cleared: 0 });
    const [batch] = h.fake.find('select', 'charging_stations');
    expect(opArgs(batch, 'limit')).toEqual([svc.LOW_SIGNAL_SYNC_BATCH]);
  });
});

describe('recordLowSignalMonitorResults', () => {
  const st = { id: 'sta_u', stationId: 'CP1' };
  const pending = [
    row({ id: 1, componentInstance: 'M1', monitoringId: 41 }),
    row({ id: 2, componentInstance: 'M2' }),
    row({ id: 3, componentInstance: 'M3' }),
  ];

  it('resends a rejected replace, reads back a Duplicate and stores an Accepted id', async () => {
    const { deps, published } = makeDeps();
    h.fake.always('select:variable_monitoring_rules', pending);
    h.fake.queue('select:charging_stations', [station2x]);
    h.fake.queue('update:variable_monitoring_rules', [{ ...pending[0]!, monitoringId: null }]);
    h.fake.queue('update:variable_monitoring_rules', [{ id: 3 }]);
    h.fake.queue('update:variable_monitoring_rules', [{ ...pending[1]!, reportRequestId: 7 }]);

    const updated = await svc.recordLowSignalMonitorResults(
      st,
      {
        setMonitoringData: [
          item('M1', -100, 41),
          item('M2', -100),
          item('M3', -100),
          { ...item('M4', 10), type: 'UpperThreshold' },
        ],
      },
      {
        setMonitoringResult: [
          { ...item('M1', -100, 41), status: 'Rejected' },
          { ...item('M2', -100), status: 'Duplicate' },
          { ...item('M3', -100), status: 'Accepted', id: 55 },
        ],
      },
      deps,
    );

    expect(updated).toBe(3);
    const updates = h.fake.find('update', 'variable_monitoring_rules');
    expect(updates[0]!.set).toMatchObject({ monitoringId: null });
    expect(updates[1]!.set).toMatchObject({ status: 'active', monitoringId: 55, errorInfo: null });
    expect(updates[2]!.set).toMatchObject({ status: 'pending', reportReason: 'duplicate' });
    expect(published.map((p) => p.action)).toEqual([
      'GetMonitoringReport',
      'SetVariableMonitoring',
    ]);
    expect(published[0]!.payload).toMatchObject({
      monitoringCriteria: ['ThresholdMonitoring'],
      componentVariable: [
        { component: { name: 'DataLink', instance: 'M2' }, variable: { name: 'SignalStrength' } },
      ],
    });
    expect(published[1]!.payload).toEqual({ setMonitoringData: [item('M1', -100)] });
  });

  it('deletes a rejected replace no longer wanted and reads a resent Duplicate as resent', async () => {
    const { deps, published } = makeDeps();
    h.settings = { stationSignalEnabled: false, signalAlertBelowDbm: -100 };
    h.fake.always('select:variable_monitoring_rules', [
      pending[0]!,
      row({ id: 2, componentInstance: 'M2', reportReason: 'resent' }),
    ]);
    h.fake.queue('select:charging_stations', [station2x]);
    h.fake.queue('update:variable_monitoring_rules', [{ ...pending[0]!, monitoringId: null }]);
    h.fake.queue('update:variable_monitoring_rules', [row({ id: 2, componentInstance: 'M2' })]);

    const updated = await svc.recordLowSignalMonitorResults(
      st,
      { setMonitoringData: [item('M1', -100, 41), item('M2', -100)] },
      {
        setMonitoringResult: [
          { ...item('M1', -100, 41), status: 'Rejected' },
          { ...item('M2', -100), status: 'Duplicate' },
        ],
      },
      deps,
    );

    expect(updated).toBe(2);
    expect(h.fake.find('update', 'variable_monitoring_rules')[1]!.set).toMatchObject({
      reportReason: 'resent',
    });
    expect(h.fake.find('delete', 'variable_monitoring_rules')).toHaveLength(1);
    expect(published.map((p) => p.action)).toEqual(['GetMonitoringReport']);
  });

  it('changes nothing for items without a pending row or a non-array request', async () => {
    const { deps, published } = makeDeps();
    expect(
      await svc.recordLowSignalMonitorResults(
        st,
        { setMonitoringData: [item('M1', -100)] },
        {},
        deps,
      ),
    ).toBe(0);
    expect(await svc.recordLowSignalMonitorResults(st, undefined, undefined, deps)).toBe(0);
    expect(published).toHaveLength(0);
  });

  it('follows up after a stored answer: a monitor switched off meanwhile is cleared', async () => {
    const { deps, published } = makeDeps();
    h.fake.queue('select:variable_monitoring_rules', pending);
    h.fake.queue('update:variable_monitoring_rules', [{ id: 3 }]);
    // Follow-up: the station, then its rows (the accepted one now active).
    h.fake.queue('select:charging_stations', [station2x]);
    h.fake.queue('select:variable_monitoring_rules', [
      row({ id: 3, componentInstance: 'M3', status: 'active', monitoringId: 55 }),
    ]);
    h.settings = { stationSignalEnabled: false, signalAlertBelowDbm: null };

    const updated = await svc.recordLowSignalMonitorResults(
      st,
      { setMonitoringData: [item('M3', -100)] },
      { setMonitoringResult: [{ ...item('M3', -100), status: 'Accepted', id: 55 }] },
      deps,
    );

    expect(updated).toBe(1);
    expect(published).toEqual([{ action: 'ClearVariableMonitoring', payload: { id: [55] } }]);
  });
});

describe('recordLowSignalMonitorFailure', () => {
  const st = { id: 'sta_u', stationId: 'CP1' };

  it('marks the pending rows error on a non-timeout failure', async () => {
    const { deps } = makeDeps();
    h.fake.queue('select:variable_monitoring_rules', [row({ id: 1 })]);
    h.fake.queue('update:variable_monitoring_rules', [{ id: 1 }]);
    const changed = await svc.recordLowSignalMonitorFailure(
      st,
      { setMonitoringData: [item('M1', -100)] },
      'Station not connected',
      deps,
    );
    expect(changed).toBe(1);
    expect(h.fake.find('update', 'variable_monitoring_rules')[0]!.set).toMatchObject({
      status: 'error',
      errorInfo: 'Station not connected',
      reportReason: null,
    });
  });

  it('answers 0 without pending rows, and writes no follow-up when nothing changed', async () => {
    const { deps } = makeDeps();
    expect(
      await svc.recordLowSignalMonitorFailure(
        st,
        { setMonitoringData: [item('M1', -100)] },
        'e',
        deps,
      ),
    ).toBe(0);
    h.fake.queue('select:variable_monitoring_rules', [row({ id: 1 })]);
    expect(
      await svc.recordLowSignalMonitorFailure(
        st,
        { setMonitoringData: [item('M1', -100)] },
        'e',
        deps,
      ),
    ).toBe(0);
    expect(h.fake.find('select', 'charging_stations')).toHaveLength(0);
  });
});

describe('recordLowSignalReportResult', () => {
  const st = { id: 'sta_u', stationId: 'CP1' };
  const req = { requestId: 7 };

  it('answers 0 for a request without a number id or without reading rows', async () => {
    const { deps } = makeDeps();
    expect(await svc.recordLowSignalReportResult(st, { requestId: 'x' }, {}, deps)).toBe(0);
    expect(await svc.recordLowSignalReportResult(st, req, {}, deps)).toBe(0);
    expect(h.fake.find('select')).toHaveLength(1);
  });

  it('waits for the report after Accepted', async () => {
    const { deps } = makeDeps();
    h.fake.queue('select:variable_monitoring_rules', [row({ reportRequestId: 7 })]);
    expect(
      await svc.recordLowSignalReportResult(st, req, { response: { status: 'Accepted' } }, deps),
    ).toBe(0);
    expect(h.fake.find('update')).toHaveLength(0);
  });

  it('ends an empty read: removal rows deleted, a timeout read sent again, a Duplicate failed', async () => {
    const { deps, published } = makeDeps();
    const timeout = row({
      id: 1,
      componentInstance: 'M1',
      reportRequestId: 7,
      reportReason: 'timeout',
    });
    const dup = row({
      id: 2,
      componentInstance: 'M2',
      reportRequestId: 7,
      reportReason: 'duplicate',
    });
    const remove = row({
      id: 3,
      componentInstance: 'M3',
      reportRequestId: 7,
      reportReason: 'remove',
    });
    h.fake.queue('select:variable_monitoring_rules', [timeout, dup, remove]);
    h.fake.queue('delete:variable_monitoring_rules', [{ id: 3 }]);
    h.fake.queue('select:charging_stations', [station2x]);
    h.fake.queue('update:variable_monitoring_rules', [{ ...timeout, reportReason: 'resent' }]);
    h.fake.queue('update:variable_monitoring_rules', [{ id: 2 }]);

    const ended = await svc.recordLowSignalReportResult(
      st,
      req,
      { response: { status: 'EmptyResultSet' } },
      deps,
    );

    expect(ended).toBe(3);
    const updates = h.fake.find('update', 'variable_monitoring_rules');
    expect(updates[0]!.set).toMatchObject({
      status: 'pending',
      monitoringId: null,
      reportReason: 'resent',
    });
    expect(updates[1]!.set).toMatchObject({
      status: 'error',
      errorInfo: expect.stringContaining('its report lists none'),
    });
    expect(published).toEqual([
      { action: 'SetVariableMonitoring', payload: { setMonitoringData: [item('M1', -100)] } },
    ]);
  });

  it('deletes the rows of an empty read no longer wanted', async () => {
    const { deps, published } = makeDeps();
    h.settings = { stationSignalEnabled: false, signalAlertBelowDbm: null };
    h.fake.queue('select:variable_monitoring_rules', [
      row({ id: 1, reportRequestId: 7, reportReason: 'timeout' }),
    ]);
    expect(
      await svc.recordLowSignalReportResult(
        st,
        req,
        { response: { status: 'EmptyResultSet' } },
        deps,
      ),
    ).toBe(1);
    expect(h.fake.find('delete', 'variable_monitoring_rules')).toHaveLength(1);
    expect(h.fake.find('update')).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it('marks the rows error on a failed read, deleting removal rows with a warning', async () => {
    const { deps, log } = makeDeps();
    h.fake.queue('select:variable_monitoring_rules', [
      row({ id: 1, reportRequestId: 7, reportReason: 'remove' }),
      row({ id: 2, reportRequestId: 7, reportReason: 'duplicate' }),
    ]);
    h.fake.queue('delete:variable_monitoring_rules', [{ id: 1 }]);
    h.fake.queue('update:variable_monitoring_rules', [{ id: 2 }]);
    expect(await svc.recordLowSignalReportResult(st, req, { error: 'timeout' }, deps)).toBe(2);
    expect(h.fake.find('update', 'variable_monitoring_rules')[0]!.set).toMatchObject({
      status: 'error',
      errorInfo: 'GetMonitoringReport: timeout',
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'timeout' }),
      expect.stringContaining('removal read failed'),
    );
  });

  it('names the status, or its absence, in the error', async () => {
    const { deps } = makeDeps();
    h.fake.queue('select:variable_monitoring_rules', [row({ id: 2, reportRequestId: 7 })]);
    await svc.recordLowSignalReportResult(st, req, { response: { status: 'Rejected' } }, deps);
    h.fake.queue('select:variable_monitoring_rules', [row({ id: 2, reportRequestId: 7 })]);
    await svc.recordLowSignalReportResult(st, req, { response: {} }, deps);
    const updates = h.fake.find('update', 'variable_monitoring_rules');
    expect(updates.map((u) => (u.set as { errorInfo: string }).errorInfo)).toEqual([
      'GetMonitoringReport: Rejected',
      'GetMonitoringReport: No GetMonitoringReport status',
    ]);
  });

  it('answers the removal count when only removal rows waited', async () => {
    const { deps } = makeDeps();
    h.fake.queue('select:variable_monitoring_rules', [
      row({ id: 1, reportRequestId: 7, reportReason: 'remove' }),
    ]);
    expect(await svc.recordLowSignalReportResult(st, req, { error: 'x' }, deps)).toBe(0);
    expect(h.fake.find('update')).toHaveLength(0);
  });
});

describe('recordLowSignalMonitorReport', () => {
  const st = { id: 'sta_u', stationId: 'CP1' };
  const monitor = (instance: string, id: number, value: number) => ({
    component: { name: 'DataLink', instance },
    variable: { name: 'SignalStrength' },
    variableMonitoring: [{ id, value, type: 'LowerThreshold', severity: 6 }],
  });
  const reading = [
    row({ id: 1, componentInstance: 'M1', reportRequestId: 7, reportReason: 'duplicate' }),
    row({ id: 2, componentInstance: 'M2', reportRequestId: 7, reportReason: 'duplicate' }),
    row({ id: 3, componentInstance: 'M3', reportRequestId: 7, reportReason: 'duplicate' }),
    row({ id: 4, componentInstance: 'M4', reportRequestId: 7, reportReason: 'remove' }),
  ];

  it('takes found ids, fails operator-only and missing modems, clears removal finds', async () => {
    const { deps, published } = makeDeps();
    h.fake.queue('select:variable_monitoring_rules', reading);
    h.fake.queue('select:variable_monitoring_rules', [
      { monitoringId: 99 },
      { monitoringId: null },
    ]);
    h.fake.queue('delete:variable_monitoring_rules', [{ id: 4 }]);
    h.fake.queue('update:variable_monitoring_rules', [{ id: 1 }]);
    h.fake.queue('update:variable_monitoring_rules', [{ id: 3 }]);
    h.fake.queue('select:charging_stations', [station2x]);
    h.fake.queue('update:variable_monitoring_rules', [{ id: 2 }]);

    const ended = await svc.recordLowSignalMonitorReport(
      st,
      {
        requestId: 7,
        tbc: false,
        monitor: [monitor('M1', 41, -95), monitor('M3', 99, -100), monitor('M4', 60, -100)],
      },
      deps,
    );

    expect(ended).toBe(4);
    const updates = h.fake.find('update', 'variable_monitoring_rules');
    expect(updates[0]!.set).toMatchObject({ status: 'active', monitoringId: 41, value: '-95' });
    expect(updates[1]!.set).toMatchObject({
      status: 'error',
      errorInfo: expect.stringContaining('operator rule'),
    });
    expect(updates[2]!.set).toMatchObject({ status: 'error' });
    expect(published).toEqual([{ action: 'ClearVariableMonitoring', payload: { id: [60] } }]);
  });

  it('waits for later messages while tbc is true', async () => {
    const { deps, published } = makeDeps();
    h.fake.queue('select:variable_monitoring_rules', reading);
    h.fake.queue('select:variable_monitoring_rules', []);
    h.fake.queue('update:variable_monitoring_rules', [{ id: 1 }]);
    // Follow-up after the found modem: no station row.
    const ended = await svc.recordLowSignalMonitorReport(
      st,
      { requestId: 7, tbc: true, monitor: [monitor('M1', 41, -100)] },
      deps,
    );
    expect(ended).toBe(1);
    expect(h.fake.find('delete')).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it('answers the removals alone when only removal rows waited, and 0 without rows', async () => {
    const { deps } = makeDeps();
    expect(await svc.recordLowSignalMonitorReport(st, { requestId: 7 }, deps)).toBe(0);
    h.fake.queue('select:variable_monitoring_rules', [reading[3]!]);
    h.fake.queue('delete:variable_monitoring_rules', [{ id: 4 }]);
    expect(await svc.recordLowSignalMonitorReport(st, { requestId: 7, monitor: 'x' }, deps)).toBe(
      1,
    );
  });
});

describe('reportedLowSignalMonitor and planLowSignalSync edges', () => {
  it('skips entries of another component, variable or modem and monitors not shaped right', () => {
    const monitors = [
      { component: { name: 'EVSE' }, variable: { name: 'SignalStrength' } },
      { component: { name: 'DataLink' }, variable: { name: 'Power' } },
      { component: { name: 'DataLink', instance: 'M2' }, variable: { name: 'SignalStrength' } },
      { component: { name: 'DataLink' }, variable: { name: 'SignalStrength' } },
      {
        component: { name: 'DataLink' },
        variable: { name: 'SignalStrength' },
        variableMonitoring: [
          { id: 1.5, value: -100, type: 'LowerThreshold', severity: 6 },
          { id: 2, value: '-100', type: 'LowerThreshold', severity: 6 },
          { id: 3, value: -100, type: 'UpperThreshold', severity: 6 },
          { id: 4, value: -100, type: 'LowerThreshold', severity: 5 },
        ],
      },
    ];
    expect(svc.reportedLowSignalMonitor(monitors, null, new Set())).toEqual({ kind: 'none' });
    expect(
      svc.reportedLowSignalMonitor(
        [
          ...monitors,
          {
            component: { name: 'DataLink' },
            variable: { name: 'SignalStrength' },
            variableMonitoring: [{ id: 9, value: -101, type: 'LowerThreshold', severity: 6 }],
          },
        ],
        null,
        new Set(),
      ),
    ).toEqual({ kind: 'found', id: 9, value: -101 });
  });

  it('leaves an unchanged monitor alone when only changed values are synced', () => {
    const plan = svc.planLowSignalSync(
      [row({ status: 'error', value: '-100', monitoringId: 4 })],
      [{ instance: 'M1', threshold: -100 }],
      false,
      { changedValuesOnly: true },
    );
    expect(plan).toEqual({ resend: [], insert: [], remove: [] });
  });
});
