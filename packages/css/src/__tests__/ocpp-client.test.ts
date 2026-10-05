// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { CSS_RECONNECT_SPREAD_S, CSS_RETRY_BACK_OFF_DEFAULTS } from '@evtivity/lib';
import {
  OcppClient,
  isServerCertificateError,
  isTlsVersionError,
  reconnectWaitMs,
} from '../ocpp-client.js';

// We cannot easily test WebSocket connections in unit tests without a real server.
// Test the constructor, option handling, and state management.

describe('OcppClient', () => {
  it('constructs with required options', () => {
    const client = new OcppClient({
      serverUrl: 'ws://localhost:3003',
      stationId: 'TEST-001',
      ocppProtocol: 'ocpp2.1',
    });
    expect(client.stationId).toBe('TEST-001');
    expect(client.protocol).toBe('ocpp2.1');
    expect(client.isConnected).toBe(false);
  });

  it('constructs with OCPP 1.6', () => {
    const client = new OcppClient({
      serverUrl: 'ws://localhost:3003',
      stationId: 'TEST-16',
      ocppProtocol: 'ocpp1.6',
    });
    expect(client.protocol).toBe('ocpp1.6');
  });

  it('rejects sendCall when not connected', async () => {
    const client = new OcppClient({
      serverUrl: 'ws://localhost:3003',
      stationId: 'TEST-001',
      ocppProtocol: 'ocpp2.1',
    });
    await expect(client.sendCall('Heartbeat', {})).rejects.toThrow('Not connected');
  });

  it('does not throw on sendCallResult when not connected', () => {
    const client = new OcppClient({
      serverUrl: 'ws://localhost:3003',
      stationId: 'TEST-001',
      ocppProtocol: 'ocpp2.1',
    });
    // Should not throw, just silently skip
    expect(() => client.sendCallResult('msg-1', { status: 'Accepted' })).not.toThrow();
  });

  it('accepts handler registrations', () => {
    const client = new OcppClient({
      serverUrl: 'ws://localhost:3003',
      stationId: 'TEST-001',
      ocppProtocol: 'ocpp2.1',
    });
    const handler = vi.fn();
    const connHandler = vi.fn();
    const disconnHandler = vi.fn();
    client.setIncomingCallHandler(handler);
    client.setConnectedHandler(connHandler);
    client.setDisconnectedHandler(disconnHandler);
    // No error means handlers are set
    expect(client.isConnected).toBe(false);
  });

  it('disconnect is safe to call when not connected', () => {
    const client = new OcppClient({
      serverUrl: 'ws://localhost:3003',
      stationId: 'TEST-001',
      ocppProtocol: 'ocpp2.1',
    });
    expect(() => client.disconnect()).not.toThrow();
  });
});

describe('connect failure classification', () => {
  const err = (code: string, message = code) => Object.assign(new Error(message), { code });

  it('recognizes a server certificate the station refused', () => {
    for (const code of [
      'CERT_HAS_EXPIRED',
      'CERT_NOT_YET_VALID',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'ERR_TLS_CERT_WILDCARD',
    ]) {
      expect(isServerCertificateError(err(code))).toBe(true);
    }
    expect(isServerCertificateError(err('ECONNREFUSED'))).toBe(false);
  });

  it('recognizes a TLS version below 1.2', () => {
    expect(isTlsVersionError(err('ERR_SSL_UNSUPPORTED_PROTOCOL'))).toBe(true);
    expect(isTlsVersionError(err('ERR_SSL_X', 'tlsv1 alert protocol version'))).toBe(true);
    expect(isTlsVersionError(err('ECONNREFUSED'))).toBe(false);
  });
});

