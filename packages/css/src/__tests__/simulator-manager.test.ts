// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
  type MockInstance,
} from 'vitest';
import type postgres from 'postgres';
import type { PubSubClient } from '@evtivity/lib';
import type { StationConfig, StationSimulator } from '../station-simulator.js';

const mocks = vi.hoisted(() => {
  const config: Record<string, string | undefined> = {};
  return {
    isTlsReachable: vi.fn<(url: string) => Promise<boolean>>(),
    readFileSync: vi.fn<(path: string, enc: string) => string>(),
    logWarn: vi.fn(),
    config,
  };
});

vi.mock('../tls-probe.js', () => ({ isTlsReachable: mocks.isTlsReachable }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: mocks.readFileSync };
});
vi.mock('../lib/config.js', () => ({ config: mocks.config }));
vi.mock('../lib/logger.js', () => ({
  logger: { warn: mocks.logWarn, debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

type Manager = import('../simulator-manager.js').SimulatorManager;

async function loadManagerClass(): Promise<
  typeof import('../simulator-manager.js').SimulatorManager
> {
  // Fresh module per test: the SP3 env cert bundle is memoized at module level.
  vi.resetModules();
  return (await import('../simulator-manager.js')).SimulatorManager;
}

interface Row {
  id: string;
  station_id: string;
  ocpp_protocol?: string;
  security_profile?: number;
  target_url?: string;
  password?: string | null;
  model?: string | null;
  serial_number?: string | null;
  firmware_version?: string | null;
  client_cert?: string | null;
  client_key?: string | null;
  ca_cert?: string | null;
  vendor_name?: string | null;
}

interface EvseRow {
  css_station_id: string;
  evse_id: number;
  connector_id: number;
  connector_type: string;
  max_power_w: number;
  phases: number;
  voltage: number;
}

// css_stations rows and css_evses rows by query text. `state` is mutable so a
// test can change what the next sync cycle sees.
function makeSql(state: { rows: Row[]; evses: EvseRow[] }): postgres.Sql {
  return ((strings: TemplateStringsArray) => {
    const q = strings.join(' ');
    if (q.includes('FROM css_evses')) return Promise.resolve(state.evses);
    if (q.includes('FROM css_stations')) {
      return Promise.resolve(
        state.rows.map((r) => ({
          ocpp_protocol: 'ocpp2.1',
          security_profile: 0,
          target_url: 'ws://localhost:7103',
          password: null,
          model: null,
          serial_number: null,
          firmware_version: null,
          client_cert: null,
          client_key: null,
          ca_cert: null,
          vendor_name: null,
          ...r,
        })),
      );
    }
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
}

type SimStub = Record<string, Mock> & {
  start: Mock;
  stop: Mock;
  startCharging: Mock;
  stationId: string;
  cssStationId: string;
  config: StationConfig;
};

function makeSim(config: StationConfig, overrides: Partial<Record<string, unknown>> = {}): SimStub {
  const base: Record<string, unknown> = {
    stationId: config.stationId,
    cssStationId: config.id,
    config,
    isConnected: false,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    isReady: vi.fn(() => true),
    getNotReadyMs: vi.fn(() => 0),
    getBootStatus: vi.fn(() => 'Accepted'),
    isOffline: vi.fn(() => false),
    getAlignedIntervalSeconds: vi.fn(() => 0),
    startCharging: vi.fn(async () => 'tx-42'),
    ...overrides,
  };
  // Any other simulator method is an async spy.
  return new Proxy(base, {
    get(target, prop: string) {
      if (!(prop in target)) target[prop] = vi.fn(async () => {});
      return target[prop];
    },
  }) as SimStub;
}

function makePubsub(): PubSubClient & { publish: ReturnType<typeof vi.fn> } {
  return {
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(),
  } as unknown as PubSubClient & { publish: ReturnType<typeof vi.fn> };
}

function results(pubsub: { publish: ReturnType<typeof vi.fn> }): unknown[] {
  return pubsub.publish.mock.calls.map((c) => {
    expect(c[0]).toBe('css_command_results');
    return JSON.parse(c[1] as string) as unknown;
  });
}

async function sync(manager: Manager): Promise<void> {
  await (manager as unknown as { syncStations(): Promise<void> }).syncStations();
}

let logSpy: MockInstance<typeof console.log>;
let warnSpy: MockInstance<typeof console.warn>;

beforeEach(() => {
  for (const k of Object.keys(mocks.config)) mocks.config[k] = undefined;
  mocks.isTlsReachable.mockReset();
  mocks.readFileSync.mockReset();
  mocks.readFileSync.mockImplementation((path: string, enc: string) =>
    realFs.readFileSync(path, enc as BufferEncoding),
  );
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

function logged(fragment: string): boolean {
  return logSpy.mock.calls.some((c) => String(c[0]).includes(fragment));
}

describe('SimulatorManager.handleCommand', () => {
  it('ignores a command that is not JSON', async () => {
    const SimulatorManager = await loadManagerClass();
    const pubsub = makePubsub();
    const manager = new SimulatorManager(makeSql({ rows: [], evses: [] }), pubsub);
    await manager.handleCommand('{not json');
    expect(pubsub.publish).not.toHaveBeenCalled();
    expect(logged('Failed to parse command JSON')).toBe(true);
  });

  it('reports a missing simulator to the API', async () => {
    const SimulatorManager = await loadManagerClass();
    const pubsub = makePubsub();
    const manager = new SimulatorManager(makeSql({ rows: [], evses: [] }), pubsub);
    await manager.handleCommand(
      JSON.stringify({ commandId: 'c1', stationId: 'NOPE', action: 'plugIn', params: {} }),
    );
    expect(results(pubsub)).toEqual([
      { commandId: 'c1', success: false, error: 'Simulator not found for station' },
    ]);
  });

  it('publishes nothing without a commandId or without pubsub', async () => {
    const SimulatorManager = await loadManagerClass();
    const pubsub = makePubsub();
    const withPubsub = new SimulatorManager(makeSql({ rows: [], evses: [] }), pubsub);
    await withPubsub.handleCommand(JSON.stringify({ stationId: 'NOPE', action: 'x', params: {} }));
    expect(pubsub.publish).not.toHaveBeenCalled();

    const noPubsub = new SimulatorManager(makeSql({ rows: [], evses: [] }));
    await expect(
      noPubsub.handleCommand(
        JSON.stringify({ commandId: 'c', stationId: 'NOPE', action: 'x', params: {} }),
      ),
    ).resolves.toBeUndefined();
  });

  it('logs and swallows a failed result publish', async () => {
    const SimulatorManager = await loadManagerClass();
    const pubsub = makePubsub();
    pubsub.publish.mockRejectedValue(new Error('redis down'));
    const manager = new SimulatorManager(makeSql({ rows: [], evses: [] }), pubsub);
    await expect(
      manager.handleCommand(
        JSON.stringify({ commandId: 'c1', stationId: 'NOPE', action: 'plugIn', params: {} }),
      ),
    ).resolves.toBeUndefined();
    expect(pubsub.publish).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), commandId: 'c1' }),
      'Publish of the command result failed, the API times out',
    );
  });

  describe('dispatch', () => {
    let manager: Manager;
    let pubsub: ReturnType<typeof makePubsub>;
    let sim: SimStub;

    beforeEach(async () => {
      const SimulatorManager = await loadManagerClass();
      pubsub = makePubsub();
      manager = new SimulatorManager(makeSql({ rows: [], evses: [] }), pubsub);
      sim = makeSim({ id: 'pk1', stationId: 'CS-1' } as StationConfig);
      manager.simulators.set('CS-1', sim as unknown as StationSimulator);
    });

    async function send(action: string, params: Record<string, unknown>): Promise<void> {
      await manager.handleCommand(
        JSON.stringify({ commandId: 'cmd', stationId: 'CS-1', action, params }),
      );
    }

    const p = {
      evseId: 2,
      connectorId: 1,
      idToken: 'TOK',
      tokenType: 'ISO14443',
      reason: 'Remote',
      errorCode: 'GroundFailure',
      status: 'Installed',
      requestId: 7,
      sampledValues: [{ value: 1 }],
      transactionId: 'tx-9',
      vendorId: 'V',
      messageId: 'M',
      data: 'D',
      type: 'FirmwareUpdated',
      timestamp: '2026-01-01T00:00:00Z',
      techInfo: 'info',
      eventData: [{ eventId: 1 }],
      seqNo: 3,
      tbc: true,
      monitor: [{ id: 1 }],
      chargingLimit: { chargingLimitSource: 'CSO' },
      chargingSchedule: [{ id: 1 }],
      chargingNeeds: { requestedEnergyTransfer: 'DC' },
      chargingLimitSource: 'EMS',
      reservationId: 5,
      reservationUpdateStatus: 'Expired',
      messageInfo: [{ id: 1 }],
      csr: 'CSR',
      certificateType: 'V2GCertificate',
      ocspRequestData: { serialNumber: '01' },
      chargingProfile: [{ id: 3 }],
      timeBase: '2026-01-01T00:00:00Z',
      activated: true,
      allowedEnergyTransfer: ['DC'],
      iso15118SchemaVersion: 'v20',
      action: 'Install',
      exiRequest: 'EXI',
      chargingProfileId: 11,
      vatNumber: 'NL1',
      idTag: 'TAG',
      meterStop: 1234,
    };

    const table: Array<[string, string, unknown[]]> = [
      ['plugIn', 'plugIn', [2]],
      ['authorize', 'authorize', [2, 'TOK', 'ISO14443']],
      ['stopCharging', 'stopCharging', [2, 'Remote']],
      ['unplug', 'unplug', [2]],
      ['injectFault', 'injectFault', [2, 'GroundFailure', 'end']],
      ['resumeCharging', 'resumeCharging', [2]],
      ['evFull', 'evFull', [2]],
      ['clearFault', 'clearFault', [2]],
      ['goOffline', 'goOffline', []],
      ['comeOnline', 'comeOnline', []],
      ['rebootStation', 'rebootStation', []],
      ['sendBootNotification', 'sendBootNotification', ['Remote']],
      ['sendHeartbeat', 'sendHeartbeat', []],
      [
        'sendStatusNotification',
        'dispatchStatusNotification',
        [2, 1, 'Installed', 'GroundFailure'],
      ],
      ['sendMeterValues', 'sendMeterValues', [2, [{ value: 1 }], 'tx-9']],
      ['sendFirmwareStatusNotification', 'sendFirmwareStatusNotification', ['Installed', 7]],
      ['sendDataTransfer', 'sendDataTransfer', ['V', 'M', 'D']],
      ['sendLogStatusNotification', 'sendLogStatusNotification', ['Installed', 7]],
      [
        'sendSecurityEventNotification',
        'sendSecurityEventNotification',
        ['FirmwareUpdated', '2026-01-01T00:00:00Z', 'info'],
      ],
      ['sendNotifyEvent', 'sendNotifyEvent', [[{ eventId: 1 }], 3, true]],
      ['sendNotifyReport', 'sendNotifyReport', [7]],
      ['sendNotifyMonitoringReport', 'sendNotifyMonitoringReport', [7, [{ id: 1 }]]],
      [
        'sendNotifyChargingLimit',
        'sendNotifyChargingLimit',
        [{ chargingLimitSource: 'CSO' }, [{ id: 1 }]],
      ],
      [
        'sendNotifyEVChargingNeeds',
        'sendNotifyEVChargingNeeds',
        [2, { requestedEnergyTransfer: 'DC' }],
      ],
      ['sendClearedChargingLimit', 'sendClearedChargingLimit', ['EMS', 2]],
      ['sendReservationStatusUpdate', 'sendReservationStatusUpdate', [5, 'Expired']],
      ['sendNotifyDisplayMessages', 'sendNotifyDisplayMessages', [7, [{ id: 1 }]]],
      ['sendNotifyCustomerInformation', 'sendNotifyCustomerInformation', [7, 'D']],
      ['sendSignCertificate', 'sendSignCertificate', ['CSR', 'V2GCertificate']],
      ['sendGetCertificateStatus', 'sendGetCertificateStatus', [{ serialNumber: '01' }]],
      ['sendGetTransactionStatus', 'sendGetTransactionStatus', ['tx-9']],
      ['sendReportChargingProfiles', 'sendReportChargingProfiles', [7, [{ id: 3 }], 2, 'EMS']],
      [
        'sendNotifyEVChargingSchedule',
        'sendNotifyEVChargingSchedule',
        ['2026-01-01T00:00:00Z', 2, [{ id: 1 }]],
      ],
      ['sendNotifySettlement', 'sendNotifySettlement', [p]],
      ['sendNotifyPriorityCharging', 'sendNotifyPriorityCharging', ['tx-9', true]],
      ['sendNotifyAllowedEnergyTransfer', 'sendNotifyAllowedEnergyTransfer', [['DC'], 'tx-9']],
      ['sendGet15118EVCertificate', 'sendGet15118EVCertificate', ['v20', 'Install', 'EXI']],
      ['sendGetCertificateChainStatus', 'sendGetCertificateChainStatus', [p]],
      [
        'sendPublishFirmwareStatusNotification',
        'sendPublishFirmwareStatusNotification',
        ['Installed', 7],
      ],
      ['sendNotifyPeriodicEventStream', 'sendNotifyPeriodicEventStream', [p]],
      ['sendNotifyDERAlarm', 'sendNotifyDERAlarm', [p]],
      ['sendNotifyDERStartStop', 'sendNotifyDERStartStop', [p]],
      ['sendReportDERControl', 'sendReportDERControl', [p]],
      ['sendBatterySwap', 'sendBatterySwap', [p]],
      ['sendPullDynamicScheduleUpdate', 'sendPullDynamicScheduleUpdate', [11]],
      ['sendVatNumberValidation', 'sendVatNumberValidation', ['NL1', 2]],
      ['sendStartTransaction', 'sendStartTransaction', [1, 'TAG']],
      ['sendStopTransaction', 'sendStopTransaction', ['tx-9', 1234, 'Remote']],
      ['sendDiagnosticsStatusNotification', 'sendDiagnosticsStatusNotification', ['Installed']],
      ['sendAuthorize', 'sendAuthorize', ['TOK', 'ISO14443']],
    ];

    it.each(table)('%s calls sim.%s with the command params', async (action, method, args) => {
      await send(action, p);
      expect(sim[method]).toHaveBeenCalledWith(...args);
      expect(results(pubsub)).toEqual([{ commandId: 'cmd', success: true }]);
    });

    it('passes suspendCharging by and the injectFault mode', async () => {
      await send('suspendCharging', { evseId: 1, by: 'EVSE' });
      expect(sim.suspendCharging).toHaveBeenCalledWith(1, 'EVSE');
      await send('injectFault', { evseId: 1, errorCode: 'GroundFailure', mode: 'suspend' });
      expect(sim.injectFault).toHaveBeenLastCalledWith(1, 'GroundFailure', 'suspend');
    });

    it('returns the Plug and Charge results in the result data', async () => {
      sim.createPncEv = vi.fn(async () => ({ pcid: 'P', oemRootCertificate: 'PEM', edition: 2 }));
      sim.installPncContract = vi.fn(async () => ({ emaid: 'E', remainingContracts: null }));
      sim.startPncCharging = vi.fn(async () => 'tx-pnc');
      await send('createPncEv', { evseId: 1 });
      expect(sim.createPncEv).toHaveBeenCalledWith(1, 2);
      await send('installPncContract', { evseId: 1 });
      await send('startPncCharging', { evseId: 1 });
      expect(results(pubsub)).toEqual([
        {
          commandId: 'cmd',
          success: true,
          data: { pcid: 'P', oemRootCertificate: 'PEM', edition: 2 },
        },
        { commandId: 'cmd', success: true, data: { emaid: 'E', remainingContracts: null } },
        { commandId: 'cmd', success: true, data: { transactionId: 'tx-pnc' } },
      ]);
    });

    it('powerCycle preserves the transactions unless preserveTransactions is false', async () => {
      await send('powerCycle', {});
      expect(sim.simulatePowerCyclePreserveTransactions).toHaveBeenCalledWith(0);
      await send('powerCycle', { powerOffMs: 3000, preserveTransactions: false });
      expect(sim.simulatePowerCycle).toHaveBeenCalledWith('PowerLoss', 3000);
    });

    it('returns the transaction id from startCharging in the result data', async () => {
      await send('startCharging', { evseId: 1, idToken: 'TOK', tokenType: 'Central' });
      expect(sim.startCharging).toHaveBeenCalledWith(1, 'TOK', 'Central');
      expect(results(pubsub)).toEqual([
        { commandId: 'cmd', success: true, data: { transactionId: 'tx-42' } },
      ]);
    });

    it('sendTransactionEvent passes only the optional fields that are set', async () => {
      await send('sendTransactionEvent', {
        evseId: 1,
        eventType: 'Updated',
        triggerReason: 'MeterValuePeriodic',
        transactionId: 'tx-1',
      });
      expect(sim.sendTransactionEvent).toHaveBeenLastCalledWith(1, 'Updated', {
        triggerReason: 'MeterValuePeriodic',
        transactionId: 'tx-1',
      });

      await send('sendTransactionEvent', {
        evseId: 1,
        eventType: 'Ended',
        triggerReason: 'StopAuthorized',
        transactionId: 'tx-1',
        chargingState: 'Idle',
        stoppedReason: 'Local',
        idToken: 'TOK',
        tokenType: 'ISO14443',
        seqNo: 4,
        meterValue: [{ timestamp: 't' }],
      });
      expect(sim.sendTransactionEvent).toHaveBeenLastCalledWith(1, 'Ended', {
        triggerReason: 'StopAuthorized',
        transactionId: 'tx-1',
        chargingState: 'Idle',
        stoppedReason: 'Local',
        idToken: 'TOK',
        tokenType: 'ISO14443',
        seqNo: 4,
        meterValue: [{ timestamp: 't' }],
      });
    });

    it('rejects an unknown action', async () => {
      await send('doTheThing', {});
      expect(results(pubsub)).toEqual([
        { commandId: 'cmd', success: false, error: 'Unknown action: doTheThing' },
      ]);
    });

    it('reports a simulator-side rejection with its message', async () => {
      sim.plugIn = vi.fn(async () => {
        throw new Error('Cable already plugged in');
      });
      await send('plugIn', { evseId: 1 });
      expect(results(pubsub)).toEqual([
        { commandId: 'cmd', success: false, error: 'Cable already plugged in' },
      ]);
    });
  });
});

describe('SimulatorManager station sync', () => {
  it('boots a new station with defaults for missing identity fields and its evses', async () => {
    const SimulatorManager = await loadManagerClass();
    const sql = makeSql({
      rows: [
        { id: 'pk1', station_id: 'CS-1', ocpp_protocol: 'ocpp1.6', password: 'secret' },
        {
          id: 'pk2',
          station_id: 'CS-2',
          model: 'X',
          serial_number: 'S2',
          firmware_version: '2.0',
          vendor_name: 'Acme',
        },
      ],
      evses: [
        {
          css_station_id: 'pk1',
          evse_id: 1,
          connector_id: 1,
          connector_type: 'ac_type2',
          max_power_w: 22000,
          phases: 3,
          voltage: 230,
        },
        {
          css_station_id: 'pk1',
          evse_id: 2,
          connector_id: 1,
          connector_type: 'dc_ccs2',
          max_power_w: 150000,
          phases: 3,
          voltage: 400,
        },
      ],
    });
    const created: SimStub[] = [];
    const factory = vi.fn((config: StationConfig) => {
      const s = makeSim(config);
      created.push(s);
      return s as unknown as StationSimulator;
    });
    const manager = new SimulatorManager(sql, undefined, factory);

    await sync(manager);

    expect(manager.simulatorCount).toBe(2);
    const c1 = created[0]!.config;
    expect(c1).toMatchObject({
      id: 'pk1',
      stationId: 'CS-1',
      ocppProtocol: 'ocpp1.6',
      securityProfile: 0,
      vendorName: 'EVtivity',
      model: 'CSS-1000',
      serialNumber: 'SN-CS-1',
      firmwareVersion: '1.0.0',
      password: 'secret',
      reconnectSpreadMs: 15_000,
    });
    expect(c1.evses).toEqual([
      {
        evseId: 1,
        connectorId: 1,
        connectorType: 'ac_type2',
        maxPowerW: 22000,
        phases: 3,
        voltage: 230,
      },
      {
        evseId: 2,
        connectorId: 1,
        connectorType: 'dc_ccs2',
        maxPowerW: 150000,
        phases: 3,
        voltage: 400,
      },
    ]);
    expect(c1).not.toHaveProperty('clientCert');
    const c2 = created[1]!.config;
    expect(c2).toMatchObject({
      ocppProtocol: 'ocpp2.1',
      vendorName: 'Acme',
      model: 'X',
      serialNumber: 'S2',
      firmwareVersion: '2.0',
      evses: [],
    });
    expect(c2).not.toHaveProperty('password');
    expect(created.every((s) => s.start.mock.calls.length === 1)).toBe(true);

    // A second sync leaves the running, ready stations alone.
    await sync(manager);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('removes a station whose start failed and stops its client, then retries next sync', async () => {
    const SimulatorManager = await loadManagerClass();
    const sql = makeSql({ rows: [{ id: 'pk1', station_id: 'CS-1' }], evses: [] });
    const first = makeSim({ id: 'pk1', stationId: 'CS-1' } as StationConfig, {
      start: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      stop: vi.fn(async () => {
        throw new Error('ignored');
      }),
    });
    const second = makeSim({ id: 'pk1', stationId: 'CS-1' } as StationConfig);
    const factory = vi
      .fn()
      .mockReturnValueOnce(first as unknown)
      .mockReturnValueOnce(second as unknown);
    const manager = new SimulatorManager(sql, undefined, factory);

    await sync(manager);
    expect(manager.simulators.has('CS-1')).toBe(false);
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(logged('Failed to start simulator CS-1: ECONNREFUSED')).toBe(true);

    await sync(manager);
    expect(manager.simulators.get('CS-1')).toBe(second);
  });

  it('restarts a running station whose css_stations.id changed', async () => {
    const SimulatorManager = await loadManagerClass();
    const sql = makeSql({ rows: [{ id: 'pk-new', station_id: 'CS-1' }], evses: [] });
    const stale = makeSim({ id: 'pk-old', stationId: 'CS-1' } as StationConfig, {
      stop: vi.fn(async () => {
        throw new Error('socket gone');
      }),
    });
    const fresh = vi.fn((config: StationConfig) => makeSim(config) as unknown as StationSimulator);
    const manager = new SimulatorManager(sql, undefined, fresh);
    manager.simulators.set('CS-1', stale as unknown as StationSimulator);

    await sync(manager);

    expect(stale.stop).toHaveBeenCalledTimes(1);
    expect(logged('css_stations.id changed for CS-1 (pk-old -> pk-new)')).toBe(true);
    expect(logged('Error stopping stale simulator CS-1: socket gone')).toBe(true);
    expect(fresh).toHaveBeenCalledTimes(1);
    expect((manager.simulators.get('CS-1') as unknown as SimStub).cssStationId).toBe('pk-new');
  });

  it('stops simulators whose stations left the database, even when stop throws', async () => {
    const SimulatorManager = await loadManagerClass();
    const state = {
      rows: [
        { id: 'pk1', station_id: 'CS-1' },
        { id: 'pk2', station_id: 'CS-2' },
      ] as Row[],
      evses: [],
    };
    const sims = new Map<string, SimStub>();
    const factory = vi.fn((config: StationConfig) => {
      const s = makeSim(
        config,
        config.stationId === 'CS-2'
          ? {
              stop: vi.fn(async () => {
                throw new Error('boom');
              }),
            }
          : {},
      );
      sims.set(config.stationId, s);
      return s as unknown as StationSimulator;
    });
    const manager = new SimulatorManager(makeSql(state), undefined, factory);
    await sync(manager);
    expect(manager.simulatorCount).toBe(2);

    state.rows = [];
    await sync(manager);

    expect(manager.simulatorCount).toBe(0);
    expect(sims.get('CS-1')!.stop).toHaveBeenCalledTimes(1);
    expect(sims.get('CS-2')!.stop).toHaveBeenCalledTimes(1);
    expect(logged('Error stopping simulator CS-2: boom')).toBe(true);
    expect(logged('Stopped simulator: CS-1')).toBe(true);
  });

  it('skips an unreachable TLS server, caches the failure, and boots once it is reachable', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const SimulatorManager = await loadManagerClass();
    const sql = makeSql({
      rows: [{ id: 'pk1', station_id: 'CS-1', target_url: 'wss://tls.example:8443' }],
      evses: [],
    });
    const factory = vi.fn(
      (config: StationConfig) => makeSim(config) as unknown as StationSimulator,
    );
    const manager = new SimulatorManager(sql, undefined, factory);

    mocks.isTlsReachable.mockResolvedValue(false);
    await sync(manager);
    expect(mocks.isTlsReachable).toHaveBeenCalledWith('wss://tls.example:8443');
    expect(factory).not.toHaveBeenCalled();
    expect(logged('TLS server wss://tls.example:8443 not reachable, will retry in 15s')).toBe(true);

    // Within the 15s negative-cache TTL: no new probe.
    vi.setSystemTime(new Date('2026-01-01T00:00:14Z'));
    await sync(manager);
    expect(mocks.isTlsReachable).toHaveBeenCalledTimes(1);

    // After the TTL the probe runs again and the station boots.
    vi.setSystemTime(new Date('2026-01-01T00:00:16Z'));
    mocks.isTlsReachable.mockResolvedValue(true);
    await sync(manager);
    expect(mocks.isTlsReachable).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(manager.simulators.has('CS-1')).toBe(true);
  });

  it('skips a sync tick while the previous one is still running', async () => {
    const SimulatorManager = await loadManagerClass();
    let release!: (v: unknown[]) => void;
    const gate = new Promise<unknown[]>((r) => {
      release = r;
    });
    const sql = vi.fn(() => gate) as unknown as postgres.Sql;
    const manager = new SimulatorManager(sql);

    const first = sync(manager);
    await sync(manager);
    expect(logged('previous syncStations still running, skipping this tick')).toBe(true);
    expect(sql).toHaveBeenCalledTimes(2); // only the first cycle's two queries

    release([]);
    await first;
    await sync(manager);
    expect(sql).toHaveBeenCalledTimes(4);
  });
});

describe('SimulatorManager SP3 env certificate bundle', () => {
  it('fills missing row PEMs from env (inline PEM over file) and keeps row PEMs that are set', async () => {
    mocks.config.CSS_CLIENT_CERT_PEM = 'ENV-CERT';
    mocks.config.CSS_CLIENT_CERT = '/ignored-because-pem-set';
    mocks.config.CSS_CLIENT_KEY = '/certs/key.pem';
    mocks.config.CSS_CA_CERT = '/certs/missing-ca.pem';
    mocks.readFileSync.mockImplementation((path: string) => {
      if (path === '/certs/key.pem') return 'FILE-KEY';
      if (path.startsWith('/certs/')) throw new Error('ENOENT');
      return realFs.readFileSync(path, 'utf8');
    });
    const SimulatorManager = await loadManagerClass();
    const sql = makeSql({
      rows: [
        { id: 'pk1', station_id: 'SP3-A', security_profile: 3 },
        { id: 'pk2', station_id: 'SP3-B', security_profile: 3, client_cert: 'ROW-CERT' },
        { id: 'pk3', station_id: 'SP1', security_profile: 1 },
      ],
      evses: [],
    });
    const configs = new Map<string, StationConfig>();
    const factory = vi.fn((config: StationConfig) => {
      configs.set(config.stationId, config);
      return makeSim(config) as unknown as StationSimulator;
    });
    const manager = new SimulatorManager(sql, undefined, factory);

    await sync(manager);

    expect(configs.get('SP3-A')).toMatchObject({ clientCert: 'ENV-CERT', clientKey: 'FILE-KEY' });
    expect(configs.get('SP3-A')).not.toHaveProperty('caCert');
    expect(configs.get('SP3-B')).toMatchObject({ clientCert: 'ROW-CERT', clientKey: 'FILE-KEY' });
    expect(configs.get('SP1')).not.toHaveProperty('clientCert');
    expect(configs.get('SP1')).not.toHaveProperty('clientKey');
    // Memoized: the files are read once for the whole fleet.
    const certReads = mocks.readFileSync.mock.calls
      .map((c) => c[0])
      .filter((x) => x.startsWith('/certs/') || x.startsWith('/ignored'));
    expect(certReads).toEqual(['/certs/key.pem', '/certs/missing-ca.pem']);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read PEM file /certs/missing-ca.pem: ENOENT'),
    );
  });

  it('uses no certificates when no env bundle is configured', async () => {
    mocks.config.CSS_CLIENT_CERT = '';
    const SimulatorManager = await loadManagerClass();
    const sql = makeSql({
      rows: [
        { id: 'pk1', station_id: 'SP3-A', security_profile: 3 },
        { id: 'pk2', station_id: 'SP3-B', security_profile: 3, ca_cert: 'ROW-CA' },
      ],
      evses: [],
    });
    const configs = new Map<string, StationConfig>();
    const factory = vi.fn((config: StationConfig) => {
      configs.set(config.stationId, config);
      return makeSim(config) as unknown as StationSimulator;
    });
    await sync(new SimulatorManager(sql, undefined, factory));

    expect(configs.get('SP3-A')).not.toHaveProperty('clientCert');
    expect(configs.get('SP3-A')).not.toHaveProperty('caCert');
    expect(configs.get('SP3-B')).toMatchObject({ caCert: 'ROW-CA' });
    expect(mocks.readFileSync.mock.calls.filter((c) => c[0] === '')).toEqual([]);
  });
});

describe('SimulatorManager start and stop', () => {
  it('syncs on start, polls every 5s, logs a failed poll, and stops every simulator', async () => {
    vi.useFakeTimers();
    const SimulatorManager = await loadManagerClass();
    const state = { rows: [{ id: 'pk1', station_id: 'CS-1' }] as Row[], evses: [] };
    let failNext = false;
    const base = makeSql(state);
    const sql = ((strings: TemplateStringsArray, ...v: unknown[]) => {
      if (failNext) return Promise.reject(new Error('db gone'));
      return (base as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(
        strings,
        ...v,
      );
    }) as unknown as postgres.Sql;
    const sims: SimStub[] = [];
    const factory = vi.fn((config: StationConfig) => {
      const s = makeSim(config);
      sims.push(s);
      return s as unknown as StationSimulator;
    });
    const manager = new SimulatorManager(sql, undefined, factory);

    await manager.start();
    expect(manager.simulatorCount).toBe(1);

    state.rows.push({ id: 'pk2', station_id: 'CS-2' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(manager.simulatorCount).toBe(2);

    failNext = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(logged('syncStations error: db gone')).toBe(true);
    failNext = false;

    await manager.stop();
    expect(manager.simulatorCount).toBe(0);
    expect(sims.every((s) => s.stop.mock.calls.length === 1)).toBe(true);

    // No more polling after stop.
    state.rows.push({ id: 'pk3', station_id: 'CS-3' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(factory).toHaveBeenCalledTimes(2);

    // Stopping twice is safe.
    await expect(manager.stop()).resolves.toBeUndefined();
  });
});
