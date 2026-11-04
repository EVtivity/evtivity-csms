// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createServer, type Server } from 'node:http';
import { connect as connectTcp, type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { WebSocket } from 'ws';

const PASSWORD = 'correct-horse-battery';

const system = {
  id: 'dps_1',
  presystemId: 'depot-1',
  name: 'Depot One',
  systemType: 'BMS',
  isEnabled: true,
  passwordHash: 'hash',
  authLockedUntil: null as Date | null,
  failedAuthCount: 0,
  infoIntervalSeconds: 60,
  requestTimeoutSeconds: 30,
  maxRetries: 2,
  keepaliveTimeoutSeconds: 300,
};

interface HoistedDb {
  enabled: boolean;
  /** The depot system row the mocked reads return (null: unknown). */
  row: Record<string, unknown> | null;
  systemLocked: boolean;
  clearCache: Mock<() => void>;
  recordFailure: Mock<(...args: unknown[]) => Promise<boolean>>;
  gate: Promise<void> | null;
  verifying: number;
}

const db = vi.hoisted(
  (): HoistedDb => ({
    enabled: true,
    row: null,
    systemLocked: false,
    clearCache: vi.fn(),
    recordFailure: vi.fn(),
    /** While set, every password check waits for it. */
    gate: null,
    verifying: 0,
  }),
);

vi.mock('@evtivity/database', () => ({
  clearVdv463SettingCache: db.clearCache,
  isVdv463Enabled: vi.fn(() => Promise.resolve(db.enabled)),
  getDepotSystem: vi.fn(() => Promise.resolve(db.row)),
  getDepotSystemByPresystemId: vi.fn((id: string) =>
    Promise.resolve(id === 'depot-1' ? db.row : null),
  ),
  recordDepotSystemAuthFailure: db.recordFailure,
  recordDepotSystemConnected: vi.fn(() => Promise.resolve()),
  recordDepotSystemBoot: vi.fn(() => Promise.resolve()),
  recordDepotSystemMessage: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/depot-system-password.js', () => ({
  verifyDepotSystemPassword: vi.fn(async (hash: string | null, password: string) => {
    db.verifying += 1;
    try {
      if (db.gate != null) await db.gate;
      return hash != null && password === 'correct-horse-battery';
    } finally {
      db.verifying -= 1;
    }
  }),
}));

vi.mock('../services/depot-system-requests.js', () => ({
  auditDepotSystemAuthLock: vi.fn(() => Promise.resolve()),
}));

const { attachVdv463Server, VDV463_AUTH_LOCK_THRESHOLD, VDV463_MAX_PENDING_SIGN_INS } =
  await import('../vdv463/server.js');
const { memoryFailureStore, VDV463_ADDRESS_LOCK_FAILURES, VDV463_FREE_FAILURES } =
  await import('../vdv463/auth-failures.js');

type Handler = (message: string) => void;

function fakePubSub(): {
  publish: (channel: string, payload: string) => Promise<void>;
  subscribe: (channel: string, h: Handler) => Promise<{ unsubscribe: () => Promise<void> }>;
  close: () => Promise<void>;
  deliver: (message: unknown) => void;
} {
  const handlers: Handler[] = [];
  return {
    publish: () => Promise.resolve(),
    subscribe: (_channel, h) => {
      handlers.push(h);
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    },
    close: () => Promise.resolve(),
    deliver: (message) => {
      for (const h of handlers) h(JSON.stringify(message));
    },
  };
}

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let server: Server;
let port: number;
let handle: ReturnType<typeof attachVdv463Server>;
let pubsub: ReturnType<typeof fakePubSub>;
let nowMs: number;
let auditLock: ReturnType<typeof vi.fn>;

async function start(
  opts: { allowPlain?: boolean; trustProxy?: false | string } = {},
): Promise<void> {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  pubsub = fakePubSub();
  auditLock = vi.fn(() => Promise.resolve());
  handle = attachVdv463Server(server, {
    log,
    pubsub,
    trustProxy: opts.trustProxy ?? '127.0.0.1',
    allowPlain: opts.allowPlain ?? true,
    readSnapshot: () => Promise.resolve([]),
    applyRequests: () => Promise.resolve(),
    failures: memoryFailureStore(),
    auditLock: auditLock as never,
    now: () => new Date(nowMs),
  });
}

/** Opens a connection from `ip` (X-Forwarded-For from the trusted loopback). */
function connect(
  ip: string,
  password: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; ws?: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/vdv463`, 'v1.463.vdv.de', {
      headers: {
        authorization: `Basic ${Buffer.from(`depot-1:${password}`).toString('base64')}`,
        'x-forwarded-for': ip,
        ...extraHeaders,
      },
    });
    ws.on('open', () => {
      resolve({ status: 101, ws });
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
    });
    ws.on('error', () => {
      resolve({ status: 0 });
    });
  });
}

async function failFrom(ip: string, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    expect((await connect(ip, 'wrong-password')).status).toBe(401);
  }
}

beforeEach(async () => {
  nowMs = Date.parse('2026-11-03T10:00:00Z');
  db.enabled = true;
  db.row = { ...system };
  db.systemLocked = false;
  db.clearCache.mockReset();
  db.recordFailure.mockReset();
  db.recordFailure.mockImplementation(() => Promise.resolve(db.systemLocked));
  await start();
});

afterEach(async () => {
  await handle.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('bus depot interface sign-in lockout (per depot system and address)', () => {
  it('lets a correct password from a clean address sign in while another address waits', async () => {
    await failFrom('203.0.113.9', VDV463_ADDRESS_LOCK_FAILURES);
    // The guessing address waits, even with the right password.
    expect((await connect('203.0.113.9', PASSWORD)).status).toBe(401);
    const clean = await connect('198.51.100.20', PASSWORD);
    expect(clean.status).toBe(101);
    clean.ws?.close();
  });

  it('makes an address wait longer after each failure and lets it in after the wait', async () => {
    await failFrom('203.0.113.9', VDV463_FREE_FAILURES);
    expect((await connect('203.0.113.9', PASSWORD)).status).toBe(401);
    nowMs += 1500;
    const ok = await connect('203.0.113.9', PASSWORD);
    expect(ok.status).toBe(101);
    ok.ws?.close();
  });

  it('counts an IPv6 /64 as one address', async () => {
    await failFrom('2001:db8:1:2::1', VDV463_FREE_FAILURES);
    expect((await connect('2001:db8:1:2::ffff', PASSWORD)).status).toBe(401);
    const other = await connect('2001:db8:1:3::1', PASSWORD);
    expect(other.status).toBe(101);
    other.ws?.close();
  });

  it('audits an address lock once when it reaches the limit', async () => {
    await failFrom('203.0.113.9', 2);
    for (let i = 2; i < VDV463_ADDRESS_LOCK_FAILURES + 2; i += 1) {
      nowMs += 20 * 60_000;
      await failFrom('203.0.113.9', 1);
    }
    const locks = auditLock.mock.calls.filter(
      (c) => (c[1] as { scope: string }).scope === 'address',
    );
    expect(locks).toHaveLength(1);
    expect(locks[0]?.[1]).toMatchObject({ addressKey: '203.0.113.9', failures: 10 });
  });

  it('holds back only addresses with failures while the system ceiling is on, and audits it', async () => {
    db.systemLocked = true;
    await failFrom('203.0.113.9', 1);
    expect(db.recordFailure).toHaveBeenCalledWith('dps_1', VDV463_AUTH_LOCK_THRESHOLD, 15 * 60_000);
    expect(auditLock.mock.calls.some((c) => (c[1] as { scope: string }).scope === 'system')).toBe(
      true,
    );
    db.row = { ...system, authLockedUntil: new Date(nowMs + 15 * 60_000) };
    expect((await connect('203.0.113.9', PASSWORD)).status).toBe(401);
    const clean = await connect('198.51.100.20', PASSWORD);
    expect(clean.status).toBe(101);
    clean.ws?.close();
  });

  it('clears the address failures after a correct password', async () => {
    await failFrom('203.0.113.9', VDV463_FREE_FAILURES - 1);
    const ok = await connect('203.0.113.9', PASSWORD);
    expect(ok.status).toBe(101);
    ok.ws?.close();
    await failFrom('203.0.113.9', VDV463_FREE_FAILURES - 1);
    const again = await connect('203.0.113.9', PASSWORD);
    expect(again.status).toBe(101);
    again.ws?.close();
  });

  it('refuses a disabled depot system with the right password and records no connection (AUTH-L2)', async () => {
    const database = await import('@evtivity/database');
    const connected = vi.mocked(database.recordDepotSystemConnected);
    connected.mockClear();
    await failFrom('203.0.113.9', VDV463_FREE_FAILURES - 1);
    db.row = { ...system, isEnabled: false };
    expect((await connect('203.0.113.9', PASSWORD)).status).toBe(401);
    expect(connected).not.toHaveBeenCalled();
    // The address failures stay: one more wrong guess makes the address wait.
    db.row = { ...system };
    await failFrom('203.0.113.9', 1);
    expect((await connect('203.0.113.9', PASSWORD)).status).toBe(401);
  });

  it('refuses an unknown depot system without counting a failure', async () => {
    db.row = null;
    expect((await connect('203.0.113.9', PASSWORD)).status).toBe(401);
    expect(db.recordFailure).not.toHaveBeenCalled();
  });
});

/** Sends a raw upgrade request and returns the first line of the answer ('' when closed). */
function rawUpgrade(path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connectTcp(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      );
    });
    let text = '';
    socket.on('data', (d: Buffer) => {
      text += d.toString('utf8');
    });
    socket.on('close', () => {
      resolve(text.split('\r\n')[0] ?? '');
    });
    setTimeout(() => {
      socket.destroy();
      resolve('still open');
    }, 3000);
  });
}

describe('bus depot interface upgrade limits', () => {
  it('answers and closes an upgrade to any other path (no socket is left open)', async () => {
    for (const path of ['/v1/health', '/vdv463x', '/%76dv463', '//vdv463']) {
      expect(await rawUpgrade(path), path).toBe('HTTP/1.1 404 Not Found');
    }
  });

  it('answers 503 past the password checks running at once, and checks no more than the cap', async () => {
    let open: () => void = () => {};
    db.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const attempts = Array.from({ length: VDV463_MAX_PENDING_SIGN_INS + 4 }, (_, i) =>
      connect(`203.0.113.${String(i + 1)}`, 'wrong-password'),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(db.verifying).toBe(VDV463_MAX_PENDING_SIGN_INS);
    open();
    db.gate = null;
    const statuses = (await Promise.all(attempts)).map((a) => a.status);
    expect(statuses.filter((st) => st === 503)).toHaveLength(4);
    expect(statuses.filter((st) => st === 401)).toHaveLength(VDV463_MAX_PENDING_SIGN_INS);
  });
});

describe('bus depot interface TLS gate (AUTH-I1, PLAT-L1)', () => {
  async function restart(opts: { allowPlain?: boolean; trustProxy?: false | string }) {
    await handle.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start(opts);
  }

  it('refuses a plain upgrade without allowPlain', async () => {
    await restart({ allowPlain: false });
    expect((await connect('198.51.100.20', PASSWORD)).status).toBe(403);
  });

  it('accepts X-Forwarded-Proto https from the trusted proxy', async () => {
    await restart({ allowPlain: false });
    const ok = await connect('198.51.100.20', PASSWORD, { 'x-forwarded-proto': 'https' });
    expect(ok.status).toBe(101);
    ok.ws?.close();
  });

  it('refuses X-Forwarded-Proto https from a peer that is no trusted proxy', async () => {
    await restart({ allowPlain: false, trustProxy: '10.0.0.1' });
    expect(
      (await connect('198.51.100.20', PASSWORD, { 'x-forwarded-proto': 'https' })).status,
    ).toBe(403);
    await restart({ allowPlain: false, trustProxy: false });
    expect(
      (await connect('198.51.100.20', PASSWORD, { 'x-forwarded-proto': 'https' })).status,
    ).toBe(403);
  });

  it('refuses a plain upgrade whose trusted proxy sent X-Forwarded-Proto https, http', async () => {
    await restart({ allowPlain: false });
    expect(
      (await connect('198.51.100.20', PASSWORD, { 'x-forwarded-proto': 'https, http' })).status,
    ).toBe(403);
  });
});

describe('bus depot interface kill switch', () => {
  async function liveConnection(): Promise<WebSocket> {
    const { status, ws } = await connect('198.51.100.20', PASSWORD);
    expect(status).toBe(101);
    if (ws == null) throw new Error('no connection');
    return ws;
  }

  function closed(ws: WebSocket): Promise<number> {
    return new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  }

  it('closes every connection when the switch turns off on any process', async () => {
    const ws = await liveConnection();
    const done = closed(ws);
    db.enabled = false;
    pubsub.deliver({ all: true });
    expect(await done).toBe(4005);
    expect(db.clearCache).toHaveBeenCalled();
    expect(handle.connections().size).toBe(0);
  });

  it('keeps connections when the switch event finds it on', async () => {
    const ws = await liveConnection();
    pubsub.deliver({ all: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(handle.connections().size).toBe(1);
    ws.close();
  });

  it('closes the connection of a disabled or deleted depot system', async () => {
    const ws = await liveConnection();
    const done = closed(ws);
    db.row = null;
    pubsub.deliver({ id: 'dps_1' });
    expect(await done).toBe(4005);
  });

  it('refuses a new connection while the switch is off', async () => {
    db.enabled = false;
    expect((await connect('198.51.100.20', PASSWORD)).status).toBe(503);
  });

  it('closes instead of applying a request sent after the switch turned off', async () => {
    const ws = await liveConnection();
    const done = closed(ws);
    const frames: string[] = [];
    ws.on('message', (d: Buffer) => frames.push(d.toString('utf8')));
    db.enabled = false;
    ws.send(
      JSON.stringify([
        1,
        'presystem',
        'depot-1',
        '2026-11-03T10:00:00Z',
        '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f',
        'BootNotification',
        { presystem: 'BMS' },
      ]),
    );
    expect(await done).toBe(4005);
    expect(frames).toHaveLength(0);
  });
});
