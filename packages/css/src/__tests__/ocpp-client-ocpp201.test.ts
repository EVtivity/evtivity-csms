// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { OcppClient } from '../ocpp-client.js';
import { assertOcpp201 } from './ocpp201-schema.js';

interface Peer {
  client: OcppClient;
  socket: WebSocket;
  protocol: string;
}

const cleanups: Array<() => Promise<void>> = [];

async function connected201(): Promise<Peer> {
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    handleProtocols: (p) => [...p][0] ?? false,
  });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const address = wss.address();
  if (address == null || typeof address === 'string') throw new Error('no address');
  cleanups.push(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  const socketPromise = new Promise<WebSocket>((resolve) => wss.once('connection', resolve));
  const client = new OcppClient({
    serverUrl: `ws://127.0.0.1:${String(address.port)}`,
    stationId: 'CS-201',
    ocppProtocol: 'ocpp2.0.1',
    securityProfile: 0,
  });
  client.setDisconnectedHandler(() => {});
  cleanups.push(() => {
    client.disconnect();
    return Promise.resolve();
  });
  await client.connect();
  const socket = await socketPromise;
  return { client, socket, protocol: socket.protocol };
}

function nextFrame(socket: WebSocket): Promise<unknown[]> {
  return new Promise((resolve) => {
    socket.once('message', (data: Buffer) => resolve(JSON.parse(data.toString()) as unknown[]));
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

describe('OcppClient on OCPP 2.0.1', () => {
  it('offers the ocpp2.0.1 subprotocol', async () => {
    const { client, protocol } = await connected201();
    expect(protocol).toBe('ocpp2.0.1');
    expect(client.protocol).toBe('ocpp2.0.1');
  });

  it('sends a 2.1 TransactionEvent in its 2.0.1 form', async () => {
    const { client, socket } = await connected201();
    const frame = nextFrame(socket);
    const reply = client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'LimitSet',
      seqNo: 1,
      evseSleep: false,
      transactionInfo: { transactionId: 'tx-1', transactionLimit: { maxCost: 5 } },
    });
    const call = await frame;
    const payload = call[3] as Record<string, unknown>;
    assertOcpp201('TransactionEvent', 'request', payload);
    expect(payload['triggerReason']).toBe('ChargingRateChanged');
    socket.send(JSON.stringify([3, call[1], {}]));
    await expect(reply).resolves.toEqual({});
  });

  it('never sends a 2.1-only message', async () => {
    const { client, socket } = await connected201();
    const frames: unknown[] = [];
    socket.on('message', (d: Buffer) => frames.push(JSON.parse(d.toString())));
    await expect(client.sendCall('NotifySettlement', { pspRef: 'x' })).rejects.toThrow(
      'NotifySettlement is not defined in OCPP 2.0.1',
    );
    expect(client.sendSend('NotifyPeriodicEventStream', { id: 1 })).toBe(false);
    await expect(
      client.sendCall('Authorize', { idToken: { idToken: 'V1', type: 'VIN' } }),
    ).rejects.toThrow(/VIN does not exist in OCPP 2.0.1/);
    await new Promise((r) => setTimeout(r, 50));
    expect(frames).toEqual([]);
  });

  it('resolves without sending when nothing of the message exists in 2.0.1', async () => {
    const { client } = await connected201();
    await expect(
      client.sendCall('MeterValues', {
        evseId: 1,
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: [{ value: 1, measurand: 'Power.Active.Setpoint' }],
          },
        ],
      }),
    ).resolves.toEqual({});
  });

  it('answers a 2.1-only CSMS call with NotImplemented without calling the handler', async () => {
    const { client, socket } = await connected201();
    const handler = vi.fn(() => Promise.resolve({ status: 'Accepted' }));
    client.setIncomingCallHandler(handler);
    const frame = nextFrame(socket);
    socket.send(JSON.stringify([2, 'm1', 'SetDefaultTariff', { evseId: 0, tariff: {} }]));
    expect(await frame).toEqual([
      4,
      'm1',
      'NotImplemented',
      'SetDefaultTariff is not defined in OCPP 2.0.1',
      {},
    ]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers a CSMS call in its 2.0.1 form', async () => {
    const { client, socket } = await connected201();
    client.setIncomingCallHandler(() =>
      Promise.resolve({ status: 'LanguageNotSupported', statusInfo: { reasonCode: 'Lang' } }),
    );
    const frame = nextFrame(socket);
    socket.send(
      JSON.stringify([
        2,
        'm2',
        'SetDisplayMessage',
        { message: { id: 1, priority: 'NormalCycle', message: { format: 'UTF8', content: 'Hi' } } },
      ]),
    );
    const result = await frame;
    expect(result[0]).toBe(3);
    assertOcpp201('SetDisplayMessage', 'response', result[2] as Record<string, unknown>);
    expect(result[2]).toEqual({ status: 'Rejected', statusInfo: { reasonCode: 'Lang' } });
  });
});