describe('reconnectWaitMs', () => {
  const backOff = { waitMinimumMs: 10_000, randomRangeMs: 5_000, repeatTimes: 3 };

  it('2.1: first attempt after RetryBackOffWaitMinimum plus up to RetryBackOffRandomRange', () => {
    expect(reconnectWaitMs(backOff, 0, 15_000, () => 0)).toBe(10_000);
    expect(reconnectWaitMs(backOff, 0, 15_000, () => 0.999)).toBeCloseTo(14_995);
  });

  it('2.1: doubles per failed attempt at most RetryBackOffRepeatTimes times', () => {
    expect(reconnectWaitMs(backOff, 1, 0, () => 0)).toBe(20_000);
    expect(reconnectWaitMs(backOff, 3, 0, () => 0)).toBe(80_000);
    expect(reconnectWaitMs(backOff, 7, 0, () => 0)).toBe(80_000);
    expect(reconnectWaitMs(backOff, 7, 0, () => 0.5)).toBe(82_500);
  });

  it('2.1: the fleet spread never extends the spec window', () => {
    expect(reconnectWaitMs(backOff, 0, 60_000, () => 0.999)).toBeLessThan(15_000);
  });

  it('1.6: 2 s doubling with 20% jitter, the spread only on the first attempt', () => {
    expect(reconnectWaitMs(null, 0, 15_000, () => 0)).toBe(2_000);
    expect(reconnectWaitMs(null, 0, 15_000, () => 0.5)).toBe(2_000 + 200 + 7_500);
    expect(reconnectWaitMs(null, 1, 15_000, () => 0.5)).toBe(4_000 + 400);
    expect(reconnectWaitMs(null, 20, 15_000, () => 0)).toBe(300_000);
  });

  it('a 2.1 fleet on the factory back-off spreads its first reconnects over the window', () => {
    const factory = {
      waitMinimumMs: CSS_RETRY_BACK_OFF_DEFAULTS.waitMinimumS * 1000,
      randomRangeMs: CSS_RETRY_BACK_OFF_DEFAULTS.randomRangeS * 1000,
      repeatTimes: CSS_RETRY_BACK_OFF_DEFAULTS.repeatTimes,
    };
    const stations = 2000;
    const perSecond = new Map<number, number>();
    for (let i = 0; i < stations; i++) {
      const waitMs = reconnectWaitMs(factory, 0, 0, () => i / stations);
      expect(waitMs).toBeGreaterThanOrEqual(2_000);
      expect(waitMs).toBeLessThan(2_000 + CSS_RECONNECT_SPREAD_S * 1000);
      const second = Math.floor(waitMs / 1000);
      perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
    }
    // Uniform over 15 s: no second takes more than a fifteenth of the fleet.
    expect(perSecond.size).toBe(CSS_RECONNECT_SPREAD_S);
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(Math.ceil(stations / 15));
  });
});

describe('OcppClient socket state', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function connectedClient(): Promise<{ client: OcppClient; socket: WebSocket }> {
    const wss = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      handleProtocols: (p) => [...p][0] ?? false,
    });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const address = wss.address();
    if (address == null || typeof address === 'string') throw new Error('no address');
    const client = new OcppClient({
      serverUrl: `ws://127.0.0.1:${String(address.port)}`,
      stationId: 'STATE-TEST',
      ocppProtocol: 'ocpp2.1',
      securityProfile: 0,
    });
    client.setDisconnectedHandler(() => {});
    cleanups.push(async () => {
      client.disconnect();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    await client.connect();
    const socket = (client as unknown as { ws: WebSocket }).ws;
    return { client, socket };
  }

  it('reports connected while the socket is open', async () => {
    const { client, socket } = await connectedClient();
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(client.isConnected).toBe(true);
  });

  it('is not connected while the socket is closing, and a send rejects as Not connected', async () => {
    const { client, socket } = await connectedClient();
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.close(1001, 'going away');

    // The close event has not fired yet: the socket is closing.
    expect(socket.readyState).toBe(WebSocket.CLOSING);
    expect(client.isConnected).toBe(false);
    await expect(client.sendCall('TransactionEvent', {})).rejects.toThrow('Not connected');
    expect(client.sendSend('NotifyPeriodicEventStream', {})).toBe(false);
    expect(() => client.sendCallResult('m1', {})).not.toThrow();
    expect(() => client.sendCallError('m2', 'InternalError')).not.toThrow();

    await closed;
    expect(client.isConnected).toBe(false);
  });
});
