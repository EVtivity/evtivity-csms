// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import WebSocket from 'ws';
import type { CsTestCase, CsTestContext } from '../cs-types.js';
import type { RunConfig, TestResult } from '../types.js';

const { sqlCalls, sqlValues, sqlEnd, stations } = vi.hoisted(() => ({
  sqlCalls: [] as string[],
  sqlValues: [] as unknown[][],
  sqlEnd: { fn: null as null | (() => Promise<void>) },
  stations: [] as Array<{ config: Record<string, unknown>; stopped: boolean }>,
}));

vi.mock('postgres', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    sqlCalls.push(strings.join('?').replace(/\s+/g, ' ').trim());
    sqlValues.push(values);
    return Promise.resolve([]);
  };
  const end = vi.fn(() => Promise.resolve());
  sqlEnd.fn = end;
  return { default: vi.fn(() => Object.assign(sql, { end })) };
});

const raiseStationSimHistoryFloor = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@evtivity/database', () => ({ raiseStationSimHistoryFloor }));

// A station that opens one WebSocket to the test server and answers nothing.
vi.mock('@evtivity/css/station-simulator', () => {
  class StationSimulator {
    readonly client = { kind: 'fake-client' };
    private ws: WebSocket | null = null;
    private readonly record: { config: Record<string, unknown>; stopped: boolean };
    constructor(readonly config: Record<string, unknown>) {
      this.record = { config, stopped: false };
      stations.push(this.record);
    }
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(
          `${String(this.config['targetUrl'])}/${String(this.config['stationId'])}`,
          [String(this.config['ocppProtocol'])],
        );
        this.ws = ws;
        ws.once('open', () => {
          resolve();
        });
        ws.once('error', reject);
      });
    }
    send(frame: unknown[]): Promise<unknown[]> {
      return new Promise((resolve) => {
        this.ws?.once('message', (data: Buffer) => {
          resolve(JSON.parse(data.toString('utf-8')) as unknown[]);
        });
        this.ws?.send(JSON.stringify(frame));
      });
    }
    stop(): Promise<void> {
      this.record.stopped = true;
      this.ws?.terminate();
      return Promise.resolve();
    }
  }
  return { StationSimulator };
});

const { executeCsTest, closeCsSql } = await import('../cs-executor.js');

const logger = pino({ level: 'silent' });
const config = { serverUrl: 'ws://unused' } as unknown as RunConfig;

function testCase(
  execute: (ctx: CsTestContext) => Promise<TestResult>,
  extra: Partial<CsTestCase> = {},
): CsTestCase {
  return {
    id: 'TC_X_01_CS',
    name: 'Example',
    module: 'X',
    version: 'ocpp2.1',
    sut: 'cs',
    description: '',
    purpose: '',
    execute,
    ...extra,
  };
}

const passed = (): Promise<TestResult> =>
  Promise.resolve({ status: 'passed', durationMs: 0, steps: [] });

type FakeStation = { send(frame: unknown[]): Promise<unknown[]> };

beforeEach(() => {
  sqlCalls.length = 0;
  sqlValues.length = 0;
  stations.length = 0;
});

