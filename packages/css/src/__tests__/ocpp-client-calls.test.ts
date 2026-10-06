// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import { OcppClient, type OcppClientOptions } from '../ocpp-client.js';

interface Server {
  wss: WebSocketServer;
  port: number;
  sockets: WebSocket[];
  requests: IncomingMessage[];
  nextSocket(): Promise<WebSocket>;
}

const cleanups: Array<() => Promise<void>> = [];

async function startServer(port = 0): Promise<Server> {
  const wss = new WebSocketServer({
    port,
    host: '127.0.0.1',
    handleProtocols: (p) => [...p][0] ?? false,
  });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const address = wss.address();
  if (address == null || typeof address === 'string') throw new Error('no address');
  const sockets: WebSocket[] = [];
  const requests: IncomingMessage[] = [];
  const waiters: Array<(ws: WebSocket) => void> = [];
  wss.on('connection', (ws, req) => {
    sockets.push(ws);
    requests.push(req);
    waiters.shift()?.(ws);
  });
  const server: Server = {
    wss,
    port: address.port,
    sockets,
    requests,
    nextSocket: () => new Promise<WebSocket>((resolve) => waiters.push(resolve)),
  };
  cleanups.push(() => closeServer(server));
  return server;
}

async function closeServer(server: Server): Promise<void> {
  for (const ws of server.wss.clients) ws.terminate();
  await new Promise<void>((resolve) => server.wss.close(() => resolve()));
}

function makeClient(port: number, extra: Partial<OcppClientOptions> = {}): OcppClient {
  const client = new OcppClient({
    serverUrl: `ws://127.0.0.1:${String(port)}`,
    stationId: 'CALLS',
    ocppProtocol: 'ocpp2.1',
    securityProfile: 0,
    ...extra,
  });
  client.setDisconnectedHandler(() => {});
  cleanups.push(() => {
    client.disconnect();
    return Promise.resolve();
  });
  return client;
}

async function connected(extra: Partial<OcppClientOptions> = {}): Promise<{
  client: OcppClient;
  server: Server;
  socket: WebSocket;
}> {
  const server = await startServer();
  const client = makeClient(server.port, extra);
  const socket = server.nextSocket();
  await client.connect();
  return { client, server, socket: await socket };
}

function nextFrame(socket: WebSocket): Promise<unknown[]> {
  return new Promise((resolve) => {
    socket.once('message', (data: Buffer) => resolve(JSON.parse(data.toString()) as unknown[]));
  });
}

function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (cond()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error('condition not met'));
      else setImmediate(tick);
    };
    tick();
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OcppClient calls', () => {
  it('sends a CALL frame and resolves with the CALLRESULT payload', async () => {
    const { client, socket } = await connected();
    const frame = nextFrame(socket);
    const reply = client.sendCall('Heartbeat', { a: 1 });
    const call = await frame;
    expect(call[0]).toBe(2);
    expect(call[2]).toBe('Heartbeat');
    expect(call[3]).toEqual({ a: 1 });
    // A result for another message id is ignored.
    socket.send(JSON.stringify([3, 'other-id', { wrong: true }]));
    socket.send(JSON.stringify([3, call[1], { currentTime: 'now' }]));
    await expect(reply).resolves.toEqual({ currentTime: 'now' });
  });

  it('rejects the call on a CALLERROR', async () => {
    const { client, socket } = await connected();
    const frame = nextFrame(socket);
    const reply = client.sendCall('Authorize', {});
    const call = await frame;
    socket.send(JSON.stringify([4, 'unknown-id', 'InternalError', 'ignored', {}]));
    socket.send(JSON.stringify([4, call[1], 'NotSupported', 'no auth', {}]));
    await expect(reply).rejects.toThrow('CALLERROR NotSupported: no auth');
  });

  it('ignores invalid JSON and short frames and keeps working', async () => {
    const { client, socket } = await connected();
    socket.send('not json');
    socket.send(JSON.stringify([3]));
    const frame = nextFrame(socket);
    const reply = client.sendCall('Heartbeat', {});
    const call = await frame;
    socket.send(JSON.stringify([3, call[1], { ok: true }]));
    await expect(reply).resolves.toEqual({ ok: true });
    expect(console.error).toHaveBeenCalledWith('[CALLS] Invalid JSON: not json');
  });

  it('times out a call without a response after 30 seconds', async () => {
    const { client, socket } = await connected();
    const frame = nextFrame(socket);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const reply = client.sendCall('StatusNotification', {});
    const assertion = expect(reply).rejects.toThrow(
      'Timeout waiting for StatusNotification response',
    );
    vi.advanceTimersByTime(30_000);
    await assertion;
    vi.useRealTimers();
    await frame;
  });

  it('rejects the call when the send itself fails', async () => {
    const { client } = await connected();
    const ws = (client as unknown as { ws: WebSocket }).ws;
    vi.spyOn(ws, 'send').mockImplementation(((_data: unknown, cb?: (err?: Error) => void) => {
      cb?.(new Error('write failed'));
    }) as WebSocket['send']);
    await expect(client.sendCall('Heartbeat', {})).rejects.toThrow('write failed');
    expect((client as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  });

  it('sends a SEND frame (MessageTypeId 6)', async () => {
    const { client, socket } = await connected();
    const frame = nextFrame(socket);
    expect(client.sendSend('NotifyPeriodicEventStream', { id: 1 })).toBe(true);
    const sent = await frame;
    expect(sent[0]).toBe(6);
    expect(sent[2]).toBe('NotifyPeriodicEventStream');
    expect(sent[3]).toEqual({ id: 1 });
  });

  it('answers a CSMS CALL with the handler result as CALLRESULT', async () => {
    const { client, socket } = await connected();
    client.setIncomingCallHandler((_id, action) => Promise.resolve({ status: 'Accepted', action }));
    const frame = nextFrame(socket);
    socket.send(JSON.stringify([2, 'csms-1', 'Reset', { type: 'Immediate' }]));
    expect(await frame).toEqual([3, 'csms-1', { status: 'Accepted', action: 'Reset' }]);
  });

  it('answers a handler failure that is not an OCPP error code with InternalError', async () => {
    const { client, socket } = await connected();
    client.setIncomingCallHandler(() => Promise.reject(new Error('database gone')));
    const frame = nextFrame(socket);
    socket.send(JSON.stringify([2, 'csms-2', 'Reset', {}]));
    expect(await frame).toEqual([4, 'csms-2', 'InternalError', 'database gone', {}]);
  });
});

