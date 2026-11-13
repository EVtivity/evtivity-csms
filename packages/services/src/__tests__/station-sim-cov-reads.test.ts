// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Database reads and writes of the station SIM service: the confirmed
// attachment view and its windows, coverage merges, covered days, disconnect
// causes, the station signal read (GetVariables and GetConfiguration), the
// stored signal snapshot and the layout link summaries.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/fake-db.js';
import { opArgs, sqlParams, sqlString } from './helpers/fake-db.js';

const h = vi.hoisted(() => ({ fake: undefined as unknown as FakeDb }));

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  h.fake = createFakeDb();
  return fakeDatabaseModule(h.fake, {
    getSim: vi.fn(),
    getSimProviderSettings: vi.fn(),
    recordSimLookup: vi.fn(),
    recordSimStatus: vi.fn(),
    recordSimSessionsSynced: vi.fn(),
    recordSimAlertsSynced: vi.fn(),
    writeAudit: vi.fn(),
    compareRecordIds: (a: string, b: string) => Number(a) - Number(b),
  });
});
vi.mock('../sim-inventory.service.js', () => ({ attachReportedStationSim: vi.fn() }));

import { SimProviderRegistry, type SimProvider } from '@evtivity/sim-providers';
import type { Sim } from '@evtivity/database';
import type { CommandResult } from '../ocpp-command.js';
import {
  ACTIVE_NETWORK_PROFILE,
  atInWindows,
  confirmedStationSim,
  createSimProviderRegistry,
  dataLinkGetVariables,
  fetchedAfterFloor,
  OPEN_WINDOW_END,
  readStationDataLink,
  recordSimFetchCoverage,
  simCoverageLockKey,
  simCoveredDays,
  simHistoryDays,
  simRefOf,
  spanInWindows,
  SIM_KEYS,
  SIM_SIGNAL_READ_SECONDS,
  stationDisconnectCauses,
  stationLinkSummaries,
  stationSignalSnapshot,
  stationSimView,
  type SimKeyStore,
} from '../station-sim.service.js';

const NOW = new Date('2026-10-21T12:00:00Z');
const HOUR = 3_600_000;

function simRow(fields: Partial<Sim> = {}): Sim {
  return {
    id: 'sim_1',
    iccid: '8901260000000000001',
    provider: 'hologram',
    providerRef: '4001',
    providerMeta: null,
    status: 'active',
    historyFloorAt: null,
    statusFetchedAt: null,
    openSessionBeganAt: null,
    ...fields,
  } as Sim;
}

function keyStore(acquire: () => Promise<boolean>): SimKeyStore {
  return {
    acquire: vi.fn(acquire),
    renew: vi.fn(),
    release: vi.fn(),
    ttlSeconds: vi.fn(),
    setFor: vi.fn(),
    increment: vi.fn(),
  };
}

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  h.fake.reset();
  vi.clearAllMocks();
});

describe('createSimProviderRegistry and simRefOf', () => {
  it('builds a provider registry', () => {
    expect(createSimProviderRegistry('k'.repeat(32), null)).toBeInstanceOf(SimProviderRegistry);
  });

  it('carries a 1NCE simcard id and ignores ids of another type', () => {
    expect(simRefOf({ providerRef: '9', providerMeta: { simcardId: 'sc1', linkId: 5 } })).toEqual({
      providerSimId: '9',
      simcardId: 'sc1',
    });
  });
});

