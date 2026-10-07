// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { MessageTimeoutError, OcppTestServer } from '../cs-server.js';

type Frame = unknown[];

/** A station-side WebSocket that records the frames the Test System sends. */
class FakeStation {
  readonly frames: Frame[] = [];
  private readonly waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> =
    [];
  closeCode: number | null = null;
  private closeResolve: (() => void) | null = null;
  readonly closed: Promise<void>;

  constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf-8')) as Frame;
      const idx = this.waiters.findIndex((w) => w.pred(frame));
      if (idx !== -1) {
        const [w] = this.waiters.splice(idx, 1);
        w?.resolve(frame);
        return;
      }
      this.frames.push(frame);
    });
    ws.on('close', (code) => {
      this.closeCode = code;
      this.closeResolve?.();
    });
  }

  next(pred: (f: Frame) => boolean = () => true): Promise<Frame> {
    const idx = this.frames.findIndex(pred);
    if (idx !== -1) {
      const [f] = this.frames.splice(idx, 1);
      return Promise.resolve(f as Frame);
    }
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }

  send(frame: unknown): void {
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }
}

function connect(url: string, protocols: string[] = ['ocpp2.1']): Promise<FakeStation> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, { headers: { authorization: 'Basic abc' } });
    const station = new FakeStation(ws);
    ws.once('open', () => {
      resolve(station);
    });
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`HTTP ${String(res.statusCode)}`));
    });
  });
}

