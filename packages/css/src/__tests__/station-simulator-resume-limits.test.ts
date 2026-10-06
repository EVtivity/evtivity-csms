// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import type { StationConfig } from '../station-simulator.js';
import {
  call,
  makeHarness,
  priv,
  silenceConsole,
  stubSql,
  type CallResponder,
  type Harness,
  type HarnessOptions,
  type Protocol,
  type SqlResponder,
} from './sim-harness.js';

// A station whose css_transactions reads follow its in-memory transactions,
// as the real table would after createTransaction / completeTransaction.
async function liveHarness(
  protocol: Protocol,
  respond?: CallResponder,
  extra: Partial<HarnessOptions> = {},
  responder?: SqlResponder,
): Promise<Harness> {
  let ref: Harness | null = null;
  const sql = stubSql((q, values) => {
    const custom = responder?.(q, values);
    if (custom != null) return custom;
    if (ref != null && q.includes('SELECT evse_id FROM css_transactions')) {
      const txId = values[1] as string;
      for (const [evseId, id] of priv(ref, 'activeTransactionIds') as Map<number, string>) {
        if (id === txId) return [{ evse_id: evseId }];
      }
      return [];
    }
    if (ref == null || !q.includes('SELECT transaction_id, meter_start_wh, id_token')) {
      return undefined;
    }
    const evseId = values[1] as number;
    const txId = (priv(ref, 'activeTransactionIds') as Map<number, string>).get(evseId);
    if (txId == null) return [];
    const ctx = (priv(ref, 'evseContexts') as Map<number, { authorizedToken: string | null }>).get(
      evseId,
    );
    return [{ transaction_id: txId, meter_start_wh: 0, id_token: ctx?.authorizedToken ?? '' }];
  });
  const h = await makeHarness({
    protocol,
    sql,
    boot: true,
    ...(respond ? { respond } : {}),
    ...extra,
  });
  ref = h;
  h.sendCall.mockClear();
  return h;
}

// Tagged-template SQL stub that rejects the queries `fails` matches and
// answers the rest like stubSql.
function failingSql(fails: (q: string) => boolean, responder?: SqlResponder): postgres.Sql {
  const queries: string[] = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = Array.isArray(strings) ? strings.join(' ') : '';
    queries.push(q);
    if (fails(q)) return Promise.reject(new Error('db down'));
    return Promise.resolve(responder?.(q, values) ?? []);
  }) as unknown as postgres.Sql;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return fn;
}

// Tagged-template SQL stub that records every query with its values.
function recordingSql(responder?: SqlResponder): {
  sql: postgres.Sql;
  log: Array<{ q: string; values: unknown[] }>;
} {
  const log: Array<{ q: string; values: unknown[] }> = [];
  const sql = stubSql((q, values) => {
    log.push({ q, values });
    return responder?.(q, values);
  });
  return { sql, log };
}

function ctxOf(h: Harness, evseId = 1): Record<string, unknown> {
  return (priv(h, 'evseContexts') as Map<number, Record<string, unknown>>).get(evseId) ?? {};
}

function txEvents(h: Harness, trigger?: string): Array<Record<string, unknown>> {
  return h
    .sent('TransactionEvent')
    .filter((e) => trigger == null || e['triggerReason'] === trigger);
}

const twoEvses: Partial<StationConfig> = {
  evses: [
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
      connectorType: 'ac_type2',
      maxPowerW: 22000,
      phases: 3,
      voltage: 230,
    },
  ],
};

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('rebootStation', () => {
  it('does nothing while disconnected', async () => {
    const h = await makeHarness({ connected: false });
    await h.sim.rebootStation();
    expect(h.sendCall).not.toHaveBeenCalled();
  });

  it('stops when the BootNotification fails', async () => {
    const h = await makeHarness({
      respond: (action) => {
        if (action === 'BootNotification') throw new Error('timed out');
        return undefined;
      },
    });
    await h.sim.rebootStation();
    expect(h.actions()).toEqual(['BootNotification']);
  });

  it('sends no status when the boot is not Accepted', async () => {
    const h = await makeHarness({
      respond: (action) =>
        action === 'BootNotification'
          ? { status: 'Pending', interval: 30, currentTime: new Date().toISOString() }
          : undefined,
    });
    await h.sim.rebootStation();
    expect(h.sent('BootNotification')[0]?.['reason']).toBe('RemoteReset');
    expect(h.sent('StatusNotification')).toHaveLength(0);
  });

  it('2.1: reports idle connectors Available and leaves a charging EVSE alone', async () => {
    const h = await liveHarness('ocpp2.1', undefined, { config: twoEvses });
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    h.sendCall.mockClear();
    await h.sim.rebootStation();
    expect(h.sent('BootNotification')[0]?.['reason']).toBe('RemoteReset');
    const statuses = h.sent('StatusNotification');
    expect(statuses).toEqual([
      expect.objectContaining({ evseId: 2, connectorStatus: 'Available' }),
    ]);
    expect(ctxOf(h, 1)['transactionId']).not.toBeNull();
    expect(h.sim.isReady()).toBe(true);
  });

  it('1.6: reports connector 0, then each idle connector', async () => {
    const h = await liveHarness('ocpp1.6');
    await h.sim.rebootStation();
    expect(h.sent('BootNotification')).toHaveLength(1);
    expect(h.sent('StatusNotification')).toEqual([
      { connectorId: 0, errorCode: 'NoError', status: 'Available' },
      { connectorId: 1, errorCode: 'NoError', status: 'Available' },
    ]);
  });

  it('1.6: a failed connector 0 status is logged and the connectors still report', async () => {
    let first = true;
    const h = await liveHarness('ocpp1.6', (action, payload) => {
      if (action === 'StatusNotification' && payload['connectorId'] === 0 && !first) {
        throw new Error('socket closed');
      }
      if (action === 'StatusNotification' && payload['connectorId'] === 0) first = false;
      return undefined;
    });
    await h.sim.rebootStation();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Connector 0 StatusNotification failed: socket closed'),
    );
    expect(h.sent('StatusNotification').at(-1)).toMatchObject({ connectorId: 1 });
  });
});

describe('comeOnline', () => {
  it('is a no-op on a connected station', async () => {
    const h = await makeHarness();
    await h.sim.comeOnline();
    expect(h.sendCall).not.toHaveBeenCalled();
  });

  it('boots again after going offline', async () => {
    const h = await makeHarness();
    h.p['offlineFlag'] = true;
    await h.sim.comeOnline();
    expect(h.p['offlineFlag']).toBe(false);
    expect(h.sent('BootNotification')[0]?.['reason']).toBe('PowerUp');
  });
});

