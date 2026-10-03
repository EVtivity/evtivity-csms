// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OcppServer } from '../server/ocpp-server.js';
import type { HandlerContext } from '../server/middleware/pipeline.js';

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

function connectStation16(port: number, stationId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/${stationId}`, ['ocpp1.6'], {
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

// Drive the station through a successful BootNotification so the boot
// guard middleware lets the test message through. Tests for non-boot
// actions must call this first; the boot guard rejects all other CALLs
// with SecurityError until the session reaches Accepted.
async function bootStation(ws: WebSocket): Promise<void> {
  const bootResponse = waitForMessage(ws);
  sendCall(ws, 'boot-' + Math.random().toString(36).slice(2, 8), 'BootNotification', {
    chargingStation: { vendorName: 'TestVendor', model: 'TestModel' },
    reason: 'PowerUp',
  });
  await bootResponse;
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
    await bootStation(ws);

    const responsePromise = waitForMessage(ws);
    sendCall(ws, 'msg-2', 'Heartbeat', {});

    const response = await responsePromise;
    expect(response[0]).toBe(3);
    const payload = response[2] as Record<string, unknown>;
    expect(payload['currentTime']).toBeDefined();
    ws.close();
  });

  it('treats any inbound CALL as a liveness signal, not just Heartbeat', async () => {
    // Per OCPP 2.1 B07.FR.04, a station sending other messages within the
    // heartbeat interval does not need to send a Heartbeat. The CSMS must
    // accept any inbound CALL as proof of life or it will kill connections
    // on stations that only send MeterValues.
    const port = getNextPort();
    const srv = await startServer(port);
    const ws = await connectStation(port, 'TEST-LIVENESS');
    await bootStation(ws);

    const conn = srv.getConnectionManager().get('TEST-LIVENESS');
    expect(conn).toBeDefined();
    const baseline = conn!.session.lastHeartbeat.getTime();

    await new Promise((resolve) => setTimeout(resolve, 20));

    const responsePromise = waitForMessage(ws);
    sendCall(ws, 'msg-liveness', 'DataTransfer', {
      vendorId: 'com.test',
      messageId: 'liveness-check',
      data: 'ping',
    });
    await responsePromise;

    expect(conn!.session.lastHeartbeat.getTime()).toBeGreaterThan(baseline);
    ws.close();
  });

  it('returns CALLERROR for unknown action', async () => {
    const port = getNextPort();
    await startServer(port);
    const ws = await connectStation(port, 'TEST-004');
    await bootStation(ws);

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
    await bootStation(ws);

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

  describe('station.Ready', () => {
    function collectReady(srv: OcppServer): string[] {
      const ready: string[] = [];
      srv.getEventBus().subscribe('station.Ready', (event) => {
        ready.push(event.aggregateId);
        return Promise.resolve();
      });
      return ready;
    }

    it('is not published when the WebSocket opens, only after BootNotification Accepted', async () => {
      const port = getNextPort();
      const srv = await startServer(port);
      const ready = collectReady(srv);

      const ws = await connectStation(port, 'TEST-READY-BOOT');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ready).toEqual([]);

      await bootStation(ws);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ready).toEqual(['TEST-READY-BOOT']);
      ws.close();
    });

    it('is published once, on the first message of a station that reconnects without a boot', async () => {
      const port = getNextPort();
      const srv = await startServer(port);
      const ready = collectReady(srv);

      const ws = await connectStation(port, 'TEST-READY-RECONNECT');
      const first = waitForMessage(ws);
      sendCall(ws, 'hb-1', 'Heartbeat', {});
      await first;
      const second = waitForMessage(ws);
      sendCall(ws, 'hb-2', 'Heartbeat', {});
      await second;
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(ready).toEqual(['TEST-READY-RECONNECT']);
      ws.close();
    });
  });

  it('tracks connections in ConnectionManager', async () => {
    const port = getNextPort();
    const srv = await startServer(port);
    const ws = await connectStation(port, 'TEST-006');

    const conn = srv.getConnectionManager().get('TEST-006');
    expect(conn).toBeDefined();
    expect(conn?.session.stationId).toBe('TEST-006');

    ws.close();
    // Poll for the disconnect to be reflected rather than guessing a fixed
    // delay; under parallel test load a 100ms wait can race the close handler.
    const deadline = Date.now() + 5000;
    while (srv.getConnectionManager().get('TEST-006') != null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
    await bootStation(ws);

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

  it('records a pong when the station replies to a server ping', async () => {
    const port = getNextPort();
    const srv = await startServer(port);
    const ws = await connectStation(port, 'TEST-PONG');

    const conn = srv.getConnectionManager().get('TEST-PONG');
    expect(conn).toBeDefined();

    // Observe the server-side socket receiving the auto-pong, which drives the
    // `ws.on('pong')` handler that calls pingMonitor.recordPong.
    const serverPongSeen = new Promise<void>((resolve) => {
      conn!.ws.on('pong', () => {
        resolve();
      });
    });
    // Server pings the client; the ws client auto-replies with a pong frame.
    conn!.ws.ping();
    await serverPongSeen;

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('handles a server-side WebSocket error by closing the connection', async () => {
    const port = getNextPort();
    const srv = await startServer(port);
    const ws = await connectStation(port, 'TEST-WSERR');

    const conn = srv.getConnectionManager().get('TEST-WSERR');
    expect(conn).toBeDefined();

    const closed = new Promise<void>((resolve) => {
      ws.on('close', () => {
        resolve();
      });
    });

    // Emitting an error on the server-side socket exercises the `ws.on('error')`
    // handler, which logs and closes the connection with code 1011.
    conn!.ws.emit('error', new Error('simulated socket failure'));
    await closed;

    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('negotiates the ocpp1.6 subprotocol when only 1.6 is offered', async () => {
    const port = getNextPort();
    const srv = await startServer(port);
    const ws = await connectStation16(port, 'TEST-16');

    expect(ws.protocol).toBe('ocpp1.6');
    const conn = srv.getConnectionManager().get('TEST-16');
    expect(conn?.session.ocppProtocol).toBe('ocpp1.6');
    ws.close();
  });

  it('publishes an inbound CALLRESULT message log for unmatched responses', async () => {
    const port = getNextPort();
    const srv = await startServer(port);
    const eventBus = srv.getEventBus();

    const logged = new Promise<Record<string, unknown>>((resolve) => {
      eventBus.subscribe('ocpp.MessageLog', (event) => {
        const p = event.payload;
        if (p['messageType'] === 3 && p['direction'] === 'inbound') {
          resolve(p);
        }
        return Promise.resolve();
      });
    });

    const ws = await connectStation(port, 'TEST-RESLOG');
    ws.send(JSON.stringify([3, 'orphan-msg', { status: 'Accepted' }]));

    const payload = await logged;
    expect(payload['messageId']).toBe('orphan-msg');
    expect(payload['action']).toBeNull();
    ws.close();
  });

  it('publishes an inbound CALLERROR message log for unmatched error responses', async () => {
    const port = getNextPort();
    const srv = await startServer(port);
    const eventBus = srv.getEventBus();

    const logged = new Promise<Record<string, unknown>>((resolve) => {
      eventBus.subscribe('ocpp.MessageLog', (event) => {
        const p = event.payload;
        if (p['messageType'] === 4 && p['direction'] === 'inbound') {
          resolve(p);
        }
        return Promise.resolve();
      });
    });

    const ws = await connectStation(port, 'TEST-ERRLOG');
    ws.send(JSON.stringify([4, 'orphan-err', 'InternalError', 'boom', { extra: true }]));

    const payload = await logged;
    expect(payload['errorCode']).toBe('InternalError');
    expect(payload['errorDescription']).toBe('boom');
    ws.close();
  });

  it('publishes an outbound CALLRESULT message log on a successful handler', async () => {
    const port = getNextPort();
    const srv = await startServer(port);
    const eventBus = srv.getEventBus();

    const logged = new Promise<Record<string, unknown>>((resolve) => {
      eventBus.subscribe('ocpp.MessageLog', (event) => {
        const p = event.payload;
        if (
          p['messageType'] === 3 &&
          p['direction'] === 'outbound' &&
          p['action'] === 'Heartbeat'
        ) {
          resolve(p);
        }
        return Promise.resolve();
      });
    });

    const ws = await connectStation(port, 'TEST-OUTLOG');
    await bootStation(ws);
    sendCall(ws, 'hb-1', 'Heartbeat', {});

    const payload = await logged;
    expect(payload['messageId']).toBe('hb-1');
    expect(payload['payload']).toHaveProperty('currentTime');
    ws.close();
  });

  it('returns an InternalError CALLERROR when a handler throws a plain Error', async () => {
    const port = getNextPort();
    const srv = await startServer(port);

    // Replace the Heartbeat handler with one that throws a non-OcppError. The
    // server must translate it into an InternalError CALLERROR rather than
    // leaking the stack to the station. Each test builds a fresh OcppServer,
    // so this override is isolated.
    srv.getRouter().register('ocpp2.1', 'Heartbeat', (_ctx: HandlerContext) => {
      throw new Error('handler exploded');
    });

    const ws = await connectStation(port, 'TEST-INTERR');
    await bootStation(ws);

    const responsePromise = waitForMessage(ws);
    sendCall(ws, 'msg-internal', 'Heartbeat', {});

    const response = await responsePromise;
    expect(response[0]).toBe(4);
    expect(response[1]).toBe('msg-internal');
    expect(response[2]).toBe('InternalError');
    expect(response[3]).toBe('Internal server error');
    ws.close();
  });

  it('uses an injected shared sql pool and leaves it open on stop', async () => {
    // The pool belongs to the caller (the process-wide client), so stop() must not end it.
    const port = getNextPort();
    const end = vi.fn();
    const sharedSql = { end } as unknown as import('postgres').Sql;
    const srv = new OcppServer({ sql: sharedSql });
    await srv.start({ port, host: '127.0.0.1' });
    await expect(srv.stop()).resolves.toBeUndefined();
    expect(end).not.toHaveBeenCalled();
    server = null;
  });

  it('uses an injected eventBus instead of constructing one', async () => {
    const port = getNextPort();
    const injected = new OcppServer();
    const sharedBus = injected.getEventBus();
    const srv = new OcppServer({ eventBus: sharedBus });
    server = srv;
    await srv.start({ port, host: '127.0.0.1' });

    expect(srv.getEventBus()).toBe(sharedBus);
    await injected.stop();
  });

  it('starts a TLS (wss://) listener and accepts secure connections', async () => {
    const certDir = mkdtempSync(join(tmpdir(), 'ocpp-tls-'));
    try {
      const keyPath = join(certDir, 'key.pem');
      const certPath = join(certDir, 'cert.pem');
      // Generate a throwaway self-signed cert for the TLS server. Skip the
      // test gracefully if openssl is unavailable in the environment.
      try {
        execFileSync('openssl', [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-days',
          '1',
          '-subj',
          '/CN=127.0.0.1',
        ]);
      } catch {
        return;
      }

      const wsPort = getNextPort();
      const tlsPort = getNextPort();
      const srv = new OcppServer();
      server = srv;
      await srv.start({
        port: wsPort,
        host: '127.0.0.1',
        tls: {
          cert: readFileSync(certPath, 'utf-8'),
          key: readFileSync(keyPath, 'utf-8'),
          port: tlsPort,
        },
      });

      const secureOpened = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`wss://127.0.0.1:${String(tlsPort)}/TEST-TLS`, ['ocpp2.1'], {
          rejectUnauthorized: false,
          headers: {
            authorization: 'Basic ' + Buffer.from('TEST-TLS:password').toString('base64'),
          },
        });
        ws.on('open', () => {
          ws.close();
          resolve(true);
        });
        ws.on('error', () => {
          resolve(false);
        });
      });

      expect(secureOpened).toBe(true);
      expect(srv.getConnectionManager().count()).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(certDir, { recursive: true, force: true });
    }
  });
});
