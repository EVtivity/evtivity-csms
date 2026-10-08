// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { liveHarness, priv, silenceConsole, type Harness, type Protocol } from './sim-harness.js';

// goOffline and comeOnline: the station loses the connection, not power. The
// transaction, the cable and the EVSE state stay; the transaction messages of
// the offline period queue and replay in order after the reconnect, without a
// BootNotification (1.6 3.7, 2.1 B04 and E11).

interface Link {
  h: Harness;
  /** Messages the CSMS received (sent while connected), in order. */
  delivered: Array<[string, Record<string, unknown>]>;
}

async function chargingStation(protocol: Protocol): Promise<Link> {
  const delivered: Link['delivered'] = [];
  let connected = true;
  const h = await liveHarness(protocol, (action, payload) => {
    if (!connected) throw new Error('Not connected');
    delivered.push([action, structuredClone(payload)]);
    return undefined;
  });
  const client = h.sim.client as unknown as Record<string, unknown>;
  client['isConnected'] = true;
  client['disconnect'] = vi.fn(() => {
    connected = false;
    client['isConnected'] = false;
  });
  client['connect'] = vi.fn(async () => {
    connected = true;
    client['isConnected'] = true;
  });
  h.sim.setConfigValue(
    protocol === 'ocpp1.6' ? 'MeterValueSampleInterval' : 'SampledDataCtrlr.TxUpdatedInterval',
    '30',
  );
  await h.sim.plugIn(1);
  await h.sim.startCharging(1, 'TAG-1');
  delivered.length = 0;
  return { h, delivered };
}

function actions(link: Link): string[] {
  return link.delivered.map(([a]) => a);
}

function payloads(link: Link, action: string): Array<Record<string, unknown>> {
  return link.delivered.filter(([a]) => a === action).map(([, p]) => p);
}

function infoOf(e: Record<string, unknown> | undefined): Record<string, unknown> {
  return (e?.['transactionInfo'] as Record<string, unknown> | undefined) ?? {};
}

function ctxOf(h: Harness): Record<string, unknown> {
  return (priv(h, 'evseContexts') as Map<number, Record<string, unknown>>).get(1) ?? {};
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T10:00:00.000Z'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('goOffline and comeOnline (2.1)', () => {
  it('keeps the transaction and resumes it online without a boot', async () => {
    const link = await chargingStation('ocpp2.1');
    const txId = ctxOf(link.h)['transactionId'];
    await link.h.sim.goOffline();
    await vi.advanceTimersByTimeAsync(65_000);
    expect(link.delivered).toHaveLength(0);
    expect(ctxOf(link.h)).toMatchObject({ transactionId: txId, cablePlugged: true });

    await link.h.sim.comeOnline();
    expect(actions(link)).not.toContain('BootNotification');
    // Offline longer than OfflineThreshold: every connector reports its real
    // state (B04.FR.01), still Occupied, never a cold-boot Available.
    expect(payloads(link, 'StatusNotification')).toEqual([
      expect.objectContaining({ evseId: 1, connectorStatus: 'Occupied' }),
    ]);
    const replayed = payloads(link, 'TransactionEvent');
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((e) => e['offline'] === true)).toBe(true);
    expect(ctxOf(link.h)['transactionId']).toBe(txId);

    // Back online the transaction goes on: new events are not offline.
    link.delivered.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    const live = payloads(link, 'TransactionEvent');
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((e) => e['offline'] == null)).toBe(true);
    expect(infoOf(live[0])['transactionId']).toBe(txId);
  });

  it('replays suspend, resume, stop and unplug in order with offline, seqNo and event timestamps', async () => {
    const link = await chargingStation('ocpp2.1');
    const t0 = Date.now();
    await link.h.sim.goOffline();
    await vi.advanceTimersByTimeAsync(10_000);
    await link.h.sim.suspendCharging(1, 'EV');
    const tSuspend = Date.now();
    await vi.advanceTimersByTimeAsync(40_000);
    await link.h.sim.resumeCharging(1);
    const tResume = Date.now();
    await vi.advanceTimersByTimeAsync(20_000);
    await link.h.sim.stopCharging(1, 'Local');
    const tStop = Date.now();
    await vi.advanceTimersByTimeAsync(5_000);
    await link.h.sim.unplug(1);
    expect(link.delivered).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);
    await link.h.sim.comeOnline();

    expect(actions(link)).not.toContain('BootNotification');
    // The real connector state first (Available after the unplug), then the queue.
    expect(actions(link)[0]).toBe('StatusNotification');
    expect(payloads(link, 'StatusNotification')).toEqual([
      expect.objectContaining({ evseId: 1, connectorStatus: 'Available' }),
    ]);
    const events = payloads(link, 'TransactionEvent');
    expect(events.every((e) => e['offline'] === true)).toBe(true);

    // seqNo continues from the last delivered event, one by one.
    const seqNos = events.map((e) => e['seqNo'] as number);
    expect(seqNos[0]).toBeGreaterThan(0);
    seqNos.forEach((n, i) => {
      if (i > 0) expect(n).toBe((seqNos[i - 1] as number) + 1);
    });

    // Timestamps are when each event happened, not the replay time.
    const stamps = events.map((e) => Date.parse(e['timestamp'] as string));
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
    expect(stamps.every((s) => s >= t0 && s <= tStop)).toBe(true);

    const changes = events.filter((e) => e['triggerReason'] === 'ChargingStateChanged');
    expect(changes.map((e) => infoOf(e)['chargingState'])).toEqual(['SuspendedEV', 'Charging']);
    expect(changes.map((e) => e['timestamp'])).toEqual([iso(tSuspend), iso(tResume)]);

    const ended = events.at(-1);
    expect(ended?.['eventType']).toBe('Ended');
    expect(ended?.['timestamp']).toBe(iso(tStop));
    expect(infoOf(ended)['stoppedReason']).toBe('Local');
    // Periodic meter values of the offline period are part of the queue.
    expect(events.some((e) => e['triggerReason'] === 'MeterValuePeriodic')).toBe(true);
    expect(ctxOf(link.h)).toMatchObject({ transactionId: null, cablePlugged: false });
  });

  it('an unplug while offline ends the transaction with EVDisconnected', async () => {
    const link = await chargingStation('ocpp2.1');
    await link.h.sim.goOffline();
    await vi.advanceTimersByTimeAsync(5_000);
    await link.h.sim.unplug(1);
    const tUnplug = Date.now();
    await link.h.sim.comeOnline();
    const ended = payloads(link, 'TransactionEvent').at(-1);
    expect(ended).toMatchObject({ eventType: 'Ended', offline: true, timestamp: iso(tUnplug) });
    expect(infoOf(ended)['stoppedReason']).toBe('EVDisconnected');
  });
});