describe('clock-aligned meter values', () => {
  it('2.1: the timer sends MeterValues for EVSE 0 with Sample.Clock', async () => {
    const h = await liveHarness('ocpp2.1');
    h.sim.setConfigValue('AlignedDataCtrlr.Measurands', 'Energy.Active.Import.Register');
    h.sim.setConfigValue('AlignedDataCtrlr.Interval', '60');
    await vi.advanceTimersByTimeAsync(60_000);
    const mv = h.sent('MeterValues').at(-1);
    expect(mv?.['evseId']).toBe(0);
    const sv = (mv?.['meterValue'] as Array<{ sampledValue: Array<Record<string, unknown>> }>)[0]
      ?.sampledValue;
    expect(sv?.[0]).toMatchObject({
      context: 'Sample.Clock',
      measurand: 'Energy.Active.Import.Register',
    });

    h.sim.stopClockAlignedTimer();
    const count = h.sent('MeterValues').length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.sent('MeterValues')).toHaveLength(count);
  });

  it('1.6: clock-aligned MeterValues use connector 0', async () => {
    const h = await liveHarness('ocpp1.6');
    h.sim.setConfigValue('ClockAlignedDataInterval', '0');
    h.sim.setConfigValue('MeterValuesAlignedData', 'Energy.Active.Import.Register');
    h.sim.setConfigValue('ClockAlignedDataInterval', '30');
    await h.sim.sendClockAlignedMeterValues();
    expect(h.sent('MeterValues').at(-1)?.['connectorId']).toBe(0);
  });

  it('2.1: during a transaction sends TransactionEvent MeterValueClock', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'TAG-1');
    h.sim.setConfigValue('AlignedDataCtrlr.Measurands', 'Energy.Active.Import.Register');
    await h.sim.sendClockAlignedMeterValues();
    const clock = txEvents(h, 'MeterValueClock');
    expect(clock).toHaveLength(1);
    expect(clock[0]).toMatchObject({ transactionInfo: { transactionId: txId } });
  });

  it('skips without an interval, a connection or measurands', async () => {
    const h = await liveHarness('ocpp2.1');
    h.sim.setConfigValue('AlignedDataCtrlr.Interval', '0');
    await h.sim.sendClockAlignedMeterValues();
    h.sim.setConfigValue('AlignedDataCtrlr.Interval', '60');
    h.sim.setConfigValue('AlignedDataCtrlr.Measurands', '');
    await h.sim.sendClockAlignedMeterValues();
    h.sim.setConfigValue('AlignedDataCtrlr.Measurands', 'Energy.Active.Import.Register');
    Object.defineProperty(h.sim.client, 'isConnected', { value: false, writable: true });
    await h.sim.sendClockAlignedMeterValues();
    expect(h.sent('MeterValues')).toHaveLength(0);
  });

  it('logs an unexpected send failure but not a connection failure', async () => {
    const h = await liveHarness('ocpp2.1', (action) => {
      if (action === 'MeterValues') throw new Error('CALLERROR FormationViolation');
      return undefined;
    });
    h.sim.setConfigValue('AlignedDataCtrlr.Measurands', 'Energy.Active.Import.Register');
    await h.sim.sendClockAlignedMeterValues();
    await vi.advanceTimersByTimeAsync(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[clock-aligned] TEST-SIM: CALLERROR FormationViolation'),
    );
  });

  it('logs an unexpected TransactionEvent failure during a transaction', async () => {
    let failTx = false;
    const h = await liveHarness('ocpp2.1', (action) => {
      if (action === 'TransactionEvent' && failTx) throw new Error('boom');
      return undefined;
    });
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    h.sim.setConfigValue('AlignedDataCtrlr.Measurands', 'Energy.Active.Import.Register');
    failTx = true;
    await h.sim.sendClockAlignedMeterValues();
    await vi.advanceTimersByTimeAsync(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[clock-aligned]'));
  });
});

describe('Reset ImmediateAndResume (B13)', () => {
  it('reports ResetCommand, reboots, then resumes as SuspendedEVSE', async () => {
    const h = await liveHarness('ocpp2.1');
    h.sim.setConfigValue('TxCtrlr.ResumptionTimeout', '60');
    h.sim.setConfigValue('TxCtrlr.AllowEnergyTransferResumption', 'false');
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'TAG-1');
    h.sendCall.mockClear();

    expect(await h.invoke('Reset', { type: 'ImmediateAndResume' })).toEqual({
      status: 'Accepted',
    });
    await vi.advanceTimersByTimeAsync(600);

    const order = h.actions().filter((a) => a !== 'NotifyEvent');
    expect(order).toEqual([
      'TransactionEvent',
      'BootNotification',
      'StatusNotification',
      'SecurityEventNotification',
      'TransactionEvent',
    ]);
    expect(txEvents(h, 'ResetCommand')[0]).toMatchObject({
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
    });
    expect(h.sent('BootNotification')[0]?.['reason']).toBe('RemoteReset');
    expect(h.sent('SecurityEventNotification')[0]?.['type']).toBe('ResetOrReboot');
    expect(txEvents(h, 'TxResumed')[0]).toMatchObject({
      transactionInfo: { transactionId: txId, chargingState: 'SuspendedEVSE' },
    });
  });

  it('an EVSE reset with energy resumption keeps charging without a boot', async () => {
    const h = await liveHarness('ocpp2.1', undefined, { config: twoEvses });
    h.sim.setConfigValue('TxCtrlr.ResumptionTimeout', '60');
    h.sim.setConfigValue('TxCtrlr.AllowEnergyTransferResumption', 'true');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    await h.sim.plugIn(2);
    await h.sim.startCharging(2, 'TAG-2');
    h.sendCall.mockClear();

    await h.invoke('Reset', { type: 'ImmediateAndResume', evseId: 2 });
    await vi.advanceTimersByTimeAsync(600);
    expect(h.sent('BootNotification')).toHaveLength(0);
    const resumed = txEvents(h, 'TxResumed');
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({
      evse: { id: 2 },
      transactionInfo: { chargingState: 'Charging' },
    });
    expect((priv(h, 'meterTimers') as Map<number, unknown>).has(2)).toBe(true);
  });

  it('logs a failed reset', async () => {
    let fail = false;
    const h = await liveHarness('ocpp2.1', (action) => {
      if (fail && action === 'TransactionEvent') throw new Error('lost');
      return undefined;
    });
    h.sim.setConfigValue('TxCtrlr.ResumptionTimeout', '60');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    fail = true;
    await h.invoke('Reset', { type: 'ImmediateAndResume' });
    await vi.advanceTimersByTimeAsync(10);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('ImmediateAndResume reset failed: lost'),
    );
  });
});

