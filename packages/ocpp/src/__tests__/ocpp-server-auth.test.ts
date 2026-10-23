// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import type { IncomingHttpHeaders } from 'node:http';
import type postgres from 'postgres';
import { hash } from 'argon2';

const { mockGetRegistrationPolicy } = vi.hoisted(() => ({
  mockGetRegistrationPolicy: vi.fn(() => Promise.resolve('approval-required')),
}));
vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  getRegistrationPolicy: mockGetRegistrationPolicy,
}));

import { OcppServer } from '../server/ocpp-server.js';
import type { ConnectionAuthLimits } from '../server/connection-auth-limiter.js';
import {
  StationAuthBackoff,
  StationAuthCache,
  StationPasswordVerifier,
  type PasswordCheck,
} from '../server/middleware/station-password-verifier.js';

// A verifier whose checks of SLOW_PASSWORD wait until `release` runs: an
// attacker's wrong passwords that hold their authentication slot.
const SLOW_PASSWORD = 'slow-wrong-password';
class SlowVerifier extends StationPasswordVerifier {
  private hold: Promise<void>;
  release: () => void = () => {};
  constructor() {
    super({ cache: new StationAuthCache(), backoff: null });
    this.hold = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  override async verify(
    ...args: Parameters<StationPasswordVerifier['verify']>
  ): Promise<PasswordCheck> {
    if (args[2] === SLOW_PASSWORD) {
      await this.hold;
      return { valid: false, cached: false };
    }
    return super.verify(...args);
  }
}

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
  stations.set('AUTH-SP0', {
    id: 'sta_auth_sp0',
    security_profile: 0,
    basic_auth_password_hash: null,
    availability: 'available',
    onboarding_status: 'accepted',
  });
  stations.set('AUTH-PENDING', {
    id: 'sta_auth_pending',
    security_profile: 0,
    basic_auth_password_hash: null,
    availability: 'available',
    onboarding_status: 'pending',
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
// lookupGate, when set, holds every station lookup until it resolves, and
// lookups counts the lookups running at once.
const lookups = { running: 0, peak: 0 };
let lookupGate: Promise<void> | null = null;

function createSql(): postgres.Sql {
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    if (text.includes('FROM charging_stations') && text.includes('basic_auth_password_hash')) {
      lookups.running++;
      lookups.peak = Math.max(lookups.peak, lookups.running);
      try {
        if (lookupGate != null) await lookupGate;
        const row = stations.get(values[0] as string);
        return row != null ? [row] : [];
      } finally {
        lookups.running--;
      }
    }
    return [];
  };
  return Object.assign(sql, {
    json: (value: unknown) => value,
    options: { max: 20 },
  }) as unknown as postgres.Sql;
}

let testPort = 19700;
let server: OcppServer | null = null;

afterEach(async () => {
  lookupGate = null;
  lookups.peak = 0;
  if (server != null) {
    await server.stop();
    server = null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

async function startServer(
  connectionAuthLimits?: Partial<ConnectionAuthLimits>,
  extra: Partial<ConstructorParameters<typeof OcppServer>[0]> = {},
): Promise<number> {
  const port = testPort++;
  const srv = new OcppServer({ sql: createSql(), connectionAuthLimits, ...extra });
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
  protocols: string[] = ['ocpp1.6'],
  forwardedFor?: string,
): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (authorization != null) headers['authorization'] = authorization;
    if (forwardedFor != null) headers['x-forwarded-for'] = forwardedFor;
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/${stationId}`, protocols, {
      headers,
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

  it('answers SecurityError to a station awaiting approval that never sent a BootNotification', async () => {
    mockGetRegistrationPolicy.mockResolvedValueOnce('approval-required');
    const port = await startServer();

    const result = await handshake(port, 'AUTH-PENDING');
    expect(result.opened).toBe(true);
    if (!result.opened) return;
    const ws = result.ws;

    const response = new Promise<unknown[]>((resolve) => {
      ws.on('message', (data: Buffer) => {
        resolve(JSON.parse(data.toString()) as unknown[]);
      });
    });
    ws.send(JSON.stringify([2, 'hb-pending', 'Heartbeat', {}]));

    const message = await response;
    expect(message[0]).toBe(4);
    expect(message[1]).toBe('hb-pending');
    expect(message[2]).toBe('SecurityError');
    ws.close();
  });

  it('processes CALLs of a pending station under open registration', async () => {
    mockGetRegistrationPolicy.mockResolvedValueOnce('open');
    const port = await startServer();

    const result = await handshake(port, 'AUTH-PENDING');
    expect(result.opened).toBe(true);
    if (!result.opened) return;
    const ws = result.ws;

    const response = new Promise<unknown[]>((resolve) => {
      ws.on('message', (data: Buffer) => {
        resolve(JSON.parse(data.toString()) as unknown[]);
      });
    });
    ws.send(JSON.stringify([2, 'hb-open', 'Heartbeat', {}]));

    const message = await response;
    expect(message[0]).toBe(3);
    expect(message[1]).toBe('hb-open');
    ws.close();
  });
});

describe('OcppServer subprotocol negotiation (OCPP-J 3.1.2, OCTT TC_B_58)', () => {
  it('answers 400 to an upgrade that offers only unsupported subprotocols, before the station lookup', async () => {
    const port = await startServer();

    const result = await handshake(port, 'AUTH-OK', basic('AUTH-OK', 'secret-password'), [
      'ocpp0.1',
      'ocpp9.9',
    ]);

    expect(result.opened).toBe(false);
    if (result.opened) return;
    expect(result.status).toBe(400);
    expect(lookups.peak).toBe(0);
    expect(server?.getConnectionManager().count()).toBe(0);
  });

  it('selects the supported subprotocol when an unsupported one is offered with it', async () => {
    const port = await startServer();

    const result = await handshake(port, 'AUTH-OK', basic('AUTH-OK', 'secret-password'), [
      'ocpp0.1',
      'ocpp2.0.1',
    ]);

    expect(result.opened).toBe(true);
    if (!result.opened) return;
    expect(result.ws.protocol).toBe('ocpp2.0.1');
    result.ws.close();
  });

  it('accepts an upgrade without a Sec-WebSocket-Protocol header', async () => {
    const port = await startServer();

    const result = await handshake(port, 'AUTH-OK', basic('AUTH-OK', 'secret-password'), []);

    expect(result.opened).toBe(true);
    if (!result.opened) return;
    expect(result.ws.protocol).toBe('');
    result.ws.close();
  });
});

describe('OcppServer connection authentication limit', () => {
  it('runs at most half the database pool of lookups at once and queues the rest', async () => {
    const port = await startServer();
    expect(server?.getConnectionAuthStats().maxConcurrent).toBe(10);
    let open: () => void = () => {};
    lookupGate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const storm = Array.from({ length: 30 }, () => handshake(port, 'AUTH-SP0'));
    await vi.waitFor(() => {
      expect(server?.getConnectionAuthStats().queued).toBe(20);
    });
    expect(lookups.running).toBe(10);
    open();

    const results = await Promise.all(storm);
    expect(results.every((r) => r.opened)).toBe(true);
    expect(lookups.peak).toBe(10);
    expect(server?.getConnectionAuthStats()).toMatchObject({ active: 0, queued: 0, rejected: 0 });
    for (const r of results) if (r.opened) r.ws.close();
  });

  it('answers 503 when the queue is full, and accepts the station on its retry', async () => {
    const port = await startServer({ maxConcurrent: 1, maxQueued: 1 });
    let open: () => void = () => {};
    lookupGate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const first = handshake(port, 'AUTH-SP0');
    const second = handshake(port, 'AUTH-SP0');
    await vi.waitFor(() => {
      expect(server?.getConnectionAuthStats().queued).toBe(1);
    });
    const third = await handshake(port, 'AUTH-SP0');
    expect(third.opened).toBe(false);
    if (!third.opened) {
      expect(third.status).toBe(503);
      expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(10);
    }
    expect(server?.getConnectionAuthStats().rejected).toBe(1);

    open();
    const accepted = await Promise.all([first, second]);
    expect(accepted.every((r) => r.opened)).toBe(true);
    const retry = await handshake(port, 'AUTH-SP0');
    expect(retry.opened).toBe(true);
    for (const r of [...accepted, retry]) if (r.opened) r.ws.close();
  });

  it('answers 503 when a request waits longer than the limit', async () => {
    const port = await startServer({ maxConcurrent: 1, maxWaitMs: 50 });
    let open: () => void = () => {};
    lookupGate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const first = handshake(port, 'AUTH-SP0');
    const waited = await handshake(port, 'AUTH-SP0');
    expect(waited.opened).toBe(false);
    if (!waited.opened) {
      expect(waited.status).toBe(503);
      expect(waited.headers['retry-after']).toMatch(/^\d+$/);
    }

    open();
    const accepted = await first;
    expect(accepted.opened).toBe(true);
    if (accepted.opened) accepted.ws.close();
  });
});

describe('OcppServer pending authentication per IP', () => {
  const PROXY = { trustedProxyCidrs: '127.0.0.1/32' };

  it('answers 429 past the per-IP pending cap while another IP still authenticates', async () => {
    const verifier = new SlowVerifier();
    const port = await startServer(undefined, {
      ...PROXY,
      maxPendingAuthPerIp: 3,
      passwordVerifier: verifier,
    });
    const attacker = '203.0.113.7';
    const held = Array.from({ length: 3 }, () =>
      handshake(port, 'AUTH-OK', basic('AUTH-OK', SLOW_PASSWORD), ['ocpp1.6'], attacker),
    );
    await vi.waitFor(() => {
      expect(server?.getConnectionAuthStats().active).toBe(3);
    });
    const extra = await handshake(
      port,
      'AUTH-OK',
      basic('AUTH-OK', SLOW_PASSWORD),
      ['ocpp1.6'],
      attacker,
    );
    expect(extra.opened).toBe(false);
    if (!extra.opened) expect(extra.status).toBe(429);

    const other = await handshake(
      port,
      'AUTH-OK',
      basic('AUTH-OK', 'secret-password'),
      ['ocpp1.6'],
      '198.51.100.20',
    );
    expect(other.opened).toBe(true);
    if (other.opened) other.ws.close();

    verifier.release();
    const results = await Promise.all(held);
    expect(results.every((r) => !r.opened && r.status === 401)).toBe(true);
  });

  it('counts IPv6 addresses of one /64 as one IP', async () => {
    const verifier = new SlowVerifier();
    const port = await startServer(undefined, {
      ...PROXY,
      maxPendingAuthPerIp: 2,
      passwordVerifier: verifier,
    });
    const held = ['2001:db8:1:2::1', '2001:db8:1:2::2'].map((ip) =>
      handshake(port, 'AUTH-OK', basic('AUTH-OK', SLOW_PASSWORD), ['ocpp1.6'], ip),
    );
    await vi.waitFor(() => {
      expect(server?.getConnectionAuthStats().active).toBe(2);
    });
    const rotated = await handshake(
      port,
      'AUTH-OK',
      basic('AUTH-OK', SLOW_PASSWORD),
      ['ocpp1.6'],
      '2001:db8:1:2:ffff::9',
    );
    expect(rotated.opened).toBe(false);
    if (!rotated.opened) expect(rotated.status).toBe(429);

    verifier.release();
    await Promise.all(held);
  });

  it('lets a station with a cached success past a full authentication queue', async () => {
    const verifier = new SlowVerifier();
    const port = await startServer(
      { maxConcurrent: 1, maxQueued: 1, maxWaitMs: 300 },
      { ...PROXY, passwordVerifier: verifier },
    );
    // The station connects once, so its success is cached.
    const first = await handshake(
      port,
      'AUTH-OK',
      basic('AUTH-OK', 'secret-password'),
      ['ocpp1.6'],
      '198.51.100.20',
    );
    expect(first.opened).toBe(true);
    if (first.opened) first.ws.close();

    // An attacker holds the only slot and the only queue place.
    const held = [0, 1].map(() =>
      handshake(port, 'AUTH-OK', basic('AUTH-OK', SLOW_PASSWORD), ['ocpp1.6'], '203.0.113.7'),
    );
    await vi.waitFor(() => {
      expect(server?.getConnectionAuthStats()).toMatchObject({ active: 1, queued: 1 });
    });

    const again = await handshake(
      port,
      'AUTH-OK',
      basic('AUTH-OK', 'secret-password'),
      ['ocpp1.6'],
      '198.51.100.20',
    );
    expect(again.opened).toBe(true);
    if (again.opened) again.ws.close();

    verifier.release();
    await Promise.all(held);
  });
  it('decides a cached success before the per-IP pending cap', async () => {
    const verifier = new SlowVerifier();
    const port = await startServer(undefined, {
      maxPendingAuthPerIp: 1,
      passwordVerifier: verifier,
    });
    const first = await handshake(port, 'AUTH-OK', basic('AUTH-OK', 'secret-password'));
    expect(first.opened).toBe(true);
    if (first.opened) first.ws.close();
    // Another client on the same address takes the only pending place.
    const held = handshake(port, 'AUTH-OK', basic('AUTH-OK', SLOW_PASSWORD));
    await vi.waitFor(() => {
      expect(server?.getConnectionAuthStats().active).toBe(1);
    });
    const again = await handshake(port, 'AUTH-OK', basic('AUTH-OK', 'secret-password'));
    expect(again.opened).toBe(true);
    if (again.opened) again.ws.close();
    verifier.release();
    await held;
  });

  it('still caps and locks a forged X-Forwarded-For without trusted proxies', async () => {
    const verifier = new SlowVerifier();
    const port = await startServer(undefined, {
      maxPendingAuthPerIp: 1,
      passwordVerifier: verifier,
    });
    const held = handshake(
      port,
      'AUTH-OK',
      basic('AUTH-OK', SLOW_PASSWORD),
      ['ocpp1.6'],
      '198.51.100.1',
    );
    await vi.waitFor(() => {
      expect(server?.getConnectionAuthStats().active).toBe(1);
    });
    // Another forged address changes nothing: the socket peer is the client.
    const forged = await handshake(
      port,
      'AUTH-OK',
      basic('AUTH-OK', SLOW_PASSWORD),
      ['ocpp1.6'],
      '198.51.100.2',
    );
    expect(forged.opened).toBe(false);
    if (!forged.opened) expect(forged.status).toBe(429);
    verifier.release();
    await held;
  });

  it('locks the socket peer out across forged X-Forwarded-For values', async () => {
    const verifier = new StationPasswordVerifier({
      cache: new StationAuthCache(),
      ipBackoff: new StationAuthBackoff({ limit: 1 }),
    });
    const port = await startServer(undefined, { passwordVerifier: verifier });
    const first = await handshake(
      port,
      'AUTH-OK',
      basic('AUTH-OK', 'wrong-password-01'),
      ['ocpp1.6'],
      '198.51.100.1',
    );
    expect(first.opened).toBe(false);
    if (!first.opened) expect(first.status).toBe(401);
    // Locked: one slow-lane verify (401), then throttled (429), whatever the header says.
    const second = await handshake(
      port,
      'AUTH-OK',
      basic('AUTH-OK', 'wrong-password-02'),
      ['ocpp1.6'],
      '198.51.100.2',
    );
    expect(second.opened).toBe(false);
    if (!second.opened) expect(second.status).toBe(401);
    const third = await handshake(
      port,
      'AUTH-OK',
      basic('AUTH-OK', 'wrong-password-03'),
      ['ocpp1.6'],
      '198.51.100.3',
    );
    expect(third.opened).toBe(false);
    if (!third.opened) expect(third.status).toBe(429);
  });
});
