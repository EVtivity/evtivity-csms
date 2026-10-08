// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type postgres from 'postgres';
import { OCTT_TEST_DRIVER_EMAIL, type PubSubClient } from '@evtivity/lib';
import { ChaosOrchestrator } from '../chaos-orchestrator.js';
import { JOURNEY_RETRY_MS, JOURNEY_WAIT_MS, type ChaosJourneys } from '../chaos-journey.js';

interface StationRow {
  station_id: string;
  ocpp_protocol: string;
}

interface StateRow {
  status: string;
  evse_status: string | null;
  has_tx: boolean;
}

interface Db {
  stations: StationRow[];
  tokens: Array<{ id_token: string; token_type: string }>;
  // Per-station state row; undefined means the row was deleted or disabled.
  state: Record<string, StateRow | undefined>;
  stateError?: Error;
  loadError?: Error | undefined;
  tokenQueryValues: unknown[][];
  stateQueries: number;
}

function makeDb(partial: Partial<Db> = {}): Db {
  return {
    stations: [{ station_id: 'CS-1', ocpp_protocol: 'ocpp2.1' }],
    tokens: [{ id_token: 'TOK-A', token_type: 'ISO14443' }],
    state: { 'CS-1': { status: 'available', evse_status: 'Available', has_tx: false } },
    tokenQueryValues: [],
    stateQueries: 0,
    ...partial,
  };
}

function makeSql(db: Db): postgres.Sql {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join(' ');
    if (q.includes('FROM charging_stations cs')) {
      if (db.loadError != null) return Promise.reject(db.loadError);
      return Promise.resolve(db.stations);
    }
    if (q.includes('FROM driver_tokens')) {
      db.tokenQueryValues.push(values);
      return Promise.resolve(db.tokens);
    }
    if (q.includes('FROM css_stations s')) {
      db.stateQueries++;
      if (db.stateError != null) return Promise.reject(db.stateError);
      const row = db.state[values[0] as string];
      return Promise.resolve(row != null ? [row] : []);
    }
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
}

interface Published {
  commandId: string;
  stationId: string;
  action: string;
  params: Record<string, unknown>;
}

function makePubsub(): PubSubClient & { publish: ReturnType<typeof vi.fn> } {
  return { publish: vi.fn(async () => {}), subscribe: vi.fn() } as unknown as PubSubClient & {
    publish: ReturnType<typeof vi.fn>;
  };
}

function published(pubsub: { publish: ReturnType<typeof vi.fn> }): Published[] {
  return pubsub.publish.mock.calls.map((c) => {
    expect(c[0]).toBe('css_commands');
    return JSON.parse(c[1] as string) as Published;
  });
}

// Math.random answers in order; once the queue is empty it returns 0.99 (no
// journey tick, no outage, last element of any pick). A random tick draws:
// journey share, station pick, outage, action pick, then any param picks.
const randomQueue: number[] = [];
let logSpy: MockInstance<typeof console.log>;