describe('EV disconnect without stopping the transaction (2.1)', () => {
  it('suspends, then ends the transaction with EVConnectTimeout', async () => {
    const h = await liveHarness('ocpp2.1');
    h.sim.setConfigValue('TxCtrlr.StopTxOnEVSideDisconnect', 'false');
    h.sim.setConfigValue('TxCtrlr.EVConnectionTimeOut', '30');
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'TAG-1');
    h.sendCall.mockClear();

    await h.sim.unplug(1);
    expect(txEvents(h, 'EVCommunicationLost')[0]).toMatchObject({
      transactionInfo: { transactionId: txId, chargingState: 'Idle' },
    });
    expect(h.sent('StatusNotification').at(-1)).toMatchObject({ connectorStatus: 'Available' });
    expect(ctxOf(h)['state']).toBe('SuspendedEV');

    await vi.advanceTimersByTimeAsync(30_000);
    const ended = h.sent('TransactionEvent').find((e) => e['eventType'] === 'Ended');
    expect(ended).toMatchObject({
      triggerReason: 'EVConnectTimeout',
      transactionInfo: { transactionId: txId, stoppedReason: 'Timeout' },
    });
    expect(ctxOf(h)).toMatchObject({ state: 'Available', transactionId: null });
  });

  it('re-plugging resumes charging and cancels the timeout', async () => {
    const h = await liveHarness('ocpp2.1');
    h.sim.setConfigValue('TxCtrlr.StopTxOnEVSideDisconnect', 'false');
    h.sim.setConfigValue('TxCtrlr.EVConnectionTimeOut', '30');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    await h.sim.unplug(1);
    h.sendCall.mockClear();

    await h.sim.plugIn(1);
    expect(txEvents(h).map((e) => e['triggerReason'])).toEqual(
      expect.arrayContaining(['CablePluggedIn', 'ChargingStateChanged']),
    );
    expect(ctxOf(h)['state']).toBe('Charging');
    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.sent('TransactionEvent').some((e) => e['eventType'] === 'Ended')).toBe(false);
  });

  it('a timeout of 0 never ends the suspended transaction', async () => {
    const h = await liveHarness('ocpp2.1');
    h.sim.setConfigValue('TxCtrlr.StopTxOnEVSideDisconnect', 'false');
    h.sim.setConfigValue('TxCtrlr.EVConnectionTimeOut', '0');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    await h.sim.unplug(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.sent('TransactionEvent').some((e) => e['eventType'] === 'Ended')).toBe(false);
  });
});