describe('executeCsTest', () => {
  it('provisions the station rows, boots the station, runs the test and cleans up', async () => {
    let seen: CsTestContext | null = null;
    const out = await executeCsTest(
      testCase(
        (ctx) => {
          seen = ctx;
          expect(ctx.server.isConnected).toBe(true);
          return passed();
        },
        { stationConfig: { evseCount: 2, fixedCable: true, configOverrides: { A: '1' } } },
      ),
      config,
      logger,
    );

    expect(out).toMatchObject({
      testId: 'TC_X_01_CS',
      testName: 'Example',
      module: 'X',
      version: 'ocpp2.1',
      result: { status: 'passed' },
    });
    expect(out.result.durationMs).toBeGreaterThanOrEqual(0);

    const ctx = seen as unknown as CsTestContext;
    expect(ctx.stationId).toMatch(/^OCTT-CS-X-TC_X_01_CS-[a-z0-9]+$/);
    expect(ctx.client).toEqual({ kind: 'fake-client' });
    expect(ctx.tls).toBeUndefined();
    expect(ctx.security.serialNumber).toBe('OCTT-SN-001');
    expect(ctx.security.password).toMatch(/^.{16,40}$/);

    const st = stations[0];
    expect(st?.stopped).toBe(true);
    expect(st?.config).toMatchObject({
      stationId: ctx.stationId,
      securityProfile: 0,
      vendorName: 'OCTT',
      model: 'OCTT-Virtual',
      reconnectSpreadMs: 0,
      configOverrides: {
        'OCPPCommCtrlr.RetryBackOffWaitMinimum': '10',
        A: '1',
      },
    });
    expect(st?.config['caCert']).toBeUndefined();
    const evses = st?.config['evses'] as Array<Record<string, unknown>>;
    expect(evses.map((e) => e['evseId'])).toEqual([1, 2]);
    expect(evses.every((e) => e['fixedCable'] === true)).toBe(true);

    expect(sqlCalls.filter((q) => q.startsWith('INSERT INTO charging_stations'))).toHaveLength(1);
    // The station row id has the shape every API route validates (sta_ plus 12
    // characters); a shorter one made the CSMS station page answer 400.
    const insertIndex = sqlCalls.findIndex((q) => q.startsWith('INSERT INTO charging_stations'));
    expect(sqlValues[insertIndex]?.[0]).toMatch(/^sta_[a-z0-9]{12}$/);
    expect(sqlCalls.filter((q) => q.startsWith('INSERT INTO css_stations'))).toHaveLength(1);
    expect(sqlCalls.filter((q) => q.startsWith('INSERT INTO css_evses'))).toHaveLength(2);
    const deletes = sqlCalls.filter((q) => q.startsWith('DELETE'));
    expect(deletes).toHaveLength(10);
    expect(deletes.at(-1)).toContain('DELETE FROM charging_stations');
    // The SIM history floor of the station's SIM goes up before the delete.
    const lookup = sqlCalls.findIndex((q) => q.startsWith('SELECT id FROM charging_stations'));
    expect(lookup).toBeGreaterThan(-1);
    expect(lookup).toBeLessThan(sqlCalls.lastIndexOf(deletes.at(-1) ?? ''));
    expect(raiseStationSimHistoryFloor).toHaveBeenCalledWith([]);
  });

  it('keeps the station row when its SIM history floor is not raised (security review L4)', async () => {
    raiseStationSimHistoryFloor.mockRejectedValueOnce(new Error('database down'));
    await executeCsTest(testCase(passed), config, logger);
    expect(raiseStationSimHistoryFloor).toHaveBeenCalledTimes(1);
    // The other cleanup runs; only the station delete, whose cascade would drop the
    // SIM attachment without a floor, is skipped.
    expect(sqlCalls.filter((q) => q.startsWith('DELETE FROM css_stations'))).toHaveLength(1);
    expect(sqlCalls.filter((q) => q.startsWith('DELETE FROM charging_stations'))).toEqual([]);
  });

  it('answers station messages with version-aware defaults (2.1)', async () => {
    const replies: Record<string, unknown> = {};
    await executeCsTest(
      testCase(async (ctx) => {
        const station = ctx.station as unknown as FakeStation;
        for (const action of [
          'BootNotification',
          'Heartbeat',
          'Authorize',
          'SignCertificate',
          'DataTransfer',
          'TransactionEvent',
          'Unknown',
        ]) {
          const frame = await station.send([2, action, action, {}]);
          replies[action] = frame[2];
        }
        return passed();
      }),
      config,
      logger,
    );
    expect(replies['BootNotification']).toMatchObject({ interval: 300, status: 'Accepted' });
    expect(replies['Heartbeat']).toEqual({ currentTime: expect.any(String) });
    expect(replies['Authorize']).toEqual({ idTokenInfo: { status: 'Accepted' } });
    expect(replies['SignCertificate']).toEqual({ status: 'Accepted' });
    expect(replies['DataTransfer']).toEqual({ status: 'Accepted' });
    expect(replies['TransactionEvent']).toEqual({});
    expect(replies['Unknown']).toEqual({});
  });

  it('answers station messages with version-aware defaults (1.6)', async () => {
    const replies: Record<string, unknown> = {};
    await executeCsTest(
      testCase(
        async (ctx) => {
          const station = ctx.station as unknown as FakeStation;
          for (const action of [
            'Authorize',
            'StartTransaction',
            'StopTransaction',
            'StatusNotification',
            'MeterValues',
            'NotifyReport',
            'NotifyEvent',
            'LogStatusNotification',
            'FirmwareStatusNotification',
            'SecurityEventNotification',
            'DiagnosticsStatusNotification',
          ]) {
            const frame = await station.send([2, action, action, {}]);
            replies[action] = frame[2];
          }
          return passed();
        },
        { version: 'ocpp1.6' },
      ),
      config,
      logger,
    );
    expect(stations[0]?.config['ocppProtocol']).toBe('ocpp1.6');
    expect(replies['Authorize']).toEqual({ idTagInfo: { status: 'Accepted' } });
    expect(replies['StartTransaction']).toMatchObject({
      idTagInfo: { status: 'Accepted' },
      transactionId: expect.any(Number),
    });
    expect(replies['StopTransaction']).toEqual({ idTagInfo: { status: 'Accepted' } });
    expect(replies['StatusNotification']).toEqual({});
    expect(replies['DiagnosticsStatusNotification']).toEqual({});
  });

  it('runs a 2.0.1 case with a 2.0.1 station and passes it when every message is 2.0.1', async () => {
    let version: string | null = null;
    const replies: Record<string, unknown> = {};
    const out = await executeCsTest(
      testCase(
        async (ctx) => {
          version = ctx.version;
          const station = ctx.station as unknown as FakeStation;
          for (const action of ['Heartbeat', 'Authorize']) {
            const payload =
              action === 'Authorize' ? { idToken: { idToken: 'A', type: 'ISO14443' } } : {};
            const frame = await station.send([2, action, action, payload]);
            replies[action] = frame[2];
          }
          return passed();
        },
        { version: 'ocpp2.0.1' },
      ),
      config,
      logger,
    );
    expect(version).toBe('ocpp2.0.1');
    expect(stations[0]?.config['ocppProtocol']).toBe('ocpp2.0.1');
    expect(replies['Authorize']).toEqual({ idTokenInfo: { status: 'Accepted' } });
    expect(out.result.status).toBe('passed');
  });

  it('fails a 2.0.1 case with a message that is not valid OCPP 2.0.1', async () => {
    const out = await executeCsTest(
      testCase(
        async (ctx) => {
          const station = ctx.station as unknown as FakeStation;
          await station.send([2, 'n1', 'NotifyPeriodicEventStream', {}]);
          await station.send([2, 'h1', 'Heartbeat', { extra: true }]);
          return passed();
        },
        { version: 'ocpp2.0.1' },
      ),
      config,
      logger,
    );
    expect(out.result.status).toBe('failed');
    const step = out.result.steps.at(-1);
    expect(step).toMatchObject({
      description: 'Every message of the test is valid OCPP 2.0.1',
      status: 'failed',
    });
    expect(step?.actual).toContain(
      'Station request: NotifyPeriodicEventStream is not defined in OCPP 2.0.1',
    );
    expect(step?.actual).toContain(
      'Station request: Heartbeat request fails the OCPP 2.0.1 schema',
    );
  });

  it('does not boot the station when the test controls the boot', async () => {
    const out = await executeCsTest(
      testCase(
        (ctx) => {
          expect(ctx.server.isConnected).toBe(false);
          return passed();
        },
        { skipAutoBoot: true },
      ),
      config,
      logger,
    );
    expect(out.result.status).toBe('passed');
  });

  it('reports an error result when the test throws, and still cleans up', async () => {
    const out = await executeCsTest(
      testCase(() => Promise.reject(new Error('boom')), { skipAutoBoot: true }),
      config,
      logger,
    );
    expect(out.result).toMatchObject({ status: 'error', error: 'boom', steps: [] });
    expect(stations[0]?.stopped).toBe(true);
    expect(sqlCalls.some((q) => q.startsWith('DELETE FROM css_stations'))).toBe(true);
  });

  it('ends a test that runs past its timeout with an error', async () => {
    const out = await executeCsTest(
      testCase(() => new Promise<TestResult>(() => {}), { skipAutoBoot: true, timeoutMs: 30 }),
      config,
      logger,
    );
    expect(out.result).toMatchObject({ status: 'error', error: 'Test timed out after 30ms' });
  });

  it('gives a tls test a PKI, a wss:// server on profile 3 and the station certificates', async () => {
    let seen: CsTestContext | null = null;
    let extraUrl = '';
    await executeCsTest(
      testCase(
        async (ctx) => {
          seen = ctx;
          extraUrl = (await ctx.startServer({ securityProfile: 2 })).url;
          return passed();
        },
        { tls: true, skipAutoBoot: true, stationConfig: { serialNumber: 'SN-9' } },
      ),
      config,
      logger,
    );
    const ctx = seen as unknown as CsTestContext;
    expect(ctx.tls?.root.cert.subject).toContain('OCTT Central System Root CA');
    expect(ctx.tls?.chargePoint.cert.subject).toContain('CN=SN-9');
    expect(ctx.tls?.server.cert.subject).toContain('CN=localhost');
    expect(extraUrl).toMatch(/^wss:\/\/localhost:\d+$/);
    expect(stations[0]?.config).toMatchObject({
      securityProfile: 3,
      verifyServerCertificate: true,
      caCert: ctx.tls?.root.pem,
      clientCert: ctx.tls?.chargePoint.pem,
      targetUrl: expect.stringMatching(/^wss:\/\/localhost:/),
    });
    // The station may move to the test servers only (TC_A_19_CS): the first
    // one and the one the test started.
    expect(stations[0]?.config['extraAllowedServerUrls']).toEqual([
      stations[0]?.config['targetUrl'],
      extraUrl,
    ]);
  });

  it('a tls test on profile 1 stays on ws:// without client certificates', async () => {
    await executeCsTest(
      testCase(passed, { tls: true, skipAutoBoot: true, stationConfig: { securityProfile: 1 } }),
      config,
      logger,
    );
    expect(stations[0]?.config).toMatchObject({
      securityProfile: 1,
      verifyServerCertificate: true,
      targetUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:/),
    });
    expect(stations[0]?.config['caCert']).toBeUndefined();
    expect(stations[0]?.config['clientCert']).toBeUndefined();
  });

  it('lets the station download only from the file servers the test starts, and closes them', async () => {
    let allowedAtStart: readonly string[] = [];
    let firstUrl = '';
    let laterUrl = '';
    let served = '';
    await executeCsTest(
      testCase(
        async (ctx) => {
          allowedAtStart = [
            ...((stations[0]?.config['extraAllowedFileTransferHosts'] as string[] | undefined) ??
              []),
          ];
          firstUrl = (await ctx.startFileServer('/fw.bin', Buffer.from('fw'))).url;
          // A server started later joins the same list the station reads at each transfer.
          const later = await ctx.startFileServer('/late.bin', Buffer.from('late'), {
            delayMs: 10,
          });
          laterUrl = later.url;
          served = Buffer.from(await (await fetch(later.url)).arrayBuffer()).toString();
          return passed();
        },
        { skipAutoBoot: true },
      ),
      config,
      logger,
    );
    expect(allowedAtStart).toEqual([]);
    expect(served).toBe('late');
    expect(stations[0]?.config['extraAllowedFileTransferHosts']).toEqual([
      new URL(firstUrl).host,
      new URL(laterUrl).host,
    ]);
    expect(new URL(firstUrl).hostname).toBe('127.0.0.1');
    // The executor closed both servers after the test.
    await expect(fetch(firstUrl)).rejects.toThrow();
    await expect(fetch(laterUrl)).rejects.toThrow();
  });

  it('startServer serves ws:// for profile 1 and refuses profile 2 without tls', async () => {
    let plainUrl = '';
    const out = await executeCsTest(
      testCase(
        async (ctx) => {
          plainUrl = (await ctx.startServer({ securityProfile: 1 })).url;
          await ctx.startServer({ securityProfile: 2 });
          return passed();
        },
        { skipAutoBoot: true },
      ),
      config,
      logger,
    );
    expect(plainUrl).toMatch(/^ws:\/\//);
    expect(out.result).toMatchObject({
      status: 'error',
      error: 'A security profile 2/3 server needs a test case with tls',
    });
  });

  it('closeCsSql ends the shared connection once', async () => {
    await closeCsSql();
    expect(sqlEnd.fn).toHaveBeenCalledTimes(1);
    await closeCsSql();
    expect(sqlEnd.fn).toHaveBeenCalledTimes(1);
  });
});