beforeEach(() => {
  randomQueue.length = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => randomQueue.shift() ?? 0.99);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function logged(fragment: string): boolean {
  return logSpy.mock.calls.some((c) => String(c[0]).includes(fragment));
}

type Internals = {
  dispatchRandomAction(): Promise<void>;
  journeys: ChaosJourneys;
  chargingStations: Set<string>;
  chargingTokenByStation: Map<string, string>;
  offlineStations: Set<string>;
  stationIds: string[];
};

function internals(o: ChaosOrchestrator): Internals {
  return o as unknown as Internals;
}

async function loaded(db: Db, pubsub = makePubsub()): Promise<ChaosOrchestrator> {
  const o = new ChaosOrchestrator(makeSql(db), pubsub, { actionIntervalMs: 1000 });
  await o.start();
  o.stop();
  return o;
}

// Every action chaos can pick in this state: one tick per pick slot, each on a
// fresh orchestrator so the picked action's own bookkeeping does not leak.
async function reachableActions(db: Db): Promise<Set<string>> {
  const names = new Set<string>();
  const slots = 200;
  for (let k = 0; k < slots; k++) {
    const pubsub = makePubsub();
    const o = await loaded(db, pubsub);
    randomQueue.length = 0;
    randomQueue.push(0.9, 0, 0.9, (k + 0.5) / slots); // no journey, station, no outage, action
    await internals(o).dispatchRandomAction();
    for (const p of published(pubsub)) names.add(p.action);
  }
  return names;
}

const NON_MUTATING_GLOBAL = [
  'sendHeartbeat',
  'sendMeterValues',
  'sendFirmwareStatusNotification',
  'sendDataTransfer',
];
const NON_MUTATING_21 = [
  ...NON_MUTATING_GLOBAL,
  'sendSecurityEventNotification',
  'sendNotifyEvent',
  'sendNotifyReport',
  'sendNotifyMonitoringReport',
  'sendNotifyChargingLimit',
  'sendNotifyEVChargingNeeds',
  'sendClearedChargingLimit',
  'sendNotifyDisplayMessages',
  'sendNotifyCustomerInformation',
  'sendSignCertificate',
  'sendGetCertificateStatus',
  'sendGetTransactionStatus',
  'sendReportChargingProfiles',
  'sendNotifyEVChargingSchedule',
  'sendNotifySettlement',
  'sendNotifyPriorityCharging',
  'sendNotifyAllowedEnergyTransfer',
  'sendLogStatusNotification',
  'sendReservationStatusUpdate',
  'sendGet15118EVCertificate',
  'sendGetCertificateChainStatus',
  'sendPublishFirmwareStatusNotification',
  'sendNotifyPeriodicEventStream',
  'sendNotifyDERAlarm',
  'sendNotifyDERStartStop',
  'sendReportDERControl',
  'sendBatterySwap',
  'sendPullDynamicScheduleUpdate',
  'sendVatNumberValidation',
];
const NON_MUTATING_16 = [...NON_MUTATING_GLOBAL, 'sendDiagnosticsStatusNotification'];

function sorted(names: Iterable<string>): string[] {
  return [...names].sort();
}

describe('ChaosOrchestrator action selection', () => {
  it('OCPP 2.1 idle station: notifications plus plug-in, authorize, fault and status', async () => {
    const actions = await reachableActions(makeDb());
    expect(sorted(actions)).toEqual(
      sorted([...NON_MUTATING_21, 'plugIn', 'authorize', 'injectFault', 'sendStatusNotification']),
    );
  });

  it('OCPP 2.1 plugged-in station may also start charging and unplug', async () => {
    const actions = await reachableActions(
      makeDb({
        state: { 'CS-1': { status: 'available', evse_status: 'Preparing', has_tx: false } },
      }),
    );
    expect(sorted(actions)).toEqual(
      sorted([
        ...NON_MUTATING_21,
        'plugIn',
        'authorize',
        'injectFault',
        'sendStatusNotification',
        'startCharging',
        'unplug',
      ]),
    );
  });

  it('never picks token actions when no driver tokens are loaded', async () => {
    const actions = await reachableActions(
      makeDb({
        tokens: [],
        state: { 'CS-1': { status: 'available', evse_status: 'Preparing', has_tx: false } },
      }),
    );
    expect(actions.has('authorize')).toBe(false);
    expect(actions.has('startCharging')).toBe(false);
    expect(actions.has('plugIn')).toBe(true);
  });

  it('OCPP 1.6 station with an active transaction: stop, unplug or fault', async () => {
    const actions = await reachableActions(
      makeDb({
        stations: [{ station_id: 'CS-1', ocpp_protocol: 'ocpp1.6' }],
        state: { 'CS-1': { status: 'available', evse_status: 'Occupied', has_tx: true } },
      }),
    );
    expect(sorted(actions)).toEqual(
      sorted([
        ...NON_MUTATING_16,
        'stopCharging',
        'unplug',
        'injectFault',
        'suspendCharging',
        'resumeCharging',
      ]),
    );
  });

  it('OCPP 1.6 faulted station can only clear the fault among state actions', async () => {
    const actions = await reachableActions(
      makeDb({
        stations: [{ station_id: 'CS-1', ocpp_protocol: 'ocpp1.6' }],
        state: { 'CS-1': { status: 'faulted', evse_status: 'Faulted', has_tx: false } },
      }),
    );
    expect(sorted(actions)).toEqual(sorted([...NON_MUTATING_16, 'clearFault']));
  });

  it('OCPP 1.6 unavailable station may send a status notification', async () => {
    const actions = await reachableActions(
      makeDb({
        stations: [{ station_id: 'CS-1', ocpp_protocol: 'ocpp1.6' }],
        state: { 'CS-1': { status: 'unavailable', evse_status: null, has_tx: false } },
      }),
    );
    expect(sorted(actions)).toEqual(sorted([...NON_MUTATING_16, 'sendStatusNotification']));
  });

  it('sends version-specific params: 1.6 status values and 2.1 boot reasons', async () => {
    const pubsub16 = makePubsub();
    const o16 = await loaded(
      makeDb({
        stations: [{ station_id: 'CS-1', ocpp_protocol: 'ocpp1.6' }],
        state: { 'CS-1': { status: 'unavailable', evse_status: 'Unavailable', has_tx: false } },
      }),
      pubsub16,
    );
    // 0.99 picks the last allowed action (sendStatusNotification) and the last 1.6 status.
    await internals(o16).dispatchRandomAction();
    expect(published(pubsub16)).toEqual([
      expect.objectContaining({
        stationId: 'CS-1',
        action: 'sendStatusNotification',
        params: { evseId: 1, connectorId: 1, status: 'Preparing' },
      }),
    ]);

    const pubsub21 = makePubsub();
    const o21 = await loaded(makeDb(), pubsub21);
    await internals(o21).dispatchRandomAction();
    expect(published(pubsub21)[0]).toMatchObject({
      action: 'sendVatNumberValidation',
      params: { vatNumber: 'NL123456789B01', evseId: 1 },
    });
  });

  it('falls back to the available state when the state query fails', async () => {
    const db = makeDb({ stateError: new Error('db down') });
    const pubsub = makePubsub();
    const o = await loaded(db, pubsub);
    randomQueue.push(0.9, 0, 0.9, 0); // first allowed action: plugIn
    await internals(o).dispatchRandomAction();
    expect(published(pubsub)).toEqual([
      expect.objectContaining({ action: 'plugIn', params: { evseId: 1 } }),
    ]);
    // A plug-in starts a journey towards a session.
    expect(internals(o).journeys.size).toBe(1);
  });

  it('logs a failed publish and does not start a journey', async () => {
    const pubsub = makePubsub();
    pubsub.publish.mockRejectedValue(new Error('redis down'));
    const o = await loaded(makeDb(), pubsub);
    randomQueue.push(0.9, 0, 0.9, 0);
    await internals(o).dispatchRandomAction();
    expect(logged('CS-1 -> plugIn failed: redis down')).toBe(true);
    expect(internals(o).journeys.size).toBe(0);
  });

  it('drops a station whose css_stations row disappeared and publishes nothing', async () => {
    const db = makeDb({ state: {} });
    const pubsub = makePubsub();
    const o = await loaded(db, pubsub);
    await internals(o).dispatchRandomAction();
    expect(pubsub.publish).not.toHaveBeenCalled();
    expect(internals(o).stationIds).toEqual([]);

    // With no targets left the next tick does nothing at all.
    await internals(o).dispatchRandomAction();
    expect(db.stateQueries).toBe(1);
  });
});

describe('ChaosOrchestrator power outages', () => {
  it('takes a station offline, then brings it back on the next tick it is picked', async () => {
    const pubsub = makePubsub();
    const o = await loaded(makeDb(), pubsub);
    internals(o).journeys.record('CS-1', 'plugIn', 0);

    randomQueue.push(0.9, 0, 0.01); // no journey tick, station, outage
    await internals(o).dispatchRandomAction();
    expect(internals(o).offlineStations.has('CS-1')).toBe(true);
    // An outage ends a journey that has not started charging.
    expect(internals(o).journeys.size).toBe(0);

    await internals(o).dispatchRandomAction();
    expect(published(pubsub).map((p) => [p.stationId, p.action, p.params])).toEqual([
      ['CS-1', 'goOffline', {}],
      ['CS-1', 'comeOnline', {}],
    ]);
    expect(internals(o).offlineStations.size).toBe(0);
  });

  it('keeps a charging journey through an outage, so the session is still stopped', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000_000);
    const db = makeDb({
      state: { 'CS-1': { status: 'charging', evse_status: 'Occupied', has_tx: true } },
    });
    const pubsub = makePubsub();
    const o = await loaded(db, pubsub);
    internals(o).chargingStations.add('CS-1');
    internals(o).chargingTokenByStation.set('CS-1', 'TOK-A');
    internals(o).journeys.record('CS-1', 'startCharging', 0);

    randomQueue.push(0.9, 0, 0.01); // no journey tick, station, outage
    await internals(o).dispatchRandomAction();
    expect(internals(o).journeys.size).toBe(1);

    randomQueue.push(0.1); // journey tick: the station comes back online first
    await internals(o).dispatchRandomAction();
    randomQueue.push(0.1, 0.0); // journey tick, reason Local
    await internals(o).dispatchRandomAction();

    expect(published(pubsub).map((p) => p.action)).toEqual([
      'goOffline',
      'comeOnline',
      'stopCharging',
    ]);
    expect(internals(o).chargingTokenByStation.has('CS-1')).toBe(false);
  });

  it('keeps its offline bookkeeping when the publish fails', async () => {
    const pubsub = makePubsub();
    pubsub.publish.mockRejectedValue(new Error('redis down'));
    const o = await loaded(makeDb(), pubsub);
    randomQueue.push(0.9, 0, 0.01);
    await expect(internals(o).dispatchRandomAction()).resolves.toBeUndefined();
    expect(internals(o).offlineStations.has('CS-1')).toBe(true);
    await expect(internals(o).dispatchRandomAction()).resolves.toBeUndefined();
    expect(internals(o).offlineStations.has('CS-1')).toBe(false);
    expect(pubsub.publish).toHaveBeenCalledTimes(2);
  });
});