describe('remote start authorization (F01.FR.01)', () => {
  async function remoteStart(
    respond: CallResponder,
  ): Promise<{ h: Harness; res: Record<string, unknown> }> {
    const h = await liveHarness('ocpp2.1', respond);
    h.sim.setConfigValue('AuthCtrlr.AuthorizeRemoteStart', 'true');
    h.sim.setConfigValue('TxCtrlr.EVConnectionTimeOut', '300');
    const res = await h.invoke('RequestStartTransaction', {
      idToken: { idToken: 'TAG-R', type: 'ISO14443' },
      remoteStartId: 7,
      evseId: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    return { h, res };
  }

  it('a token that is not Accepted ends the authorization', async () => {
    const { h, res } = await remoteStart((action) =>
      action === 'Authorize' ? { idTokenInfo: { status: 'Blocked' } } : undefined,
    );
    expect(res).toEqual({ status: 'Accepted' });
    expect(h.sent('Authorize')[0]).toMatchObject({ idToken: { idToken: 'TAG-R' } });
    expect(ctxOf(h)).toMatchObject({
      state: 'Available',
      authorizedToken: null,
      remoteStartId: null,
    });
  });

  it('an Accepted token keeps the authorization', async () => {
    const { h } = await remoteStart(() => undefined);
    expect(ctxOf(h)).toMatchObject({ state: 'Authorized', authorizedToken: 'TAG-R' });
  });

  it('a failed Authorize keeps the authorization', async () => {
    const { h } = await remoteStart((action) => {
      if (action === 'Authorize') throw new Error('timed out');
      return undefined;
    });
    expect(ctxOf(h)).toMatchObject({ state: 'Authorized', authorizedToken: 'TAG-R' });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Authorize for remote start failed: timed out'),
    );
  });

  it('with AuthorizeRemoteStart false a plugged EVSE starts without Authorize', async () => {
    const h = await liveHarness('ocpp2.1');
    h.sim.setConfigValue('AuthCtrlr.AuthorizeRemoteStart', 'false');
    await h.sim.plugIn(1);
    h.sendCall.mockClear();
    const res = await h.invoke('RequestStartTransaction', {
      idToken: { idToken: 'TAG-R', type: 'ISO14443' },
      remoteStartId: 8,
      evseId: 1,
    });
    expect(res).toMatchObject({ status: 'Accepted', transactionId: expect.any(String) });
    expect(h.sent('Authorize')).toHaveLength(0);
    expect(txEvents(h, 'RemoteStart')).toHaveLength(1);
  });
});

function reconnect(h: Harness): Promise<void> {
  return call(h, 'onReconnect') as Promise<void>;
}

describe('power cycle', () => {
  it('simulatePowerCycle stops running transactions with the reason, then reconnects', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'TAG-1');
    await h.sim.simulatePowerCycle('PowerLoss', 5000);
    const ended = h.sent('TransactionEvent').find((e) => e['eventType'] === 'Ended');
    expect(ended).toMatchObject({
      transactionInfo: { transactionId: txId, stoppedReason: 'PowerLoss' },
    });
    expect(h.sim.client.reconnectNow).toHaveBeenCalledWith(5000);
    expect(h.p['rebootOnReconnect']).toBe(true);
  });

  it('1.6: an interrupted transaction is stopped with PowerLoss after the reboot', async () => {
    const h = await liveHarness('ocpp1.6');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    h.sendCall.mockClear();
    await h.sim.simulatePowerCyclePreserveTransactions(1000);
    expect(h.sim.client.reconnectNow).toHaveBeenCalledWith(1000);
    expect(h.sent('StopTransaction')).toHaveLength(0);
    expect((priv(h, 'meterTimers') as Map<number, unknown>).has(1)).toBe(false);

    await reconnect(h);
    expect(h.sent('BootNotification')).toHaveLength(1);
    expect(h.sent('StopTransaction')[0]).toMatchObject({
      transactionId: 4242,
      reason: 'PowerLoss',
    });
    expect(ctxOf(h)['transactionId']).toBeNull();
  });

  async function preserved(
    configure: (h: Harness) => void,
  ): Promise<{ h: Harness; txId: string; log: Array<{ q: string; values: unknown[] }> }> {
    const log: Array<{ q: string; values: unknown[] }> = [];
    const h = await liveHarness('ocpp2.1', undefined, {}, (q, values) => {
      log.push({ q, values });
      return undefined;
    });
    configure(h);
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'TAG-1');
    await h.sim.simulatePowerCyclePreserveTransactions();
    h.sendCall.mockClear();
    return { h, txId, log };
  }

  it('2.1: preserves the transaction and marks it in the database', async () => {
    const { h, txId, log } = await preserved(() => {});
    const marker = log.find((l) => l.q.includes('SET preserved_at ='));
    expect(marker?.values).toContainEqual(expect.objectContaining({ transactionId: txId }));
    expect(
      (priv(h, 'preservedTransactions') as Map<number, { transactionId: string }>).get(1),
    ).toMatchObject({ transactionId: txId, idToken: 'TAG-1' });
  });

  it('2.1: resumes within ResumptionTimeout as SuspendedEVSE', async () => {
    const { h, txId, log } = await preserved((s) => {
      s.sim.setConfigValue('TxCtrlr.ResumptionTimeout', '60');
      s.sim.setConfigValue('TxCtrlr.AllowEnergyTransferResumption', 'false');
    });
    await reconnect(h);
    expect(h.sent('StatusNotification')).toContainEqual(
      expect.objectContaining({ evseId: 1, connectorStatus: 'Occupied' }),
    );
    expect(txEvents(h, 'TxResumed')[0]).toMatchObject({
      transactionInfo: { transactionId: txId, chargingState: 'SuspendedEVSE' },
    });
    expect((priv(h, 'preservedTransactions') as Map<number, unknown>).size).toBe(0);
    expect(log.some((l) => l.q.includes('SET preserved_at = NULL'))).toBe(true);
  });

  it('2.1: resumes charging when energy transfer resumption is allowed', async () => {
    const { h } = await preserved((s) => {
      s.sim.setConfigValue('TxCtrlr.ResumptionTimeout', '60');
      s.sim.setConfigValue('TxCtrlr.AllowEnergyTransferResumption', 'true');
    });
    await reconnect(h);
    expect(txEvents(h, 'TxResumed')[0]).toMatchObject({
      transactionInfo: { chargingState: 'Charging' },
    });
    expect((priv(h, 'meterTimers') as Map<number, unknown>).has(1)).toBe(true);
  });

  it('2.1: without ResumptionTimeout ends the transaction and starts a new one on the cable', async () => {
    const { h, txId } = await preserved((s) => {
      s.sim.deleteConfigValue('TxCtrlr.ResumptionTimeout');
    });
    await reconnect(h);
    const ended = h.sent('TransactionEvent').find((e) => e['eventType'] === 'Ended');
    expect(ended).toMatchObject({
      triggerReason: 'AbnormalCondition',
      transactionInfo: { transactionId: txId, stoppedReason: 'PowerLoss' },
    });
    const started = h.sent('TransactionEvent').find((e) => e['eventType'] === 'Started');
    expect(started).toMatchObject({ triggerReason: 'CablePluggedIn' });
    expect(ctxOf(h)['transactionId']).not.toBe(txId);
    expect(ctxOf(h)['state']).toBe('EVConnected');
  });

  it('2.1: an expired ResumptionTimeout ends the transaction; no cable means Available', async () => {
    const { h, txId } = await preserved((s) => {
      s.sim.setConfigValue('TxCtrlr.ResumptionTimeout', '10');
    });
    ctxOf(h)['cablePlugged'] = false;
    vi.setSystemTime(Date.now() + 20_000);
    await reconnect(h);
    expect(txEvents(h, 'AbnormalCondition')[0]).toMatchObject({
      transactionInfo: { transactionId: txId },
    });
    expect(h.sent('TransactionEvent').some((e) => e['eventType'] === 'Started')).toBe(false);
    expect(h.sent('StatusNotification').at(-1)).toMatchObject({ connectorStatus: 'Available' });
    expect(ctxOf(h)).toMatchObject({ state: 'Available', transactionId: null });
  });

  it('2.1: ResumptionTimeout 0 never resumes', async () => {
    const { h } = await preserved((s) => {
      s.sim.setConfigValue('TxCtrlr.ResumptionTimeout', '0');
    });
    await reconnect(h);
    expect(txEvents(h, 'TxResumed')).toHaveLength(0);
    expect(txEvents(h, 'AbnormalCondition')).toHaveLength(1);
  });
});

describe('connector lock failure', () => {
  it('2.1: reports ConnectorPlugRetentionLock Problem', async () => {
    const h = await makeHarness();
    await h.sim.simulateLockFailure(1, 1);
    const data = (h.sent('NotifyEvent')[0]?.['eventData'] as Array<Record<string, unknown>>)[0];
    expect(data).toMatchObject({
      actualValue: 'true',
      component: { name: 'ConnectorPlugRetentionLock', evse: { id: 1, connectorId: 1 } },
      variable: { name: 'Problem' },
    });
  });

  it('1.6: sends nothing', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    await h.sim.simulateLockFailure(1);
    expect(h.sendCall).not.toHaveBeenCalled();
  });
});

type QueueItem = { id: string; action: string; payload: Record<string, unknown> };

function setQueue(h: Harness, items: Array<Omit<QueueItem, 'id'>>): QueueItem[] {
  const q = items.map((it, i) => ({ id: `q${String(i)}`, ...it }));
  h.p['offlineMessageQueue'] = q;
  return q;
}

function replay(h: Harness): Promise<void> {
  return call(h, 'replayOfflineQueue') as Promise<void>;
}

