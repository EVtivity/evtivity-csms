// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { OcppServer } from '../server/ocpp-server.js';

let testPort = 19080;
let server: OcppServer | null = null;

function getNextPort(): number {
  return testPort++;
}

afterEach(async () => {
  if (server != null) {
    await server.stop();
    server = null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

async function startServer(port: number): Promise<OcppServer> {
  const srv = new OcppServer();
  server = srv;
  await srv.start({ port, host: '127.0.0.1' });
  return srv;
}

function connectStation(port: number, stationId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/${stationId}`, ['ocpp2.1'], {
      headers: {
        authorization: 'Basic ' + Buffer.from(`${stationId}:password`).toString('base64'),
      },
    });
    ws.on('open', () => {
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

function sendCall(
  ws: WebSocket,
  messageId: string,
  action: string,
  payload: Record<string, unknown>,
): void {
  ws.send(JSON.stringify([2, messageId, action, payload]));
}

function waitForMessage(ws: WebSocket): Promise<unknown[]> {
  return new Promise((resolve) => {
    ws.once('message', (data: Buffer) => {
      resolve(JSON.parse(data.toString('utf-8')) as unknown[]);
    });
  });
}

describe('OcppServer integration', () => {
  it('accepts WebSocket connection with correct subprotocol', async () => {
    const port = getNextPort();
    await startServer(port);
    const ws = await connectStation(port, 'TEST-001');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('responds to BootNotification with Accepted', async () => {
    const port = getNextPort();
    await startServer(port);
    const ws = await connectStation(port, 'TEST-002');

    const responsePromise = waitForMessage(ws);
    sendCall(ws, 'msg-1', 'BootNotification', {
      chargingStation: {
        vendorName: 'TestVendor',
        model: 'TestModel',
      },
      reason: 'PowerUp',
    });

    const response = await responsePromise;
    expect(response[0]).toBe(3);
    expect(response[1]).toBe('msg-1');
    const payload = response[2] as Record<string, unknown>;
    expect(payload['status']).toBe('Accepted');
    expect(payload['interval']).toBe(300);
    expect(payload['currentTime']).toBeDefined();
    ws.close();
  });

  it('responds to Heartbeat with currentTime', async () => {
    const port = getNextPort();
    await startServer(port);
    const ws = await connectStation(port, 'TEST-003');

    const responsePromise = waitForMessage(ws);
    sendCall(ws, 'msg-2', 'Heartbeat', {});

    const response = await responsePromise;
    expect(response[0]).toBe(3);
    const payload = response[2] as Record<string, unknown>;
    expect(payload['currentTime']).toBeDefined();
    ws.close();
  });

  it('returns CALLERROR for unknown action', async () => {
    const port = getNextPort();
    await startServer(port);
    const ws = await connectStation(port, 'TEST-004');

    const responsePromise = waitForMessage(ws);
    sendCall(ws, 'msg-3', 'NonExistentAction', {});

    const response = await responsePromise;
    expect(response[0]).toBe(4);
    expect(response[1]).toBe('msg-3');
    expect(response[2]).toBe('NotImplemented');
    ws.close();
  });

  it('handles DataTransfer with UnknownVendorId', async () => {
    const port = getNextPort();
    await startServer(port);
    const ws = await connectStation(port, 'TEST-005');

    const responsePromise = waitForMessage(ws);
    sendCall(ws, 'msg-4', 'DataTransfer', {
      vendorId: 'com.test',
      messageId: 'test-message',
      data: 'hello',
    });

    const response = await responsePromise;
    expect(response[0]).toBe(3);
    const payload = response[2] as Record<string, unknown>;
    expect(payload['status']).toBe('UnknownVendorId');
    ws.close();
  });

  it('publishes station.Connected with ocppProtocol in payload', async () => {
    const port = getNextPort();
    const srv = await startServer(port);
    const eventBus = srv.getEventBus();

    const connected = new Promise<{ stationId: string; ocppProtocol: string }>((resolve) => {
      eventBus.subscribe('station.Connected', (event) => {
        resolve(event.payload as { stationId: string; ocppProtocol: string });
        return Promise.resolve();
      });
    });

    const ws = await connectStation(port, 'TEST-PROTO');
    const payload = await connected;

    expect(payload.stationId).toBe('TEST-PROTO');
    expect(payload.ocppProtocol).toBe('ocpp2.1');
    ws.close();
  });

  it('tracks connections in ConnectionManager', async () => {
    const port = getNextPort();
    const srv = await startServer(port);
    const ws = await connectStation(port, 'TEST-006');

    const conn = srv.getConnectionManager().get('TEST-006');
    expect(conn).toBeDefined();
    expect(conn?.session.stationId).toBe('TEST-006');

    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(srv.getConnectionManager().get('TEST-006')).toBeUndefined();
  });

  it('silently ignores invalid JSON messages', async () => {
    const port = getNextPort();
    await startServer(port);
    const ws = await connectStation(port, 'TEST-JSON');

    ws.send('not valid json {{{');
    // Should not crash. Wait a bit and verify connection is still open.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('silently ignores messages that are not arrays', async () => {
    const port = getNextPort();
    await startServer(port);
    const ws = await connectStation(port, 'TEST-NOARR');

    ws.send(JSON.stringify({ foo: 'bar' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('silently ignores arrays with fewer than 3 elements', async () => {
    const port = getNextPort();
    await startServer(port);
    const ws = await connectStation(port, 'TEST-SHORT');

    ws.send(JSON.stringify([2, 'msg-x']));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('logs warning for unsupported message type', async () => {
    const port = getNextPort();
    await startServer(port);
    const ws = await connectStation(port, 'TEST-BADTYPE');

    // Send a message with an invalid message type (5 is not valid OCPP)
    ws.send(JSON.stringify([5, 'msg-x', 'SomeAction', {}]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Connection should still be open; server logged a warning but didn't crash
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('handles OcppError from pipeline as CALLERROR', async () => {
    const port = getNextPort();
    await startServer(port);
    const ws = await connectStation(port, 'TEST-ERR');

    const responsePromise = waitForMessage(ws);
    // Send a call with action that does not exist (triggers NotImplemented OcppError from router)
    sendCall(ws, 'msg-err', 'InvalidActionThatDoesNotExist', {});

    const response = await responsePromise;
    expect(response[0]).toBe(4); // CALLERROR
    expect(response[1]).toBe('msg-err');
    expect(response[2]).toBe('NotImplemented');
    ws.close();
  });

  it('handles CALLRESULT from station gracefully when no pending', async () => {
    const port = getNextPort();
    await startServer(port);
    const ws = await connectStation(port, 'TEST-NOPEND');

    // Send a CALLRESULT with unknown messageId - server should not crash
    ws.send(JSON.stringify([3, 'unknown-msg-id', { status: 'Accepted' }]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('handles CALLERROR from station gracefully when no pending', async () => {
    const port = getNextPort();
    await startServer(port);
    const ws = await connectStation(port, 'TEST-NOCALL');

    // Send a CALLERROR with unknown messageId
    ws.send(JSON.stringify([4, 'unknown-msg-id', 'InternalError', 'test', {}]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('publishes station.Disconnected on close', async () => {
    const port = getNextPort();
    const srv = await startServer(port);
    const eventBus = srv.getEventBus();

    const disconnected = new Promise<{ stationId: string }>((resolve) => {
      eventBus.subscribe('station.Disconnected', (event) => {
        resolve(event.payload as { stationId: string });
        return Promise.resolve();
      });
    });

    const ws = await connectStation(port, 'TEST-DISC');
    ws.close();

    const payload = await disconnected;
    expect(payload.stationId).toBe('TEST-DISC');
  });

  it('exposes accessor methods', async () => {
    const port = getNextPort();
    const srv = await startServer(port);

    expect(srv.getEventBus()).toBeDefined();
    expect(srv.getConnectionManager()).toBeDefined();
    expect(srv.getCorrelator()).toBeDefined();
    expect(srv.getRouter()).toBeDefined();
    expect(srv.getDispatcher()).toBeDefined();
    expect(srv.getLifecycle()).toBeDefined();
    expect(srv.getPingMonitor()).toBeDefined();
    expect(srv.getLogger()).toBeDefined();
  });

  it('rejects connection without correct subprotocol', async () => {
    const port = getNextPort();
    await startServer(port);

    const connected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/TESTXX`, ['invalid-protocol'], {
        headers: {
          authorization: 'Basic ' + Buffer.from('TESTXX:password').toString('base64'),
        },
      });
      ws.on('open', () => {
        ws.close();
        resolve(true);
      });
      ws.on('error', () => {
        resolve(false);
      });
      ws.on('close', () => {
        resolve(false);
      });
    });

    expect(connected).toBe(false);
  });
});
