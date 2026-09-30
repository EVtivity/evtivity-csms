// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { IncomingHttpHeaders } from 'node:http';
import type postgres from 'postgres';
import { hash } from 'argon2';
import { OcppServer } from '../server/ocpp-server.js';

interface StationRow {
  id: string;
  security_profile: number;
  basic_auth_password_hash: string | null;
  availability: string;
  onboarding_status: string;
}

let passwordHash = '';
const stations = new Map<string, StationRow>();

beforeAll(async () => {
  passwordHash = await hash('secret-password');
  stations.set('AUTH-OK', {
    id: 'sta_auth_ok',
    security_profile: 1,
    basic_auth_password_hash: passwordHash,
    availability: 'available',
    onboarding_status: 'accepted',
  });
  stations.set('AUTH-BLOCKED', {
    id: 'sta_auth_blocked',
    security_profile: 1,
    basic_auth_password_hash: passwordHash,
    availability: 'available',
    onboarding_status: 'blocked',
  });
});

// Tagged-template stand-in for postgres.js: answers the station lookup in
// authenticateConnection from the map above and resolves every other query
// (connection_logs inserts, ping monitor snapshots) to an empty result.
function createSql(): postgres.Sql {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    if (text.includes('FROM charging_stations') && text.includes('basic_auth_password_hash')) {
      const row = stations.get(values[0] as string);
      return Promise.resolve(row != null ? [row] : []);
    }
    return Promise.resolve([]);
  };
  return Object.assign(sql, { json: (value: unknown) => value }) as unknown as postgres.Sql;
}

let testPort = 19700;
let server: OcppServer | null = null;

afterEach(async () => {
  if (server != null) {
    await server.stop();
    server = null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

async function startServer(): Promise<number> {
  const port = testPort++;
  const srv = new OcppServer({ sql: createSql() });
  server = srv;
  await srv.start({ port, host: '127.0.0.1' });
  return port;
}

function basic(user: string, password: string): string {
  return 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
}

type HandshakeResult =
  | { opened: true; ws: WebSocket }
  | { opened: false; status: number; headers: IncomingHttpHeaders };

function handshake(
  port: number,
  stationId: string,
  authorization?: string,
): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/${stationId}`, ['ocpp1.6'], {
      headers: authorization != null ? { authorization } : {},
    });
    ws.on('open', () => {
      resolve({ opened: true, ws });
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve({ opened: false, status: res.statusCode ?? 0, headers: res.headers });
      res.resume();
      ws.terminate();
    });
    ws.on('error', (err) => {
      reject(err);
    });
  });
}

describe('OcppServer authentication before the WebSocket upgrade', () => {
  it('answers a missing Authorization header with 401 and a Basic challenge', async () => {
    const port = await startServer();

    const result = await handshake(port, 'AUTH-OK');

    expect(result.opened).toBe(false);
    if (result.opened) return;
    expect(result.status).toBe(401);
    expect(result.headers['www-authenticate']).toMatch(/^Basic realm="OCPP"/);
  });

  it('accepts the retry with credentials after the challenge', async () => {
    const port = await startServer();

    const first = await handshake(port, 'AUTH-OK');
    expect(first.opened).toBe(false);

    const second = await handshake(port, 'AUTH-OK', basic('AUTH-OK', 'secret-password'));
    expect(second.opened).toBe(true);
    if (second.opened) {
      expect(second.ws.protocol).toBe('ocpp1.6');
      second.ws.close();
    }
  });

  it('answers a wrong password with 401', async () => {
    const port = await startServer();

    const result = await handshake(port, 'AUTH-OK', basic('AUTH-OK', 'wrong'));

    expect(result.opened).toBe(false);
    if (result.opened) return;
    expect(result.status).toBe(401);
    expect(result.headers['www-authenticate']).toMatch(/^Basic /);
  });

  it('answers a username that differs from the station ID with 401', async () => {
    const port = await startServer();

    const result = await handshake(port, 'AUTH-OK', basic('OTHER', 'secret-password'));

    expect(result.opened).toBe(false);
    if (result.opened) return;
    expect(result.status).toBe(401);
  });

  it('answers an unknown station with 404 and no challenge', async () => {
    const port = await startServer();

    const result = await handshake(port, 'AUTH-UNKNOWN', basic('AUTH-UNKNOWN', 'secret-password'));

    expect(result.opened).toBe(false);
    if (result.opened) return;
    expect(result.status).toBe(404);
    expect(result.headers['www-authenticate']).toBeUndefined();
  });

  it('answers a blocked station with 403', async () => {
    const port = await startServer();

    const result = await handshake(port, 'AUTH-BLOCKED', basic('AUTH-BLOCKED', 'secret-password'));

    expect(result.opened).toBe(false);
    if (result.opened) return;
    expect(result.status).toBe(403);
  });

  it('processes a CALL sent right after the upgrade', async () => {
    const port = await startServer();

    const result = await handshake(port, 'AUTH-OK', basic('AUTH-OK', 'secret-password'));
    expect(result.opened).toBe(true);
    if (!result.opened) return;
    const ws = result.ws;

    const response = new Promise<unknown[]>((resolve) => {
      ws.on('message', (data: Buffer) => {
        resolve(JSON.parse(data.toString()) as unknown[]);
      });
    });
    ws.send(JSON.stringify([2, 'hb-1', 'Heartbeat', {}]));

    const message = await response;
    expect(message[0]).toBe(3);
    expect(message[1]).toBe('hb-1');
    ws.close();
  });
});