describe('offline queue replay', () => {
  it('sends each queued message in order and removes it from the database', async () => {
    const { sql, log } = recordingSql();
    const h = await makeHarness({ sql });
    setQueue(h, [
      { action: 'StatusNotification', payload: { evseId: 1 } },
      { action: 'Heartbeat', payload: {} },
    ]);
    await replay(h);
    expect(h.actions()).toEqual(['StatusNotification', 'Heartbeat']);
    expect(priv(h, 'offlineMessageQueue')).toEqual([]);
    const deletes = log.filter((l) => l.q.includes('DELETE FROM css_offline_messages'));
    expect(deletes.map((d) => d.values[1])).toEqual(['q0', 'q1']);
  });

  it('drops a message the CSMS answers with an error and continues', async () => {
    const h = await makeHarness({
      respond: (action) => {
        if (action === 'DataTransfer') throw new Error('CALLERROR');
        return undefined;
      },
    });
    setQueue(h, [
      { action: 'DataTransfer', payload: {} },
      { action: 'Heartbeat', payload: {} },
    ]);
    await replay(h);
    expect(h.actions()).toEqual(['DataTransfer', 'Heartbeat']);
    expect(priv(h, 'offlineMessageQueue')).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to replay DataTransfer: CALLERROR'),
    );
  });

  it('keeps the message when the connection drops mid-replay', async () => {
    const h = await makeHarness({
      respond: () => {
        throw new Error('not open');
      },
    });
    Object.defineProperty(h.sim.client, 'isConnected', { value: false, writable: true });
    setQueue(h, [{ action: 'Heartbeat', payload: {} }]);
    await replay(h);
    expect((priv(h, 'offlineMessageQueue') as QueueItem[]).map((m) => m.action)).toEqual([
      'Heartbeat',
    ]);
  });

  it('a second replay while one runs does nothing', async () => {
    const h = await makeHarness();
    h.p['replayingOfflineQueue'] = true;
    setQueue(h, [{ action: 'Heartbeat', payload: {} }]);
    await replay(h);
    expect(h.sendCall).not.toHaveBeenCalled();
  });

  it('1.6: a rejected offline StartTransaction stops with DeAuthorized when configured', async () => {
    let reject = false;
    const h = await liveHarness('ocpp1.6', (action) =>
      action === 'StartTransaction' && reject
        ? { transactionId: 4242, idTagInfo: { status: 'Invalid' } }
        : undefined,
    );
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    h.sim.setConfigValue('StopTransactionOnInvalidId', 'true');
    reject = true;
    h.sendCall.mockClear();
    setQueue(h, [
      {
        action: 'StartTransaction',
        payload: { connectorId: 1, idTag: 'TAG-1', meterStart: 0, timestamp: 't' },
      },
    ]);
    await replay(h);
    expect(h.sent('StopTransaction')[0]).toMatchObject({ reason: 'DeAuthorized' });
  });

  it('1.6: a rejected offline StartTransaction suspends the connector otherwise', async () => {
    const h = await liveHarness('ocpp1.6', (action) =>
      action === 'StartTransaction'
        ? { transactionId: 99, idTagInfo: { status: 'Blocked' } }
        : undefined,
    );
    h.sim.setConfigValue('StopTransactionOnInvalidId', 'false');
    setQueue(h, [
      {
        action: 'StartTransaction',
        payload: { connectorId: 1, idTag: 'TAG-1', meterStart: 0, timestamp: 't' },
      },
    ]);
    await replay(h);
    expect(h.sent('StatusNotification').at(-1)).toMatchObject({
      connectorId: 1,
      status: 'SuspendedEVSE',
    });
    expect(h.sent('StopTransaction')).toHaveLength(0);
  });

  it('1.6: an offline start queues StartTransaction with a local transaction id', async () => {
    const h = await liveHarness('ocpp1.6');
    await h.sim.plugIn(1);
    Object.defineProperty(h.sim.client, 'isConnected', { value: false, writable: true });
    h.sim.addToLocalAuthList('TAG-OFF');
    h.sendCall.mockClear();
    const txId = await h.sim.startCharging(1, 'TAG-OFF');
    expect(Number(txId)).toBeGreaterThan(0);
    const queued = priv(h, 'offlineMessageQueue') as QueueItem[];
    expect(queued.find((m) => m.action === 'StartTransaction')?.payload).toMatchObject({
      connectorId: 1,
      idTag: 'TAG-OFF',
    });
  });

  it('2.1: a rejected idToken in a replayed TransactionEvent is cached and stops the transaction', async () => {
    let reject = false;
    const h = await liveHarness('ocpp2.1', (action) =>
      action === 'TransactionEvent' && reject ? { idTokenInfo: { status: 'Invalid' } } : undefined,
    );
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'TAG-1');
    reject = true;
    h.sendCall.mockClear();
    setQueue(h, [
      {
        action: 'TransactionEvent',
        payload: {
          eventType: 'Updated',
          idToken: { idToken: 'TAG-1', type: 'ISO14443' },
          transactionInfo: { transactionId: txId },
        },
      },
    ]);
    await replay(h);
    expect((call(h, 'cachedIdTokenInfo', 'TAG-1') as Record<string, unknown>)['status']).toBe(
      'Invalid',
    );
    const ended = h.sent('TransactionEvent').find((e) => e['eventType'] === 'Ended');
    expect(ended).toMatchObject({ transactionInfo: { stoppedReason: 'DeAuthorized' } });
  });

  it('a replayed rejection whose transaction lookup fails stops nothing', async () => {
    const h = await liveHarness(
      'ocpp2.1',
      (action) =>
        action === 'TransactionEvent' ? { idTokenInfo: { status: 'Invalid' } } : undefined,
      {},
      (q) => {
        if (q.includes('SELECT evse_id FROM css_transactions')) throw new Error('unexpected');
        return undefined;
      },
    );
    setQueue(h, [
      {
        action: 'TransactionEvent',
        payload: { idToken: { idToken: 'X' }, transactionInfo: { transactionId: 'T' } },
      },
    ]);
    await replay(h);
    expect(priv(h, 'offlineMessageQueue')).toEqual([]);
    expect((call(h, 'cachedIdTokenInfo', 'X') as Record<string, unknown>)['status']).toBe(
      'Invalid',
    );
    expect(h.sent('TransactionEvent').some((e) => e['eventType'] === 'Ended')).toBe(false);
  });
});

const ENERGY = 'Energy.Active.Import.Register';

async function chargingHarness(
  configure: (h: Harness) => void = () => {},
): Promise<{ h: Harness; txId: string }> {
  const h = await liveHarness('ocpp2.1');
  h.sim.setConfigValue('SampledDataCtrlr.TxUpdatedInterval', '10');
  configure(h);
  await h.sim.plugIn(1);
  const txId = await h.sim.startCharging(1, 'TAG-1');
  return { h, txId };
}