describe('OcppTestServer (ws://)', () => {
  let server: OcppTestServer;
  let url: string;
  const stations: FakeStation[] = [];

  beforeEach(async () => {
    server = new OcppTestServer();
    ({ url } = await server.start());
  });

  afterEach(async () => {
    for (const s of stations.splice(0)) s.ws.terminate();
    await server.stop();
  });

  async function station(path = '/CS001', protocols?: string[]): Promise<FakeStation> {
    const s = await connect(`${url}${path}`, protocols);
    stations.push(s);
    return s;
  }

  it('serves ws:// on loopback and reports the connected station and protocol', async () => {
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(server.isConnected).toBe(false);
    const waiting = server.waitForConnection(2000);
    await station('/CS001?x=1', ['ocpp1.6']);
    await expect(waiting).resolves.toBe('CS001');
    expect(server.isConnected).toBe(true);
    expect(server.stationId).toBe('CS001');
    expect(server.protocol).toBe('ocpp1.6');
    expect(server.lastUpgrade).toMatchObject({
      url: '/CS001?x=1',
      authorization: 'Basic abc',
      accepted: true,
      tls: null,
    });
    // Already connected: resolves at once.
    await expect(server.waitForConnection(10)).resolves.toBe('CS001');
  });

  it('prefers ocpp2.1 when the station offers both subprotocols', async () => {
    await station('/CS002', ['ocpp1.6', 'ocpp2.1']);
    await server.waitForConnection(2000);
    expect(server.protocol).toBe('ocpp2.1');
  });

  it('rejects the connection wait when no station connects in time', async () => {
    await expect(server.waitForConnection(20)).rejects.toThrow('No station connected within 20ms');
  });

  it('closes a connection without a station ID', async () => {
    const s = await station('/');
    await s.closed;
    expect(s.closeCode).toBe(4002);
    expect(server.isConnected).toBe(false);
  });

  it('closes a second station connection', async () => {
    await station('/CS001');
    await server.waitForConnection(2000);
    const second = await station('/CS002');
    await second.closed;
    expect(second.closeCode).toBe(4001);
    expect(server.stationId).toBe('CS001');
  });

  it('refuses an upgrade without an OCPP subprotocol', async () => {
    await expect(connect(`${url}/CS001`, ['mqtt'])).rejects.toThrow();
    expect(server.isConnected).toBe(false);
  });

  it('sends a command and resolves with the CALLRESULT payload', async () => {
    const s = await station();
    await server.waitForConnection(2000);
    const result = server.sendCommand('Reset', { type: 'Immediate' }, 2000);
    const call = await s.next();
    expect(call[0]).toBe(2);
    expect(call[2]).toBe('Reset');
    expect(call[3]).toEqual({ type: 'Immediate' });
    s.send([3, call[1], { status: 'Accepted' }]);
    await expect(result).resolves.toEqual({ status: 'Accepted' });
  });

  it('rejects a command answered with a CALLERROR', async () => {
    const s = await station();
    await server.waitForConnection(2000);
    const result = server.sendCommand('Reset', {}, 2000);
    const call = await s.next();
    s.send([4, call[1], 'NotImplemented', 'no reset', {}]);
    await expect(result).rejects.toThrow('CALLERROR NotImplemented: no reset');
  });

  it('times out a command the station never answers', async () => {
    const s = await station();
    await server.waitForConnection(2000);
    await expect(server.sendCommand('Reset', {}, 30)).rejects.toThrow(
      'Command Reset timed out after 30ms',
    );
    // A late answer for the timed out call is ignored.
    const call = await s.next();
    s.send([3, call[1], {}]);
  });

  it('rejects a command when no station is connected', async () => {
    await expect(server.sendCommand('Reset', {})).rejects.toThrow('No station connected');
  });

  it('auto-answers a station CALL with an empty payload and buffers it', async () => {
    const s = await station();
    await server.waitForConnection(2000);
    s.send([2, 'm1', 'Heartbeat', {}]);
    const reply = await s.next((f) => f[1] === 'm1');
    expect(reply).toEqual([3, 'm1', {}]);
    await expect(server.waitForMessage('Heartbeat', 100)).resolves.toEqual({});
    // The buffered message is consumed once.
    await expect(server.waitForMessage('Heartbeat', 20)).rejects.toThrow(
      'Timed out waiting for Heartbeat after 20ms',
    );
  });

  it('rejects a timed out wait with a MessageTimeoutError', async () => {
    const err: unknown = await server.waitForMessage('Heartbeat', 20).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MessageTimeoutError);
    expect(err).toMatchObject({ action: 'Heartbeat', timeoutMs: 20 });
  });

  it('waitForMessageOrNull returns the payload, or null on a timeout', async () => {
    const s = await station();
    await server.waitForConnection(2000);
    const waiting = server.waitForMessageOrNull('Heartbeat', 2000);
    s.send([2, 'n1', 'Heartbeat', { n: 1 }]);
    await expect(waiting).resolves.toEqual({ n: 1 });
    await expect(server.waitForMessageOrNull('Heartbeat', 20)).resolves.toBeNull();
  });

  it('waitForMessageOrNull rethrows a failure that is not a timeout', async () => {
    const waiting = server.waitForMessageOrNull('Heartbeat', 2000);
    await server.stop();
    await expect(waiting).rejects.toThrow('Server stopping');
  });

  it('ignores a frame that is not JSON', async () => {
    const s = await station();
    await server.waitForConnection(2000);
    s.send('not json');
    s.send([2, 'n2', 'Heartbeat', {}]);
    await expect(server.waitForMessage('Heartbeat', 2000)).resolves.toEqual({});
  });

  it('answers a CALL with the message handler response', async () => {
    server.setMessageHandler((action, payload) =>
      Promise.resolve({ echoed: action, n: payload['n'] }),
    );
    const s = await station();
    await server.waitForConnection(2000);
    s.send([2, 'm2', 'DataTransfer', { n: 7 }]);
    expect(await s.next((f) => f[1] === 'm2')).toEqual([3, 'm2', { echoed: 'DataTransfer', n: 7 }]);
  });

  it('answers a CALL with InternalError when the handler throws', async () => {
    server.setMessageHandler(() => Promise.reject(new Error('handler broke')));
    const s = await station();
    await server.waitForConnection(2000);
    s.send([2, 'm3', 'Authorize', {}]);
    expect(await s.next((f) => f[1] === 'm3')).toEqual([
      4,
      'm3',
      'InternalError',
      'handler broke',
      {},
    ]);
  });

  it('resolves a waiter with the CALL payload and answers through the handler', async () => {
    server.setMessageHandler(() => Promise.resolve({ status: 'Accepted' }));
    const s = await station();
    await server.waitForConnection(2000);
    const waiting = server.waitForMessage('StatusNotification', 2000);
    s.send([2, 'm4', 'StatusNotification', { connectorId: 1 }]);
    await expect(waiting).resolves.toEqual({ connectorId: 1 });
    expect(await s.next((f) => f[1] === 'm4')).toEqual([3, 'm4', { status: 'Accepted' }]);
  });

  it('answers a waited CALL with an empty payload when the handler throws', async () => {
    server.setMessageHandler(() => Promise.reject(new Error('nope')));
    const s = await station();
    await server.waitForConnection(2000);
    const waiting = server.waitForMessage('Heartbeat', 2000);
    s.send([2, 'm5', 'Heartbeat', {}]);
    await expect(waiting).resolves.toEqual({});
    expect(await s.next((f) => f[1] === 'm5')).toEqual([3, 'm5', {}]);
  });

  it('auto-answers a waited CALL without a handler', async () => {
    const s = await station();
    await server.waitForConnection(2000);
    const waiting = server.waitForMessage('BootNotification', 2000);
    s.send([2, 'm6', 'BootNotification', { reason: 'PowerUp' }]);
    await expect(waiting).resolves.toEqual({ reason: 'PowerUp' });
    expect(await s.next((f) => f[1] === 'm6')).toEqual([3, 'm6', {}]);
  });

  it('records a SEND without answering it, for a waiter or the buffer', async () => {
    const s = await station();
    await server.waitForConnection(2000);
    const waiting = server.waitForMessage('NotifyPeriodicEventStream', 2000);
    s.send([6, 's1', 'NotifyPeriodicEventStream', { id: 1 }]);
    await expect(waiting).resolves.toEqual({ id: 1 });
    s.send([6, 's2', 'NotifyPeriodicEventStream', { id: 2 }]);
    // A CALL after the SEND proves the SEND was processed and got no answer.
    s.send([2, 'm7', 'Heartbeat', {}]);
    expect(await s.next()).toEqual([3, 'm7', {}]);
    await expect(server.waitForMessage('NotifyPeriodicEventStream', 100)).resolves.toEqual({
      id: 2,
    });
  });

  it('clearBuffer drops buffered messages', async () => {
    const s = await station();
    await server.waitForConnection(2000);
    s.send([2, 'm8', 'Heartbeat', {}]);
    await s.next((f) => f[1] === 'm8');
    server.clearBuffer();
    await expect(server.waitForMessage('Heartbeat', 20)).rejects.toThrow('Timed out');
  });

  it('ignores invalid JSON, short frames and unknown message ids', async () => {
    const s = await station();
    await server.waitForConnection(2000);
    s.send('not json');
    s.send([2, 'x']);
    s.send([3, 'unknown-id', {}]);
    s.send([4, 'unknown-id', 'GenericError', '', {}]);
    s.send([2, 'm9', 'Heartbeat', {}]);
    expect(await s.next()).toEqual([3, 'm9', {}]);
    expect(server.isConnected).toBe(true);
  });

  it('sendCallError sends a CALLERROR frame, and nothing without a station', async () => {
    server.sendCallError('none', 'GenericError');
    const s = await station();
    await server.waitForConnection(2000);
    server.sendCallError('abc', 'FormatViolation', 'bad', { field: 'x' });
    expect(await s.next()).toEqual([4, 'abc', 'FormatViolation', 'bad', { field: 'x' }]);
  });

  it('rejects pending commands when the station closes the socket', async () => {
    const s = await station();
    await server.waitForConnection(2000);
    const result = server.sendCommand('Reset', {}, 5000);
    await s.next();
    s.ws.close();
    await expect(result).rejects.toThrow('Station disconnected');
    expect(server.isConnected).toBe(false);
  });

  it('disconnectStation drops the connection and refuses reconnects until accepted', async () => {
    const s = await station();
    await server.waitForConnection(2000);
    s.send([2, 'm10', 'Heartbeat', {}]);
    await s.next((f) => f[1] === 'm10');
    const result = server.sendCommand('Reset', {}, 5000);
    server.disconnectStation(true);
    await expect(result).rejects.toThrow('Station disconnected');
    expect(server.isConnected).toBe(false);
    await s.closed;
    // Buffered messages from before the disconnect are gone.
    await expect(server.waitForMessage('Heartbeat', 20)).rejects.toThrow('Timed out');

    await expect(connect(`${url}/CS001`)).rejects.toThrow('HTTP 503');
    expect(server.refusedAttempts).toHaveLength(1);
    expect(server.upgradeAttempts.at(-1)?.accepted).toBe(false);

    server.acceptConnections();
    const waiting = server.waitForConnection(2000);
    await station('/CS001');
    await expect(waiting).resolves.toBe('CS001');
    expect(server.upgradeAttempts).toHaveLength(3);
  });

  it('disconnectStation without a station only clears the buffer', () => {
    server.disconnectStation();
    expect(server.isConnected).toBe(false);
  });

  it('stop rejects pending commands and message waiters', async () => {
    const s = await station();
    await server.waitForConnection(2000);
    const result = expect(server.sendCommand('Reset', {}, 5000)).rejects.toThrow('Server stopping');
    const waiting = expect(server.waitForMessage('Heartbeat', 5000)).rejects.toThrow(
      'Server stopping',
    );
    await s.next();
    await server.stop();
    await result;
    await waiting;
    expect(server.stationId).toBeNull();
    expect(server.protocol).toBeNull();
    // A fresh server so afterEach can stop it.
    server = new OcppTestServer();
    await server.start();
  });

  it('refuses TLS-only operations on a plain server', () => {
    expect(() => {
      server.setServerCertificate('c', 'k');
    }).toThrow('setServerCertificate needs a TLS server');
    expect(() => {
      server.setTlsOptions({ cert: 'c', key: 'k', requestCert: false });
    }).toThrow('setTlsOptions needs a TLS server');
  });

  it('rejects a TLS handshake wait when none happens', async () => {
    await expect(server.waitForTlsHandshake(20)).rejects.toThrow('No TLS handshake within 20ms');
    expect(server.tlsHandshakes()).toEqual([]);
  });
});