describe('confirmed attachment and its window', () => {
  it('answers null without an open confirmed attachment', async () => {
    expect(await confirmedStationSim('sta_1')).toBeNull();
    expect(await stationSimView('sta_1')).toBeNull();
    const where = opArgs(h.fake.calls[0], 'where')?.[0];
    expect(await sqlParams(where)).toContain('sta_1');
    expect(await sqlString(where)).toMatch(/is null.*is not null/);
  });

  it('bounds the view at the history floor, or at the epoch without one', async () => {
    const floor = new Date('2026-10-01T00:00:00Z');
    h.fake.queue('select', [{ sim: simRow({ historyFloorAt: floor }), attachment: { id: 1 } }]);
    const view = await stationSimView('sta_1');
    expect(view?.windows).toEqual([{ from: floor, to: OPEN_WINDOW_END }]);
    h.fake.queue('select', [{ sim: simRow(), attachment: { id: 1 } }]);
    expect((await stationSimView('sta_1'))?.windows[0]!.from.getTime()).toBe(0);
  });

  it('never matches a row without a window', async () => {
    expect(await sqlString(atInWindows('t.at' as never, []))).toBe('false');
    expect(await sqlString(spanInWindows('t.a' as never, 't.b' as never, []))).toBe('false');
    const w = [{ from: new Date(0), to: OPEN_WINDOW_END }];
    expect(await sqlParams(atInWindows('t.at' as never, w))).toContain('t.at');
  });

  it('shows fetch state only when fetched after the floor', () => {
    const floor = new Date('2026-10-10T00:00:00Z');
    expect(fetchedAfterFloor(null, simRow())).toBe(false);
    expect(fetchedAfterFloor(new Date(1), simRow())).toBe(true);
    expect(
      fetchedAfterFloor(new Date('2026-10-09T00:00:00Z'), simRow({ historyFloorAt: floor })),
    ).toBe(false);
    expect(
      fetchedAfterFloor(new Date('2026-10-11T00:00:00Z'), simRow({ historyFloorAt: floor })),
    ).toBe(true);
  });
});

describe('simHistoryDays', () => {
  it('takes the shortest window of the enabled providers, null without one', async () => {
    const registry = (providers: Partial<SimProvider>[]) =>
      ({ enabledProviders: () => Promise.resolve(providers) }) as unknown as SimProviderRegistry;
    expect(await simHistoryDays(registry([]))).toBeNull();
    expect(await simHistoryDays(registry([{ historyDays: 90 }, { historyDays: 30 }]))).toBe(30);
  });
});

describe('recordSimFetchCoverage', () => {
  const from = new Date('2026-10-10T00:00:00Z');
  const to = new Date('2026-10-12T00:00:00Z');

  it('writes nothing for an empty range', async () => {
    await recordSimFetchCoverage('sim_1', 'hologram', { from: to, to: from }, NOW);
    expect(h.fake.calls).toHaveLength(0);
  });

  it('locks the SIM and inserts a range that touches no other', async () => {
    await recordSimFetchCoverage('sim_1', 'hologram', { from, to }, NOW);
    expect(h.fake.find('execute')[0]!.text).toContain('pg_advisory_xact_lock');
    expect(h.fake.find('delete')).toHaveLength(0);
    expect(h.fake.find('insert', 'sim_fetch_coverage')[0]!.values).toEqual({
      simId: 'sim_1',
      provider: 'hologram',
      coveredFrom: from,
      coveredTo: to,
      fetchedAt: NOW,
    });
    expect(simCoverageLockKey('sim_1')).toBe('sim_coverage:sim_1');
  });

  it('replaces the touching ranges with one merged range', async () => {
    h.fake.queue('select:sim_fetch_coverage', [
      { id: 'c1', coveredFrom: new Date('2026-10-08T00:00:00Z'), coveredTo: from },
      {
        id: 'c2',
        coveredFrom: new Date('2026-10-11T00:00:00Z'),
        coveredTo: new Date('2026-10-14T00:00:00Z'),
      },
    ]);
    await recordSimFetchCoverage('sim_1', 'hologram', { from, to }, NOW);
    const [del] = h.fake.find('delete', 'sim_fetch_coverage');
    expect(await sqlParams(opArgs(del, 'where')?.[0])).toEqual(
      expect.arrayContaining(['c1', 'c2']),
    );
    expect(h.fake.find('insert', 'sim_fetch_coverage')[0]!.values).toMatchObject({
      coveredFrom: new Date('2026-10-08T00:00:00Z'),
      coveredTo: new Date('2026-10-14T00:00:00Z'),
    });
    expect(h.fake.calls.every((c) => c.inTx)).toBe(true);
  });
});

