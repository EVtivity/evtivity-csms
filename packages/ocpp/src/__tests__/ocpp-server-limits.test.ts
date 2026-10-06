// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import type postgres from 'postgres';
import type { OcppServer as OcppServerType } from '../server/ocpp-server.js';

// Lower the per-IP connection and message-rate thresholds BEFORE the OCPP
// server (and its config module) are imported, so the production limit
// branches are reachable. ESM hoists static imports, so the override must
// happen before a dynamic import of the server module. Vitest isolates module
// state per file, so these overrides do not affect ocpp-server.test.ts.
let OcppServer: typeof OcppServerType;

beforeAll(async () => {
  process.env['OCPP_MAX_CONNECTIONS_PER_IP'] = '2';
  process.env['OCPP_MAX_MESSAGES_PER_IP_PER_SECOND'] = '3';
  const mod = await import('../server/ocpp-server.js');
  OcppServer = mod.OcppServer;
  // The first import transforms the whole server module graph; with coverage on a busy
  // machine that took over the default 10 s hook limit.
}, 60_000);

let testPort = 19500;
let server: OcppServerType | null = null;

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

function connect(port: number, stationId: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${String(port)}/${stationId}`, ['ocpp2.1'], {
    headers: {
      authorization: 'Basic ' + Buffer.from(`${stationId}:password`).toString('base64'),
    },
  });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      resolve();
    });
    ws.on('error', reject);
  });
}

describe('OcppServer per-IP limits', () => {
  it('closes connections beyond the per-IP connection limit with code 1008', async () => {
    const port = getNextPort();
    const srv = new OcppServer();
    server = srv;
    await srv.start({ port, host: '127.0.0.1' });

    const ws1 = connect(port, 'LIMIT-1');
    const ws2 = connect(port, 'LIMIT-2');
    await waitOpen(ws1);
    await waitOpen(ws2);

    // Third connection from the same IP exceeds the limit of 2.
    const ws3 = connect(port, 'LIMIT-3');
    const closeInfo = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws3.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
      ws3.on('error', () => {
        /* close event still fires */
      });
    });

    expect(closeInfo.code).toBe(1008);
    expect(closeInfo.reason).toContain('Too many connections');

    ws1.close();
    ws2.close();
  });

  it('rejects upgrades beyond the limit while earlier authentications are pending', async () => {
    // The station lookup hangs until released, so authentications stay pending.
    let releaseLookups: () => void = () => undefined;
    const lookupsReleased = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });
    let lookups = 0;
    const lookup = (strings: TemplateStringsArray): Promise<unknown[]> => {
      if (strings.join('?').includes('FROM charging_stations')) {
        lookups++;
        return lookupsReleased.then(() => []);
      }
      return Promise.resolve([]);
    };
    // options.max sizes the connection-auth limit (half the pool).
    const sql = Object.assign(lookup, { options: { max: 20 } }) as unknown as postgres.Sql;

    const port = getNextPort();
    const srv = new OcppServer({ sql });
    server = srv;
    await srv.start({ port, host: '127.0.0.1' });

    const statusOf = (ws: WebSocket): Promise<number> =>
      new Promise((resolve) => {
        ws.on('unexpected-response', (_req, res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          ws.terminate();
        });
        ws.on('error', () => {
          /* unexpected-response carries the status */
        });
      });

    const pending1 = connect(port, 'PENDING-1');
    const pending2 = connect(port, 'PENDING-2');
    const status1 = statusOf(pending1);
    const status2 = statusOf(pending2);
    await vi.waitFor(() => {
      expect(lookups).toBe(2);
    });

    // Third upgrade from the same IP exceeds the limit of 2 before any lookup.
    expect(await statusOf(connect(port, 'PENDING-3'))).toBe(429);
    expect(lookups).toBe(2);

    // Pending authentications finish (unknown station) and free their slots.
    releaseLookups();
    expect(await status1).toBe(404);
    expect(await status2).toBe(404);
    const next = connect(port, 'PENDING-4');
    expect(await statusOf(next)).toBe(404);
  });

  it('closes the connection when the per-IP message rate limit is exceeded', async () => {
    const port = getNextPort();
    const srv = new OcppServer();
    server = srv;
    await srv.start({ port, host: '127.0.0.1' });

    const ws = connect(port, 'RATE-1');
    await waitOpen(ws);

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    // Send more than 3 messages in the same 1s window to trip the limit.
    for (let i = 0; i < 6; i++) {
      ws.send(JSON.stringify([2, `m-${String(i)}`, 'Heartbeat', {}]));
    }

    const info = await closed;
    expect(info.code).toBe(1008);
    expect(info.reason).toContain('rate limit');
  });
});