describe('goOffline and comeOnline (1.6)', () => {
  it('keeps the transaction and reports no Available or boot on the reconnect', async () => {
    const link = await chargingStation('ocpp1.6');
    const txId = ctxOf(link.h)['transactionId'];
    await link.h.sim.goOffline();
    await vi.advanceTimersByTimeAsync(65_000);
    await link.h.sim.comeOnline();
    expect(actions(link)).not.toContain('BootNotification');
    expect(actions(link)).not.toContain('StatusNotification');
    const meter = payloads(link, 'MeterValues');
    expect(meter.length).toBeGreaterThan(0);
    expect(meter.every((m) => m['transactionId'] === Number(txId))).toBe(true);
    expect(ctxOf(link.h)).toMatchObject({ transactionId: txId, cablePlugged: true });
  });

  it('replays MeterValues and StopTransaction in order with their timestamps, then the status', async () => {
    const link = await chargingStation('ocpp1.6');
    const t0 = Date.now();
    await link.h.sim.goOffline();
    await vi.advanceTimersByTimeAsync(10_000);
    await link.h.sim.suspendCharging(1, 'EV');
    await vi.advanceTimersByTimeAsync(40_000);
    await link.h.sim.resumeCharging(1);
    await vi.advanceTimersByTimeAsync(20_000);
    await link.h.sim.stopCharging(1, 'Local');
    const tStop = Date.now();
    await vi.advanceTimersByTimeAsync(5_000);
    await link.h.sim.unplug(1);
    expect(link.delivered).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);
    await link.h.sim.comeOnline();

    const order = actions(link);
    expect(order).not.toContain('BootNotification');
    // 1.6 sends the queued transaction messages first (OCTT TC_037_1), then
    // the statuses that changed while offline.
    const stopAt = order.indexOf('StopTransaction');
    expect(stopAt).toBeGreaterThan(0);
    expect(order.slice(0, stopAt).every((a) => a === 'MeterValues')).toBe(true);
    expect(order.slice(stopAt + 1)).toEqual(['StatusNotification']);
    expect(payloads(link, 'StatusNotification')[0]).toMatchObject({
      connectorId: 1,
      status: 'Available',
    });

    const stamps = payloads(link, 'MeterValues').map((m) =>
      Date.parse((m['meterValue'] as Array<{ timestamp: string }>)[0]?.timestamp ?? ''),
    );
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
    expect(stamps.every((s) => s >= t0 && s <= tStop)).toBe(true);
    expect(payloads(link, 'StopTransaction')[0]).toMatchObject({
      reason: 'Local',
      timestamp: iso(tStop),
    });
  });

  it('an unplug while offline queues StopTransaction with EVDisconnected', async () => {
    const link = await chargingStation('ocpp1.6');
    await link.h.sim.goOffline();
    await vi.advanceTimersByTimeAsync(5_000);
    await link.h.sim.unplug(1);
    const tUnplug = Date.now();
    await link.h.sim.comeOnline();
    expect(payloads(link, 'StopTransaction')).toEqual([
      expect.objectContaining({ reason: 'EVDisconnected', timestamp: iso(tUnplug) }),
    ]);
    expect(payloads(link, 'StatusNotification').at(-1)).toMatchObject({ status: 'Available' });
  });

  it('a transaction message waits behind the queue instead of overtaking it', async () => {
    const link = await chargingStation('ocpp1.6');
    await link.h.sim.goOffline();
    await vi.advanceTimersByTimeAsync(35_000);
    const client = link.h.sim.client as unknown as Record<string, unknown>;
    client['isConnected'] = true;
    // Online again but the queue is not drained yet: the stop joins the queue.
    await link.h.sim.stopCharging(1, 'Local');
    expect(payloads(link, 'StopTransaction')).toEqual([]);
    const queue = priv(link.h, 'offlineMessageQueue') as Array<{ action: string }>;
    expect(queue.at(-1)?.action).toBe('StopTransaction');
  });
});