describe('ChaosOrchestrator session journeys', () => {
  it('starts charging a plugged-in station with a free token when its step is due', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const db = makeDb({
      tokens: [
        { id_token: 'TOK-A', token_type: 'ISO14443' },
        { id_token: 'TOK-B', token_type: 'eMAID' },
      ],
      state: { 'CS-1': { status: 'available', evse_status: 'Preparing', has_tx: false } },
    });
    const pubsub = makePubsub();
    const o = await loaded(db, pubsub);
    internals(o).journeys.record('CS-1', 'plugIn', 0);
    vi.setSystemTime(JOURNEY_WAIT_MS.plugged[1] + 1);

    randomQueue.push(0.1, 0.0); // journey tick, first free token
    await internals(o).dispatchRandomAction();

    expect(published(pubsub)).toEqual([
      expect.objectContaining({
        stationId: 'CS-1',
        action: 'startCharging',
        params: { evseId: 1, idToken: 'TOK-A', tokenType: 'ISO14443' },
      }),
    ]);
    expect(internals(o).chargingTokenByStation.get('CS-1')).toBe('TOK-A');
  });

  it('skips a due start when every driver token is already charging', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000_000);
    const db = makeDb({
      stations: [
        { station_id: 'CS-1', ocpp_protocol: 'ocpp2.1' },
        { station_id: 'CS-2', ocpp_protocol: 'ocpp2.1' },
      ],
      state: {
        'CS-1': { status: 'charging', evse_status: 'Occupied', has_tx: true },
        'CS-2': { status: 'available', evse_status: 'Preparing', has_tx: false },
      },
    });
    const pubsub = makePubsub();
    const o = await loaded(db, pubsub);
    internals(o).chargingStations.add('CS-1');
    internals(o).chargingTokenByStation.set('CS-1', 'TOK-A');
    internals(o).journeys.record('CS-2', 'plugIn', 0);

    randomQueue.push(0.1);
    await internals(o).dispatchRandomAction();

    expect(pubsub.publish).not.toHaveBeenCalled();
    expect(internals(o).chargingStations.has('CS-2')).toBe(false);
  });

  it('ends the journey when its due step is no longer possible', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000_000);
    // The stop is due, but the station is idle: an operator already stopped it.
    const pubsub = makePubsub();
    const o = await loaded(makeDb(), pubsub);
    internals(o).journeys.record('CS-1', 'startCharging', 0);

    randomQueue.push(0.1);
    await internals(o).dispatchRandomAction();

    expect(pubsub.publish).not.toHaveBeenCalled();
    expect(internals(o).journeys.size).toBe(0);
  });

  it('keeps a charging journey through a fault', async () => {
    const db = makeDb({
      stations: [{ station_id: 'CS-1', ocpp_protocol: 'ocpp1.6' }],
      state: { 'CS-1': { status: 'charging', evse_status: 'Occupied', has_tx: true } },
    });
    const pubsub = makePubsub();
    const o = await loaded(db, pubsub);

    // Random ticks over every pick slot until one picks injectFault. Each tick
    // starts from a charging journey, since a picked stop or unplug moves it on.
    for (let k = 0; k < 200 && !published(pubsub).some((p) => p.action === 'injectFault'); k++) {
      randomQueue.length = 0;
      internals(o).journeys.record('CS-1', 'startCharging', 0);
      randomQueue.push(0.9, 0, 0.9, (k + 0.5) / 200); // no journey, station, no outage, action
      await internals(o).dispatchRandomAction();
    }

    expect(published(pubsub).at(-1)?.action).toBe('injectFault');
    expect(['end', 'suspend']).toContain(published(pubsub).at(-1)?.params['mode']);
    expect(internals(o).journeys.nextDue(Number.MAX_SAFE_INTEGER)).toEqual({
      stationId: 'CS-1',
      action: 'stopCharging',
    });
  });

  it('postpones a due stop that is not possible yet while the transaction is active', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000_000);
    // Finishing allows no stop, but the transaction is still active.
    const db = makeDb({
      state: { 'CS-1': { status: 'charging', evse_status: 'Finishing', has_tx: true } },
    });
    const pubsub = makePubsub();
    const o = await loaded(db, pubsub);
    internals(o).journeys.record('CS-1', 'startCharging', 0);

    randomQueue.push(0.1);
    await internals(o).dispatchRandomAction();

    expect(pubsub.publish).not.toHaveBeenCalled();
    expect(internals(o).journeys.nextDue(10_000_000 + JOURNEY_RETRY_MS[0] - 1)).toBeNull();
    expect(internals(o).journeys.nextDue(10_000_000 + JOURNEY_RETRY_MS[1])).toEqual({
      stationId: 'CS-1',
      action: 'stopCharging',
    });
  });

  it('a stop clears the station charging markers so its token is free again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000_000);
    const db = makeDb({
      state: { 'CS-1': { status: 'charging', evse_status: 'Occupied', has_tx: true } },
    });
    const pubsub = makePubsub();
    const o = await loaded(db, pubsub);
    internals(o).chargingStations.add('CS-1');
    internals(o).chargingTokenByStation.set('CS-1', 'TOK-A');
    internals(o).journeys.record('CS-1', 'startCharging', 0);

    randomQueue.push(0.1, 0.0); // journey tick, reason Local
    await internals(o).dispatchRandomAction();

    expect(published(pubsub)).toEqual([
      expect.objectContaining({ action: 'stopCharging', params: { evseId: 1, reason: 'Local' } }),
    ]);
    expect(internals(o).chargingStations.has('CS-1')).toBe(false);
    expect(internals(o).chargingTokenByStation.has('CS-1')).toBe(false);
  });
});