describe('simCoveredDays', () => {
  const bounds = { historyDays: 30, retentionDays: 90, reportingDelayHours: 6 };
  const from = new Date('2026-10-19T00:00:00Z');
  const to = new Date('2026-10-21T00:00:00Z');

  it('reads nothing and marks no day fetched without a SIM', async () => {
    const days = await simCoveredDays(null, from, to, 'UTC', bounds, NOW);
    expect(h.fake.calls).toHaveLength(0);
    expect(days.length).toBeGreaterThan(0);
    expect(days.some((d) => d.label === 'has_data' || d.label === 'no_sessions')).toBe(false);
  });

  it('counts covered days and clips the coverage to the windows', async () => {
    h.fake.queue('select:sim_fetch_coverage', [
      { from: new Date('2026-10-18T00:00:00Z'), to: new Date('2026-10-21T00:00:00Z') },
    ]);
    h.fake.queue('select:sim_sessions', [
      { startedAt: new Date('2026-10-19T10:00:00Z'), endedAt: new Date('2026-10-19T11:00:00Z') },
    ]);
    h.fake.queue('select:sim_alerts', [{ receivedAt: new Date('2026-10-20T10:00:00Z') }]);
    const all = await simCoveredDays('sim_1', from, to, 'UTC', bounds, NOW);
    const clipped = await simCoveredDays(
      'sim_1',
      from,
      to,
      'UTC',
      {
        ...bounds,
        historyDays: null,
        windows: [{ from: new Date('2026-10-20T00:00:00Z'), to: OPEN_WINDOW_END }],
      },
      NOW,
    );
    expect(all).not.toEqual(clipped);
    expect(all.some((d) => d.label === 'has_data')).toBe(true);
    // The windowed read filters the sessions and alerts by the window too.
    const sessionsReads = h.fake.find('select', 'sim_sessions');
    expect(await sqlParams(opArgs(sessionsReads[1], 'where')?.[0])).toContain(
      'sim_sessions.startedAt',
    );
    expect(sessionsReads).toHaveLength(2);
  });
});

describe('stationDisconnectCauses', () => {
  const at = new Date('2026-10-20T10:00:00Z');

  it('answers nothing for no disconnect, and reads no SIM data without a view', async () => {
    expect(await stationDisconnectCauses('sta_1', [], { reportingDelayHours: 6 })).toEqual([]);
    expect(h.fake.calls).toHaveLength(0);
    const causes = await stationDisconnectCauses('sta_1', [{ at, reason: null }], {
      reportingDelayHours: 6,
      now: NOW,
    });
    expect(causes).toHaveLength(1);
    expect(h.fake.calls).toHaveLength(1);
  });

  it('reads the SIM rows of the confirmed attachment and uses its status after the floor', async () => {
    h.fake.queue('select', [
      {
        sim: simRow({
          statusFetchedAt: new Date('2026-10-20T09:00:00Z'),
          openSessionBeganAt: new Date('2026-10-20T08:00:00Z'),
        }),
        attachment: { id: 1 },
      },
    ]);
    const causes = await stationDisconnectCauses(
      'sta_1',
      [
        { at, reason: null },
        { at: new Date(at.getTime() + HOUR), reason: null },
      ],
      { reportingDelayHours: 6, now: NOW },
    );
    expect(causes).toHaveLength(2);
    // The view, three session reads, the alerts and the coverage.
    expect(h.fake.find('select', 'sim_sessions')).toHaveLength(3);
    expect(h.fake.find('select', 'sim_alerts')).toHaveLength(1);
    expect(h.fake.find('select', 'sim_fetch_coverage')).toHaveLength(1);
    const [, before] = h.fake.find('select', 'sim_sessions');
    expect(opArgs(before, 'limit')).toEqual([1]);
  });
});

describe('dataLinkGetVariables', () => {
  const rows = [
    { component: 'DataLink', instance: 'B', variable: 'SignalStrength' },
    { component: 'DataLink', instance: 'B', variable: 'ICCID' },
    { component: 'DataLink', instance: 'A', variable: 'Active' },
    { component: 'DataLink', instance: 'A', variable: 'Vendor' },
    { component: 'OCPPCommCtrlr', instance: null, variable: 'ActiveNetworkProfile' },
  ];

  it('asks nothing without DataLink rows', () => {
    expect(dataLinkGetVariables([rows[4]!], null)).toEqual([]);
  });

  it('asks every signal strength first, then the profile, then the reported variables', () => {
    const items = dataLinkGetVariables(rows, null);
    expect(items.map((i) => (i['variable'] as { name: string }).name)).toEqual([
      'SignalStrength',
      'SignalStrength',
      ACTIVE_NETWORK_PROFILE.variable,
      'ICCID',
      'Active',
    ]);
    expect(items[0]!['component']).toEqual({ name: 'DataLink', instance: 'B' });
  });

  it('keeps within the items limit and the message bytes, never below one item', () => {
    expect(dataLinkGetVariables(rows, 2)).toHaveLength(2);
    expect(dataLinkGetVariables(rows, null, 10)).toHaveLength(1);
    const withoutInstance = dataLinkGetVariables(
      [{ component: 'DataLink', instance: null, variable: 'SignalStrength' }],
      null,
    );
    expect(withoutInstance[0]!['component']).toEqual({ name: 'DataLink' });
  });
});