describe('OcppClient connection lifecycle', () => {
  it('disconnect rejects pending calls', async () => {
    const { client } = await connected();
    const reply = client.sendCall('Heartbeat', {});
    client.disconnect();
    await expect(reply).rejects.toThrow('Client disconnected');
    expect(client.isConnected).toBe(false);
  });

  it('a connection loss rejects pending calls and reconnectNow comes back without backoff', async () => {
    const { client, server } = await connected();
    const onConnected = vi.fn();
    const beforeAttempt = vi.fn();
    client.setConnectedHandler(onConnected);
    client.setBeforeReconnectAttempt(beforeAttempt);
    const reply = client.sendCall('Heartbeat', {});
    const second = server.nextSocket();
    client.reconnectNow(0);
    await expect(reply).rejects.toThrow('Connection lost');
    await second;
    await waitFor(() => onConnected.mock.calls.length > 0);
    expect(beforeAttempt).toHaveBeenCalledWith(1);
    expect(client.isConnected).toBe(true);
    expect(server.requests).toHaveLength(2);
  });

  it('reconnectNow without a socket does nothing', () => {
    const client = makeClient(1);
    expect(() => client.reconnectNow(0)).not.toThrow();
    expect(client.isConnected).toBe(false);
  });

  it('keeps retrying with the back-off after a failed attempt, until disconnected', async () => {
    const server = await startServer();
    const client = makeClient(server.port);
    await client.connect();
    const attempts: number[] = [];
    client.setReconnectBackOff(() => ({ waitMinimumMs: 1, randomRangeMs: 0, repeatTimes: 0 }));
    client.setBeforeReconnectAttempt((n) => attempts.push(n));
    // The server goes away: every reconnect attempt fails.
    await closeServer(server);
    await waitFor(() => attempts.length >= 2);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[CALLS] Reconnect attempt 1 failed'),
    );
    client.disconnect();
    const settled = attempts.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(attempts.length).toBeLessThanOrEqual(settled + 1);
    expect((client as unknown as { reconnecting: boolean }).reconnecting).toBe(false);
  });

  it('profile 3 connects without Basic auth', async () => {
    const server = await startServer();
    const client = makeClient(server.port, {
      securityProfile: 3,
      clientCert: 'CERT',
      clientKey: 'KEY',
    });
    await client.connect();
    expect(server.requests[0]?.headers['authorization']).toBeUndefined();
  });

  it('reports a refused TLS version to its handler and rejects the connect', async () => {
    const server = await startServer();
    const client = makeClient(server.port);
    const onTls = vi.fn();
    const onCert = vi.fn();
    client.setTlsVersionRejectedHandler(onTls);
    client.setServerCertificateRejectedHandler(onCert);
    const connecting = client.connect();
    const ws = (client as unknown as { ws: WebSocket }).ws;
    const err = Object.assign(new Error('wrong version number'), {
      code: 'ERR_SSL_WRONG_VERSION_NUMBER',
    });
    ws.emit('error', err);
    await expect(connecting).rejects.toBe(err);
    expect(onTls).toHaveBeenCalledWith(err);
    expect(onCert).not.toHaveBeenCalled();
  });
});