describe('transaction limits in the meter loop (2.1)', () => {
  it('a driver-set energy limit is reported with LimitSet and reached', async () => {
    const { h, txId } = await chargingHarness((s) => {
      s.sim.setConfigValue('TxCtrlr.MaxEnergyLimit', '0');
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(txEvents(h, 'LimitSet')[0]).toMatchObject({
      transactionInfo: { transactionId: txId, transactionLimit: { maxEnergy: 0 } },
    });
    expect(txEvents(h, 'EnergyLimitReached')[0]).toMatchObject({
      transactionInfo: { chargingState: 'SuspendedEVSE' },
    });
    expect((priv(h, 'meterTimers') as Map<number, unknown>).has(1)).toBe(false);
  });

  it('the driver limit merges with the CSMS limit to the most restrictive', async () => {
    const { h } = await chargingHarness();
    (priv(h, 'evseTransactionLimits') as Map<number, Record<string, number>>).set(1, {
      maxEnergy: 5000,
      maxTime: 600,
      maxCost: 2,
    });
    h.sim.setConfigValue('TxCtrlr.MaxEnergyLimit', '9000');
    h.sim.setConfigValue('TxCtrlr.MaxTimeLimit', '300');
    h.sim.setConfigValue('TxCtrlr.MaxCostLimit', '5');
    await vi.advanceTimersByTimeAsync(10_000);
    const info = txEvents(h, 'LimitSet').at(-1)?.['transactionInfo'] as Record<string, unknown>;
    expect(info['transactionLimit']).toEqual({
      maxEnergy: 5000,
      maxTime: 300,
      maxCost: 2,
    });
  });

  it('a time limit is reached once the transaction ran that long', async () => {
    const { h } = await chargingHarness((s) => {
      s.sim.setConfigValue('TxCtrlr.MaxTimeLimit', '25');
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(txEvents(h, 'TimeLimitReached')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(txEvents(h, 'TimeLimitReached')).toHaveLength(1);
  });

  it('a cost limit reached by the cost from CSMS', async () => {
    const { h } = await chargingHarness((s) => {
      s.sim.setConfigValue('TxCtrlr.MaxCostLimit', '1');
    });
    (priv(h, 'evseTotalCost') as Map<number, number>).set(1, 1.5);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(txEvents(h, 'CostLimitReached')).toHaveLength(1);
  });

  it('energy delivered after a rejected idToken suspends the EVSE at the allowance', async () => {
    const { h, txId } = await chargingHarness();
    (priv(h, 'evseInvalidIdMaxEnergy') as Map<number, number>).set(1, 0);
    await vi.advanceTimersByTimeAsync(10_000);
    const suspended = txEvents(h, 'ChargingStateChanged').filter(
      (e) => (e['transactionInfo'] as Record<string, unknown>)['chargingState'] === 'SuspendedEVSE',
    );
    expect(suspended[0]).toMatchObject({ transactionInfo: { transactionId: txId } });
    expect((priv(h, 'evseInvalidIdMaxEnergy') as Map<number, number>).has(1)).toBe(false);
  });

  it('the first tick moves EVConnected to Charging', async () => {
    const { h, txId } = await chargingHarness();
    (priv(h, 'evseChargingState') as Map<number, string>).set(1, 'EVConnected');
    h.sendCall.mockClear();
    call(h, 'startMeterLoop', 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(txEvents(h, 'ChargingStateChanged')[0]).toMatchObject({
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
    });
  });

  it('the meter loop does not start on a stopped simulator', async () => {
    const h = await makeHarness();
    h.p['destroyed'] = true;
    call(h, 'startMeterLoop', 1);
    expect((priv(h, 'meterTimers') as Map<number, unknown>).size).toBe(0);
  });
});

describe('local cost calculation (E16.FR.16)', () => {
  const tariff = {
    tariffId: 'T-1',
    currency: 'SEK',
    energy: { prices: [{ priceKwh: 2 }] },
    chargingTime: { prices: [{ priceMinute: 0.5 }] },
  };

  it('sends RunningCost with the tariff currency as the cost grows', async () => {
    const { h, txId } = await chargingHarness((s) => {
      void s.invoke('SetDefaultTariff', { evseId: 0, tariff });
    });
    await vi.advanceTimersByTimeAsync(120_000);
    const running = txEvents(h, 'RunningCost');
    expect(running.length).toBeGreaterThan(1);
    const last = running.at(-1);
    expect(last).toMatchObject({
      transactionInfo: { transactionId: txId },
      costDetails: { currency: 'SEK' },
    });
    const costs = running.map(
      (e) => (e['costDetails'] as Record<string, number>)['totalCost'] as number,
    );
    expect(costs.at(-1)).toBeGreaterThanOrEqual(1);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
  });

  it('a cost limit is reached on the locally calculated cost', async () => {
    const { h } = await chargingHarness((s) => {
      void s.invoke('SetDefaultTariff', { evseId: 1, tariff: { ...tariff, tariffId: 'T-2' } });
      s.sim.setConfigValue('TxCtrlr.MaxCostLimit', '0.5');
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(txEvents(h, 'CostLimitReached')).toHaveLength(1);
  });
});

describe('signed meter values (J02)', () => {
  it('signs periodic readings and adds the public key once per transaction', async () => {
    const { h } = await chargingHarness((s) => {
      s.sim.setConfigValue('SampledDataCtrlr.TxUpdatedMeasurands', ENERGY);
      s.sim.setConfigValue('SampledDataCtrlr.SignReadings', 'true');
      s.sim.setConfigValue('OCPPCommCtrlr.PublicKeyWithSignedMeterValue', 'OncePerTransaction');
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const signed = txEvents(h)
      .flatMap((e) => (e['meterValue'] as Array<{ sampledValue: unknown[] }> | undefined) ?? [])
      .flatMap((mv) => mv.sampledValue as Array<Record<string, unknown>>)
      .map((sv) => sv['signedMeterValue'] as Record<string, string> | undefined);
    expect(signed.length).toBeGreaterThan(1);
    expect(signed.every((s) => s?.['signingMethod'] != null && s['signedMeterData'] !== '')).toBe(
      true,
    );
    expect(signed.filter((s) => s?.['publicKey'] !== '')).toHaveLength(1);
  });

  it('adds the public key to every value with EveryMeterValue', async () => {
    const { h } = await chargingHarness((s) => {
      s.sim.setConfigValue('SampledDataCtrlr.TxUpdatedMeasurands', ENERGY);
      s.sim.setConfigValue('SampledDataCtrlr.SignReadings', 'true');
      s.sim.setConfigValue('OCPPCommCtrlr.PublicKeyWithSignedMeterValue', 'EveryMeterValue');
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const keys = txEvents(h, 'MeterValuePeriodic')
      .flatMap((e) => (e['meterValue'] as Array<{ sampledValue: unknown[] }>)[0]?.sampledValue)
      .map((sv) => (sv as { signedMeterValue: { publicKey: string } }).signedMeterValue.publicKey);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.length > 0)).toBe(true);
  });
});

describe('TxEnded meter data (J02.FR.11)', () => {
  it('collects periodic and clock readings for the Ended event', async () => {
    const { h, txId } = await chargingHarness((s) => {
      s.sim.setConfigValue('SampledDataCtrlr.TxEndedInterval', '20');
      s.sim.setConfigValue('SampledDataCtrlr.TxEndedMeasurands', ENERGY);
      s.sim.setConfigValue('AlignedDataCtrlr.TxEndedInterval', '30');
      s.sim.setConfigValue('AlignedDataCtrlr.TxEndedMeasurands', ENERGY);
    });
    await vi.advanceTimersByTimeAsync(95_000);
    await h.sim.stopCharging(1, 'Local');
    const ended = h.sent('TransactionEvent').find((e) => e['eventType'] === 'Ended');
    expect(ended).toMatchObject({ transactionInfo: { transactionId: txId } });
    const contexts = (
      ended?.['meterValue'] as Array<{ sampledValue: Array<{ context: string }> }>
    ).map((mv) => mv.sampledValue[0]?.context);
    expect(contexts.filter((c) => c === 'Sample.Periodic').length).toBeGreaterThanOrEqual(4);
    expect(contexts.filter((c) => c === 'Sample.Clock').length).toBeGreaterThanOrEqual(3);
  });

  it('records nothing without measurands', async () => {
    const { h } = await chargingHarness((s) => {
      s.sim.setConfigValue('SampledDataCtrlr.TxEndedInterval', '20');
      s.sim.setConfigValue('SampledDataCtrlr.TxEndedMeasurands', '');
    });
    await vi.advanceTimersByTimeAsync(45_000);
    expect((priv(h, 'evseTxEndedMeterValues') as Map<number, unknown[]>).get(1)).toEqual([]);
  });
});

describe('state loaded from the database', () => {
  it('rebuilds reservations, auth data, profiles, messages and running transactions', async () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    const sql = stubSql((q) => {
      if (q.includes('FROM css_reservations')) {
        return [
          { reservation_id: 1, evse_id: 1, id_token: 'R1', expiry_date_time: future },
          { reservation_id: 2, evse_id: 1, id_token: 'R2', expiry_date_time: past },
        ];
      }
      if (q.includes('FROM css_local_auth_entries')) {
        return [
          {
            id_token: 'LA1',
            token_type: 'ISO14443',
            auth_status: 'Accepted',
            list_version: 4,
            entry_data: { groupIdToken: { idToken: 'GRP', type: 'Central' } },
          },
          {
            id_token: 'LA2',
            token_type: null,
            auth_status: 'Blocked',
            list_version: 2,
            entry_data: null,
          },
        ];
      }
      if (q.includes('FROM css_auth_cache')) {
        return [
          { id_token: 'C1', id_token_info: { status: 'Accepted' }, cached_at: new Date() },
          { id_token: 'C2', id_token_info: { status: 'Accepted' }, cached_at: new Date(0) },
        ];
      }
      if (q.includes('FROM css_charging_profiles')) {
        return [{ profile_id: 9, evse_id: 1, profile_data: { id: 9, stackLevel: 0 } }];
      }
      if (q.includes('FROM css_display_messages')) {
        return [{ message_id: 3, message_data: { id: 3, priority: 'NormalCycle' } }];
      }
      if (q.includes('preserved_at IS NOT NULL')) return [];
      if (q.includes('SELECT evse_id, transaction_id, id_token, token_type')) {
        return [
          { evse_id: 1, transaction_id: 'TX-DB', id_token: 'LA1', token_type: 'ISO14443' },
          { evse_id: 7, transaction_id: 'TX-NONE', id_token: null, token_type: null },
        ];
      }
      return undefined;
    });
    const h = await makeHarness({ sql });

    const reservations = priv(h, 'reservations') as Map<number, unknown>;
    expect([...reservations.keys()]).toEqual([1]);
    expect((priv(h, 'reservationTimers') as Map<number, unknown>).has(1)).toBe(true);

    expect(priv(h, 'localAuthListVersion')).toBe(4);
    const entries = priv(h, 'localAuthEntries') as Map<string, Record<string, unknown>>;
    expect(entries.get('LA1')).toMatchObject({ authStatus: 'Accepted', tokenType: 'ISO14443' });
    expect(entries.get('LA2')).toEqual({ authStatus: 'Blocked' });
    expect((priv(h, 'tokenGroupMap') as Map<string, unknown>).get('LA1')).toEqual({
      idToken: 'GRP',
      type: 'Central',
    });

    expect(call(h, 'cachedIdTokenInfo', 'C1')).toEqual({ status: 'Accepted' });
    expect(call(h, 'cachedIdTokenInfo', 'C2')).toBeUndefined();
    expect((priv(h, 'chargingProfilesCache') as Map<number, unknown>).get(9)).toMatchObject({
      _evseId: 1,
    });
    expect((priv(h, 'displayMessagesCache') as Map<number, unknown>).has(3)).toBe(true);

    expect(ctxOf(h)).toMatchObject({
      transactionId: 'TX-DB',
      authorizedToken: 'LA1',
      cablePlugged: true,
      state: 'Occupied',
    });
    expect(
      (priv(h, 'transactionStartTokens') as Map<string, Record<string, unknown>>).get('TX-DB'),
    ).toEqual({ idToken: 'LA1', groupIdToken: { idToken: 'GRP', type: 'Central' } });
  });

  it('logs a failed transaction rebuild and keeps the EVSE idle', async () => {
    const sql = failingSql((q) =>
      q.includes('SELECT evse_id, transaction_id, id_token, token_type'),
    );
    const h = await makeHarness({ sql });
    expect(ctxOf(h)['transactionId']).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('evseContexts rebuild failed'),
      'db down',
    );
  });
});

describe('database write failures are logged, not thrown', () => {
  it('station, EVSE and transaction writes', async () => {
    const sql = failingSql((q) =>
      /css_stations SET status|UPDATE css_evses|INSERT INTO css_transactions|SET status = 'completed'/.test(
        q,
      ),
    );
    const h = await makeHarness({ sql, boot: true });
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    await h.sim.stopCharging(1, 'Local');
    const errors = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (c) => String(c[0]),
    );
    expect(errors.some((e) => e.includes('Failed to update station status: db down'))).toBe(true);
    expect(errors.some((e) => e.includes('Failed to update EVSE status: db down'))).toBe(true);
    expect(errors.some((e) => e.includes('Failed to create transaction: db down'))).toBe(true);
  });

  it('a failed transaction lookup counts as no transaction', async () => {
    const sql = failingSql((q) => q.includes('FROM css_transactions') && q.includes('SELECT'));
    const h = await makeHarness({ sql });
    expect(await call(h, 'getActiveTransaction', 1)).toBeNull();
    expect(await call(h, 'findEvseForTransaction', 'T')).toBeNull();
    expect(await call(h, 'hasAnyActiveTransaction')).toBe(false);
  });

  it('a failed completion is logged', async () => {
    const sql = failingSql((q) => q.includes("SET status = 'completed'"));
    const h = await makeHarness({ sql });
    await call(h, 'completeTransaction', 'TX', 'Local', 10);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to complete transaction: db down'),
    );
  });

  it('a failed offline queue write and delete are logged', async () => {
    const sql = failingSql((q) => q.includes('css_offline_messages') && !q.includes('SELECT'));
    const h = await makeHarness({ sql });
    call(h, 'queueOfflineMessage', 'Heartbeat', {});
    expect(call(h, 'dequeueOfflineMessage')).toMatchObject({ action: 'Heartbeat' });
    expect(call(h, 'dequeueOfflineMessage')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('offline queue enqueue failed'),
      'db down',
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('offline queue dequeue failed'),
      'db down',
    );
  });
});

type ClientHooks = {
  onConnectedCallback: () => void;
  onDisconnectedCallback: () => void;
  onIncomingCall: (id: string, action: string, payload: Record<string, unknown>) => unknown;
  reconnectBackOff: () => { waitMinimumMs: number; randomRangeMs: number; repeatTimes: number };
  onServerCertificateRejected: (err: Error) => void;
  onTlsVersionRejected: (err: Error) => void;
};

function hooks(h: Harness): ClientHooks {
  return h.sim.client as unknown as ClientHooks;
}

describe('connection callbacks', () => {
  it('a disconnect records the offline start and statuses once', async () => {
    const { sql, log } = recordingSql();
    const h = await makeHarness({ sql, boot: true });
    hooks(h).onDisconnectedCallback();
    const since = h.p['offlineSince'];
    expect(since).toEqual(expect.any(Number));
    vi.setSystemTime(Date.now() + 5000);
    hooks(h).onDisconnectedCallback();
    expect(h.p['offlineSince']).toBe(since);
    expect(h.p['statusesAtDisconnect']).toBeInstanceOf(Map);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      log.some((l) => l.q.includes('UPDATE css_stations') && l.values[0] === 'disconnected'),
    ).toBe(true);
    expect(h.sim.isReady()).toBe(false);
  });

  it('2.1: the reconnect back-off follows OCPPCommCtrlr.RetryBackOff*', async () => {
    const h = await makeHarness();
    h.sim.setConfigValue('OCPPCommCtrlr.RetryBackOffWaitMinimum', '7');
    h.sim.setConfigValue('OCPPCommCtrlr.RetryBackOffRandomRange', '-1');
    h.sim.setConfigValue('OCPPCommCtrlr.RetryBackOffRepeatTimes', '3');
    const backOff = hooks(h).reconnectBackOff();
    expect(backOff.waitMinimumMs).toBe(7000);
    expect(backOff.repeatTimes).toBe(3);
    expect(backOff.randomRangeMs).toBeGreaterThanOrEqual(0);
  });

  it('incoming calls go to the command handler', async () => {
    const h = await makeHarness();
    h.p['localAuthListVersion'] = 6;
    expect(await hooks(h).onIncomingCall('m1', 'GetLocalListVersion', {})).toEqual({
      versionNumber: 6,
    });
  });

  it('a rejected server certificate queues a security event per protocol', async () => {
    const h21 = await makeHarness();
    hooks(h21).onServerCertificateRejected(new Error('bad cert'));
    hooks(h21).onTlsVersionRejected(new Error('TLSv1.1'));
    const q21 = priv(h21, 'offlineMessageQueue') as QueueItem[];
    expect(q21.map((m) => m.payload['type'])).toEqual([
      'InvalidCsmsCertificate',
      'InvalidTLSVersion',
    ]);
    expect(q21[0]?.payload['techInfo']).toBe('bad cert');

    const h16 = await makeHarness({ protocol: 'ocpp1.6' });
    hooks(h16).onServerCertificateRejected(new Error('bad cert'));
    hooks(h16).onTlsVersionRejected(new Error('TLSv1.1'));
    const q16 = priv(h16, 'offlineMessageQueue') as QueueItem[];
    expect(q16.map((m) => m.payload['type'])).toEqual(['InvalidCentralSystemCertificate']);
  });

  it('the first successful connection after a failed start runs the boot', async () => {
    const h = await makeHarness();
    setQueue(h, [{ action: 'SecurityEventNotification', payload: { type: 'X' } }]);
    hooks(h).onConnectedCallback();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent('BootNotification')[0]?.['reason']).toBe('PowerUp');
    expect(h.p['initialBootDone']).toBe(true);
    expect(h.sent('SecurityEventNotification').map((p) => p['type'])).toContain('X');
  });

  it('a failed boot after reconnect is logged', async () => {
    const h = await makeHarness({
      respond: (action) => {
        if (action === 'BootNotification') throw new Error('refused');
        return undefined;
      },
    });
    await reconnect(h);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Boot after reconnect failed: refused'),
    );
  });

  it('a failed reboot sequence on reconnect is logged', async () => {
    const h = await liveHarness('ocpp2.1');
    h.p['rebootOnReconnect'] = true;
    h.sendCall.mockImplementation(async (action: string) => {
      if (action === 'BootNotification') throw new Error('refused');
      return {};
    });
    await reconnect(h);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Reconnect startup failed: refused'),
    );
  });

  it('a failed resume after a connection loss is logged', async () => {
    const h = await liveHarness('ocpp2.1');
    h.p['statusesAtDisconnect'] = new Map();
    h.sendCall.mockImplementation(async (action: string) => {
      if (action === 'StatusNotification') throw new Error('lost again');
      return {};
    });
    await reconnect(h);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Resume after connection loss failed: lost again'),
    );
  });

  it('a failed StartupOfTheDevice security event is logged and the boot continues', async () => {
    const h = await makeHarness({
      boot: true,
      respond: (action) => {
        if (action === 'SecurityEventNotification') throw new Error('nope');
        return undefined;
      },
    });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('StartupOfTheDevice security event failed: nope'),
    );
    expect(h.sim.getBootStatus()).toBe('Accepted');
  });
});