describe('readStationDataLink', () => {
  const settings = { stationSignalEnabled: true, ocpp16SignalKeys: ['CSQ'] };
  const ok: CommandResult = { response: { getVariableResult: [] } } as unknown as CommandResult;

  function ctx(
    send: (...a: unknown[]) => Promise<CommandResult>,
    acquire = () => Promise.resolve(true),
  ) {
    return { keys: keyStore(acquire), log, send: vi.fn(send), now: () => NOW };
  }

  it('skips while signal reads are off, for a conformance station and an offline one', async () => {
    const c = ctx(() => Promise.resolve(ok));
    expect(
      await readStationDataLink(c as never, 'sta_1', { ...settings, stationSignalEnabled: false }),
    ).toEqual({ result: 'skipped', reason: 'signal_off' });
    h.fake.queue('select:charging_stations', [{ isConformance: true, isOnline: true }]);
    expect(await readStationDataLink(c as never, 'sta_1', settings)).toEqual({
      result: 'skipped',
      reason: 'not_operator_station',
    });
    expect(await readStationDataLink(c as never, 'sta_1', settings)).toEqual({
      result: 'skipped',
      reason: 'station_offline',
    });
    expect(c.send).not.toHaveBeenCalled();
  });

  it('skips a 2.x station without DataLink rows and a 1.6 station without keys', async () => {
    const c = ctx(() => Promise.resolve(ok));
    h.fake.queue('select:charging_stations', [
      { stationId: 'CS1', ocppProtocol: 'ocpp2.1', isOnline: true },
    ]);
    expect(await readStationDataLink(c as never, 'sta_1', settings)).toEqual({
      result: 'skipped',
      reason: 'no_device_model',
    });
    h.fake.queue('select:charging_stations', [
      { stationId: 'CS1', ocppProtocol: 'ocpp1.6', isOnline: true },
    ]);
    expect(
      await readStationDataLink(c as never, 'sta_1', { ...settings, ocpp16SignalKeys: [] }),
    ).toEqual({ result: 'skipped', reason: 'no_keys' });
  });

  it('sends GetVariables within the reported limits and returns the read time', async () => {
    const c = ctx(() => Promise.resolve(ok));
    h.fake.queue('select:charging_stations', [
      { stationId: 'CS1', ocppProtocol: 'ocpp2.1', isOnline: true },
    ]);
    h.fake.queue('select:station_configurations', [
      { component: 'DataLink', instance: null, variable: 'SignalStrength' },
      { component: 'DataLink', instance: null, variable: 'ICCID' },
    ]);
    h.fake.queue('select:station_configurations', [{ value: '1' }]);
    h.fake.queue('select:station_configurations', [{ value: 'not a number' }]);
    const out = await readStationDataLink(c, 'sta_1', settings);
    expect(out).toEqual({ result: 'ok', readAt: NOW.toISOString() });
    expect(c.send).toHaveBeenCalledWith(
      'CS1',
      'GetVariables',
      {
        getVariableData: [
          { component: { name: 'DataLink' }, variable: { name: 'SignalStrength' } },
        ],
      },
      undefined,
      { noQueue: true },
    );
    expect(c.keys.acquire).toHaveBeenCalledWith(
      SIM_KEYS.signalRead('sta_1'),
      expect.any(String),
      SIM_SIGNAL_READ_SECONDS * 1000,
    );
  });

  it('sends GetConfiguration to a 1.6 station', async () => {
    const c = ctx(() => Promise.resolve(ok));
    h.fake.queue('select:charging_stations', [
      { stationId: 'CS2', ocppProtocol: 'ocpp1.6', isOnline: true },
    ]);
    await readStationDataLink(c, 'sta_2', settings);
    expect(c.send).toHaveBeenCalledWith('CS2', 'GetConfiguration', { key: ['CSQ'] }, 'ocpp1.6', {
      noQueue: true,
    });
  });

  it('skips a recent read and fails when Redis is down', async () => {
    const online = [{ stationId: 'CS2', ocppProtocol: 'ocpp1.6', isOnline: true }];
    h.fake.queue('select:charging_stations', online);
    expect(
      await readStationDataLink(
        ctx(
          () => Promise.resolve(ok),
          () => Promise.resolve(false),
        ) as never,
        'sta_2',
        settings,
      ),
    ).toEqual({ result: 'skipped', reason: 'recent' });
    h.fake.queue('select:charging_stations', online);
    const down = ctx(
      () => Promise.resolve(ok),
      () => Promise.reject(new Error('redis')),
    );
    expect(await readStationDataLink(down as never, 'sta_2', settings)).toEqual({
      result: 'failed',
      kind: 'unavailable',
    });
    expect(down.send).not.toHaveBeenCalled();
  });

  it('maps each command failure', async () => {
    const cases: [Partial<CommandResult>, unknown][] = [
      [
        { error: 'x', timedOut: true },
        { result: 'failed', kind: 'timeout' },
      ],
      [
        { error: 'x', code: 'OCPP_VERSION_MISMATCH' },
        { result: 'failed', kind: 'unsupported' },
      ],
      [
        { error: 'x', offline: true },
        { result: 'skipped', reason: 'station_offline' },
      ],
      [
        { error: 'x', queued: true },
        { result: 'skipped', reason: 'station_offline' },
      ],
      [{ error: 'x' }, { result: 'failed', kind: 'command_failed' }],
      [{}, { result: 'failed', kind: 'command_failed' }],
    ];
    for (const [result, expected] of cases) {
      h.fake.queue('select:charging_stations', [
        { stationId: 'CS2', ocppProtocol: 'ocpp1.6', isOnline: true },
      ]);
      const c = ctx(() => Promise.resolve(result as CommandResult));
      expect(await readStationDataLink(c as never, 'sta_2', settings)).toEqual(expected);
    }
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('stationSignalSnapshot', () => {
  const settings = { ocpp16SignalKeys: ['CSQ', 'RSSI'], signalGoodDbm: -70, signalFairDbm: -85 };

  it('answers null for an unknown station', async () => {
    expect(await stationSignalSnapshot('sta_x', settings)).toBeNull();
  });

  it('reads the 1.6 keys with the newest update time', async () => {
    h.fake.queue('select:charging_stations', [{ ocppProtocol: 'ocpp1.6' }]);
    h.fake.queue('select:station_configurations', [
      { variable: 'CSQ', value: '20', updatedAt: new Date('2026-10-20T00:00:00Z') },
      { variable: 'CSQ', value: '21', updatedAt: new Date('2026-10-21T00:00:00Z') },
    ]);
    const snap = await stationSignalSnapshot('sta_1', settings);
    expect(snap).toMatchObject({
      protocol: 'ocpp1.6',
      deviceModel: null,
      values: { CSQ: '20', RSSI: null },
      readAt: '2026-10-21T00:00:00.000Z',
      thresholds: { goodDbm: -70, fairDbm: -85 },
    });
  });

  it('reads no rows for a 1.6 station without keys', async () => {
    h.fake.queue('select:charging_stations', [{ ocppProtocol: 'ocpp1.6' }]);
    const snap = await stationSignalSnapshot('sta_1', { ...settings, ocpp16SignalKeys: [] });
    expect(snap).toMatchObject({ values: {}, readAt: null });
    expect(h.fake.calls).toHaveLength(1);
  });

  it('groups the 2.x DataLink values by instance with graded signals and the profile', async () => {
    h.fake.queue('select:charging_stations', [{ ocppProtocol: 'ocpp2.0.1' }]);
    const t = new Date('2026-10-21T01:00:00Z');
    h.fake.queue('select:station_configurations', [
      {
        component: 'OCPPCommCtrlr',
        instance: null,
        variable: 'ActiveNetworkProfile',
        value: '1',
        unit: null,
        updatedAt: t,
      },
      {
        component: 'OCPPCommCtrlr',
        instance: null,
        variable: 'Other',
        value: 'x',
        unit: null,
        updatedAt: t,
      },
      {
        component: 'DataLink',
        instance: 'B',
        variable: 'SignalStrength',
        value: '-60',
        unit: 'dBm',
        updatedAt: t,
      },
      {
        component: 'DataLink',
        instance: null,
        variable: 'ICCID',
        value: '89',
        unit: null,
        updatedAt: new Date(0),
      },
      {
        component: 'DataLink',
        instance: 'B',
        variable: 'Vendor',
        value: 'v',
        unit: null,
        updatedAt: t,
      },
    ]);
    const snap = await stationSignalSnapshot('sta_1', settings);
    expect(snap).toMatchObject({
      protocol: 'ocpp2x',
      deviceModel: 'ok',
      activeNetworkProfile: '1',
      readAt: t.toISOString(),
      values: {
        'OCPPCommCtrlr.ActiveNetworkProfile': '1',
        'DataLink[B].SignalStrength': '-60',
        'DataLink.ICCID': '89',
      },
    });
    expect(snap?.dataLinks.map((d) => d.instance)).toEqual([null, 'B']);
    expect(snap?.dataLinks[1]).toMatchObject({
      signalUnit: 'dBm',
      signal: { dbm: -60, grade: 'good' },
    });
  });

  it('tells a reported model without DataLink from an unread one', async () => {
    h.fake.queue('select:charging_stations', [{ ocppProtocol: 'ocpp2.1' }]);
    h.fake.queue((c) => c.kind === 'select' && opArgs(c, 'limit') != null, [{ id: 1 }]);
    expect((await stationSignalSnapshot('sta_1', settings))?.deviceModel).toBe('no_datalink');
    h.fake.queue('select:charging_stations', [{ ocppProtocol: 'ocpp2.1' }]);
    expect((await stationSignalSnapshot('sta_1', settings))?.deviceModel).toBe('unread');
  });
});

describe('stationLinkSummaries', () => {
  it('reads nothing for no station', async () => {
    const out = await stationLinkSummaries([], {
      signalEnabled: true,
      enabledProviders: ['hologram'],
    });
    expect(out.size).toBe(0);
    expect(h.fake.calls).toHaveLength(0);
  });

  it('takes the first known 2.x signal by instance and the newest session network type', async () => {
    h.fake.queue('select:station_configurations', [
      { stationId: 'a', instance: 'B', value: '-90', unit: 'dBm', ocppProtocol: 'ocpp2.1' },
      { stationId: 'a', instance: 'A', value: '-75', unit: 'dBm', ocppProtocol: 'ocpp2.1' },
      { stationId: 'b', instance: null, value: '5', unit: 'dBm', ocppProtocol: 'ocpp2.1' },
      { stationId: 'c', instance: null, value: '-60', unit: 'dBm', ocppProtocol: 'ocpp1.6' },
      { stationId: 'd', instance: null, value: 'junk', unit: null, ocppProtocol: 'ocpp2.1' },
    ]);
    h.fake.queue('select:sim_attachments', [
      { stationId: 'a', sim: simRow({ id: 'sim_a' }) },
      { stationId: 'b', sim: simRow({ id: 'sim_b', provider: 'other' }) },
      { stationId: 'c', sim: simRow({ id: 'sim_c', provider: null }) },
      { stationId: null, sim: simRow({ id: 'sim_n' }) },
      { stationId: 'e', sim: simRow({ id: 'sim_e' }) },
    ]);
    h.fake.always(
      (c) => c.kind === 'select' && c.table === 'sim_sessions',
      [{ radioAccessTechnology: ' LTE ' }],
    );
    const out = await stationLinkSummaries(['a', 'a', 'b', 'c', 'e'], {
      signalEnabled: true,
      enabledProviders: ['hologram'],
    });
    expect(out.get('a')).toEqual({ networkType: 'LTE', signalDbm: -75 });
    expect(out.get('e')).toEqual({ networkType: 'LTE', signalDbm: null });
    expect(out.has('b')).toBe(false);
    expect(out.has('c')).toBe(false);
    // Only enabled-provider SIMs with a station read their sessions.
    expect(h.fake.find('select', 'sim_sessions')).toHaveLength(2);
  });

  it('skips signal reads while off and the network type without providers', async () => {
    const out = await stationLinkSummaries(['a'], { signalEnabled: false, enabledProviders: [] });
    expect(out.size).toBe(0);
    expect(h.fake.calls).toHaveLength(0);
  });

  it('leaves the network type empty for a blank technology', async () => {
    h.fake.queue('select:sim_attachments', [{ stationId: 'a', sim: simRow() }]);
    h.fake.queue('select:sim_sessions', [{ radioAccessTechnology: '  ' }]);
    const out = await stationLinkSummaries(['a'], {
      signalEnabled: false,
      enabledProviders: ['hologram'],
    });
    expect(out.size).toBe(0);
  });
});
