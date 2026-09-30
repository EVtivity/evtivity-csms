// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { OcppServer as OcppServerType } from '../server/ocpp-server.js';

// Shorten the idle timeout BEFORE the OCPP server (and its config module) is
// imported, as in ocpp-server-limits.test.ts. Vitest isolates module state per
// file, so the override does not affect the other server tests.
let OcppServer: typeof OcppServerType;

beforeAll(async () => {
  process.env['OCPP_IDLE_TIMEOUT_MS'] = '300';
  const mod = await import('../server/ocpp-server.js');
  OcppServer = mod.OcppServer;
});

let testPort = 19800;
let server: OcppServerType | null = null;

afterEach(async () => {
  if (server != null) {
    await server.stop();
    server = null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

async function connect(): Promise<{
  ws: WebSocket;
  closed: Promise<{ code: number; reason: string }>;
}> {
  const port = testPort++;
  const srv = new OcppServer();
  server = srv;
  await srv.start({ port, host: '127.0.0.1' });

  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/IDLE-1`, ['ocpp1.6'], {
    headers: { authorization: 'Basic ' + Buffer.from('IDLE-1:password').toString('base64') },
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      resolve();
    });
    ws.on('error', reject);
  });
  return { ws, closed };
}

async function keepAliveFor(ms: number, send: () => void): Promise<void> {
  const timer = setInterval(send, 100);
  await new Promise((resolve) => setTimeout(resolve, ms));
  clearInterval(timer);
}

describe('OcppServer idle timeout', () => {
  it('closes a connection without messages or ping/pong frames', async () => {
    const { closed } = await connect();

    const info = await closed;

    expect(info.code).toBe(1000);
    expect(info.reason).toBe('Idle timeout');
  });

  it('keeps a connection open while the station sends WebSocket pings', async () => {
    const { ws } = await connect();

    await keepAliveFor(900, () => {
      ws.ping();
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('keeps a connection open while pongs arrive', async () => {
    const { ws } = await connect();

    // Stand-in for the station answering the ping monitor, which pings every
    // 30s and is too slow for this test; an unsolicited pong reaches the same
    // server handler.
    await keepAliveFor(900, () => {
      ws.pong();
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