describe('ChaosOrchestrator lifecycle', () => {
  it('loads stations up to the limit, excludes OCTT tokens, ticks, refreshes and stops', async () => {
    vi.useFakeTimers();
    const db = makeDb({
      stations: [
        { station_id: 'CS-1', ocpp_protocol: 'ocpp2.1' },
        { station_id: 'CS-2', ocpp_protocol: 'ocpp1.6' },
        { station_id: 'CS-3', ocpp_protocol: 'ocpp2.1' },
      ],
      state: {
        'CS-1': { status: 'available', evse_status: 'Available', has_tx: false },
        'CS-2': { status: 'available', evse_status: 'Available', has_tx: false },
      },
    });
    const pubsub = makePubsub();
    const o = new ChaosOrchestrator(makeSql(db), pubsub, {
      actionIntervalMs: 500,
      stationLimit: 2,
    });

    await o.start();
    expect(internals(o).stationIds).toEqual(['CS-1', 'CS-2']);
    expect(db.tokenQueryValues[0]).toEqual([OCTT_TEST_DRIVER_EMAIL]);
    expect(logged('[chaos] Loaded 2 stations and 1 tokens')).toBe(true);
    expect(logged('Started action timer (500ms interval, 2 stations)')).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    expect(pubsub.publish).toHaveBeenCalledTimes(1);

    // Refresh: CS-2 is gone, its offline and charging markers are dropped.
    internals(o).offlineStations.add('CS-2');
    internals(o).chargingStations.add('CS-2');
    internals(o).chargingTokenByStation.set('CS-2', 'TOK-A');
    internals(o).journeys.record('CS-2', 'plugIn', Date.now());
    internals(o).offlineStations.add('CS-1');
    db.stations = [{ station_id: 'CS-1', ocpp_protocol: 'ocpp2.1' }];
    o.stop();

    await o.start();
    expect(internals(o).stationIds).toEqual(['CS-1']);
    expect(internals(o).offlineStations.has('CS-2')).toBe(false);
    expect(internals(o).offlineStations.has('CS-1')).toBe(true);
    expect(internals(o).chargingStations.has('CS-2')).toBe(false);
    expect(internals(o).chargingTokenByStation.has('CS-2')).toBe(false);
    expect(internals(o).journeys.size).toBe(0);
    o.stop();
  });

  it('re-reads stations every 30s and logs a failed refresh', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const pubsub = makePubsub();
    const o = new ChaosOrchestrator(makeSql(db), pubsub, { actionIntervalMs: 3_600_000 });
    await o.start();
    expect(internals(o).stationIds).toEqual(['CS-1']);

    db.stations = [
      { station_id: 'CS-1', ocpp_protocol: 'ocpp2.1' },
      { station_id: 'CS-9', ocpp_protocol: 'ocpp1.6' },
    ];
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(internals(o).stationIds).toEqual(['CS-1', 'CS-9']));

    db.loadError = new Error('connection reset');
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(logged('[chaos] Refresh failed: connection reset')).toBe(true));
    expect(internals(o).stationIds).toEqual(['CS-1', 'CS-9']);

    o.stop();
    db.loadError = undefined;
    db.stations = [];
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(internals(o).stationIds).toEqual(['CS-1', 'CS-9']);
    expect(pubsub.publish).not.toHaveBeenCalled();
    // Stopping twice is safe.
    expect(() => o.stop()).not.toThrow();
  });

  it('uses defaults of a 1s interval and no station limit', async () => {
    vi.useFakeTimers();
    const db = makeDb({
      stations: Array.from({ length: 5 }, (_, i) => ({
        station_id: `CS-${String(i)}`,
        ocpp_protocol: 'ocpp2.1',
      })),
    });
    const o = new ChaosOrchestrator(makeSql(db), makePubsub());
    await o.start();
    expect(internals(o).stationIds).toHaveLength(5);
    expect(logged('Started action timer (1000ms interval, 5 stations)')).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(db.stateQueries).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.stateQueries).toBe(1);
    o.stop();
  });
});