describe('1.6 StartTransaction sent while offline', () => {
  const CSMS_TX_ID = 4242;

  // Plugged in online, then offline before the start: StartTransaction queues
  // with a temporary local transaction id (1.6 3.7).
  async function offlineStart(): Promise<Link & { localTxId: string }> {
    const delivered: Link['delivered'] = [];
    let connected = true;
    const h = await liveHarness('ocpp1.6', (action, payload) => {
      if (!connected) throw new Error('Not connected');
      delivered.push([action, structuredClone(payload)]);
      if (action === 'StartTransaction') {
        return { transactionId: CSMS_TX_ID, idTagInfo: { status: 'Accepted' } };
      }
      return undefined;
    });
    const client = h.sim.client as unknown as Record<string, unknown>;
    client['isConnected'] = true;
    client['disconnect'] = vi.fn(() => {
      connected = false;
      client['isConnected'] = false;
    });
    client['connect'] = vi.fn(async () => {
      connected = true;
      client['isConnected'] = true;
    });
    h.sim.setConfigValue('MeterValueSampleInterval', '30');
    h.sim.setConfigValue('AllowOfflineTxForUnknownId', 'true');
    await h.sim.plugIn(1);
    await h.sim.goOffline();
    await h.sim.startCharging(1, 'TAG-1');
    delivered.length = 0;
    const localTxId = ctxOf(h)['transactionId'] as string;
    return { h, delivered, localTxId };
  }

  it('rewrites the queued MeterValues and StopTransaction to the CSMS transaction id', async () => {
    const link = await offlineStart();
    expect(link.localTxId).not.toBe(String(CSMS_TX_ID));
    await vi.advanceTimersByTimeAsync(65_000);
    await link.h.sim.stopCharging(1, 'Local');
    expect(link.delivered).toHaveLength(0);
    const queue = priv(link.h, 'offlineMessageQueue') as Array<{
      action: string;
      payload: Record<string, unknown>;
    }>;
    expect(queue.some((m) => m.payload['transactionId'] === Number(link.localTxId))).toBe(true);

    await link.h.sim.comeOnline();

    const order = actions(link);
    expect(order[0]).toBe('StartTransaction');
    expect(payloads(link, 'StartTransaction')[0]).not.toHaveProperty('transactionId');
    const meter = payloads(link, 'MeterValues');
    expect(meter.length).toBeGreaterThan(0);
    expect(meter.every((m) => m['transactionId'] === CSMS_TX_ID)).toBe(true);
    expect(payloads(link, 'StopTransaction')).toEqual([
      expect.objectContaining({ transactionId: CSMS_TX_ID, reason: 'Local' }),
    ]);
  });

  it('continues a running transaction under the CSMS transaction id', async () => {
    const link = await offlineStart();
    await vi.advanceTimersByTimeAsync(35_000);
    await link.h.sim.comeOnline();
    expect(ctxOf(link.h)['transactionId']).toBe(String(CSMS_TX_ID));
    expect((priv(link.h, 'activeTransactionIds') as Map<number, string>).get(1)).toBe(
      String(CSMS_TX_ID),
    );
    expect(payloads(link, 'MeterValues').every((m) => m['transactionId'] === CSMS_TX_ID)).toBe(
      true,
    );

    link.delivered.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    await link.h.sim.stopCharging(1, 'Local');
    const live = payloads(link, 'MeterValues');
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((m) => m['transactionId'] === CSMS_TX_ID)).toBe(true);
    expect(payloads(link, 'StopTransaction')).toEqual([
      expect.objectContaining({ transactionId: CSMS_TX_ID }),
    ]);
  });
});

describe('comeOnline before the first boot', () => {
  it('boots from power-up when the station never finished booting', async () => {
    const link = await chargingStation('ocpp2.1');
    link.h.p['initialBootDone'] = false;
    link.h.p['offlineFlag'] = true;
    await link.h.sim.comeOnline();
    expect(payloads(link, 'BootNotification')[0]).toMatchObject({ reason: 'PowerUp' });
  });
});
